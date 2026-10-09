import { ALLOWED_MERMAID_DIAGRAMS } from "@/lib/constants/limits";

/**
 * Syntactic validation of Mermaid source, using mermaid's own parser.
 *
 * Sanitisation answers "is this safe?"; this module answers "is this valid?".
 * Both are required: `mermaid.parse()` is a grammar check and will happily
 * accept a diagram whose node carries a `click` directive, and the sanitiser
 * will happily pass a well-formed `flowchart` whose body does not parse.
 */

/** Why a diagram failed validation. User-safe: no code is ever interpolated. */
export type MermaidValidationFailure =
    | "EMPTY_CODE"
    | "UNSUPPORTED_DIAGRAM_TYPE"
    | "SYNTAX_ERROR"
    | "PARSER_UNAVAILABLE";

/**
 * How far validation got.
 *
 * `parsed` means mermaid's grammar accepted the code in this context.
 * `deferred` means the context had no DOM, so mermaid's parser could not run and
 * the code is only structurally checked - see `isMermaidParseAvailable`.
 */
export type MermaidParseGate = "parsed" | "deferred";

export type MermaidValidationResult =
    | { ok: true; code: string; gate: MermaidParseGate }
    | { ok: false; reason: MermaidValidationFailure };

/**
 * How mermaid is configured for every parse this app performs.
 *
 * `securityLevel: "strict"` is the load-bearing setting: it is what makes
 * mermaid escape label text instead of interpreting it as HTML, and it disables
 * click callbacks. `htmlLabels: false` is belt-and-braces for the same property.
 * `startOnLoad: false` stops mermaid from scanning the document on import and
 * rendering anything behind our back.
 *
 * These values are asserted in `tests/mermaid/validate.test.ts`: a validation
 * pass that silently ran with looser settings would be indistinguishable from a
 * working one.
 */
export const MERMAID_PARSE_CONFIG = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    flowchart: { htmlLabels: false },
} as const;

/** The minimal mermaid surface this module uses. */
type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    parse: (
        code: string,
        options?: { suppressErrors?: boolean },
    ) => Promise<unknown>;
};

/**
 * Whether mermaid's parser can run in this JavaScript context.
 *
 * Mermaid sanitises label text with DOMPurify, which needs a DOM. The server
 * route runs on `runtime = "nodejs"`, where there is none, and a diagram is
 * only ever *rendered* in the browser anyway.
 *
 * This is why ARCHITECTURE.md places the parse gate in Stage 5.3, client-side.
 * Server-side validation is sanitisation plus the structural checks below, and
 * the browser re-parses with mermaid before it renders. Detecting the missing
 * DOM explicitly is what lets both halves report honestly: the server says
 * `deferred` rather than either skipping the check silently or failing every
 * diagram.
 */
export function isMermaidParseAvailable(): boolean {
    return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * The declaration keyword on the first meaningful line.
 *
 * Read from the source rather than from mermaid's parse result so the allowlist
 * is enforced explicitly and testably, and so it still applies in a context
 * where the parser cannot run.
 */
function declaredDiagramType(code: string): string | undefined {
    for (const rawLine of code.split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        // A leading comment line is legal Mermaid and carries no declaration.
        if (line.startsWith("%%")) continue;
        return line.split(/[\s:{]/)[0]?.toLowerCase();
    }
    return undefined;
}

/**
 * Enforce the diagram-type allowlist.
 *
 * Mermaid keeps adding diagram types, several of which carry markup, template or
 * raw-HTML handling this app has no reason to reason about. An unknown
 * declaration is rejected here rather than left to the parser, so the set of
 * things that can be rendered is enumerable.
 */
function hasAllowedDeclaration(code: string): boolean {
    const declared = declaredDiagramType(code);
    if (declared === undefined) return false;
    return ALLOWED_MERMAID_DIAGRAMS.some(
        (allowed) => allowed.toLowerCase() === declared,
    );
}

/**
 * Cached mermaid instance.
 *
 * `mermaid.initialize` mutates module-global state, so the instance is created
 * once per process and reused. The promise is retained even on rejection, so a
 * broken environment does not cause a re-import storm on every diagram.
 */
let mermaidPromise: Promise<MermaidApi> | undefined;

/** Import and configure mermaid once per process. */
function loadMermaid(): Promise<MermaidApi> {
    mermaidPromise ??= import("mermaid").then((module) => {
        const instance = module.default as unknown as MermaidApi;
        instance.initialize({ ...MERMAID_PARSE_CONFIG });
        return instance;
    });
    return mermaidPromise;
}

/**
 * Test seam: drop the cached instance so a later call re-initialises mermaid.
 *
 * Needed because `initialize` mutates module-global config, so a test asserting
 * on configuration needs a clean slate. Production code has no use for this.
 */
export function resetMermaidForTests(): void {
    mermaidPromise = undefined;
}

/**
 * Confirm that `code` is valid Mermaid without rendering it.
 *
 * `mermaid.parse()` runs the grammar and builds the diagram database, but it
 * never touches the document: nothing is inserted and no SVG is produced. That
 * is what makes it usable as a gate - and why this module calls `parse` and
 * never `render`. The browser performs the actual `mermaid.render()`, and only
 * after passing this gate.
 *
 * Errors are caught and reduced to a code: a parse failure's message quotes the
 * offending source, which is model output derived from an untrusted document,
 * so it must never reach a user-facing string.
 */
export async function parseMermaidCode(
    code: string,
): Promise<MermaidValidationResult> {
    const trimmed = code.trim();
    if (trimmed.length === 0) return { ok: false, reason: "EMPTY_CODE" };

    if (!hasAllowedDeclaration(trimmed)) {
        return { ok: false, reason: "UNSUPPORTED_DIAGRAM_TYPE" };
    }

    if (!isMermaidParseAvailable()) {
        return { ok: true, code: trimmed, gate: "deferred" };
    }

    let mermaid: MermaidApi;
    try {
        mermaid = await loadMermaid();
    } catch {
        // A parser that cannot load is not a basis for trusting the syntax, so
        // this fails closed: the caller regenerates once, then falls back.
        return { ok: false, reason: "PARSER_UNAVAILABLE" };
    }

    try {
        await mermaid.parse(trimmed);
        return { ok: true, code: trimmed, gate: "parsed" };
    } catch {
        return { ok: false, reason: "SYNTAX_ERROR" };
    }
}