import { MAX_DIAGRAM_GENERATION_ATTEMPTS } from "@/lib/constants/limits";
import type { StudyDiagram } from "@/lib/validation/ai-schemas";

import { sanitizeMermaidCode } from "./sanitize";
import { normalizeMermaidSyntax } from "./normalize";
import { parseMermaidCode, type MermaidParseGate } from "./validate";

/**
 * The public entry point of the Mermaid safety layer: sanitise, normalise,
 * parse-gate, retry once, fall back.
 *
 * The invariant this module exists to hold: **no unvalidated Mermaid ever
 * leaves it**. Every code path returns either a string that passed both the
 * sanitiser and the parse gate, or the hardcoded fallback - and the fallback
 * itself is passed through the same gate, so there is no "trusted because we
 * wrote it" exemption that could rot.
 *
 * Regeneration is injected rather than imported so the layer stays independent
 * of the AI stage and can be tested without a network call. When the regenerator
 * is absent (for example in a unit test, or a build without a configured key)
 * the fallback is used immediately.
 */

/** Where the rendered diagram came from. Surfaced in the response and the UI. */
export type DiagramSource = "generated" | "regenerated" | "fallback";

export interface ResolvedDiagram extends StudyDiagram {
    mermaidCode: string;
    /**
     * Which attempt produced this code. Lets the UI say why a fallback appeared
     * without leaking the rejected source or the model's failure text.
     */
    source: DiagramSource;
    /** User-safe note, present only for the fallback. */
    notice?: string;
    /** Whether the parse gate ran here or is deferred to the browser. */
    parseGate: MermaidParseGate;
}

/**
 * Asks the AI stage for one replacement diagram.
 *
 * The reasons are fixed strings describing *which check* failed. The rejected
 * source is never passed: it is model output, and replaying it into a prompt
 * would let document-authored text re-enter in the instruction voice.
 */
export type DiagramRegenerator = (reasons: string[]) => Promise<StudyDiagram>;

/**
 * The safe fallback diagram.
 *
 * A plain, static flowchart authored here rather than generated: it contains no
 * document content, so it cannot leak anything, and it is short enough that no
 * limit can reject it. The wording tells the user the diagram was replaced
 * instead of silently showing something unrelated to their material.
 */
export const FALLBACK_DIAGRAM: StudyDiagram = {
    mermaidCode: [
        "flowchart TD",
        "    Upload[Study material uploaded]",
        "    Upload --> Extract[Text extracted]",
        "    Extract --> Summary[Summary and key takeaways]",
        "    Extract --> Quiz[20-question quiz]",
        "    Summary --> Review[Review the material]",
        "    Quiz --> Review",
    ].join("\n"),
    diagramType: "flowchart",
    explanation:
        "The generated diagram could not be validated, so this placeholder is shown instead. The summary and quiz below are unaffected.",
};

/**
 * Sanitise, then parse-gate, a single diagram.
 *
 * Returns the reason on failure so the regenerator can be told what class of
 * problem to avoid, without being shown the rejected code (which is model output
 * and must not be replayed into a prompt).
 *
 * The middle step is `normalizeMermaidSyntax`, and its position is deliberate.
 * It runs on *sanitised* text, so it only ever re-delimits label text the
 * sanitiser has already cleared, and it runs *before* the parse gate so the
 * gate judges the code that will actually be shipped to the browser. Without it,
 * a label such as `C[Water splitting (O2 + e- + H+)]` reaches the browser as a
 * parse error: the server-side gate is deferred (no DOM on the Node runtime),
 * so the browser is the first and only parser the diagram ever meets, and the
 * regeneration retry designed to catch this never runs.
 */
async function prepareDiagram(diagram: StudyDiagram): Promise<
    | { ok: true; code: string; gate: MermaidParseGate }
    | { ok: false; reasons: string[] }
