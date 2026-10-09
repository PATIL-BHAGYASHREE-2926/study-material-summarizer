/**
 * Provider-selection tests.
 *
 * The point of these is that adding Groq did not displace Gemini: both clients
 * remain reachable, selection is explicit when configured, and neither client
 * can be constructed without its own credential.
 *
 * `groq-sdk` and `@google/genai` are both mocked, so the assertions can tell
 * which one was reached without any network call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveProvider } from "@/lib/ai/provider";
import { buildTestDocument } from "../fixtures/study-output";

const { groqCreate, geminiGenerate } = vi.hoisted(() => ({
    groqCreate: vi.fn(),
    geminiGenerate: vi.fn(),
}));

vi.mock("groq-sdk", () => ({
    default: class {
        readonly chat = { completions: { create: groqCreate } };
        constructor() {}
    },
}));

vi.mock("@google/genai", () => ({
    GoogleGenAI: class {
        readonly models = { generateContent: geminiGenerate };
        constructor() {}
    },
}));

const { generateStudyMaterial } = await import("@/lib/ai/generate-study-material");

const GROQ_KEY = "gsk-test-DO-NOT-LEAK-0000000001";
const GEMINI_KEY = "ai-test-DO-NOT-LEAK-0000000002";

/** A payload that satisfies every Zod schema the stage applies. */
function validPayload(): unknown {
    const questions = Array.from({ length: 20 }, (_unused, index) => ({
        id: `q${index + 1}`,
        question: `Question ${index + 1}?`,
        options: ["A", "B", "C", "D"],
        correctIndex: 0,
        explanation: "Because.",
    }));

    return {
        summary: {
            tldr: "A summary.",
            keyTakeaways: ["One."],
            sectionBreakdowns: [{ sectionIndex: 1, title: "T", summary: "S" }],
        },
        diagram: { mermaidCode: "flowchart TD\n  A --> B", diagramType: "flowchart", explanation: "E" },
        quiz: questions,
    };
}

beforeEach(() => {
    groqCreate.mockReset();
    geminiGenerate.mockReset();
    delete process.env["AI_PROVIDER"];
    delete process.env["GROQ_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
});

afterEach(() => {
    delete process.env["AI_PROVIDER"];
    delete process.env["GROQ_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
});

describe("provider selection", () => {
    it("prefers Groq when both providers are configured", () => {
        process.env["GROQ_API_KEY"] = GROQ_KEY;
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;

        expect(resolveProvider()).toBe("groq");
    });

    it("falls back to Gemini when only Gemini is configured", () => {
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;

        expect(resolveProvider()).toBe("gemini");
    });

    it("honours an explicit AI_PROVIDER over the credentials present", () => {
        // The operator's choice wins even when the other provider has a key.
        process.env["AI_PROVIDER"] = "gemini";
        process.env["GROQ_API_KEY"] = GROQ_KEY;

        expect(resolveProvider()).toBe("gemini");
    });

    it("is case-insensitive and ignores surrounding whitespace", () => {
        process.env["AI_PROVIDER"] = "  GROQ  ";

        expect(resolveProvider()).toBe("groq");
    });

    it("falls back rather than throwing on an unrecognised provider name", () => {
        // A typo in .env.local must not take the whole upload path down.
        process.env["AI_PROVIDER"] = "gropq";
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;

        expect(resolveProvider()).toBe("gemini");
    });

    it("names Groq when nothing is configured at all", () => {
        // The client it selects then raises MISSING_API_KEY, which is a precise
        // error; silently choosing another provider would not be.
        expect(resolveProvider()).toBe("groq");
    });

    it("ignores a blank credential rather than treating it as configured", () => {
        process.env["GROQ_API_KEY"] = "   ";
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;

        expect(resolveProvider()).toBe("gemini");
    });
});

describe("each provider still works end to end", () => {
    it("reaches Groq when it is selected", async () => {
        process.env["AI_PROVIDER"] = "groq";
        process.env["GROQ_API_KEY"] = GROQ_KEY;
        groqCreate.mockResolvedValueOnce({
            choices: [{ message: { content: JSON.stringify(validPayload()) } }],
        });

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(20);
        expect(groqCreate).toHaveBeenCalledTimes(1);
        expect(geminiGenerate).not.toHaveBeenCalled();
    });

    it("reaches Gemini when it is selected", async () => {
        process.env["AI_PROVIDER"] = "gemini";
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;
        geminiGenerate.mockResolvedValueOnce({ text: JSON.stringify(validPayload()) });

        const output = await generateStudyMaterial(buildTestDocument());

        expect(output.quiz).toHaveLength(20);
        expect(geminiGenerate).toHaveBeenCalledTimes(1);
        expect(groqCreate).not.toHaveBeenCalled();
    });

    it("does not construct the Groq client for a Gemini request", async () => {
        process.env["AI_PROVIDER"] = "gemini";
        process.env["GEMINI_API_KEY"] = GEMINI_KEY;
        groqCreate.mockResolvedValue({ choices: [{ message: { content: "{}" } }] });
        geminiGenerate.mockResolvedValueOnce({ text: JSON.stringify(validPayload()) });

        await generateStudyMaterial(buildTestDocument());

        expect(groqCreate).not.toHaveBeenCalled();
    });
});