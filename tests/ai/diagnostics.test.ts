import { afterEach, describe, expect, it, vi } from "vitest";

import { describeAiFailure, logAiFailure } from "@/lib/ai/diagnostics";
import { AiGenerationError, type AiErrorCode } from "@/lib/ai/errors";

/**
 * Diagnostics exist to make a Gemini failure diagnosable from a log line without
 * making the credential loggable, so both halves are pinned here: the category
 * and status that tell an operator what broke, and the guarantees about what
 * can never appear in the output.
 */

/** The SDK error shape for an upstream that answered with an HTTP status. */
function apiError(status: number, message: string): Error {
    const error = new Error(message);
    Object.assign(error, { name: "ApiError", status });
    return error;
}

/** The SDK error shape for a failure before any response was produced. */
function networkError(name: string, message: string): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

/** Wrap a cause the way `toAiGenerationError` does. */
function failing(code: AiErrorCode, cause: unknown): AiGenerationError {
    return new AiGenerationError(code, undefined, { cause });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("describeAiFailure", () => {
    it("identifies a missing key without contacting the service", () => {
        const detail = describeAiFailure(new AiGenerationError("MISSING_API_KEY"));

        expect(detail.category).toBe("missing_api_key");
        expect(detail.upstreamStatus).toBeNull();
    });

    it.each([
        [400, "upstream_rejected_request"],
        [401, "upstream_unauthorized"],
        [403, "upstream_unauthorized"],
        [404, "upstream_model_not_found"],
        [429, "upstream_rate_limited_or_out_of_quota"],
        [500, "upstream_server_error"],
        [503, "upstream_server_error"],
    ])("maps upstream %i to %s", (status, category) => {
        const detail = describeAiFailure(
            failing("GEMINI_REQUEST_FAILED", apiError(status, "upstream said no")),
        );

        expect(detail.category).toBe(category);
        expect(detail.upstreamStatus).toBe(status);
    });

    it("reads a status carried on a nested cause", () => {
        const inner = apiError(429, "quota");
        const outer = new Error("wrapper", { cause: inner });

        const detail = describeAiFailure(failing("GEMINI_REQUEST_FAILED", outer));

        expect(detail.upstreamStatus).toBe(429);
        expect(detail.category).toBe("upstream_rate_limited_or_out_of_quota");
    });

    it("classifies a transport failure as a network problem, not an API rejection", () => {
        const detail = describeAiFailure(
            failing("GEMINI_REQUEST_FAILED", networkError("ConnectionError", "ECONNREFUSED")),
        );

        expect(detail.category).toBe("network_failure");
        expect(detail.upstreamStatus).toBeNull();
    });

    it("survives a self-referential cause chain", () => {
        const error = new Error("loop");
        (error as { cause?: unknown }).cause = error;

        expect(() => describeAiFailure(failing("GEMINI_REQUEST_FAILED", error))).not.toThrow();
    });

    it("treats a response-validation failure as an AI-stage error", () => {
        // No cause means the request succeeded and we rejected the answer, which
        // is a different problem from the service being unreachable.
        const detail = describeAiFailure(new AiGenerationError("OUTPUT_SCHEMA_MISMATCH"));

        expect(detail.category).toBe("ai_stage_error");
        expect(detail.upstreamStatus).toBeNull();
    });

    it("gives configuration advice that names variables, never values", () => {
        const detail = describeAiFailure(
            failing("GEMINI_REQUEST_FAILED", apiError(404, "model gone")),
        );

        expect(detail.hint).toContain("GEMINI_MODEL");
    });
});

describe("logAiFailure", () => {
    /** Capture what reaches console.error while asserting on a redacted copy. */
    function captureLog(run: () => void): string {
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
            lines.push(parts.map(String).join(" "));
        });
        run();
        return lines.join("\n");
    }

    it("records the category and upstream status", () => {
        const output = captureLog(() => {
            logAiFailure("summarize", failing("GEMINI_REQUEST_FAILED", apiError(400, "bad request")));
        });

        expect(output).toContain("category=upstream_rejected_request");
        expect(output).toContain("upstreamStatus=400");
        expect(output).toContain("code=GEMINI_REQUEST_FAILED");
    });

    it("records that no response was produced when there was no status", () => {
        const output = captureLog(() => {
            logAiFailure(
                "summarize",
                failing("GEMINI_REQUEST_FAILED", networkError("ConnectionError", "ECONNREFUSED")),
            );
        });

        expect(output).toContain("category=network_failure");
        expect(output).toContain("upstreamStatus=none");
    });

    it("never emits the upstream message, which can carry the credential", () => {
        // The Gemini API takes the key as a URL query parameter, so an SDK error
        // message can quote the full request URL. That is precisely why the
        // message is not logged.
        const key = "AIzaSy-secret-key-value-0000000000000";
        const leaky = apiError(
            400,
            `Invalid argument. Request URL: https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        );

        const output = captureLog(() => {
            logAiFailure("summarize", failing("GEMINI_REQUEST_FAILED", leaky));
        });

        expect(output).not.toContain(key);
        expect(output).not.toContain("generativelanguage");
        expect(output).not.toContain("key=");
    });

    it("never echoes the environment it is running in", () => {
        process.env.GEMINI_API_KEY = "AIzaSy-a-key-injected-into-the-test";
        try {
            const output = captureLog(() => {
                logAiFailure("summarize", failing("GEMINI_REQUEST_FAILED", apiError(401, "nope")));
            });

            expect(output).not.toContain("AIzaSy-a-key-injected-into-the-test");
            expect(output).not.toContain(process.env.GEMINI_API_KEY as string);
        } finally {
            delete process.env.GEMINI_API_KEY;
        }
    });

    it("is silent about the value of GEMINI_MODEL", () => {
        process.env.GEMINI_MODEL = "some-typoed-model-name";
        try {
            const output = captureLog(() => {
                logAiFailure("summarize", failing("GEMINI_REQUEST_FAILED", apiError(404, "gone")));
            });

            expect(output).not.toContain("some-typoed-model-name");
        } finally {
            delete process.env.GEMINI_MODEL;
        }
    });
});