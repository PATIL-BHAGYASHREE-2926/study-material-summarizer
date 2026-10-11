import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    MAX_DOCUMENT_UNITS,
    MAX_EXTRACTED_TEXT_CHARS,
    MAX_UNIT_TEXT_CHARS,
} from "@/lib/constants/limits";
import type {
    CanonicalDocument,
    CanonicalDocumentSection,
} from "@/types/canonical-document";

import { buildCanonicalDocument } from "./canonical";
import { DocumentProcessingError, toDocumentProcessingError } from "./errors";
import {
    deriveTitle,
    joinWrappedLines,
    normalizeLine,
    splitLines,
    stripBulletPrefix,
} from "./normalize";

/**
 * Minimal structural types for the slice of the pdf.js API this extractor uses.
 *
 * `pdfjs-dist/legacy/build/pdf.mjs` ships no type declarations, and depending on
 * the full pdf.js type surface would be overkill for text extraction only.
 */
interface PdfJsTextItem {
    str: string;
    hasEOL?: boolean;
    transform?: number[];
}

interface PdfJsPageProxy {
    getTextContent(): Promise<{ items: Array<PdfJsTextItem | unknown> }>;
}

interface PdfJsDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfJsPageProxy>;
    getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

interface PdfJsLoadingTask {
    promise: Promise<PdfJsDocumentProxy>;
    destroy(): Promise<void>;
}

interface PdfJsModule {
    getDocument(params: {
        data: Uint8Array;
        isEvalSupported?: boolean;
        useSystemFonts?: boolean;
        disableFontFace?: boolean;
        standardFontDataUrl?: string;
    }): PdfJsLoadingTask;
}

/**
 * The pdf.js worker module, reduced to the one member this file checks.
 *
 * `pdfjs-dist/legacy/build/pdf.worker.mjs` ships no type declarations, so the
 * member is declared here and validated at runtime rather than trusted.
 */
interface PdfJsWorkerModule {
    WorkerMessageHandler: unknown;
}

/**
 * Slot pdf.js looks in for an already-loaded worker, before it tries to import
 * one by path.
 *
 * pdf.js reads this off `globalThis`, so it is typed here rather than declared
 * globally to keep the pollution inside this module.
 */
type PdfJsWorkerGlobal = typeof globalThis & {
    pdfjsWorker?: PdfJsWorkerModule;
};

let pdfJsPromise: Promise<PdfJsModule> | null = null;

/**
 * Put the worker module where pdf.js looks for one before resolving any path.
 *
 * Under Node, pdf.js runs its worker in-process as a "fake" worker and loads it
 * lazily with `import(GlobalWorkerOptions.workerSrc)`. That option defaults to
 * the relative path `"./pdf.worker.mjs"` and the import is marked `webpackIgnore`
 * / `vite-ignore`, so a bundler deliberately leaves it alone. Unbundled that
 * relative path resolves fine; bundled - which is how the Next.js server runs
 * this file - the api module is emitted into a chunk directory with no
 * `pdf.worker.mjs` beside it, so the import rejects with
 * `Cannot find module '.../chunks/pdf.worker.mjs'`, pdf.js raises "Setting up
 * fake worker failed", and *every* upload is rejected before a single byte of
 * the file is parsed.
 *
 * `pdf.worker.mjs` assigns this slot in its own module body, and pdf.js reads it
 * *before* it resolves a path, so importing the worker here is what fixes the
 * bundled build. The assignment is repeated explicitly rather than left to that
 * side effect, because a pdf.js upgrade that dropped it would silently restore
 * this bug.
 *
 * Both imports use literal specifiers so a bundler includes them instead of
 * deferring to runtime resolution, and the worker is imported first so the slot
 * is populated before anything can ask pdf.js for a worker.
 *
 * The assignment is unconditional: the slot is process-global and pdf.js reads
 * it before anything else, so deferring to whatever happened to write it first
 * would let an unrelated module disable PDF parsing for every user. The shape is
 * checked first, because registering something pdf.js cannot use would send it
 * silently back down the failing path it was meant to avoid.
 */
function registerPdfJsWorker(worker: unknown): void {
    const candidate = worker as Partial<PdfJsWorkerModule> | null;
    if (typeof candidate?.WorkerMessageHandler !== "function") {
        throw new DocumentProcessingError("PARSER_UNAVAILABLE", undefined, {
            cause: new Error("The pdf.js worker module exported no WorkerMessageHandler."),
        });
    }

    (globalThis as PdfJsWorkerGlobal).pdfjsWorker = worker as PdfJsWorkerModule;
}

