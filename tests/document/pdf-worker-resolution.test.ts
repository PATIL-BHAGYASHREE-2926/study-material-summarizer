import { beforeAll, describe, expect, it } from "vitest";

import { buildCorruptPdf, buildPdf } from "../fixtures/documents";

/**
 * Regression coverage for the bundled-server pdf.js worker failure.
 *
 * pdf.js runs its worker in-process under Node and loads it lazily with
 * `import(GlobalWorkerOptions.workerSrc)`, which defaults to the relative path
 * `"./pdf.worker.mjs"`. That specifier is marked `webpackIgnore` / `vite-ignore`,
 * so a bundler deliberately leaves it alone. In the Next.js server build the
 * pdf.js api module is emitted into a chunk directory with no `pdf.worker.mjs`
 * beside it, so the import rejects with
 * `Cannot find module '.../chunks/pdf.worker.mjs'`, pdf.js turns that into
 * "Setting up fake worker failed", and *every* PDF upload was reported to the
 * user as a corrupted file - including perfectly valid ones.
 *
 * Unbundled, as in this suite, that relative path resolves perfectly well, so
 * the production condition is reproduced instead: `workerSrc` is pointed at a
 * path that does not exist, which is exactly what pdf.js sees once it has been
 * bundled. The fix is for the extractor to import the worker module itself -
 * which puts a usable handler on `globalThis.pdfjsWorker`, the slot pdf.js
 * consults before it resolves any path - so extraction has to keep working.
 *
 * Only the first case runs against a cold pdf.js worker memo; the two after it
 * execute once the memo is already resolved, which is the normal steady state
 * of a running server. They are here to pin what must stay true afterwards - the
 * slot is populated, and a genuinely damaged file is still called damaged - so
 * that neither a future change to the worker wiring nor the new
 * `PARSER_UNAVAILABLE` classification quietly swallows them.
 *
 * This file deliberately has no `beforeAll` that touches `getDocument`, so that
 * memo is still cold when the extractor first reaches for pdf.js. It is also a
 * file of its own because `pdfjs-dist` is externalised and `vi.resetModules()`
 * cannot hand back a fresh instance to undo an earlier test file's use.
 */

const workerSlot = globalThis as { pdfjsWorker?: unknown };

beforeAll(async () => {
    delete workerSlot.pdfjsWorker;

    const pdfJs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfJs.GlobalWorkerOptions.workerSrc = "./__pdf.worker.does-not-exist__.mjs";
});

describe("extractPdfDocument when pdf.js cannot resolve its own worker", () => {
    it("extracts a valid PDF because the extractor supplies the worker", async () => {
        const { extractPdfDocument } = await import("@/lib/document/pdf");

        const document = await extractPdfDocument(
            buildPdf([{ heading: "Retrieval", body: ["Chunking splits documents."] }]),
            "rag.pdf",
        );

        expect(document.metadata.sourceType).toBe("pdf");
        expect(document.sections[0]?.content).toBe("Chunking splits documents.");
    });

    it("registers the worker module on the slot pdf.js reads first", async () => {
        const { extractPdfDocument } = await import("@/lib/document/pdf");

        await extractPdfDocument(buildPdf([{ body: ["content"] }]), "notes.pdf");

        expect(workerSlot.pdfjsWorker).toBeDefined();
        expect(
            (workerSlot.pdfjsWorker as { WorkerMessageHandler?: unknown }).WorkerMessageHandler,
        ).toBeTypeOf("function");
    });

    it("still reports a genuinely damaged PDF as CORRUPTED_PDF", async () => {
        // Guards against the worker workaround masking the real corruption code.
        const { extractPdfDocument } = await import("@/lib/document/pdf");

        await expect(extractPdfDocument(buildCorruptPdf(), "broken.pdf")).rejects.toMatchObject({
            code: "CORRUPTED_PDF",
        });
    });
});