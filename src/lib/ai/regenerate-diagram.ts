import { MAX_MERMAID_CODE_LENGTH } from "@/lib/constants/limits";
import { validateDiagram, type StudyDiagram } from "@/lib/validation/ai-schemas";
import type { CanonicalDocument } from "@/types/canonical-document";

import { AiGenerationError, toAiGenerationError } from "./errors";
import { requestDiagramOutput, requestFailedCode } from "./provider";
import { buildStudyPrompt, type StudyPrompt } from "./prompt";

/**
 * The single AI call that replaces a diagram which failed sanitisation or
 * parsing.
 *
 * It exists as its own module rather than as a branch inside
 * `generate-study-material.ts` for two reasons:
 *
 * 1. The retry costs one *diagram* response, not a second summary plus twenty
 *    questions that the pipeline would immediately discard. A failed diagram is
 *    a rendering problem, not a document problem, so re-running the whole study
 *    stage would multiply cost and latency to fix nothing.
 * 2. `generateStudyMaterial` is the stage's validation authority. Diagram
 *    regeneration has a different output shape and its own single-attempt
 *    budget, so folding it into that function would put a second, laxer parser
 *    beside the strict one.
 *
 * As with the main stage, the failure budget is one request: no retry loop. The
 * caller falls back to a safe static diagram when this throws, and a thrown
 * `AiGenerationError` is the signal for that - so a missing API key degrades to
 * the fallback diagram rather than failing the whole upload.
 */

/** Upper bound on the corrected source accepted before it is handed to mermaid. */
const MAX_CORRECTED_DIAGRAM_CHARS = MAX_MERMAID_CODE_LENGTH;

/**
 * Build the instruction for the replacement attempt.
 *
 * The rejected source is *not* echoed back. That source is model output derived
 * from an untrusted document, and replaying it into the next prompt would open
 * a second-order injection channel: anything the model managed to emit once -
 * including text that was deliberately smuggled - would arrive in the
 * instruction voice. The model is told what failed and asked for a fresh
 * diagram instead.
 *
 * The failing construct names below are fixed by the sanitiser, never by the
 * data, so they are safe to send.
 */
function buildCorrectionInstruction(reasons: string[]): string {
    const uniqueReasons = [...new Set(reasons)].slice(0, 8);

    return [
        "",
        "# Correction",
        "",
        "The diagram in your previous response was rejected and will not be shown to the user. Do not repeat it.",
        uniqueReasons.length > 0
            ? `The problems found: ${uniqueReasons.join("; ")}.`
            : "The diagram did not pass validation.",
        "Write one new Mermaid diagram from scratch, based on the document text, using a simple diagram type such as `flowchart TD`, `sequenceDiagram`, `classDiagram`, or `mindmap`.",
        "Use plain text labels only. No HTML tags, no `script` or `style`, no `click` or `href` directives, no `%%{init:...}%%` directives, and no URLs of any kind.",
        'If a `flowchart` node label contains any of `( ) [ ] { } | @ >` or `"`, wrap that whole label in double quotes - `A["Light reactions (thylakoid)"]` or `H["Precision@k"]`. Mermaid reads those characters as syntax inside an unquoted label, which is the most common reason a diagram fails to render.',
        `Keep it under ${MAX_CORRECTED_DIAGRAM_CHARS} characters.`,
        "Return only the JSON object described in your instructions.",
    ].join("\n");
}

/** Attach the diagram correction to an existing, already-fenced study prompt. */
function withDiagramCorrection(
    prompt: StudyPrompt,
    reasons: string[],
): StudyPrompt {
    return {
        ...prompt,
        systemInstruction: `${prompt.systemInstruction}${buildCorrectionInstruction(reasons)}`,
    };
}

/**
 * Ask the model for one replacement diagram.
 *
 * Rejects with an `AiGenerationError`; the caller treats any rejection as "use
 * the fallback diagram" rather than as a failure of the upload.
 */
export async function regenerateDiagram(
    document: CanonicalDocument,
    reasons: string[],
): Promise<StudyDiagram> {
    const prompt = withDiagramCorrection(buildStudyPrompt(document), reasons);

    let payload: unknown;
    try {
        payload = await requestDiagramOutput(prompt);
    } catch (error) {
        throw toAiGenerationError(error, requestFailedCode());
    }

    const result = validateDiagram(payload);
    if (!result.success) {
        throw new AiGenerationError("OUTPUT_SCHEMA_MISMATCH", undefined, {
            // Issue text quotes the model, so it stays server-side in the cause.
            cause: new Error(`${result.issues.length} diagram schema validation issue(s)`),
        });
    }

    return result.data;
}