async function importPdfJs(): Promise<PdfJsModule> {
    registerPdfJsWorker(await import("pdfjs-dist/legacy/build/pdf.worker.mjs"));

    const pdfJs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return pdfJs as unknown as PdfJsModule;
}

/**
 * pdf.js is server-only. It is imported dynamically so the module (and its
 * worker) can never be pulled into a client bundle.
 */
function loadPdfJs(): Promise<PdfJsModule> {
    pdfJsPromise ??= importPdfJs();
    return pdfJsPromise;
}

/**
 * Load pdf.js, converting a load failure into a typed error.
 *
 * A failed load must not poison the module cache: the promise is cleared so a
 * later request can retry the import. That only helps if the failure was
 * transient - pdf.js memoises its own worker setup for the life of the process,
 * so a worker that failed to start will not recover on a retry, but a module
 * that failed to *load* (a partially written build, a transient OOM) will.
 *
 * This is a fault in *this deployment* - a missing or unloadable pdf.js module -
 * not in the upload, so it is reported as `PARSER_UNAVAILABLE` rather than being
 * blamed on the user's file.
 */
async function loadPdfJsOrThrow(): Promise<PdfJsModule> {
    const pending = loadPdfJs();
    try {
        return await pending;
    } catch (error) {
        // Only drop our own rejected promise: a concurrent request may have
        // already started a fresh load that should stay cached.
        if (pdfJsPromise === pending) pdfJsPromise = null;
        throw new DocumentProcessingError("PARSER_UNAVAILABLE", undefined, { cause: error });
    }
}

/**
 * Path to standard font data provided by pdfjs-dist.
 *
 * Required by pdf.js when documents use standard 14 non-embedded fonts.
 * Must include the trailing slash so pdf.js can append font filenames.
 */
function getStandardFontDataUrl(): string {
    try {
        const pkg = import.meta.resolve("pdfjs-dist/package.json");
        const dir = path.join(path.dirname(fileURLToPath(pkg)), "standard_fonts");
        return dir.replaceAll("\\", "/") + "/";
    } catch {
        const dir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts");
        return dir.replaceAll("\\", "/") + "/";
    }
}

/** Headings must be at least this many characters to be useful. */
const HEADING_MIN_LENGTH = 3;
const HEADING_MAX_LENGTH = 120;
/** A heading must be meaningfully larger than the page's dominant font size. */
const HEADING_SIZE_RATIO = 1.18;
/** How many heading candidates to consider per page. */
const MAX_HEADING_CANDIDATES = 1;
/** An x decrease larger than this (points) marks a new column, not a wrap. */
const COLUMN_REWIND_TOLERANCE = 12;

interface PositionedRun {
    text: string;
    hasEOL: boolean;
    /** Font height in points, or 0 when unknown. */
    size: number;
    /** Baseline y coordinate in PDF user space, or `null` when unknown. */
    y: number | null;
    /** Left edge x coordinate in PDF user space, or `null` when unknown. */
    x: number | null;
}

/** A visual line plus the dominant font size used to render it. */
interface TextLine {
    text: string;
    size: number;
}

interface PageExtraction {
    text: string;
    headings: string[];
}

/**
 * Running ceilings on how much text extraction may consume.
 *
 * The alternative - extracting everything and truncating afterwards in
 * `buildCanonicalDocument` - means the memory and CPU have already been spent,
 * so the work has to be bounded *while* it happens. The budget tracks the
 * current unit separately from the whole document, so a document made of many
 * modest pages is not rejected by the per-page rule.
 */
class ExtractionBudget {
    private unitChars = 0;
    private totalChars = 0;

    /** Add `chars` of extracted text, failing fast when a ceiling is crossed. */
    charge(chars: number): void {
        this.unitChars += chars;
        this.totalChars += chars;

        if (
            this.unitChars > MAX_UNIT_TEXT_CHARS ||
            this.totalChars > MAX_EXTRACTED_TEXT_CHARS
        ) {
            this.unitChars = 0;
            throw new DocumentProcessingError("TEXT_LIMIT_EXCEEDED");
        }
    }

    /** Start a new page or slide, resetting the per-unit counter. */
    startUnit(): void {
        this.unitChars = 0;
    }
}

/**
 * Group positioned text runs into visual lines.
 *
 * A new line starts when pdf.js flags `hasEOL` *or* when the baseline moves.
 * The positional check is required because a single `BT`/`ET` text object can
 * emit many runs without ever setting `hasEOL` - without it, a heading and the
 * body line below it merge into one string.
 */
