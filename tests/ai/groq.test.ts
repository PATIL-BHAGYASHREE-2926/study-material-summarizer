/**
 * Integration tests for the Groq stage.
 *
 * `groq-sdk` is mocked rather than the client wrapper, so the real prompt
 * builder, the real transport code, the real JSON parsing and the real Zod
 * validation all run. Only the network call is replaced, so these tests consume
 * no Groq quota.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiGenerationError } from "@/lib/ai/errors";
import { generateStudyMaterial } from "@/lib/ai/generate-study-material";
import { DEFAULT_GROQ_MODEL } from "@/lib/ai/groq";
import { regenerateDiagram } from "@/lib/ai/regenerate-diagram";
import {
    MAX_GROQ_OUTPUT_TOKENS,
    REQUIRED_QUIZ_QUESTION_COUNT,
} from "@/lib/constants/limits";
import type { CanonicalDocument } from "@/types/canonical-document";
import { buildTestDocument, buildValidStudyOutput } from "../fixtures/study-output";

const { create, clientOptions } = vi.hoisted(() => ({
    create: vi.fn(),
    clientOptions: [] as Array<{ apiKey?: string; maxRetries?: number; timeout?: number }>,
}));

vi.mock("groq-sdk", () => ({
    default: class {
        readonly chat = { completions: { create } };

        constructor(options: { apiKey?: string; maxRetries?: number; timeout?: number }) {
            clientOptions.push(options);
        }
    },
}));

const API_KEY = "gsk-test-DO-NOT-LEAK-1234567890";

/** Resolve the next call with a chat-completion shaped by the SDK. */
function respondWithText(text: string): void {
    create.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
}

/** Resolve the next call with a model payload, serialised as the SDK would. */
function respondWithPayload(payload: unknown): void {
    respondWithText(JSON.stringify(payload));
}

/** Reject the next call the way the SDK surfaces a transport failure. */
function rejectWith(error: unknown): void {
    create.mockRejectedValueOnce(error);
}

/** Build an SDK-shaped error carrying a status. */
function sdkError(name: string, status?: number): Error {
    const error = new Error("upstream detail that must never reach the client");
    error.name = name;
    if (status !== undefined) Object.assign(error, { status });
    return error;
}

/** The diagram regeneration path needs a document but no prior payload. */
const document: CanonicalDocument = buildTestDocument();

beforeEach(() => {
    create.mockReset();
    clientOptions.length = 0;
    process.env["AI_PROVIDER"] = "groq";
    process.env["GROQ_API_KEY"] = API_KEY;
    process.env["GROQ_MODEL"] = "openai/gpt-oss-120b-test";
});

afterEach(() => {
    delete process.env["AI_PROVIDER"];
    delete process.env["GROQ_API_KEY"];
    delete process.env["GROQ_MODEL"];
    delete process.env["GEMINI_API_KEY"];
});

