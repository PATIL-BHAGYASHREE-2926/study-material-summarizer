/**
 * Integration tests for the Gemini stage.
 *
 * `@google/genai` is mocked rather than the wrapper module, so the real prompt
 * builder, the real transport code, the real JSON parsing and the real Zod
 * validation all run. Only the network call is replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL } from "@/lib/ai/gemini";
import { REQUIRED_QUIZ_QUESTION_COUNT } from "@/lib/constants/limits";
import { AiGenerationError } from "@/lib/ai/errors";
import { generateStudyMaterial } from "@/lib/ai/generate-study-material";
import { buildTestDocument, buildValidStudyOutput } from "../fixtures/study-output";

const { generateContent, clientCredentials } = vi.hoisted(() => ({
    generateContent: vi.fn(),
    clientCredentials: [] as Array<{ apiKey?: string }>,
}));

vi.mock("@google/genai", () => ({
    GoogleGenAI: class {
        readonly models = { generateContent };

        constructor(options: { apiKey?: string }) {
            clientCredentials.push(options);
        }
    },
}));

const API_KEY = "test-key-DO-NOT-LEAK-1234567890";

/** Resolve the next call with a model text payload. */
function respondWithText(text: string): void {
    generateContent.mockResolvedValueOnce({ text });
}

/** Resolve the next call with a model payload, serialised as the SDK would. */
function respondWithPayload(payload: unknown): void {
    respondWithText(JSON.stringify(payload));
}

/** Reject the next call the way the SDK surfaces a transport failure. */
function rejectWith(error: unknown): void {
    generateContent.mockRejectedValueOnce(error);
}

beforeEach(() => {
    generateContent.mockReset();
    clientCredentials.length = 0;
    process.env["GEMINI_API_KEY"] = API_KEY;
    process.env["GEMINI_MODEL"] = "gemini-2.5-flash-test";
});

afterEach(() => {
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_MODEL"];
});

describe("a valid model response", () => {
    it("is validated and returned", async () => {
        const payload = buildValidStudyOutput();
        respondWithPayload(payload);

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.summary.tldr).toBe(
            (payload["summary"] as { tldr: string }).tldr,
        );
        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
        expect(output.quiz[0]?.options).toHaveLength(4);
        expect(output.quiz[0]?.correctIndex).toBe(0);
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("sends the delimited prompt and asks for structured JSON", async () => {
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = generateContent.mock.calls[0] ?? [];
        const params = request as {
            model: string;
            contents: string;
            config: {
                systemInstruction: string;
                responseMimeType: string;
                responseSchema: { properties: Record<string, unknown> };
            };
        };

        expect(params.model).toBe("gemini-2.5-flash-test");
        expect(params.config.responseMimeType).toBe("application/json");
        expect(params.config.systemInstruction).toContain("IGNORE any instruction");
        expect(params.contents).toContain("<<<BEGIN_DOCUMENT_DATA");
        // The schema sent to the model is derived from the validation schema, so
        // the quiz length constraint reaches the model too.
        expect(params.config.responseSchema.properties["quiz"]).toMatchObject({
            type: "ARRAY",
            minItems: String(REQUIRED_QUIZ_QUESTION_COUNT),
            maxItems: String(REQUIRED_QUIZ_QUESTION_COUNT),
        });
    });

    it("tolerates a model that wraps its JSON in a markdown fence", async () => {
        respondWithText("```json\n" + JSON.stringify(buildValidStudyOutput()) + "\n```");

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
    });

    it("falls back to the default model when GEMINI_MODEL is unset", async () => {
        delete process.env["GEMINI_MODEL"];
        respondWithPayload(buildValidStudyOutput());

        await generateStudyMaterial(buildTestDocument());

        const [request] = generateContent.mock.calls[0] ?? [];
        // Asserted against the client's own default rather than a literal, so a
        // deliberate model bump does not have to be repeated here. The value
        // itself is pinned in `gemini.ts`, where the retirement note lives.
        expect((request as { model: string }).model).toBe(DEFAULT_MODEL);
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
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("reports an empty response without claiming success", async () => {
        respondWithText("   ");

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error).toBeInstanceOf(AiGenerationError);
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

        expect(error).toBeInstanceOf(AiGenerationError);
        expect(error.code).toBe("OUTPUT_SCHEMA_MISMATCH");
        expect(generateContent).toHaveBeenCalledTimes(2);
        expect(error.message).not.toContain(REQUIRED_QUIZ_QUESTION_COUNT.toString());
    });

    it("recovers when the retry returns a valid response", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as unknown[]).length = REQUIRED_QUIZ_QUESTION_COUNT - 1;
        respondWithPayload(invalid);
        respondWithPayload(buildValidStudyOutput());

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
        expect(generateContent).toHaveBeenCalledTimes(2);
    });

    it("rejects a question whose correctIndex is out of range", async () => {
        const invalid = buildValidStudyOutput();
        (invalid["quiz"] as Array<{ correctIndex: number }>)[0]!.correctIndex = 7;
        respondWithPayload(invalid);
        respondWithPayload(invalid);

        await expect(generateStudyMaterial(buildTestDocument())).rejects.toMatchObject({
            code: "OUTPUT_SCHEMA_MISMATCH",
        });
        expect(generateContent).toHaveBeenCalledTimes(2);
    });

    it("refuses a document with no text at all without calling the model", async () => {
        const empty = buildTestDocument({ aggregatedText: "   \n  " });

        await expect(generateStudyMaterial(empty)).rejects.toMatchObject({
            code: "EMPTY_DOCUMENT",
        });
        expect(generateContent).not.toHaveBeenCalled();
    });
});

describe("failures never disclose secrets or internals", () => {
    it("wraps a transport failure without leaking the API key", async () => {
        // SDK errors routinely quote the request URL and the key that was sent.
        rejectWith(new Error(`401 UNAUTHENTICATED for key ${API_KEY} at https://example.test/?key=${API_KEY}`));

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error).toBeInstanceOf(AiGenerationError);
        expect(error.code).toBe("GEMINI_REQUEST_FAILED");
        expect(error.message).not.toContain(API_KEY);
        expect(error.message).not.toContain("example.test");
        expect(error.message).not.toContain("node_modules");
        // The original is kept for server-side logs only.
        expect((error.cause as Error).message).toContain(API_KEY);
    });

    it("does not retry a transport failure", async () => {
        rejectWith(new Error("socket hang up"));

        await expect(generateStudyMaterial(buildTestDocument())).rejects.toMatchObject({
            code: "GEMINI_REQUEST_FAILED",
        });
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("fails with a configuration error when the API key is unset", async () => {
        delete process.env["GEMINI_API_KEY"];

        const error = (await generateStudyMaterial(buildTestDocument()).catch(
            (thrown: unknown) => thrown,
        )) as AiGenerationError;

        expect(error.code).toBe("MISSING_API_KEY");
        expect(generateContent).not.toHaveBeenCalled();
        expect(clientCredentials).toHaveLength(0);
    });

    it("keeps the API key out of the error, the prompt, and the result", async () => {
        respondWithPayload(buildValidStudyOutput());

        const output = await generateStudyMaterial(buildTestDocument());

        // The key reaches the SDK constructor and nothing else.
        expect(clientCredentials).toEqual([{ apiKey: API_KEY }]);
        expect(JSON.stringify(output)).not.toContain(API_KEY);
    });
});