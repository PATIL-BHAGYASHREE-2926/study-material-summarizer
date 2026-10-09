import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

import {
    MAX_DECOMPRESSED_PACKAGE_BYTES,
    MAX_DOCUMENT_UNITS,
    MAX_ENTITY_COUNT,
    MAX_ENTITY_DEPTH,
    MAX_ENTITY_SIZE,
    MAX_EXPANDED_LENGTH,
    MAX_EXTRACTED_TEXT_CHARS,
    MAX_PACKAGE_ENTRIES,
    MAX_PART_BYTES,
    MAX_RELATIONSHIPS_PER_PART,
    MAX_TOTAL_EXPANSIONS,
    MAX_UNIT_TEXT_CHARS,
    MAX_XML_NODE_COUNT,
} from "@/lib/constants/limits";
import type {
    CanonicalDocument,
    CanonicalDocumentSection,
} from "@/types/canonical-document";

import { buildCanonicalDocument } from "./canonical";
import {
    DocumentProcessingError,
    toDocumentProcessingError,
    type DocumentErrorCode,
} from "./errors";
import {
    deriveTitle,
    normalizeContentBlock,
    normalizeLine,
    stripBulletPrefix,
} from "./normalize";

/**
 * PPTX is an OpenXML package, so extraction reads the XML parts directly.
 *
 * Namespace prefixes are kept on *elements* (they disambiguate `p:sp` from
 * `a:sp`) and stripped when matching element names, but attributes keep their
 * prefixes because `p:sldId/@id` and `@r:id` are different attributes and
 * collapsing them loses the relationship reference.
 */
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: false,
    // Element text must stay a string: `<a:t>95</a:t>` is a cell value, not a
    // number, and coercing it would drop the text on the floor.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => NAME_TO_ALWAYS_ARRAY.has(localName(name)),
    /**
     * Entity processing is required - slide text legitimately contains
     * `&amp;` and `&lt;` - so expansion is bounded instead of disabled.
     *
     * Without these caps an internal DTD subset is a billion-laughs bomb:
     * `&lol9;` can expand to gigabytes from a few hundred bytes of markup. The
     * limits apply to the expanded result, which is what actually costs memory.
     *
     * Every value is passed explicitly, including `maxExpansionDepth`. The
     * library's default for that one has varied across 5.x releases, and the
     * recursive case - a chain of entities each referencing the previous - is
     * the one the size caps alone do not bound directly.
     */
    processEntities: {
        enabled: true,
        maxEntitySize: MAX_ENTITY_SIZE,
        maxTotalExpansions: MAX_TOTAL_EXPANSIONS,
        maxExpandedLength: MAX_EXPANDED_LENGTH,
        maxEntityCount: MAX_ENTITY_COUNT,
        maxExpansionDepth: MAX_ENTITY_DEPTH,
    },
});

/** Elements that can legally repeat and must never be collapsed to one value. */
const NAME_TO_ALWAYS_ARRAY = new Set([
    "Relationship",
    "sldId",
    "sp",
    "graphicFrame",
    "pic",
    "tbl",
    "tr",
    "tc",
    "p",
    "r",
    "br",
    "fld",
    "t",
]);

const CONTENT_TYPES_PART = "[Content_Types].xml";
const PRESENTATION_PART = "ppt/presentation.xml";
const PRESENTATION_RELS_PART = "ppt/_rels/presentation.xml.rels";

/** Group shapes nest a few levels deep; beyond this a tree is not a real slide. */
const MAX_SHAPE_DEPTH = 8;

const NOTES_RELATIONSHIP_TYPE = "notesSlide";
const SLIDE_RELATIONSHIP_TYPE = "slide";
const CORE_PROPERTIES_PART = "docProps/core.xml";

/** Page furniture placeholders: metadata, never study content. */
const NOTES_PLACEHOLDER_TYPES = new Set(["sldNum", "hdr", "ftr", "dt"]);
const TITLE_PLACEHOLDER_TYPES = new Set(["title", "ctrTitle"]);

