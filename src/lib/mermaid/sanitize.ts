import { MAX_MERMAID_CODE_LENGTH } from "@/lib/constants/limits";

/**
 * Server-side Mermaid sanitisation.
 *
 * Mermaid is a *language*, and several of its constructs are code: `click`
 * attaches behaviour to a node, `href` and friends turn a label into a link, and
 * `%%{init: ...}%%` is an unparsed configuration blob handed to mermaid's own
 * runtime. Diagram text here comes from a language model reading an untrusted
 * uploaded document, so it is attacker-influenced input and is treated as such.
 *
 * The strategy is *normalise then verify* rather than *match and hope*:
 *
 * 1. Remove every construct that can execute, navigate, or smuggle markup.
 * 2. Re-read the sanitised result and fail if anything dangerous survived.
 *
 * Step 2 is what makes step 1 trustworthy. A denylist of regular expressions is
 * only as good as its last bypass; the post-condition check is what actually
 * guarantees the output is inert, because it is applied to the exact bytes that
 * will be parsed and rendered.
 *
 * This runs *before* `mermaid.parse()`. Parsing is a syntax check; it does not
 * know or care that a diagram links to `javascript:`.
 */

export type SanitizeFailureReason =
    | "EMPTY_CODE"
    | "TOO_LONG"
    | "UNSAFE_CONTENT_REMAINED";

export interface SanitizedCode {
    ok: true;
    /** The only string that may be parsed or rendered. */
    code: string;
    /** Names of the removal rules that changed the input, in application order. */
    removedRules: string[];
}

export type SanitizeResult =
    | SanitizedCode
    | { ok: false; reason: SanitizeFailureReason; detail?: string };

/**
 * Named entities that matter for markup smuggling.
 *
 * `&lt;` is the interesting one: a model asked to avoid "<script>" will happily
 * emit "&#60;script&#62;" or "&lt;script&gt;", which is not a tag to a naive
 * regex but reconstructs one the moment anything decodes it. Only entities
 * that can rebuild markup, quoting, or a block break are decoded - the full
 * HTML entity table has no security value here and would turn legitimate prose
 * into garbage.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    amp: "&",
    sol: "/",
    nbsp: " ",
    colon: ":",
    NewLine: "\n",
    Tab: "\t",
};

/** Highest Unicode code point, so `&#x110000;` is rejected rather than throwing. */
const MAX_CODE_POINT = 0x10ffff;

/** C0 control characters plus DEL, excluding tab, newline and carriage return. */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/** A leading byte-order mark, which would otherwise hide the diagram declaration. */
const BYTE_ORDER_MARK = new RegExp("^\\uFEFF");

/**
 * Decode one numeric or named HTML entity.
 *
 * Returning `undefined` for anything unrecognised matters: an unknown sequence
 * is left untouched rather than mangled, so a diagram containing a legitimate
 * `&copy;` survives sanitisation unchanged.
 */
function decodeEntity(entity: string): string | undefined {
    if (entity.startsWith("#")) {
        const isHex = entity[1] === "x" || entity[1] === "X";
        const digits = isHex ? entity.slice(2) : entity.slice(1);
        if (digits.length === 0) return undefined;

        const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > MAX_CODE_POINT) {
            return undefined;
        }

        try {
            return String.fromCodePoint(codePoint);
        } catch {
            return undefined;
        }
    }

    return NAMED_ENTITIES[entity];
}

/**
 * Decode markup-significant HTML entities so they cannot smuggle a tag past the
 * tag stripper.
 *
 * Runs after the removal rules, so anything reconstructed from `&#60;` is
 * re-checked by the residual post-condition rather than being trusted. Decoding
 * is single-pass and non-recursive: `&amp;lt;script&amp;gt;` decodes once to the
 * literal text `&lt;script&gt;`, which is not a tag and is inert - mermaid under
 * `securityLevel: "strict"` treats label text as text, not markup.
 */
function decodeMarkupEntities(code: string): string {
    const entityPattern = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

    return code.replace(entityPattern, (match: string, entity: string) => {
        const decoded = decodeEntity(entity);
        // Unknown entity: keep it verbatim so legitimate text is not corrupted.
        return decoded ?? match;
    });
}

