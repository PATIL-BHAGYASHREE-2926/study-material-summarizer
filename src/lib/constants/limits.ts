/**
 * Central configuration for supported formats and hard limits.
 *
 * Values mirror the constraints documented in `ARCHITECTURE.md` (Stage 1) and
 * `docs/rough-brief.md` (out-of-scope boundaries). Nothing else in the app is
 * allowed to hard-code these numbers.
 */

export const SUPPORTED_SOURCE_TYPES = ["pdf", "pptx"] as const;

export type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];

/** Legacy binary PowerPoint (OLE2/CFB). Detected only so it can be rejected clearly. */
export const LEGACY_PPT_SOURCE_TYPE = "ppt";

export const MIME_TYPES = {
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    legacyPpt: "application/vnd.ms-powerpoint",
} as const;

/** Browsers/OSs report generic or empty types for PPTX, so these are tolerated. */
export const GENERIC_MIME_TYPES = [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
    "",
] as const;

export const FILE_EXTENSIONS = {
    pdf: ".pdf",
    pptx: ".pptx",
    legacyPpt: ".ppt",
} as const;

/** Value for the HTML `accept` attribute on the file input. */
export const SUPPORTED_FILE_ACCEPT = `${FILE_EXTENSIONS.pdf},${FILE_EXTENSIONS.pptx}`;

/** 50 MB, per ARCHITECTURE.md Stage 1. */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Reject documents longer than 100 pages/slides, per the project brief. */
export const MAX_DOCUMENT_UNITS = 100;

/** The quiz must contain exactly this many questions. */
export const REQUIRED_QUIZ_QUESTION_COUNT = 20;

/** Every generated question must offer exactly four options. */
export const QUIZ_OPTION_COUNT = 4;

/** Guard rails on text handed to Gemini. */
export const MAX_AGGREGATED_TEXT_CHARS = 600_000;
export const MAX_MERMAID_CODE_LENGTH = 20_000;

/**
 * Ceiling on the generated study material.
 *
 * A valid response is a summary, a diagram and twenty four-option questions
 * with explanations, so the cap is sized to leave headroom above that without
 * letting a runaway generation turn one upload into an unbounded bill. It is a
 * hard stop, not a target: hitting it produces a truncated response that fails
 * schema validation and is retried once like any other invalid response.
 */
export const MAX_GEMINI_OUTPUT_TOKENS = 16_000;

/**
 * Completion budget for the Groq stage, matched to the Gemini one.
 *
 * The same reasoning applies: twenty four-option questions with explanations plus
 * a summary and a diagram is the shape that has to fit, and overspending the
 * budget is caught by Zod and retried like any other invalid response.
 *
 * Sized slightly above the Gemini figure because GPT-OSS is a reasoning model
 * and draws reasoning tokens from the same budget as the answer. The margin is
 * headroom for that overhead, not a larger intended answer.
 */
export const MAX_GROQ_OUTPUT_TOKENS = 20_000;

/**
 * Per-request timeout for the Groq client, in milliseconds.
 *
 * The SDK default is one minute. One upload can involve a large PDF parsed
 * in-process plus a reasoning model generating twenty questions, and the server
 * route allows 120 seconds, so a client that gives up at 60 turns a slow-but-
 * successful generation into a spurious timeout. Sized under the route budget so
 * the timeout is reported as a typed `AI_REQUEST_TIMEOUT` rather than surfacing
 * as an opaque platform-level failure.
 */
export const GROQ_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Maximum distinct schema field paths named in a retry prompt.
 *
 * A rejected response can fail on hundreds of paths at once. The paths themselves
 * are safe to echo (they are fixed by the schema, not by the data) but there is no
 * value in enumerating all of them, and the prompt has to stay readable.
 */
export const MAX_CORRECTION_ISSUE_PATHS = 20;

/**
 * Ceiling on the total *actually decompressed* size of an OpenXML package.
 *
 * The 50 MB upload limit only bounds the compressed input, so a small archive
 * could otherwise expand to gigabytes in memory. This is enforced against the
 * real byte count produced by decompression, never against the sizes declared
 * in the archive's central directory, because those are attacker controlled.
 */
export const MAX_DECOMPRESSED_PACKAGE_BYTES = 64 * 1024 * 1024;