/** Placeholders excluded from a slide's body because they are handled elsewhere. */
const SKIPPED_SLIDE_PLACEHOLDERS = new Set([
    ...NOTES_PLACEHOLDER_TYPES,
    ...TITLE_PLACEHOLDER_TYPES,
]);

/** Strip a namespace prefix from an element name (`p:sld` -> `sld`). */
function localName(name: string): string {
    const colon = name.indexOf(":");
    return colon === -1 ? name : name.slice(colon + 1);
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * Read an attribute by name, falling back to a namespace-agnostic match so
 * callers do not need to know which namespace declared it.
 *
 * An exact match always wins, which is what keeps `p:sldId/@id` from being
 * shadowed by `@r:id` when the caller asks for `"r:id"` explicitly.
 */
function attr(node: unknown, name: string): string | undefined {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;

    let value = record[`@_${name}`];
    if (value === undefined && !name.includes(":")) {
        const key = Object.keys(record).find(
            (candidate) =>
                candidate.startsWith("@_") && localName(candidate.slice(2)) === name,
        );
        if (key !== undefined) value = record[key];
    }

    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    return undefined;
}

/**
 * Read a child element by local name, ignoring its namespace prefix.
 *
 * An exact match wins so a prefixed sibling (e.g. `a:tbl` vs `p:tbl`) is never
 * shadowed by the wrong namespace.
 */
function child(node: unknown, name: string): unknown {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;

    if (name in record) return record[name];

    const key = Object.keys(record).find((candidate) => localName(candidate) === name);
    return key === undefined ? undefined : record[key];
}

/**
 * Resolve an OpenXML relationship target against the part that declared it.
 *
 * Targets are relative (`slides/slide1.xml`, `../notesSlides/notesSlide1.xml`)
 * and may contain traversal segments, so they are normalised rather than
 * concatenated. A leading `/` marks a package-absolute target. Traversal can
 * never escape the package root: popping an empty segment is a no-op.
 */
export function resolvePartPath(sourcePart: string, target: string): string {
    const normalized = target.replace(/\\/g, "/");
    if (normalized.startsWith("/")) return normalized.replace(/^\/+/, "");

    const baseSegments = sourcePart.split("/").slice(0, -1);
    for (const segment of normalized.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") baseSegments.pop();
        else baseSegments.push(segment);
    }
    return baseSegments.join("/");
}

/**
 * Uncompressed size declared by the archive's central directory.
 *
 * JSZip stores this on the entry's internal `_data` record rather than on the
 * entry itself, so it is read defensively: a missing value means "unknown",
 * which is treated as within budget rather than as grounds to reject a file.
 */
function declaredUncompressedSize(entry: JSZip.JSZipObject): number {
    const entryRecord = entry as unknown as {
        uncompressedSize?: unknown;
        _data?: { uncompressedSize?: unknown };
    };

    const size = entryRecord.uncompressedSize ?? entryRecord._data?.uncompressedSize;
    return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Reject packages whose central directory is implausible before any part is
 * touched.
 *
 * Entry count is a cheap, reliable signal: a legitimate 100-slide deck lists a
 * few hundred parts, so tens of thousands of entries means either a malformed
 * file or an attempt to make the per-entry work the attack surface. Declared
 * sizes are checked only as an early hint - they are attacker controlled, so
 * the authoritative budget is enforced on the bytes decompression actually
 * produces (see `readPart`).
 */
function assertPackageManifestWithinBudget(zip: JSZip): void {
    const entries = Object.values(zip.files);
    if (entries.length > MAX_PACKAGE_ENTRIES) {
        throw new DocumentProcessingError("TOO_MANY_PACKAGE_ENTRIES");
    }

    let declaredTotal = 0;
    for (const entry of entries) {
        if (entry.dir) continue;
        declaredTotal += declaredUncompressedSize(entry);
        if (declaredTotal > MAX_DECOMPRESSED_PACKAGE_BYTES) {
            throw new DocumentProcessingError("PACKAGE_TOO_LARGE");
        }
    }
}

/**
 * Tracks the real cost of decompressing a package.
 *
 * Every byte handed back to the caller is counted here, so the budget is
 * enforced on output that actually exists rather than on metadata the archive
 * claims. A crafted file can declare anything it likes in its central
 * directory, including a compressed size of 4 bytes for a 4 GB part.
 */
class DecompressionBudget {
    private spent = 0;

    /** Reserve `bytes` of decompressed output, failing if the package is over. */
    charge(bytes: number): void {
        this.spent += bytes;
        if (this.spent > MAX_DECOMPRESSED_PACKAGE_BYTES) {
            this.spent = 0;
            throw new DocumentProcessingError("PACKAGE_TOO_LARGE");
        }
    }
}

/**
 * Decompress one package part, charging the budget for the bytes it yields.
 *
 * Streaming through `internalStream` is what makes the limit real: chunks are
 * counted as they arrive and the stream is paused the moment the part or the
 * package exceeds its budget, so an oversized part is never fully materialised
 * in memory.
 */
async function readPart(
    entry: JSZip.JSZipObject,
    budget: DecompressionBudget,
): Promise<Uint8Array> {
    // `internalStream` is the streaming API behind `async()`, and unlike
    // `async()` it lets the caller inspect each chunk before it is buffered.
    // JSZip's own types omit it, so the shape is declared locally.
    const streamable = entry as unknown as {
        internalStream(type: "uint8array"): {
            on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
            on(event: "error", listener: (error: unknown) => void): unknown;
            on(event: "end", listener: () => void): unknown;
            pause(): void;
            resume(): void;
        };
    };

    return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let received = 0;
        let settled = false;

        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            // Dropping the accumulated chunks releases the partial payload even
            // though the stream may emit a late "end" before it stops.
            chunks.length = 0;
            reject(toDocumentProcessingError(error, "CORRUPTED_PPTX"));
        };

        const helper = streamable.internalStream("uint8array");

        helper.on("data", (chunk: Uint8Array) => {
            if (settled) return;
            received += chunk.byteLength;

            try {
                if (received > MAX_PART_BYTES) {
                    throw new DocumentProcessingError("PACKAGE_TOO_LARGE");
                }
                budget.charge(chunk.byteLength);
            } catch (error) {
                // Pause rather than drain: the point is to stop spending memory
                // on a part that has already blown its budget.
                helper.pause();
                fail(error);
                return;
            }

            chunks.push(chunk);
        });

        helper.on("error", fail);

        helper.on("end", () => {
            if (settled) return;
            settled = true;

            const total = new Uint8Array(received);
            let offset = 0;
            for (const chunk of chunks) {
                total.set(chunk, offset);
                offset += chunk.byteLength;
            }
            resolve(total);
        });

        helper.resume();
    });
}

