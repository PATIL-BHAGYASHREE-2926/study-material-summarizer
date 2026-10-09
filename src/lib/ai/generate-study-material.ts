import { validateStudyOutput, type StudyOutput } from "@/lib/validation/ai-schemas";
import type { CanonicalDocument } from "@/types/canonical-document";

import { AiGenerationError, toAiGenerationError } from "./errors";
import { requestStudyOutput, requestFailedCode } from "./provider";
import { buildCorrectionInstruction, buildStudyPrompt, type StudyPrompt } from "./prompt";

/**
 * Orchestration of the AI stage: prompt, request, validate, retry once.
 *
 * This is the only entry point into the AI stage, so it is also the only place
 * that decides when a model response is acceptable. Keeping validation here -
 * rather than trusting the SDK's structured-output mode - is deliberate: the
 * schema is enforced by the API *best effort*, and a model can still return 19
 * questions. Everything that leaves this module has been through
 * `validateStudyOutput`.
 *
 * Provider-agnostic: the request goes through `provider.ts`, which selects
 * between the Groq and Gemini clients. Nothing below that line changes when the
 * provider does.
 */

/**
 * Total attempts, not retries.
 *
 * One retry is the whole budget: a second failure means the model is not
 * producing usable output for this document, and repeating the request more often
 * just multiplies latency and cost without improving the odds.
 */
const MAX_ATTEMPTS = 2;

/**
 * Run one request and validate it, returning either the validated output or the
 * issues that caused rejection.
 *
 * Transport failures (a refused connection, a malformed body) are *not* retried:
 * they say nothing about the document, and retrying them would just double the
 * wait for a request that was never going to succeed. Only a model that answered
 * with something unusable earns the second attempt.
 */
async function attempt(
    prompt: StudyPrompt,
): Promise<{ ok: true; output: StudyOutput } | { ok: false; issues: string[] }> {
    const payload = await requestStudyOutput(prompt);
    const result = validateStudyOutput(payload);
    return result.success ? { ok: true, output: result.data } : { ok: false, issues: result.issues };
}

/** Apply the corrective turn to a previously rejected prompt. */
function withCorrection(prompt: StudyPrompt, issues: string[]): StudyPrompt {
    const correction = buildCorrectionInstruction(issues);
    return {
        ...prompt,
        systemInstruction: `${prompt.systemInstruction}\n\n# Correction\n\n${correction}`,
    };
}

/**
 * Generate a summary, a Mermaid diagram and a 20-question quiz for a document.
 *
 * Rejects with an `AiGenerationError` whose `message` is always safe to show to
 * the user: the model output, the SDK error and the API key are never part of it.
 */
export async function generateStudyMaterial(
    document: CanonicalDocument,
): Promise<StudyOutput> {
    if (document.aggregatedText.trim().length === 0) {
        throw new AiGenerationError("EMPTY_DOCUMENT");
    }

    let prompt = buildStudyPrompt(document);
    let lastIssues: string[] = [];

    try {
        for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
            const result = await attempt(prompt);

            if (result.ok) return result.output;

            lastIssues = result.issues;
            // The retry carries the correction into the next request rather than
            // looping on the identical prompt, which would just reproduce the
            // same rejection.
            if (attemptIndex + 1 < MAX_ATTEMPTS) {
                prompt = withCorrection(prompt, lastIssues);
            }
        }
    } catch (error) {
        throw toAiGenerationError(error, requestFailedCode());
    }

    // The issues are intentionally dropped rather than attached: they quote model
    // output, so they stay on the server, in the cause chain.
    throw new AiGenerationError("OUTPUT_SCHEMA_MISMATCH", undefined, {
        cause: new Error(`${lastIssues.length} schema validation issue(s)`),
    });
}