function runsToLines(runs: PositionedRun[]): TextLine[] {
    const lines: TextLine[] = [];
    let current = "";
    let currentY: number | null = null;
    let currentX: number | null = null;
    let sizeWeights = new Map<number, number>();

    const flush = () => {
        if (current.length === 0) return;
        lines.push({ text: current, size: dominantOf(sizeWeights) });
        current = "";
        sizeWeights = new Map<number, number>();
    };

    for (const run of runs) {
        // A baseline move or an x rewind means the previous run ended the visual
        // line; both are checked *before* appending, so the new run opens the
        // next line instead of being prepended to it.
        const baselineMoved =
            currentY !== null && run.y !== null && Math.abs(run.y - currentY) > 1;
        const columnRewound =
            currentX !== null && run.x !== null && run.x < currentX - COLUMN_REWIND_TOLERANCE;

        if (baselineMoved || columnRewound) flush();

        // pdf.js splits one visual line into several items whenever the font
        // changes; without a separator those runs fuse into single words.
        if (
            current.length > 0 &&
            !/\s$/.test(current) &&
            !/^\s/.test(run.text) &&
            run.x !== null &&
            currentX !== null &&
            run.x - currentX > 0
        ) {
            current += " ";
        }

        current += run.text;
        currentY = run.y ?? currentY;
        currentX = run.x ?? currentX;
        if (run.size > 0) {
            const key = Math.round(run.size * 10) / 10;
            sizeWeights.set(key, (sizeWeights.get(key) ?? 0) + run.text.length);
        }

        // `hasEOL` marks the run that *ends* a line, so the flush happens after
        // it has been appended - never before.
        if (run.hasEOL) {
            flush();
            currentY = null;
            currentX = null;
        }
    }

    flush();
    return lines;
}

/** The size carrying the most characters in a weight map. */
function dominantOf(weights: Map<number, number>): number {
    let dominant = 0;
    let bestWeight = -1;
    for (const [size, weight] of weights) {
        if (weight > bestWeight) {
            bestWeight = weight;
            dominant = size;
        }
    }
    return dominant;
}

/**
 * Read the rendered text height, origin and baseline from a pdf.js text matrix.
 *
 * The matrix is `[scaleX, skewY, skewX, scaleY, x, y]`; `scaleY` is the
 * effective font height and `x`/`y` place the run's origin.
 */
function readGeometry(transform: unknown): {
    size: number;
    x: number | null;
    y: number | null;
} {
    if (!Array.isArray(transform)) return { size: 0, x: null, y: null };
    const scaleY = transform[3];
    const x = transform[4];
    const y = transform[5];
    return {
        size: typeof scaleY === "number" && scaleY > 0 ? scaleY : 0,
        x: typeof x === "number" ? x : null,
        y: typeof y === "number" ? y : null,
    };
}

/**
 * Pick the font size used by most of the page's characters.
 *
 * Weighted by character count, so a single large drop cap does not redefine
 * the body size.
 */
function dominantFontSize(runs: PositionedRun[]): number {
    const weights = new Map<number, number>();
    for (const run of runs) {
        if (run.size <= 0) continue;
        const key = Math.round(run.size * 10) / 10;
        weights.set(key, (weights.get(key) ?? 0) + run.text.length);
    }
    return dominantOf(weights);
}

/** Build candidate headings from the lines rendered above the body font size. */
function collectHeadings(lines: TextLine[], threshold: number): string[] {
    const headings: string[] = [];
    for (const line of lines) {
        if (line.size <= 0 || line.size < threshold) continue;
        const candidate = stripBulletPrefix(line.text);
        if (candidate.length < HEADING_MIN_LENGTH) continue;
        if (candidate.length > HEADING_MAX_LENGTH) continue;
        if (!/\p{L}/u.test(candidate)) continue;
        headings.push(candidate);
        if (headings.length >= MAX_HEADING_CANDIDATES) break;
    }
    return headings;
}

/**
 * Fallback heading heuristic for pages where nothing beats the dominant size.
 *
 * A short page whose first line is the only one set in a distinct, larger font
 * is a title even when the title outweighs the body text. Without this, a
 * title-only page would silently lose its heading.
 */
