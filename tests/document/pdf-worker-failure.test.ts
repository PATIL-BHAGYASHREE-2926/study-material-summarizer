import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPdf } from "../fixtures/documents";

/**
 * A pdf.js that cannot run is a fault in the deployment, not in the upload.
 *
 * Reporting it as `CORRUPTED_PDF` is what turned a broken worker into "The PDF
 * could not be read. It may be corrupted or damaged" for every user who ever
 * uploaded a valid file, so all three routes into that failure are pinned here:
 * the worker module not exporting what pdf.js needs, pdf.js failing to start its
 * worker, and neither leaking internal detail to the user.
 *
 * The pdf.js api module is stubbed rather than the real one being reached for,
 * because it is the only way to drive `getDocument` into failing after the
 * worker has been registered - stubbing the worker module instead would fail
 * earlier, during import, and never reach the branch being tested here.
 */

/** The exact prefix pdf.js uses when its own worker setup fails. */
const WORKER_SETUP_FAILURE =
    'Setting up fake worker failed: "Cannot find module \'/app/.next/server/chunks/pdf.worker.mjs\'".';

/** A `PDFDocumentLoadingTask` whose promise rejects, as pdf.js's would. */
function rejectingLoadingTask(message: string) {
    return {
        promise: Promise.reject(new Error(message)),
        destroy: async () => undefined,
    };
}

/** A `PDFDocumentLoadingTask` whose `getDocument` call throws synchronously. */
function throwingLoadingTask() {
    return {
        getDocument: () => {
            throw new Error(WORKER_SETUP_FAILURE);
        },
    };
}

afterEach(() => {
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.worker.mjs");
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.resetModules();
});

describe("extractPdfDocument when the worker module is unusable", () => {
    it("reports the reader as unavailable instead of blaming the file", async () => {
        vi.doMock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => ({}));

        const { extractPdfDocument } = await import("@/lib/document/pdf");

        const error = (await extractPdfDocument(
            buildPdf([{ heading: "Retrieval", body: ["Chunking splits documents."] }]),
            "rag.pdf",
        ).catch((thrown: unknown) => thrown)) as { code?: string; message: string };

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("PARSER_UNAVAILABLE");
    });
});

describe("extractPdfDocument when pdf.js cannot start its worker", () => {
    it("classifies an asynchronously failing worker as unavailable", async () => {
        vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
            getDocument: () => rejectingLoadingTask(WORKER_SETUP_FAILURE),
        }));

        const { extractPdfDocument } = await import("@/lib/document/pdf");

        const error = (await extractPdfDocument(
            buildPdf([{ heading: "Retrieval", body: ["Chunking splits documents."] }]),
            "rag.pdf",
        ).catch((thrown: unknown) => thrown)) as { code?: string; message: string };

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("PARSER_UNAVAILABLE");
    });

    it("classifies a synchronously failing getDocument as unavailable", async () => {
        vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => throwingLoadingTask());

        const { extractPdfDocument } = await import("@/lib/document/pdf");

        const error = (await extractPdfDocument(
            buildPdf([{ body: ["content"] }]),
            "notes.pdf",
        ).catch((thrown: unknown) => thrown)) as { code?: string; message: string };

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("PARSER_UNAVAILABLE");
    });

    it("keeps the internal failure detail out of the message", async () => {
        vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
            getDocument: () => rejectingLoadingTask(WORKER_SETUP_FAILURE),
        }));

        const { extractPdfDocument } = await import("@/lib/document/pdf");

        const error = (await extractPdfDocument(
            buildPdf([{ body: ["content"] }]),
            "notes.pdf",
        ).catch((thrown: unknown) => thrown)) as { code?: string; message: string };

        expect(error.message).not.toMatch(/corrupted|damaged|pdf\.js|node_modules|[A-Za-z]:\\/i);
        expect(error.message).not.toContain("chunks/pdf.worker.mjs");
    });
});