async function readXml(
    zip: JSZip,
    path: string,
    budget: DecompressionBudget,
): Promise<string | null> {
    const entry = zip.file(path);
    if (!entry) return null;

    // Cheap pre-filter only. A lying central directory cannot get past
    // `readPart`, which charges the real decompressed size.
    if (declaredUncompressedSize(entry) > MAX_PART_BYTES) {
        throw new DocumentProcessingError("PACKAGE_TOO_LARGE");
    }

    const bytes = await readPart(entry, budget);
    return new TextDecoder("utf-8").decode(bytes);
}

/** Parse a part, converting parser failures into safe, typed errors. */
function parseXml(xml: string, fallbackCode: DocumentErrorCode): unknown {
    try {
        return xmlParser.parse(xml);
    } catch (error) {
        throw toDocumentProcessingError(error, fallbackCode);
    }
}

async function requireXml(
    zip: JSZip,
    path: string,
    budget: DecompressionBudget,
): Promise<string> {
    const xml = await readXml(zip, path, budget);
    if (xml === null) {
        throw new DocumentProcessingError("INVALID_PPTX_STRUCTURE");
    }
    return xml;
}

/** Map relationship ids to their resolved target paths within the package. */
function readRelationships(
    xml: string | null,
    sourcePart: string,
    typeFilter?: string,
): Map<string, string> {
    const map = new Map<string, string>();
    if (!xml) return map;

    const parsed = parseXml(xml, "CORRUPTED_PPTX") as Record<string, unknown>;
    const container = asArray(child(child(parsed, "Relationships"), "Relationship"));

    for (const relationship of container) {
        // A relationship list is attacker controlled and is walked once per
        // referenced part, so an unbounded one turns into quadratic work.
        if (map.size >= MAX_RELATIONSHIPS_PER_PART) {
            throw new DocumentProcessingError("INVALID_PPTX_STRUCTURE");
        }

        const id = attr(relationship, "Id");
        const target = attr(relationship, "Target");
        const type = attr(relationship, "Type") ?? "";
        if (!id || !target) continue;
        if (typeFilter && !type.endsWith(`/${typeFilter}`)) continue;
        map.set(id, resolvePartPath(sourcePart, target));
    }
    return map;
}

