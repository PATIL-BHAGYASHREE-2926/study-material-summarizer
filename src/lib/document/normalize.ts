/**
 * Text normalisation shared by every extractor.
 *
 * Extractors work on wildly different inputs (PDF text runs, PowerPoint XML
 * text nodes). Normalisation happens here once so both converge on identical
 * output shape before the canonical document is assembled.
 */

/** Unicode spaces that should collapse to an ASCII space. */
const EXOTIC_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** Zero-width and bidirectional control characters, plus other invisible junk. */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * Unicode tag characters (U+E0000-E007F) plus unpaired surrogate halves.
 *
 * Tag characters are invisible and are used to smuggle ASCII payloads past
 * human review, while lone surrogates are an invalid encoding artefact that
 * downstream UTF-8 handling can mangle. Neither carries study content.
 */
const TAG_AND_LONE_SURROGATES =
    /[\u{E0000}-\u{E007F}\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** Unicode noncharacters, which are permanently unassigned and never content. */
const NONCHARACTERS = /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g;

/** C0/C1 control characters except tab, line feed and carriage return. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Characters commonly used to disguise prompt-injection payloads.
 *
 * Document content is untrusted, so zero-width joiners, soft hyphens and
 * variation selectors are stripped before the text ever reaches the prompt
 * builder.
 */
const INVISIBLE_MARKUP = /[\u00ad\u034f\u180e\ufe00-\ufe0f]/g;

/** Unicode sentence/list separators normalised to ASCII equivalents. */
const SENTENCE_SEPARATORS = /[\u2023\u204b\u3002\ufe52\ufe56\ufe51\u3001]/g;

/**
 * Collapse every run of horizontal whitespace to a single space and trim.
 *
 * Vertical structure (line breaks) is deliberately preserved - it carries
 * meaning for slides and headings.
 */
export function normalizeInlineText(value: string): string {
    if (typeof value !== "string") return "";

    // In invisibles come first: a zero-width or tag character wedged between a
    // base letter and a combining mark would otherwise block composition and
    // leave the text in a form that differs from what a reader sees.
    const stripped = value
        .replace(TAG_AND_LONE_SURROGATES, "")
        .replace(NONCHARACTERS, "")
        .replace(INVISIBLE_MARKUP, "")
        .replace(INVISIBLE_CHARS, "")
        .replace(CONTROL_CHARS, "");

    // NFC composes decomposed sequences into their canonical single code point,
    // so "e" + U+0301 cannot be smuggled through as a different byte sequence
    // than the "é" the UI renders.
    const composed = composeUnicode(stripped);

    return composed
        .replace(EXOTIC_SPACES, " ")
        .replace(SENTENCE_SEPARATORS, (match) => (match === "\u3001" ? "," : "."))
        .replace(/\r\n?/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Apply canonical (NFC) composition without ever failing extraction.
 *
 * `normalize` is unavailable in a few exotic runtimes and can throw on a
 * malformed sequence, and a normalisation failure must never lose the user's
 * document - the unnormalised text is still better than none.
 */
function composeUnicode(value: string): string {
    try {
        return value.normalize("NFC");
    } catch {
        return value;
    }
}

/** Longest display title the UI will render without truncating awkwardly. */
const MAX_TITLE_CHARS = 200;

/**
 * Normalise and upper bound a single logical line (a bullet or paragraph).
 */
export function normalizeLine(value: string): string {
    return normalizeInlineText(value).replace(/\n+/g, " ").trim();
}

/** True when the text has no meaningful content once normalised. */
export function isBlankText(value: string | null | undefined): boolean {
    if (!value) return true;
    return normalizeLine(value).replace(/[\s\-\u2022\u2023\u25aa\u25cf*#|>]/g, "").length === 0;
}

/**
 * Join wrapped PDF lines back into paragraphs.
 *
 * PDF extractors emit one string per positioned text run, so a single sentence
 * can arrive as several fragments. A line ending in a hyphen is a hyphenated
 * word split across lines and is rejoined without the hyphen; a line ending in
 * sentence punctuation starts a new paragraph.
 */
export function joinWrappedLines(lines: string[]): string[] {
    const paragraphs: string[] = [];
    let current = "";

    const flush = () => {
        const trimmed = current.trim();
        if (trimmed.length > 0) paragraphs.push(trimmed);
        current = "";
    };

    for (const rawLine of lines) {
        const line = normalizeLine(rawLine);
        if (line.length === 0) {
            flush();
            continue;
        }

        if (current.length === 0) {
            current = line;
            continue;
        }

        const hyphenated = /[A-Za-z\u00c0-\u024f]-$/.test(current);
        if (hyphenated) {
            current = `${current.slice(0, -1)}${line}`;
            continue;
        }

        if (/[.!?:;)\]}]$/.test(current)) {
            flush();
            current = line;
            continue;
        }

        current = `${current} ${line}`;
    }

    flush();
    return paragraphs;
}

/**
 * Turn a run of bullet-like lines into a clean, de-duplicated list.
 *
 * Bullet glyphs vary by platform (PDF encodings, PowerPoint theme fonts), so
 * every common variant is recognised and stripped.
 */
const BULLET_PREFIX =
    /^(?:[-*\u2022\u2023\u25aa\u25ab\u25cf\u25e6\u2043\u2219\u00b7\u2027\u2794\u2192]+|(?:\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)])\s+/;

/**
 * Most bullet levels stripped from one line.
 *
 * The strip is a fixpoint loop, so a line of nothing but nested bullets costs
 * one pass per level - quadratic in its own length. No real slide nests this
 * deeply (PowerPoint allows five outline levels), and the cap keeps a crafted
 * line of 60 000 bullets from spending that budget on regex passes.
 */
const MAX_BULLET_DEPTH = 8;

export function stripBulletPrefix(line: string): string {
    let value = normalizeLine(line);
    let previous: string;

    for (let depth = 0; depth < MAX_BULLET_DEPTH; depth += 1) {
        previous = value;
        value = value.replace(BULLET_PREFIX, "");
        if (value === previous) break;
    }

    return normalizeLine(value);
}

/**
 * Normalise a block of extracted content into a single string.
 *
 * Empty lines and duplicate adjacent lines (very common in PDF output where a
 * glyph is emitted twice) are removed. Leading indentation is preserved
 * because PowerPoint outline levels are encoded as leading whitespace.
 */
export function normalizeContentBlock(lines: string[]): string {
    const output: string[] = [];
    for (const rawLine of lines) {
        const indent = /^[\t ]*/.exec(rawLine)?.[0] ?? "";
        const line = normalizeInlineText(rawLine);
        if (line.length === 0) continue;
        if (output.length > 0 && output[output.length - 1] === line) continue;
        output.push(`${normalizeIndent(indent)}${line}`);
    }
    return output.join("\n");
}

/** Collapse a run of whitespace to two spaces per outline level. */
function normalizeIndent(indent: string): string {
    const width = indent.replace(/\t/g, "  ").length;
    if (width === 0) return "";
    return " ".repeat(Math.min(width, 8));
}

/**
 * Structural markers this application itself emits into the aggregated text.
 *
 * Extracted content is untrusted data, so if it could reproduce these verbatim
 * it would be able to forge page/slide boundaries, impersonate a speaker-notes
 * label, or fake the truncation notice - letting a document dictate the shape
 * of the prompt built from it.
 */
const STRUCTURAL_MARKERS = {
    /** Section header emitted by `buildAggregatedText`. */
    heading: /^(\s*)(#{1,6})(?=\s|$)/gm,
    /** Label emitted before speaker notes. */
    notesLabel: /^(\s*)Speaker notes:/gim,
    /** Notice appended when aggregated text is truncated. */
    truncation: /\[Content truncated:/g,
} as const;

/** Escape prefix that neutralises a forged marker while keeping it readable. */
const FORGERY_ESCAPE = "\\";

/**
 * Neutralise structural markers inside untrusted document text.
 *
 * Lines that would be read as a section heading, a speaker-notes label or the
 * truncation notice are escaped rather than dropped, so the reader still sees
 * the document's own text but it cannot be mistaken for structure the
 * application generated.
 */
export function escapeStructuralMarkers(value: string): string {
    if (typeof value !== "string") return "";
    return value
        // The whole run of hashes is escaped, not just the first character:
        // `\## page 99` would still read as a heading to a Markdown renderer.
        .replace(STRUCTURAL_MARKERS.heading, `$1${FORGERY_ESCAPE}$2`)
        .replace(STRUCTURAL_MARKERS.notesLabel, `$1${FORGERY_ESCAPE}Speaker notes:`)
        .replace(STRUCTURAL_MARKERS.truncation, `${FORGERY_ESCAPE}[Content truncated:`);
}

/**
 * Split a single string into logical lines, tolerating every newline flavour.
 */
export function splitLines(value: string): string[] {
    if (typeof value !== "string") return [];
    return value.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Count words the way a reader would: whitespace-delimited runs that contain
 * at least one letter, digit or CJK character.
 */
export function countWords(value: string): number {
    if (typeof value !== "string") return 0;
    const matches = value.match(/[\p{L}\p{N}]+/gu);
    return matches ? matches.length : 0;
}

/**
 * Derive a short display title from a file name or raw text.
 *
 * The result is always bounded, including the fallback, so no caller can end up
 * rendering an unbounded title.
 */
export function deriveTitle(
    candidates: Array<string | null | undefined>,
    fallback: string,
): string {
    for (const candidate of candidates) {
        const title = stripBulletPrefix(candidate ?? "").replace(/[\r\n]+/g, " ");
        if (title.length > 0) return capTitle(title);
    }
    return capTitle(fallback.trim().length > 0 ? fallback : "Untitled document");
}

/** Truncate a display title to a renderable length. */
function capTitle(title: string): string {
    return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 3)}...` : title;
}
