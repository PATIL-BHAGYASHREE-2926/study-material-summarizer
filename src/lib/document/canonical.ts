import {
    MAX_AGGREGATED_TEXT_CHARS,
    type SupportedSourceType,
} from "@/lib/constants/limits";
import type {
    CanonicalDocument,
    CanonicalDocumentInput,
    CanonicalDocumentSection,
} from "@/types/canonical-document";

import { DocumentProcessingError } from "./errors";
import {
    countWords,
    escapeStructuralMarkers,
    isBlankText,
    normalizeContentBlock,
    normalizeLine,
    splitLines,
} from "./normalize";

/**
 * Cap a single section so one pathological page cannot consume the whole
 * prompt budget and starve later sections.
 */
const MAX_SECTION_CHARS = 12_000;
const MAX_TITLE_CHARS = 200;
const AGGREGATED_TRUNCATION_NOTICE =
    "\n\n[Content truncated: the document exceeded the maximum text length supported by this app.]";

export interface BuildCanonicalDocumentOptions {
    sourceType: SupportedSourceType;
    title: string;
    sections: CanonicalDocumentSection[];
    /**
     * Marker used in the aggregated text so the LLM can still attribute content
     * to its originating page or slide.
     */
    unitNoun?: "page" | "slide";
}

/**
 * Serialise sections into the single prompt-ready blob.
 *
 * The unit marker is what lets the model cite "page 4" or "slide 7" later, so
 * it is part of the aggregated text rather than thrown away.
 */
export function buildAggregatedText(
    sections: CanonicalDocumentSection[],
    unitNoun: "page" | "slide" = "page",
): string {
    const blocks: string[] = [];
    for (const section of sections) {
        // Section titles are single-line by construction (`normalizeLine`
        // flattens newlines), so they cannot open a line of their own.
        const title = section.title ? escapeStructuralMarkers(section.title) : "";
        const header = title
            ? `## ${unitNoun} ${section.unitIndex}: ${title}`
            : `## ${unitNoun} ${section.unitIndex}`;

        // Body text and notes are attacker controlled and are the only fields
        // that can contain newlines, so they are escaped here: unescaped, a
        // document could forge its own `## page 4` header and the model would
        // treat the following text as a real section.
        const parts = [header, escapeStructuralMarkers(section.content)];
        if (section.notes && section.notes.length > 0) {
            parts.push(`Speaker notes: ${escapeStructuralMarkers(section.notes)}`);
        }
        blocks.push(parts.filter((part) => part.length > 0).join("\n"));
    }
    return blocks.join("\n\n");
}

/** Truncate a section body so one page cannot consume the whole prompt budget. */
function capLength(value: string): string {
    return value.length > MAX_SECTION_CHARS
        ? `${value.slice(0, MAX_SECTION_CHARS)} ...`
        : value;
}

/** Truncate a display title. */
function capTitle(value: string): string {
    return value.length > MAX_TITLE_CHARS
        ? `${value.slice(0, MAX_TITLE_CHARS - 3)}...`
        : value;
}

/**
 * Drop unusable sections and enforce the invariants the downstream Gemini and
 * UI stages rely on.
 */
function sanitizeSections(
    sections: CanonicalDocumentSection[],
): CanonicalDocumentSection[] {
    const seen = new Set<number>();
    const result: CanonicalDocumentSection[] = [];

    for (const section of sections) {
        if (!Number.isInteger(section.unitIndex) || section.unitIndex < 1) continue;
        if (seen.has(section.unitIndex)) continue;

        // Content is multi-line (one paragraph or bullet per line), so line
        // structure is preserved rather than flattened.
        const content = normalizeContentBlock(splitLines(section.content ?? ""));
        if (isBlankText(content)) continue;

        seen.add(section.unitIndex);

        const title = section.title ? normalizeLine(section.title) : "";
        const notes = section.notes
            ? normalizeContentBlock(splitLines(section.notes))
            : "";

        const sanitized: CanonicalDocumentSection = {
            unitIndex: section.unitIndex,
            content: capLength(content),
        };
        if (title.length > 0) sanitized.title = capTitle(title);
        if (!isBlankText(notes)) sanitized.notes = capLength(notes);
        result.push(sanitized);
    }

    return result.sort((a, b) => a.unitIndex - b.unitIndex);
}

/**
 * Convergence point for both extractors.
 *
 * Guarantees a `CanonicalDocument` that has: at least one usable section, a
 * non-empty title, `totalUnits` equal to the number of retained sections, a
 * word count, and aggregated text within the prompt budget.
 */
export function buildCanonicalDocument(
    options: BuildCanonicalDocumentOptions,
): CanonicalDocument {
    const sections = sanitizeSections(options.sections);
    if (sections.length === 0) {
        // Both extractors reach this point when their sections normalise away to
        // nothing, so the code must match the format the user actually uploaded.
        throw new DocumentProcessingError(
            options.sourceType === "pptx"
                ? "NO_EXTRACTABLE_SLIDES"
                : "NO_EXTRACTABLE_TEXT",
        );
    }

    const title = normalizeLine(options.title);
    const totalWords = sections.reduce(
        (sum, section) =>
            sum +
            countWords(section.content) +
            countWords(section.notes ?? "") +
            countWords(section.title ?? ""),
        0,
    );

    const unitNoun = options.unitNoun ?? (options.sourceType === "pptx" ? "slide" : "page");
    const aggregatedText = truncateAggregatedText(
        buildAggregatedText(sections, unitNoun),
    );

    const input: CanonicalDocumentInput = {
        metadata: {
            title: capTitle(title.length > 0 ? title : "Untitled document"),
            sourceType: options.sourceType,
            totalUnits: sections.length,
            totalWords,
        },
        sections,
    };

    return { ...input, aggregatedText };
}

function truncateAggregatedText(text: string): string {
    if (text.length <= MAX_AGGREGATED_TEXT_CHARS) return text;
    return `${text.slice(0, MAX_AGGREGATED_TEXT_CHARS)}${AGGREGATED_TRUNCATION_NOTICE}`;
}
