import type { AiGenerationError } from "./errors";

/**
 * Server-side diagnostics for the AI stage.
 *
 * ## Why this exists
 *
 * Every AI failure reaches the browser as one of a handful of fixed sentences,
 * which is the right thing for the user and useless for whoever is on call:
 * "The AI service could not be reached" is returned identically for a revoked
 * key, an exhausted quota, a wrong model name, a typo in the model string, and a
 * genuine network fault. This module turns the failure into a small set of
 * loggable facts so those cases can be told apart from the terminal without
 * loosening what the browser sees.
 *
 * ## What is deliberately never logged
 *
 * Nothing here reads or emits an API key, a request header, or the SDK's own
 * error `message`. SDK messages routinely embed the full request URL - and the
 * Gemini API carries its key in the URL query string - so logging a message
 * verbatim would write the credential to stdout on every failure. The category is
 * derived from the structured `status` the SDK attaches, which is the one field
 * that carries the same information without the secret.
 *
 * `hintFor` names environment *variables* rather than reading them. A logger that
 * reads configuration is a logger that can leak it, so the provider is inferred
 * from the error code already in hand instead.
 */

/** What kind of AI-provider failure this was, in log-safe terms. */
export type AiFailureCategory =
    /** No credential for the selected provider; no request was attempted. */
    | "missing_api_key"
    /** Upstream answered 400 - rejected key, malformed request, or bad model. */
    | "upstream_rejected_request"
    /** Upstream answered 401 or 403 - the key is unknown, revoked or restricted. */
    | "upstream_unauthorized"
    /** Upstream answered 404 - almost always a model name that does not exist. */
    | "upstream_model_not_found"
    /** Upstream answered 429 - rate limited or out of quota. */
    | "upstream_rate_limited_or_out_of_quota"
    /** Upstream answered 5xx. */
    | "upstream_server_error"
    /** A transport-level failure: DNS, TLS, refused connection, timeout. */
    | "network_failure"
    /** The request exceeded the configured client timeout. */
    | "request_timeout"
    /** An SDK error that carried no recognisable status. */
    | "unknown_upstream_failure"
    /** Our own typed error - validation, empty response, schema mismatch. */
    | "ai_stage_error";

/** Structured, non-secret facts about one AI-stage failure. */
export interface AiFailureDetail {
    category: AiFailureCategory;
    /** The HTTP status the SDK reported, or `null` when there was no response. */
    upstreamStatus: number | null;
    /** The `AiErrorCode` the user was shown, so log and UI can be correlated. */
    code: string;
    /**
     * A short hint about what to change, when the category implies one.
     *
     * Deliberately advice about *configuration*, never about a value: it can say
     * "check GROQ_API_KEY", not what the key or model currently is.
     */
    hint: string | null;
}

/** Statuses that mean "the credential is the problem", not "the service is". */
function categorizeStatus(status: number): AiFailureCategory {
    if (status === 400) return "upstream_rejected_request";
    if (status === 401 || status === 403) return "upstream_unauthorized";
    if (status === 404) return "upstream_model_not_found";
    if (status === 429) return "upstream_rate_limited_or_out_of_quota";
    if (status >= 500) return "upstream_server_error";
    return "unknown_upstream_failure";
}

/**
 * Read the HTTP status out of an SDK error without trusting its shape.
 *
 * `@google/genai` raises `ApiError` with a numeric `status`, but the transport
 * layers below it raise plain `Error`s for connection problems, and a wrapped or
 * rethrown error may carry the status on `cause` instead. All three are checked;
 * anything else yields `null`, which the caller reports as "no response".
 */
function readUpstreamStatus(error: unknown): number | null {
    const seen = new Set<unknown>();

    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
        if (seen.has(current)) return null;
        seen.add(current);

        if (typeof current !== "object") return null;
        const status = (current as { status?: unknown }).status;
        if (typeof status === "number" && Number.isFinite(status)) return status;

        current = (current as { cause?: unknown }).cause;
    }

    return null;
}

/**
 * Whether a failure happened before any HTTP response was produced.
 *
 * Checked structurally by class name rather than `instanceof` so the diagnostic
 * keeps working if an SDK moves the class between its entry points, and so this
 * module stays importable without pulling in either SDK.
 */