/**
 * Read the text of a run (`a:r`) or field (`a:fld`).
 *
 * Handles both the single-object and array forms so it stays correct whether or
 * not the parser was configured to force repeated elements into arrays.
 */
function readRunText(node: unknown): string {
    let text = "";

    const visit = (value: unknown) => {
        if (typeof value === "string") {
            text += value;
            return;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            // Element text that looks like a scalar still has to survive.
            text += String(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value) visit(entry);
            return;
        }
        if (typeof value !== "object" || value === null) return;

        const record = value as Record<string, unknown>;

        // `a:t` carrying an attribute (e.g. `xml:space="preserve"`) parses to an
        // object whose text lives under `#text`.
        if ("#text" in record) {
            visit(record["#text"]);
            return;
        }

        for (const [key, entry] of Object.entries(record)) {
            if (localName(key) !== "t") continue;
            visit(entry);
        }
    };

    visit(node);
    return text;
}

/**
 * Read a `a:txBody` / `p:txBody` into lines, keeping bullet hierarchy.
 *
 * Indent level comes from `a:pPr/@lvl` (0-indexed, default 0) and bullets are
 * stripped, because the hierarchy is expressed structurally here rather than
 * left as literal glyphs in the text.
 */
function readTextBody(txBody: unknown, budget: TextExtractionBudget): string[] {
    if (txBody === undefined || txBody === null) return [];

    const paragraphs = asArray(child(txBody, "p"));
    const lines: string[] = [];

    for (const paragraph of paragraphs) {
        const rawParts: string[] = [];

        // A paragraph holds several sibling nodes in sequence: `a:pPr` first,
        // then one or more `a:r` runs, `a:br` breaks and `a:fld` fields. All
        // of them must be walked in document order.
        for (const node of asArray(paragraph)) {
            if (typeof node !== "object" || node === null) continue;
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                const name = localName(key);

                if (name === "pPr" || name === "endParaRPr") continue;
                if (name === "r") {
                    const runText = readRunText(value);
                    // Charged as runs are read, so a single paragraph with
                    // megabytes of runs stops here rather than after being
                    // concatenated into `rawParts`.
                    budget.charge(runText.length);
                    rawParts.push(runText);
                    continue;
                }
                if (name === "br") {
                    rawParts.push("\n");
                    continue;
                }
                if (name === "fld") {
                    // Slide-number and date fields render as noise in the prompt.
                    rawParts.push("");
                }
            }
        }

        const levelRaw = attr(child(paragraph, "pPr"), "lvl");
        const level = Math.min(
            Math.max(Number.parseInt(levelRaw ?? "0", 10) || 0, 0),
            4,
        );

        for (const line of rawParts.join("").split("\n")) {
            const text = stripBulletPrefix(line);
            if (text.length === 0) continue;
            lines.push(`${"  ".repeat(level)}${text}`);
        }
    }

    return lines;
}

/**
 * Find the first table anywhere inside a shape.
 *
 * A table lives at `p:graphicFrame/a:graphic/a:graphicData/a:tbl`, several
 * levels below the frame itself, and may sit inside group shapes too, so the
 * whole subtree is searched. The search stops at the first match so nested
 * tables cannot cause the outer one to be missed.
 */