> {
    const sanitized = sanitizeMermaidCode(diagram.mermaidCode);
    if (!sanitized.ok) {
        return {
            ok: false,
            reasons: [
                sanitized.reason === "EMPTY_CODE"
                    ? "The diagram source was empty."
                    : sanitized.reason === "TOO_LONG"
                        ? "The diagram source was too long."
                        : "The diagram source contained a disallowed construct.",
            ],
        };
    }

    const validated = await parseMermaidCode(normalizeMermaidSyntax(sanitized.code).code);
    if (!validated.ok) {
        return {
            ok: false,
            reasons: [
                validated.reason === "SYNTAX_ERROR"
                    ? "The diagram source was not valid Mermaid syntax."
                    : validated.reason === "UNSUPPORTED_DIAGRAM_TYPE"
                        ? "The diagram used an unsupported diagram type."
                        : validated.reason === "EMPTY_CODE"
                            ? "The diagram source was empty."
                            : "The diagram parser was unavailable.",
            ],
        };
    }

    return { ok: true, code: validated.code, gate: validated.gate };
}

/**
 * Turn one diagram into one renderable diagram.
 *
 * The order is fixed: sanitise, parse-gate, and only then consider a retry. A
 * diagram that survives both is returned untouched; otherwise the regenerator is
 * called at most `MAX_DIAGRAM_GENERATION_ATTEMPTS` times, and whatever happens
 * after that the fallback is returned. **This function does not throw**: a
 * diagram problem must never fail an upload whose summary and quiz are already
 * valid.
 */
export async function resolveDiagram(
    diagram: StudyDiagram,
    regenerate?: DiagramRegenerator,
): Promise<ResolvedDiagram> {
    const reasons: string[] = [];

    for (let attempt = 0; attempt <= MAX_DIAGRAM_GENERATION_ATTEMPTS; attempt += 1) {
        // The regenerator is only reachable on attempts after the first, which
        // is what bounds this to a single extra AI call.
        const candidate =
            attempt === 0 ? diagram : await requestReplacement(regenerate, reasons);
        if (candidate === undefined) break;

        const prepared = await prepareDiagram(candidate);
        if (prepared.ok) {
            return {
                ...candidate,
                mermaidCode: prepared.code,
                source: attempt === 0 ? "generated" : "regenerated",
                parseGate: prepared.gate,
            };
        }

        reasons.push(...prepared.reasons);
    }

    // `reasons` is deliberately not surfaced: it names model behaviour, and the
    // notice below already says everything the user can act on.
    return fallbackDiagram();
}

/**
 * Ask the regenerator for a replacement, converting any failure into `undefined`.
 *
 * A missing API key, a transport error or a schema rejection all mean the same
 * thing here: there is no diagram to be had, so the loop should stop and the
 * fallback should be used. Swallowing the error is deliberate and safe - the
 * original `AiGenerationError` carries no user-facing detail the fallback does
 * not already state, and letting it escape would turn a cosmetic failure into a
 * failed upload.
 */
async function requestReplacement(
    regenerate: DiagramRegenerator | undefined,
    reasons: string[],
): Promise<StudyDiagram | undefined> {
    if (regenerate === undefined) return undefined;
    try {
        return await regenerate(reasons);
    } catch {
        return undefined;
    }
}

/**
 * Return the fallback, after proving it passes the same gate as everything else.
 *
 * The check is not paranoia for its own sake: it is the assertion that the
 * fallback is a *validated* diagram like any other. If a future edit to
 * `FALLBACK_DIAGRAM` broke it, the safe response is still to hand the UI
 * something - and the sanitised form, even if it failed the grammar, is inert.
 */
async function fallbackDiagram(): Promise<ResolvedDiagram> {
    const prepared = await prepareDiagram(FALLBACK_DIAGRAM);

    return {
        ...FALLBACK_DIAGRAM,
        mermaidCode: prepared.ok ? prepared.code : FALLBACK_DIAGRAM.mermaidCode,
        source: "fallback",
        notice:
            "The generated diagram could not be shown safely, so a placeholder outline is displayed instead. The summary and quiz below are unaffected.",
        parseGate: prepared.ok ? prepared.gate : "deferred",
    };
}

export { sanitizeMermaidCode } from "./sanitize";
export type { SanitizeResult, SanitizeFailureReason } from "./sanitize";
export { parseMermaidCode, isMermaidParseAvailable } from "./validate";
export type {
    MermaidValidationResult,
    MermaidValidationFailure,
    MermaidParseGate,
} from "./validate";