function fallbackHeading(lines: TextLine[]): string[] {
    const first = lines[0];
    if (!first || lines.length < 2) return [];

    const firstSize = first.size;
    if (firstSize <= 0) return [];

    const differsFromRest = lines
        .slice(1)
        .some((line) => line.size > 0 && line.size !== firstSize);
    if (!differsFromRest) return [];

    const candidate = stripBulletPrefix(first.text);
    if (candidate.length < HEADING_MIN_LENGTH || candidate.length > HEADING_MAX_LENGTH) {
        return [];
    }
    if (!/\p{L}/u.test(candidate)) return [];
    return [candidate];
}

/**
 * Join wrapped lines into paragraphs, breaking at font-size changes.
 *
 * A heading rendered larger than the body must not be glued onto the first
 * body line beneath it, so a size change forces a paragraph break.
 */
function buildParagraphs(lines: TextLine[]): string[] {
    const paragraphs: string[] = [];
    let buffer: string[] = [];
    let bufferSize: number | null = null;

    const flush = () => {
        if (buffer.length > 0) paragraphs.push(...joinWrappedLines(buffer));
        buffer = [];
        bufferSize = null;
    };

    for (const line of lines) {
        const sizeChanged =
            bufferSize !== null && line.size > 0 && bufferSize > 0 && line.size !== bufferSize;
        if (sizeChanged) flush();
        if (bufferSize === null) bufferSize = line.size;
        buffer.push(line.text);
    }
    flush();

    return paragraphs;
}

/** Extract plain text plus heading candidates from a single page. */
async function extractPage(
    page: PdfJsPageProxy,
    budget: ExtractionBudget,
): Promise<PageExtraction> {
    const textContent = await page.getTextContent();
    const runs: PositionedRun[] = [];

    for (const item of textContent.items) {
        if (typeof item !== "object" || item === null) continue;
        const candidate = item as PdfJsTextItem;
        if (typeof candidate.str !== "string" || candidate.str.length === 0) continue;

        // Charged per run rather than per finished page, so a single page that
        // expands to hundreds of megabytes of text is abandoned mid-iteration
        // instead of after it has been fully materialised.
        budget.charge(candidate.str.length);

        const { size, x, y } = readGeometry(candidate.transform);
        runs.push({ text: candidate.str, hasEOL: candidate.hasEOL === true, size, x, y });
    }

    const lines = runsToLines(runs);
    const text = buildParagraphs(lines).join("\n");

    const bodySize = dominantFontSize(runs);
    const threshold = bodySize > 0 ? bodySize * HEADING_SIZE_RATIO : Infinity;

    const headings = collectHeadings(lines, threshold);
    if (headings.length > 0) return { text, headings };

    return { text, headings: fallbackHeading(lines) };
}

function errorName(error: unknown): string {
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" ? name : "";
}

function isEncryptedError(error: unknown): boolean {
    const name = errorName(error);
    return name === "PasswordException" || name === "EncryptedPDFException";
}

function isCorruptPdfError(error: unknown): boolean {
    const name = errorName(error);
    return (
        name === "InvalidPDFException" ||
        name === "MissingPDFException" ||
        name === "UnexpectedResponseException" ||
        name === "AbortException"
    );
}

/**
 * Detect pdf.js failing to bring up its worker at all.
 *
 * This is the failure that makes every upload look corrupted, and it has
 * nothing to do with the upload: pdf.js rejects the loading task with a plain
 * `Error` whose only marker is this prefix, so it is matched on text. It is
 * deliberately narrow - the exact string pdf.js builds - so an unrelated parse
 * failure still maps to `CORRUPTED_PDF`.
 */
function isWorkerUnavailableError(error: unknown): boolean {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" && message.startsWith("Setting up fake worker failed");
}

/** Read the document title from the PDF info dictionary, if present. */
async function readMetadataTitle(document: PdfJsDocumentProxy): Promise<string | null> {
    try {
        const metadata = await document.getMetadata();
        const title = metadata.info?.Title;
        if (typeof title !== "string") return null;
        const cleaned = stripBulletPrefix(title);
        return cleaned.length > 0 ? cleaned : null;
    } catch {
        // Metadata is best-effort; its absence must not fail extraction.
        return null;
    }
}

/** Drop the heading line from the body when it was also used as the title. */
function removeLeadingHeading(content: string, heading: string): string {
    // Both sides are normalised before comparison: the heading only had its
    // bullet prefix stripped, so a raw comparison would miss on exotic spaces.
    const target = normalizeLine(heading);
    if (target.length === 0) return content;

    const lines = splitLines(content);
    const firstMeaningful = lines.findIndex((line) => normalizeLine(line).length > 0);
    if (firstMeaningful === -1) return content;
    if (normalizeLine(lines[firstMeaningful] ?? "") !== target) return content;

    return lines
        .filter((_, index) => index !== firstMeaningful)
        .join("\n")
        .trim();
}