function findTable(node: unknown, depth = 0, state = { visited: 0 }): unknown {
    if (node === null || node === undefined || depth > MAX_SHAPE_DEPTH) return undefined;

    // The depth cap alone does not bound a wide tree: a flat run of thousands
    // of sibling shapes is a legitimate slide, but an attacker-authored one
    // would make this full-subtree search quadratic. The visit budget keeps the
    // worst case linear in the number of nodes actually examined.
    if (++state.visited > MAX_XML_NODE_COUNT) {
        throw new DocumentProcessingError("PACKAGE_TOO_LARGE");
    }

    if (Array.isArray(node)) {
        for (const entry of node) {
            const found = findTable(entry, depth + 1, state);
            if (found !== undefined) return found;
        }
        return undefined;
    }

    if (typeof node !== "object") return undefined;

    const table = child(node, "tbl");
    if (table !== undefined) return table;

    for (const value of Object.values(node as Record<string, unknown>)) {
        const found = findTable(value, depth + 1, state);
        if (found !== undefined) return found;
    }
    return undefined;
}

/** Render a table as a pipe-delimited grid so its structure survives. */
function readTable(shape: unknown, budget: TextExtractionBudget): string[] {
    const table = asArray(findTable(shape))[0];
    if (table === undefined) return [];

    const rows = asArray(child(table, "tr"));
    const lines: string[] = [];

    for (const row of rows) {
        const cells = asArray(child(row, "tc")).map((cell) => {
            const text = readTextBody(child(cell, "txBody"), budget)
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .join(" ");
            return text.replace(/\|/g, "\\|") || " ";
        });
        if (cells.length > 0) lines.push(`| ${cells.join(" | ")} |`);
    }

    return lines.length > 0 ? ["Table:", ...lines] : [];
}

/**
 * Extract the slide title from a title placeholder.
 *
 * Only a real title placeholder (`title` / `ctrTitle`) counts. Guessing the
 * title from a body shape's first line would either mislabel a content slide
 * or silently drop that line from the content, so no guess is made.
 */
function pickSlideTitle(
    shapes: Array<Record<string, unknown>>,
    titleBudget: TextExtractionBudget,
): string | undefined {
    for (const shape of shapes) {
        const placeholderType = placeholderTypeOf(shape);
        if (!placeholderType || !TITLE_PLACEHOLDER_TYPES.has(placeholderType)) continue;

        const lines = readTextBody(child(shape, "txBody"), titleBudget)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (lines.length === 0) continue;

        // A title placeholder can hold several lines; join them into one phrase.
        const title = normalizeLine(lines.join(" "));
        if (title.length > 0) return title;
    }

    return undefined;
}

/** Read the placeholder type of a shape, if it declares one. */
function placeholderTypeOf(shape: Record<string, unknown>): string | undefined {
    return attr(child(child(child(shape, "nvSpPr"), "nvPr"), "ph"), "type");
}

/** True when the shape carries only a picture (`p:pic`), not extractable text. */
function isPicture(shape: Record<string, unknown>): boolean {
    return Object.keys(shape).some((key) => localName(key) === "pic");
}

/**
 * Collect every leaf shape of a slide or notes tree.
 *
 * Group shapes (`p:grpSp`) nest further shapes, and decks built from grouped
 * text boxes are common, so the whole tree is flattened - otherwise every text
 * box inside a group would silently contribute nothing.
 */
function collectShapes(shapeTree: unknown, depth = 0): Array<Record<string, unknown>> {
    if (shapeTree === null || shapeTree === undefined || depth > MAX_SHAPE_DEPTH) return [];

    const children = [
        ...asArray(child(shapeTree, "sp")),
        ...asArray(child(shapeTree, "graphicFrame")),
    ];
    const groups = asArray(child(shapeTree, "grpSp"));

    const collected: Array<Record<string, unknown>> = [];
    for (const group of groups) {
        collected.push(...collectShapes(group, depth + 1));
    }
    for (const child_ of children) {
        collected.push(child_ as Record<string, unknown>);
    }

    return collected;
}