function isNetworkFailure(error: unknown): boolean {
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return (
        typeof name === "string" &&
        (name === "ConnectionError" ||
            name === "RequestTimeoutError" ||
            name === "RequestAbortedError" ||
            // groq-sdk
            name === "APIConnectionError" ||
            name === "APIConnectionTimeoutError" ||
            name === "APIUserAbortError")
    );
}

/**
 * Configuration advice implied by a category.
 *
 * Names variables and provider shape, never values. `code` is what selects the
 * provider here, so no environment variable is read on the logging path - a
 * logger that reads configuration is a logger that can leak it.
 */
function hintFor(category: AiFailureCategory, code: string): string | null {
    const groq = code === "GROQ_REQUEST_FAILED" || code === "AI_REQUEST_TIMEOUT";
    const keyVar = groq ? "GROQ_API_KEY" : "GEMINI_API_KEY";
    const modelVar = groq ? "GROQ_MODEL" : "GEMINI_MODEL";
    const vendor = groq ? "Groq" : "Google";

    switch (category) {
        case "missing_api_key":
            return "Set GROQ_API_KEY (or GEMINI_API_KEY for the Gemini provider) in .env.local and restart the server.";
        case "upstream_unauthorized":
            return `The key was rejected by ${vendor}. Check ${keyVar} is valid, active and not restricted.`;
        case "upstream_model_not_found":
            return `${vendor} does not recognise the model. Check ${modelVar} names a model available to this key.`;
        case "upstream_rejected_request":
            return `${vendor} rejected the request. Check ${keyVar} is a real key (not a placeholder), and that ${modelVar} supports JSON schema structured output.`;
        case "upstream_rate_limited_or_out_of_quota":
            return "Rate limited or out of quota. Check the key's quota and billing.";
        case "upstream_server_error":
            return `${vendor} returned a server error. Usually transient; retry later.`;
        case "network_failure":
            return `The request did not reach ${vendor}. Check outbound network access and any proxy.`;
        case "request_timeout":
            return `The request exceeded ${groq ? "GROQ_REQUEST_TIMEOUT_MS" : "the client timeout"}. Try a smaller document.`;
        default:
            return null;
    }
}

/**
 * Reduce an AI-stage failure to loggable, non-secret facts.
 *
 * `error` is the `AiGenerationError` the browser was shown; the SDK failure is
 * read from its `cause` chain. Only `code`, the category, the upstream status
 * and configuration advice cross this boundary.
 */
export function describeAiFailure(error: AiGenerationError): AiFailureDetail {
    if (error.code === "MISSING_API_KEY") {
        return {
            category: "missing_api_key",
            upstreamStatus: null,
            code: error.code,
            hint: hintFor("missing_api_key", error.code),
        };
    }

    if (error.code === "AI_REQUEST_TIMEOUT") {
        return {
            category: "request_timeout",
            upstreamStatus: null,
            code: error.code,
            hint: hintFor("request_timeout", error.code),
        };
    }

    const status = readUpstreamStatus(error.cause);

    // Our own response-validation failures have no upstream error at all: the
    // request succeeded, the model answered, and we rejected the answer.
    if (error.cause === undefined) {
        return {
            category: "ai_stage_error",
            upstreamStatus: null,
            code: error.code,
            hint: null,
        };
    }

    let category: AiFailureCategory;
    if (status !== null) {
        category = categorizeStatus(status);
    } else if (isNetworkFailure(error.cause)) {
        category = "network_failure";
    } else {
        category = "unknown_upstream_failure";
    }

    return {
        category,
        upstreamStatus: status,
        code: error.code,
        hint: hintFor(category, error.code),
    };
}

/**
 * Log one AI-stage failure.
 *
 * The formatted line is built from a fixed template and only ever interpolates
 * values derived by `describeAiFailure`. No secret can reach it, because none of
 * those values comes from the credential or from an upstream message body.
 */
export function logAiFailure(stage: string, error: AiGenerationError): void {
    const detail = describeAiFailure(error);
    const parts = [
        `[${stage}]`,
        `code=${detail.code}`,
        `category=${detail.category}`,
        `upstreamStatus=${detail.upstreamStatus ?? "none"}`,
    ];
    if (detail.hint !== null) parts.push(`hint="${detail.hint}"`);

    console.error(parts.join(" "));
}