/**
 * Extract a PDF into the canonical document representation.
 *
 * One section per page, page numbers preserved as 1-indexed `unitIndex`, and
 * document metadata used for the title when available.
 *
 * Every failure path leaves this function as a `DocumentProcessingError`, so a
 * half-broken PDF can never surface a raw pdf.js message to the UI.
 */
export async function extractPdfDocument(
    data: Uint8Array,
    fallbackTitle: string,
): Promise<CanonicalDocument> {
    if (data.byteLength === 0) {
        throw new DocumentProcessingError("EMPTY_FILE");
    }

    const pdfJs = await loadPdfJsOrThrow();

    // `getDocument` itself is inside the classified block: it constructs the
    // transport factory synchronously, so a misconfigured pdf.js can throw here
    // rather than by rejecting `loadingTask.promise`.
    let loadingTask: PdfJsLoadingTask;
    try {
        loadingTask = pdfJs.getDocument({
            data,
            // Never allow pdf.js to evaluate embedded JavaScript.
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            standardFontDataUrl: getStandardFontDataUrl(),
        });
    } catch (error) {
        throw toPdfError(error);
    }

    let document: PdfJsDocumentProxy;
    try {
        document = await loadingTask.promise;
    } catch (error) {
        await loadingTask.destroy().catch(() => undefined);
        throw toPdfError(error);
    }

    try {
        if (document.numPages > MAX_DOCUMENT_UNITS) {
            throw new DocumentProcessingError("TOO_MANY_UNITS");
        }

        const metadataTitle = await readMetadataTitle(document);
        const firstPageHeading = await collectSections(document);
        const sections = firstPageHeading.sections;

        if (sections.length === 0) {
            throw new DocumentProcessingError("NO_EXTRACTABLE_TEXT");
        }

        return buildCanonicalDocument({
            sourceType: "pdf",
            title: deriveTitle([metadataTitle, firstPageHeading.heading], fallbackTitle),
            sections,
            unitNoun: "page",
        });
    } catch (error) {
        // `getPage` and `getTextContent` can throw on a PDF whose header and
        // cross-reference table are valid but whose page objects are not.
        throw toPdfError(error);
    } finally {
        // Releases the pdf.js worker and its in-memory page caches.
        await loadingTask.destroy().catch(() => undefined);
    }
}

/** Map an arbitrary pdf.js failure onto a safe, typed document error. */
function toPdfError(error: unknown): DocumentProcessingError {
    if (error instanceof DocumentProcessingError) return error;
    if (isWorkerUnavailableError(error)) {
        return new DocumentProcessingError("PARSER_UNAVAILABLE", undefined, { cause: error });
    }
    if (isEncryptedError(error)) {
        return new DocumentProcessingError("ENCRYPTED_PDF", undefined, { cause: error });
    }
    if (isCorruptPdfError(error)) {
        return new DocumentProcessingError("CORRUPTED_PDF", undefined, { cause: error });
    }
    return toDocumentProcessingError(error, "CORRUPTED_PDF");
}

interface PdfSections {
    sections: CanonicalDocumentSection[];
    /** First heading seen on page 1, used only if metadata has no title. */
    heading: string | undefined;
}

/**
 * Walk every page, keeping page numbers and the first heading on page 1.
 *
 * Pages without extractable text (scans, blank separators) are dropped rather
 * than emitted as empty sections, so `unitIndex` keeps the real page number.
 */
async function collectSections(document: PdfJsDocumentProxy): Promise<PdfSections> {
    const sections: CanonicalDocumentSection[] = [];
    const budget = new ExtractionBudget();
    let firstHeading: string | undefined;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        budget.startUnit();
        const page = await document.getPage(pageNumber);
        const { text, headings } = await extractPage(page, budget);

        if (text.trim().length === 0) continue;

        const heading = headings[0];
        if (pageNumber === 1 && heading) firstHeading = heading;

        const content = heading ? removeLeadingHeading(text, heading) : text;
        const section: CanonicalDocumentSection = {
            unitIndex: pageNumber,
            content: content.length > 0 ? content : text,
        };
        if (heading) section.title = heading;
        sections.push(section);
    }

    return { sections, heading: firstHeading };
}