/** Extract the body content of a slide, excluding its title and decorative shapes. */
function readSlideBody(
    shapes: Array<Record<string, unknown>>,
    budget: TextExtractionBudget,
): string {
    const lines: string[] = [];

    for (const shape of shapes) {
        const placeholderType = placeholderTypeOf(shape);

        // Titles are captured separately; slide furniture (number, header,
        // footer, date) and pictures carry no study content.
        if (placeholderType && SKIPPED_SLIDE_PLACEHOLDERS.has(placeholderType)) continue;
        if (isPicture(shape)) continue;

        lines.push(...readTable(shape, budget));
        lines.push(...readTextBody(child(shape, "txBody"), budget));
    }

    return normalizeContentBlock(lines);
}

/** Read speaker notes, ignoring the slide-image and slide-number placeholders. */
function readSpeakerNotes(
    notesXml: string,
    budget: TextExtractionBudget,
): string | undefined {
    const parsed = parseXml(notesXml, "CORRUPTED_PPTX") as Record<string, unknown>;
    const root = child(parsed, "notes") ?? parsed;
    const shapeTree = child(child(root, "cSld"), "spTree");
    if (shapeTree === undefined) return undefined;

    const lines: string[] = [];
    for (const shape of collectShapes(shapeTree)) {
        const placeholderType = placeholderTypeOf(shape);
        // Notes text lives in the `body` placeholder; `sldImg` is the slide
        // image and the rest is page furniture.
        if (placeholderType && NOTES_PLACEHOLDER_TYPES.has(placeholderType)) continue;
        if (placeholderType === "sldImg") continue;
        if (isPicture(shape)) continue;

        lines.push(...readTable(shape, budget));
        lines.push(...readTextBody(child(shape, "txBody"), budget));
    }

    const notes = normalizeContentBlock(lines);
    return notes.length > 0 ? notes : undefined;
}

/** Ordered slide parts, taken from `p:sldIdLst` so numbering is author-defined. */
function readSlideOrder(presentationXml: string, relsXml: string | null): string[] {
    const presentation = parseXml(presentationXml, "CORRUPTED_PPTX") as Record<string, unknown>;
    const slideIdList = child(child(presentation, "presentation"), "sldIdLst");
    const ids = asArray(child(slideIdList, "sldId"));
    const relationships = readRelationships(relsXml, PRESENTATION_PART, SLIDE_RELATIONSHIP_TYPE);

    const ordered: string[] = [];
    for (const id of ids) {
        // `p:sldId` carries both `@id` (the slide number) and `@r:id` (the
        // relationship), so the namespaced attribute must be requested.
        const relationshipId = attr(id, "r:id");
        const target = relationshipId ? relationships.get(relationshipId) : undefined;
        if (target) ordered.push(target);
    }
    return ordered;
}

/**
 * Extract a PPTX presentation into the canonical document representation.
 *
 * One section per slide in presentation order, slide numbers preserved as
 * 1-indexed `unitIndex`, with speaker notes attached when present.
 *
 * Every failure path leaves this function as a `DocumentProcessingError` so the
 * UI never sees a raw JSZip or XML-parser message.
 */
export async function extractPptxDocument(
    data: Uint8Array,
    fallbackTitle: string,
): Promise<CanonicalDocument> {
    if (data.byteLength === 0) {
        throw new DocumentProcessingError("EMPTY_FILE");
    }

    try {
        return await readPresentation(data, fallbackTitle);
    } catch (error) {
        throw toDocumentProcessingError(error, "CORRUPTED_PPTX");
    }
}

