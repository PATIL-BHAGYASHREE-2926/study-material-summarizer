import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPdf } from "../fixtures/documents";
import type { SummarizeResponse } from "@/types/summarize-response";

/**
 * The route is the only place a browser ever sees a document failure, so the
 * status code and payload for each class of failure are pinned here rather than
 * at the extractor, which only decides the error *code*.
 *
 * The AI stage is stubbed: these tests are about what the route does with a
 * document error, and a real model call would make them depend on a key, a
 * network and a nondeterministic response.
 */

const { generateStudyMaterial } = vi.hoisted(() => ({ generateStudyMaterial: vi.fn() }));

vi.mock("@/lib/ai/generate-study-material", () => ({ generateStudyMaterial }));
vi.mock("@/lib/ai/regenerate-diagram", () => ({ regenerateDiagram: vi.fn() }));

afterEach(() => {
    // `doMock` outlives the module registry, so it has to be undone explicitly
    // or the next case inherits a stubbed pdf.js.
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.worker.mjs");
    vi.resetModules();
    vi.clearAllMocks();
});

/**
 * POST `bytes` as a PDF to the route.
 *
 * The bytes are copied into a fresh `ArrayBuffer` because `buildPdf` returns a
 * view whose buffer TypeScript will not accept as a `BlobPart`.
 */
async function postPdf(bytes: Uint8Array, fileName = "lecture.pdf") {
    const { POST } = await import("@/app/api/summarize/route");
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);

    const form = new FormData();
    form.append("file", new File([body], fileName, { type: "application/pdf" }));

    const response = await POST(
        new Request("http://localhost/api/summarize", { method: "POST", body: form }),
    );
    const parsed = (await response.json()) as SummarizeResponse;

    return {
        response,
        body: parsed,
        // Narrowed at the call site: every case below asserts on a failure.
        error: parsed.ok ? null : parsed.error,
    };
}

describe("POST /api/summarize", () => {
    it("reports a damaged PDF as the client's problem, with no retry hint", async () => {
        const { response, error } = await postPdf(
            new TextEncoder().encode("%PDF-1.7\ngarbage\n%%EOF"),
        );

        expect(response.status).toBe(422);
        expect(error).toMatchObject({ code: "CORRUPTED_PDF", retryable: false });
        expect(response.headers.get("Retry-After")).toBeNull();
        expect(generateStudyMaterial).not.toHaveBeenCalled();
    });

    it("reports an unusable document reader as a retryable service failure", async () => {
        // A deployment fault, so it must not be reported as a bad upload: 503,
        // retryable, with a backoff hint and nothing from the internals.
        vi.doMock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => ({}));

        const { response, error } = await postPdf(
            buildPdf([{ heading: "Retrieval", body: ["Chunking splits documents."] }]),
        );

        expect(response.status).toBe(503);
        expect(error).toMatchObject({ code: "PARSER_UNAVAILABLE", retryable: true });
        expect(response.headers.get("Retry-After")).toBe("5");
        expect(error?.message).not.toMatch(/corrupted|damaged|pdf\.js|node_modules/i);
    });

    it("still extracts a valid PDF and hands the canonical document to the AI stage", async () => {
        // The AI stage is stopped here on purpose: the assertion is about what
        // extraction handed over, not about what the model did with it.
        generateStudyMaterial.mockRejectedValue(new Error("stop here"));

        await postPdf(buildPdf([{ heading: "Retrieval", body: ["Chunking splits documents."] }]));

        expect(generateStudyMaterial).toHaveBeenCalledTimes(1);
        expect(generateStudyMaterial.mock.calls[0]?.[0]).toMatchObject({
            metadata: { sourceType: "pdf", totalUnits: 1 },
            sections: [{ unitIndex: 1, title: "Retrieval" }],
        });
    });
});