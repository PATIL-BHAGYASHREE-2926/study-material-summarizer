import type { StudyPrompt } from "./prompt";

/**
 * Provider selection for the AI stage.
 *
 * ## Why this is a selection, not a rewrite
 *
 * The Gemini integration is unchanged and still fully supported. This module
 * only decides *which* client issues a request, so both providers sit behind the
 * same two functions and neither knows the other exists. Everything downstream -
 * prompt construction, Zod validation, the Mermaid gate, the UI - is untouched.
 *
 * ## Selection order
 *
 * 1. `AI_PROVIDER`, when set, is authoritative. An unknown value is a
 *    configuration mistake and falls back rather than throwing, so a typo in
 *    `.env.local` degrades to "Groq if it is configured, otherwise Gemini"
 *    instead of taking the whole upload path down.
 * 2. Otherwise Groq is preferred when `GROQ_API_KEY` is set, and Gemini when
 *    `GEMINI_API_KEY` is set. This makes the newer provider the default for a
 *    deployment that configures both, without changing behaviour for a
 *    deployment that only ever had Gemini.
 *
 * A provider with no credential is still selected rather than skipped: the
 * alternative is to silently serve a different provider's output than the
 * operator configured, and `MISSING_API_KEY` is a precise, actionable error.
 */

export type AiProvider = "groq" | "gemini";

/** Read a configured provider name, without exposing it to the browser. */
function configuredProvider(): AiProvider | null {
    const raw = process.env["AI_PROVIDER"]?.trim().toLowerCase();
    if (raw === "groq") return "groq";
    if (raw === "gemini") return "gemini";
    return null;
}

/**
 * Resolve the provider for this request.
 *
 * Read per request rather than memoised, so editing `.env.local` and reloading
 * takes effect without a server restart - matching how the credentials
 * themselves are read.
 */
export function resolveProvider(): AiProvider {
    const explicit = configuredProvider();
    if (explicit !== null) return explicit;

    if (process.env["GROQ_API_KEY"]?.trim()) return "groq";
    if (process.env["GEMINI_API_KEY"]?.trim()) return "gemini";

    // Nothing is configured. Groq is named because it is the preferred provider
    // above; the client it selects then raises `MISSING_API_KEY`, which names
    // both variables in its message rather than pointing at one.
    return "groq";
}

/** Request the full study payload (summary, diagram, twenty-question quiz). */
export async function requestStudyOutput(prompt: StudyPrompt): Promise<unknown> {
    if (resolveProvider() === "groq") {
        const { requestStudyOutput: request } = await import("./groq");
        return request(prompt);
    }

    const { requestStudyOutput: request } = await import("./gemini");
    return request(prompt);
}

/**
 * Request a replacement Mermaid diagram only.
 *
 * Kept parallel to `requestStudyOutput` so the single regeneration attempt in
 * `src/lib/mermaid/index.ts` costs one small diagram response either way.
 */
export async function requestDiagramOutput(prompt: StudyPrompt): Promise<unknown> {
    if (resolveProvider() === "groq") {
        const { requestDiagramOutput: request } = await import("./groq");
        return request(prompt);
    }

    const { requestDiagramOutput: request } = await import("./gemini");
    return request(prompt);
}

/**
 * The error code a transport failure from the active provider should carry.
 *
 * Each client raises its own code from its own catch block, so this is only used
 * to re-label a failure caught outside a client - for example one raised by the
 * prompt builder's correction path. Keeping it a function rather than a constant
 * means it stays correct if the provider changes mid-request.
 */
export function requestFailedCode(): "GROQ_REQUEST_FAILED" | "GEMINI_REQUEST_FAILED" {
    return resolveProvider() === "groq" ? "GROQ_REQUEST_FAILED" : "GEMINI_REQUEST_FAILED";
}