async function readPresentation(
    data: Uint8Array,
    fallbackTitle: string,
): Promise<CanonicalDocument> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(data);
    } catch (error) {
        throw toDocumentProcessingError(error, "CORRUPTED_PPTX");
    }

    // The manifest is bounded before a single byte is decompressed; the real
    // byte budget is then enforced per part by `readPart`.
    assertPackageManifestWithinBudget(zip);

    // A .pptx must be an OpenXML package, not merely a ZIP file.
    if (!zip.file(CONTENT_TYPES_PART) || !zip.file(PRESENTATION_PART)) {
        throw new DocumentProcessingError("INVALID_PPTX_STRUCTURE");
    }

    const budget = new DecompressionBudget();

    const presentationXml = await requireXml(zip, PRESENTATION_PART, budget);
    const presentationRelsXml = await readXml(zip, PRESENTATION_RELS_PART, budget);
    const slideParts = readSlideOrder(presentationXml, presentationRelsXml);

    if (slideParts.length === 0) {
        throw new DocumentProcessingError("NO_EXTRACTABLE_SLIDES");
    }
    if (slideParts.length > MAX_DOCUMENT_UNITS) {
        throw new DocumentProcessingError("TOO_MANY_UNITS");
    }

    const sections: CanonicalDocumentSection[] = [];
    const textBudget = new TextExtractionBudget();

    for (let index = 0; index < slideParts.length; index += 1) {
        const slidePart = slideParts[index] as string;
        const slideXml = await readXml(zip, slidePart, budget);
        if (!slideXml) continue;

        textBudget.startUnit();
        const parsed = parseXml(slideXml, "CORRUPTED_PPTX") as Record<string, unknown>;
        const shapeTree = child(child(child(parsed, "sld"), "cSld"), "spTree");
        const shapes = collectShapes(shapeTree);

        const title = pickSlideTitle(shapes, textBudget);
        const content = readSlideBody(shapes, textBudget);
        if (content.length === 0 && !title) continue;

        const section: CanonicalDocumentSection = {
            unitIndex: index + 1,
            content: content.length > 0 ? content : (title ?? ""),
        };
        if (title) section.title = title;

        const notes = await readSlideNotesFor(zip, slidePart, budget, textBudget);
        if (notes) section.notes = notes;

        sections.push(section);
    }

    if (sections.length === 0) {
        throw new DocumentProcessingError("NO_EXTRACTABLE_SLIDES");
    }

    return buildCanonicalDocument({
        sourceType: "pptx",
        title: deriveTitle(
            [await readCoreTitle(zip, budget), sections[0]?.title],
            fallbackTitle,
        ),
        sections,
        unitNoun: "slide",
    });
}

/**
 * Running ceilings on slide text.
 *
 * Mirrors the PDF budget: a slide whose runs expand to far more text than the
 * app can ever use is rejected while it is being read, not after the whole
 * deck has been assembled.
 */
class TextExtractionBudget {
    private unitChars = 0;
    private totalChars = 0;

    startUnit(): void {
        this.unitChars = 0;
    }

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
}

/** Build the `_rels` path that belongs to a package part. */
function relsPathFor(partPath: string): string {
    const lastSlash = partPath.lastIndexOf("/");
    if (lastSlash === -1) return `_rels/${partPath}.rels`;
    return `${partPath.slice(0, lastSlash)}/_rels/${partPath.slice(lastSlash + 1)}.rels`;
}

/** Resolve and read the notes part referenced by a slide's relationships. */
async function readSlideNotesFor(
    zip: JSZip,
    slidePart: string,
    budget: DecompressionBudget,
    textBudget: TextExtractionBudget,
): Promise<string | undefined> {
    const relsXml = await readXml(zip, relsPathFor(slidePart), budget);
    if (!relsXml) return undefined;

    const notesPart = readRelationships(relsXml, slidePart, NOTES_RELATIONSHIP_TYPE);
    for (const path of notesPart.values()) {
        const notesXml = await readXml(zip, path, budget);
        if (!notesXml) continue;
        const notes = readSpeakerNotes(notesXml, textBudget);
        if (notes) return notes;
    }
    return undefined;
}

/**
 * Read `docProps/core.xml` title metadata when the package provides it.
 *
 * `dc:title` is an element, not an attribute, so it is read as a child node.
 */
async function readCoreTitle(
    zip: JSZip,
    budget: DecompressionBudget,
): Promise<string | null> {
    const coreXml = await readXml(zip, CORE_PROPERTIES_PART, budget);
    if (!coreXml) return null;
    try {
        const parsed = parseXml(coreXml, "CORRUPTED_PPTX") as Record<string, unknown>;
        const properties = child(parsed, "coreProperties");
        const title = child(properties, "title");
        const text = normalizeLine(typeof title === "string" ? title : "");
        return text.length > 0 ? stripBulletPrefix(text) : null;
    } catch {
        // Metadata is best-effort; its absence must not fail extraction.
        return null;
    }
}