/** Largest single package part that will be read into memory, post-decompression. */
export const MAX_PART_BYTES = 16 * 1024 * 1024;

/**
 * Maximum number of entries a package may declare in its central directory.
 *
 * A ZIP can list millions of empty or tiny entries in a small file; bounding
 * the count stops both the central-directory walk and the per-entry work that
 * follows it from becoming the attack surface.
 */
export const MAX_PACKAGE_ENTRIES = 4_000;

/**
 * Maximum text extracted from a single page or slide.
 *
 * Enforced *while* extracting so one pathological page fails fast instead of
 * being fully materialised and only then truncated.
 */
export const MAX_UNIT_TEXT_CHARS = 60_000;

/**
 * Maximum total text extracted from a whole document during extraction.
 *
 * Distinct from `MAX_AGGREGATED_TEXT_CHARS`, which bounds what is rendered into
 * the prompt: this one stops the extractor itself from ever buffering more than
 * this much text.
 */
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

/** Maximum XML elements/attributes a single package part may expand to. */
export const MAX_XML_NODE_COUNT = 200_000;

/**
 * Bounds on XML entity expansion, applied to untrusted OOXML.
 *
 * Entity processing cannot simply be switched off: slide text legitimately
 * contains `&amp;` and `&lt;`. Instead the *expanded result* is capped, because
 * that is what actually costs memory. Without these, an internal DTD subset is
 * a billion-laughs bomb - a few hundred bytes of markup expanding to gigabytes.
 *
 * These are all set here rather than left to `fast-xml-parser` defaults, several
 * of which are unbounded. `MAX_ENTITY_DEPTH` covers the recursive case
 * specifically: a chain of entities that each reference the previous one.
 */
export const MAX_ENTITY_SIZE = 10_000;
export const MAX_TOTAL_EXPANSIONS = 1_000;
export const MAX_EXPANDED_LENGTH = 100_000;
export const MAX_ENTITY_COUNT = 100;
export const MAX_ENTITY_DEPTH = 10;

/** Maximum relationships accepted from one `_rels` part. */
export const MAX_RELATIONSHIPS_PER_PART = 2_000;

/**
 * Mermaid diagram declarations this app will render.
 *
 * A closed allowlist rather than a denylist of bad constructs: Mermaid's grammar
 * keeps gaining new diagram types over time, and several of them (for example the
 * `html`-embedding and frontmatter-adjacent syntaxes) carry markup, template or
 * raw-HTML handling that this app does not want to reason about. An unknown
 * declaration is rejected and, after one regeneration attempt, replaced by the
 * safe fallback diagram.
 */
export const ALLOWED_MERMAID_DIAGRAMS = [
    "flowchart",
    "graph",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "stateDiagram-v2",
    "mindmap",
    "erDiagram",
    "journey",
    "gantt",
    "pie",
    "quadrantChart",
    "requirementDiagram",
    "timeline",
    "gitGraph",
    "C4Context",
] as const;

/**
 * Total attempts to obtain a valid diagram from the AI stage, not retries.
 *
 * One regeneration is the whole budget, per the Mermaid requirements: a model
 * that produced an unusable diagram once is unlikely to produce a usable one on
 * a second attempt, and the fallback diagram is cheap and always safe.
 */
export const MAX_DIAGRAM_GENERATION_ATTEMPTS = 1;

/**
 * Server duration budget for one summarization request, in seconds.
 *
 * Large PDFs are parsed in-process and the model has to produce a summary, a
 * diagram and twenty questions, so the default budget is not generous enough.
 */
export const SUMMARIZE_REQUEST_MAX_DURATION_SECONDS = 120;

/** Leading bytes used for signature detection (never trust the extension alone). */
export const FILE_SIGNATURES = {
    pdf: [0x25, 0x50, 0x44, 0x46] as readonly number[],
    /** "PK\x03\x04" — any ZIP-based container, including PPTX. */
    zip: [0x50, 0x4b, 0x03, 0x04] as readonly number[],
    /** OLE2 / Compound File Binary — legacy .ppt and old .doc/.xls. */
    ole2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as readonly number[],
} as const;

export const SIGNATURE_PREFIX_LENGTH = 8;