/** `<script ...> ... </script>` and `<style ...> ... </style>`, contents included. */
const SCRIPT_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;

/**
 * Any remaining HTML or XML tag.
 *
 * Only `<` or `</` followed by a letter or underscore counts, so mermaid's own
 * arrow operators (`-->`, `-.->`) and a bare `<` in prose survive while
 * `<img onerror=...>`, `</svg>` and `<foreignObject>` are removed.
 */
const HTML_TAG = /<\/?[a-zA-Z_][^>]*>/g;

/** `%%{init: ... }%%` plus any unterminated `%%{` directive. */
const DIRECTIVE_BLOCK = /%%\{[\s\S]*?\}%%/g;
const UNTERMINATED_DIRECTIVE = /%%\{[^\n]*/g;

/**
 * A whole line that is only a `click` / `cb` interaction directive.
 *
 * The entire line is removed rather than just the keyword: `click` takes a node
 * id and a target URL, so deleting only the word would leave the link payload
 * behind in a line that no longer parses as a directive - the payload would be
 * re-read as ordinary node text and could still be reconstructed into markup.
 */
const CLICK_DIRECTIVE_LINE = /^[ \t]*(?:click|cb)\b[^\n]*$/gim;

/**
 * Mermaid's styling directives.
 *
 * `classDef`, `class`, `style` and `linkStyle` accept free-form value lists that
 * mermaid feeds into CSS, so they are dropped wholesale rather than filtered.
 * They carry no meaning without the diagram, so removing them loses presentation
 * only, never content.
 */
const STYLE_DIRECTIVE_LINE = /^[ \t]*(?:classDef|class|style|linkStyle)\b[^\n]*$/gim;

/**
 * URL schemes that must never survive sanitisation.
 *
 * `data:` is included because `data:text/html;base64,...` is a fully functional
 * document origin and an SVG-bearing data URL is exactly the shape a script
 * payload needs. `file:` and `blob:` are included because both name local
 * resources the page should not be able to reach through a study diagram.
 */
const BLOCKED_SCHEME = /\b(?:javascript|vbscript|data|file|blob)\s*:/gi;

/** `href`, `xlink:href` and `src` attributes, in HTML or Mermaid syntax. */
const URL_ATTRIBUTE = /\b(?:xlink:)?(?:href|src)\b[ \t]*[:=][^;"'\n]*/gi;

/** CSS `url(...)` references, which can pull in an arbitrary origin. */
const CSS_URL_REFERENCE = /url\([^)\n]*\)/gi;

/**
 * Mermaid's link syntax: `[label](target)` and `[label][reference]`.
 *
 * The target is removed and the label text is kept, so a diagram that used a
 * link purely for labelling degrades into a plain text node instead of losing
 * content. A residual `](` or `][` after these run means an unbalanced or
 * exotic link form survived, which the post-condition then rejects.
 */
const MARKDOWN_LINK_TARGET = /\]\([^)\n]*\)/g;
const MARKDOWN_LINK_REFERENCE = /\]\[[^\]\n]*\]/g;

/**
 * Post-conditions: if any of these match the sanitised output, the sanitiser
 * has a hole and the code is rejected rather than passed on.
 *
 * Intentionally broader than the removal rules above. Over-rejecting costs one
 * regeneration attempt and then a fallback diagram; under-rejecting costs script
 * execution in the user's browser.
 */
const RESIDUAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    ["html-tag", /<\/?[a-zA-Z_][^>]*>/],
    ["directive", /%%\{/],
    ["url-scheme", /\b(?:javascript|vbscript|data|file|blob)\s*:/i],
    ["url-attribute", /\b(?:xlink:)?(?:href|src)\b/i],
    ["css-url", /url\(/i],
    ["interaction-directive", /^[ \t]*(?:click|cb)\b/im],
    ["link-target", /\]\s*[(\[]/],
    ["script-block", /<\s*(?:script|style)\b/i],
];

/** Collapse the runs of blank lines that a pile of removals leaves behind. */
function tidy(code: string): string {
    return code.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Neutralise every unsafe construct in `rawCode`, then verify the result.
 *
 * On success the returned `code` is the only string that may be parsed or
 * rendered. On failure there is no "mostly safe" outcome: a diagram that still
 * trips a post-condition is discarded so the caller can regenerate once and then
 * fall back, which is the behaviour `src/lib/mermaid/index.ts` implements.
 */
export function sanitizeMermaidCode(rawCode: string): SanitizeResult {
    if (typeof rawCode !== "string" || rawCode.trim().length === 0) {
        return { ok: false, reason: "EMPTY_CODE", detail: "The diagram source was empty." };
    }

    // Enforced before any work: an over-long diagram is a denial-of-service
    // vector for both the parser and the browser renderer, and truncating it
    // would only manufacture a syntax error, so it is rejected outright.
    if (rawCode.length > MAX_MERMAID_CODE_LENGTH) {
        return {
            ok: false,
            reason: "TOO_LONG",
            detail: `The diagram source exceeded ${MAX_MERMAID_CODE_LENGTH} characters.`,
        };
    }

    let current = rawCode;
    const removedRules: string[] = [];

    /**
     * Apply one removal rule, recording whether it changed anything.
     *
     * Recording per rule rather than per string keeps `removedRules` useful as
     * an audit trail: it says *which class* of construct the model emitted,
     * without echoing any of the model-authored text.
     */
    const remove = (rule: string, transform: (code: string) => string): void => {
        const next = transform(current);
        if (next !== current) removedRules.push(rule);
        current = next;
    };

    remove("control-characters", (code) =>
        code.replace(CONTROL_CHARACTERS, "").replace(BYTE_ORDER_MARK, "").replace(/\r\n?/g, "\n"),
    );

    // Entities are decoded *first*, before any removal rule runs. Order matters:
    // `A["&#60;script&#62;..."]` is not a tag to `HTML_TAG`, so a tag stripper
    // that ran first would leave the reconstructed `<script>` sitting in the
    // output for the post-condition to reject - safe, but it would throw away an
    // otherwise valid diagram. Decoding first means the reconstructed tag is
    // removed on its own merits, together with its contents.
    //
    // Decoding is single-pass and non-recursive, so `&amp;lt;script&amp;gt;`
    // decodes once to the literal text `&lt;script&gt;`, which is not a tag and
    // is inert: mermaid under `securityLevel: "strict"` treats label text as
    // text, not markup.
    remove("entity", (code) => decodeMarkupEntities(code));

    remove("directive", (code) =>
        code.replace(DIRECTIVE_BLOCK, "").replace(UNTERMINATED_DIRECTIVE, ""),
    );
    remove("script-block", (code) => code.replace(SCRIPT_STYLE_BLOCK, ""));
    remove("interaction-directive", (code) => code.replace(CLICK_DIRECTIVE_LINE, ""));
    remove("style-directive", (code) => code.replace(STYLE_DIRECTIVE_LINE, ""));
    remove("html-tag", (code) => code.replace(HTML_TAG, ""));
    remove("url-attribute", (code) => code.replace(URL_ATTRIBUTE, ""));
    remove("url-scheme", (code) => code.replace(BLOCKED_SCHEME, ""));
    remove("css-url", (code) => code.replace(CSS_URL_REFERENCE, ""));
    remove("markdown-link", (code) =>
        code
            .replace(MARKDOWN_LINK_TARGET, "]")
            .replace(MARKDOWN_LINK_REFERENCE, "]"),
    );

    current = tidy(current);

    if (current.length === 0) {
        return {
            ok: false,
            reason: "EMPTY_CODE",
            detail: "Nothing survived sanitisation.",
        };
    }

    for (const [name, pattern] of RESIDUAL_PATTERNS) {
        if (pattern.test(current)) {
            return {
                ok: false,
                reason: "UNSAFE_CONTENT_REMAINED",
                detail: `A disallowed construct survived sanitisation (${name}).`,
            };
        }
    }

    return { ok: true, code: current, removedRules: [...new Set(removedRules)] };
}

/** Names of the post-conditions applied to sanitised output. */
export function describeSanitizerPostConditions(): string[] {
    return RESIDUAL_PATTERNS.map(([name]) => name);
}