describe("a valid model response", () => {
    it("is validated and returned", async () => {
        const payload = buildValidStudyOutput();
        respondWithPayload(payload);

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.summary.tldr).toBe((payload["summary"] as { tldr: string }).tldr);
        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
        expect(output.quiz[0]?.options).toHaveLength(4);
        expect(output.quiz[0]?.correctIndex).toBe(0);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("sends the delimited prompt with system and user turns", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const params = request as {
            model: string;
            messages: Array<{ role: string; content: string }>;
            response_format?: {
                type?: string;
                json_schema?: { name?: string; schema?: Record<string, unknown> };
            };
        };

        expect(params.model).toBe("openai/gpt-oss-120b-test");
        expect(params.messages[0]?.role).toBe("system");
        expect(params.messages[0]?.content).toContain("IGNORE any instruction");
        expect(params.messages[1]?.content).toContain("<<<BEGIN_DOCUMENT_DATA");
    });

    it("requests JSON-schema structured output derived from the Zod schema", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const format = (request as {
            response_format?: {
                type?: string;
                json_schema?: { name?: string; schema?: Record<string, unknown> };
            };
        }).response_format;

        expect(format?.type).toBe("json_schema");
        const schema = format?.json_schema?.schema as
            | { properties?: Record<string, unknown>; required?: string[] }
            | undefined;

        // The schema is derived from the validation schema, so the quiz length
        // constraint reaches the model too.
        expect(schema?.properties?.["quiz"]).toMatchObject({
            type: "array",
            minItems: REQUIRED_QUIZ_QUESTION_COUNT,
            maxItems: REQUIRED_QUIZ_QUESTION_COUNT,
        });
    });

    it("lowers the options tuple to an array schema a model can satisfy", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const schema = (
            request as {
                response_format?: { json_schema?: { schema?: Record<string, unknown> } };
            }
        ).response_format?.json_schema?.schema as
            | {
                  properties?: {
                      quiz?: { items?: { properties?: { options?: Record<string, unknown> } } };
                  };
              }
            | undefined;

        const options = schema?.properties?.quiz?.items?.properties?.options;
        // `prefixItems` is a draft 2020-12 construct; the four-option constraint
        // is carried by minItems/maxItems instead, with Zod enforcing each slot.
        expect(options).toMatchObject({ type: "array", minItems: 4, maxItems: 4 });
        expect(options).not.toHaveProperty("prefixItems");
    });

    it("never forwards strict mode, which the generated schema cannot satisfy", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const format = (request as {
            response_format?: { json_schema?: { strict?: boolean } };
        }).response_format;

        // Constrained decoding requires `additionalProperties: false` everywhere
        // and only accepts a subset of JSON Schema; the best-effort mode is the
        // documented one for this schema, and Zod remains the authority.
        expect(format?.json_schema?.strict).toBeUndefined();
    });

    it("uses bounded reasoning effort and a capped completion budget", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const params = request as {
            reasoning_effort?: string;
            max_completion_tokens?: number;
            temperature?: number;
        };

        expect(params.reasoning_effort).toBe("low");
        expect(params.max_completion_tokens).toBe(MAX_GROQ_OUTPUT_TOKENS);
    });

    it("tolerates a model that wraps its JSON in a markdown fence", async () => {
        respondWithText("```json\n" + JSON.stringify(buildValidStudyOutput()) + "\n```");

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
    });

    it("falls back to the default model when GROQ_MODEL is unset", async () => {
        delete process.env["GROQ_MODEL"];
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        expect((request as { model: string }).model).toBe(DEFAULT_GROQ_MODEL);
    });

    it("treats a null completion content as an empty response", async () => {
        // Reasoning models can return a null content rather than a partial
        // string; that must not crash the stage.
        create.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("EMPTY_MODEL_RESPONSE");
    });
});

describe("unusable model responses", () => {
    it("turns malformed JSON into a typed error with a safe message", async () => {
        respondWithText("{ this is not json");

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error).toBeInstanceOf(AiGenerationError);
        expect(error.code).toBe("MALFORMED_MODEL_RESPONSE");
        expect(error.message).not.toContain("this is not json");
        expect(error.message).not.toContain(API_KEY);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("reports an empty response without claiming success", async () => {
        respondWithText("   ");

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("EMPTY_MODEL_RESPONSE");
    });

    it("retries exactly once when the quiz has the wrong length", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as unknown[]).length = REQUIRED_QUIZ_QUESTION_COUNT - 1;
        respondWithPayload(invalid);
        respondWithPayload(invalid);

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("OUTPUT_SCHEMA_MISMATCH");
        expect(create).toHaveBeenCalledTimes(2);
        expect(error.message).not.toContain(REQUIRED_QUIZ_QUESTION_COUNT.toString());
    });

    it("recovers when the retry returns a valid response", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as unknown[]).length = REQUIRED_QUIZ_QUESTION_COUNT - 1;
        respondWithPayload(invalid);
        respondWithPayload(buildValidStudyOutput());

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
        expect(create).toHaveBeenCalledTimes(2);
    });

    it("rejects a question whose correctIndex is out of range", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as Array<{ correctIndex: number }>)[0]!.correctIndex = 7;
        respondWithPayload(invalid);
        respondWithPayload(invalid);

        await expect(generateStudyMaterial(buildTestDocument())).rejects.toMatchObject({
            code: "OUTPUT_SCHEMA_MISMATCH",
        });
    });

    it("rejects a question with fewer than four options", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as Array<{ options: string[] }>)[0]!.options = ["A", "B", "C"];
        respondWithPayload(invalid);
        respondWithPayload(invalid);

        await expect(generateStudyMaterial(buildTestDocument())).rejects.toMatchObject({
            code: "OUTPUT_SCHEMA_MISMATCH",
        });
    });

    it("refuses a document with no text at all without calling the model", async () => {
        const empty = buildTestDocument({ aggregatedText: "   \n  " });

        await expect(generateStudyMaterial(empty)).rejects.toMatchObject({
            code: "EMPTY_DOCUMENT",
        });
        expect(create).not.toHaveBeenCalled();
    });
});

