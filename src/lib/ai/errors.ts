/**
 * Typed, user-presentable failures from the Gemini stage.
 *
 * Mirrors `src/lib/document/errors.ts`: every message here is safe to hand
 * straight to the UI. Raw model output, raw SDK errors and the API key are
 * never interpolated into a message - a failed generation must not turn into a
 * way to read the credential or to reflect attacker-authored text back at the
 * user.
 */

export type AiErrorCode =
    | "MISSING_API_KEY"
    | "GEMINI_REQUEST_FAILED"
    | "GROQ_REQUEST_FAILED"
    | "AI_REQUEST_TIMEOUT"
    | "EMPTY_MODEL_RESPONSE"
    | "MALFORMED_MODEL_RESPONSE"
    | "OUTPUT_SCHEMA_MISMATCH"
    | "EMPTY_DOCUMENT";

const DEFAULT_MESSAGES: Record<AiErrorCode, string> = {
    MISSING_API_KEY:
        "AI generation is not configured on the server. Set GROQ_API_KEY (or GEMINI_API_KEY) and restart the app.",
    GEMINI_REQUEST_FAILED:
        "The AI service could not be reached. Please try again in a moment.",
    GROQ_REQUEST_FAILED:
        "The AI service could not be reached. Please try again in a moment.",
    AI_REQUEST_TIMEOUT:
        "The AI service took too long to respond. Please try again, or try a smaller document.",
    EMPTY_MODEL_RESPONSE:
        "The AI service returned no content for this document. Please try again.",
    MALFORMED_MODEL_RESPONSE:
        "The AI service returned a response that could not be read. Please try again.",
    OUTPUT_SCHEMA_MISMATCH:
        "The AI service did not return usable study material for this document. Please try again, or try a document with more text.",
    EMPTY_DOCUMENT:
        "This document has no text to summarise. Try a text-based PDF or presentation.",
};

/**
 * Raised anywhere in the Gemini stage.
 *
 * Carries a stable `code` so the UI can branch without string matching, plus an
 * already-safe message. The originating error is attached as `cause` for
 * server-side logs only - it is never rendered.
 */
export class AiGenerationError extends Error {
    readonly code: AiErrorCode;

    constructor(code: AiErrorCode, message?: string, options?: { cause?: unknown }) {
        super(message ?? DEFAULT_MESSAGES[code], options);
        this.name = "AiGenerationError";
        this.code = code;
    }
}

/** Narrow an unknown thrown value to an `AiGenerationError`. */
export function isAiGenerationError(error: unknown): error is AiGenerationError {
    return error instanceof AiGenerationError;
}

/**
 * Wrap an arbitrary thrown value into an `AiGenerationError` without leaking
 * the original message.
 *
 * SDK errors routinely embed the request URL, the model id and, in some
 * transports, the credential that was sent. Keeping the original message out of
 * the user-visible error is what stops a Gemini failure from becoming an API key
 * disclosure; the original is preserved only as `cause`.
 */
export function toAiGenerationError(
    error: unknown,
    fallbackCode: AiErrorCode,
): AiGenerationError {
    if (isAiGenerationError(error)) return error;
    return new AiGenerationError(fallbackCode, undefined, { cause: error });
}