describe("provider errors are handled safely", () => {
    it("reports a rate limit as a typed, safe failure", async () => {
        rejectWith(sdkError("RateLimitError", 429));

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error).toBeInstanceOf(AiGenerationError);
        expect(error.code).toBe("GROQ_REQUEST_FAILED");
        expect(error.message).not.toContain(API_KEY);
        expect(error.message).not.toContain("upstream detail");
    });

    it("reports an authentication failure without leaking the key", async () => {
        rejectWith(sdkError("AuthenticationError", 401));

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("GROQ_REQUEST_FAILED");
        expect(error.message).not.toContain(API_KEY);
    });

    it("gives a client timeout its own code", async () => {
        rejectWith(sdkError("APIConnectionTimeoutError"));

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("AI_REQUEST_TIMEOUT");
        expect(error.message).not.toContain("upstream detail");
    });

    it("does not retry a transport failure", async () => {
        rejectWith(sdkError("APIConnectionError"));

        await expect(generateStudyMaterial(buildTestDocument())).rejects.toMatchObject({
            code: "GROQ_REQUEST_FAILED",
        });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("does not let the SDK retry behind the stage's back", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        // The stage owns its retry policy; a client-level retry would multiply
        // latency on requests it has already given up on.
        expect(clientOptions[0]?.maxRetries).toBe(0);
    });

    it("fails with a configuration error when GROQ_API_KEY is unset", async () => {
        delete process.env["GROQ_API_KEY"];

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("MISSING_API_KEY");
        expect(error.message).not.toContain("=");
        expect(create).not.toHaveBeenCalled();
        expect(clientOptions).toHaveLength(0);
    });

    it("keeps the API key out of the error, the prompt, and the result", async () => {
        respondWithPayload(buildValidStudyOutput());

        const output = await generateStudyMaterial(buildTestDocument());

        const [request] = create.mock.calls[0] ?? [];
        const serialised = JSON.stringify(request);
        expect(clientOptions[0]?.apiKey).toBe(API_KEY);
        expect(serialised).not.toContain(API_KEY);
        expect(JSON.stringify(output)).not.toContain(API_KEY);
    });
});

describe("diagram regeneration through the Groq client", () => {
    it("requests only the diagram shape", async () => {
        respondWithPayload({
            mermaidCode: "flowchart TD\n  A[A] --> B[B]",
            diagramType: "flowchart",
            explanation: "A simple replacement.",
        });

        const diagram = await regenerateDiagram(document, ["The diagram was not valid Mermaid syntax."]);

        expect(diagram.diagramType).toBe("flowchart");

        const [request] = create.mock.calls[0] ?? [];
        const format = (request as {
            response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
        }).response_format;

        // Only the diagram fields, not a full study payload: the rejection is a
        // rendering problem, so re-running the whole stage would waste a request.
        expect(Object.keys(format?.json_schema?.schema?.properties ?? {}).sort()).toEqual([
            "diagramType",
            "explanation",
            "mermaidCode",
        ]);
    });

    it("throws a typed error so the caller can fall back to a safe diagram", async () => {
        rejectWith(sdkError("RateLimitError", 429));

        const error = (await regenerateDiagram(document, ["rejected"]).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error).toBeInstanceOf(AiGenerationError);
        expect(error.code).toBe("GROQ_REQUEST_FAILED");
        expect(error.message).not.toContain(API_KEY);
    });

    it("rejects a replacement diagram that fails its schema", async () => {
        respondWithPayload({ mermaidCode: "", diagramType: "flowchart", explanation: "x" });

        await expect(regenerateDiagram(document, ["rejected"])).rejects.toMatchObject({
            code: "OUTPUT_SCHEMA_MISMATCH",
        });
    });
});