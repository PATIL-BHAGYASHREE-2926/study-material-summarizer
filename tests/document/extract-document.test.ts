import { describe, expect, it } from "vitest";

import { MIME_TYPES } from "@/lib/constants/limits";
import { DocumentProcessingError } from "@/lib/document/errors";
import { extractDocument } from "@/lib/document/index";
import { sanitizeFileName, validateUpload } from "@/lib/validation/upload";
import {
    buildCorruptPdf,
    buildGarbageBytes,
    buildPdf,
    buildPptx,
    p,
} from "../fixtures/documents";

const OLE2_HEADER = new Uint8Array([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

describe("extractDocument dispatch", () => {
    it("routes a PDF to the PDF extractor", async () => {
        const data = buildPdf([{ heading: "Chapter One", body: ["Body text."] }]);

        const document = await extractDocument({
            sourceType: "pdf",
            data,
            fileName: "lecture.pdf",
        });

        expect(document.metadata.sourceType).toBe("pdf");
        // With no PDF info dictionary, the first page's heading is the title.
        expect(document.metadata.title).toBe("Chapter One");
        expect(document.sections[0]?.title).toBe("Chapter One");
    });

    it("routes a PPTX to the PPTX extractor", async () => {
        const data = await buildPptx({
            slides: [{ title: "Intro Slide", paragraphs: [p("Body text.")] }],
        });

        const document = await extractDocument({
            sourceType: "pptx",
            data,
            fileName: "week-01.pptx",
        });

        expect(document.metadata.sourceType).toBe("pptx");
        expect(document.sections[0]?.title).toBe("Intro Slide");
    });

    it("rejects legacy PPT with a clear, actionable error", async () => {
        const error = (await extractDocument({
            sourceType: "ppt",
            data: new Uint8Array([1, 2, 3, 4]),
            fileName: "old.ppt",
        }).catch((thrown: unknown) => thrown)) as DocumentProcessingError;

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect(error.code).toBe("UNSUPPORTED_SOURCE_TYPE");
        expect(error.message).toMatch(/PDF or PPTX/i);
    });

    it("rejects an unknown source type without crashing", async () => {
        await expect(
            extractDocument({
                sourceType: "docx" as never,
                data: new Uint8Array([1, 2, 3]),
            }),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE_TYPE" });
    });

    it("derives a title from the file name when the document has none", async () => {
        const data = buildPdf([{ body: ["Just body text, no heading."] }]);

        const document = await extractDocument({
            sourceType: "pdf",
            data,
            fileName: "Database Systems Week 4.pdf",
        });

        expect(document.metadata.title).toBe("Database Systems Week 4");
    });

    it("falls back to a placeholder title when no file name is given", async () => {
        const data = buildPdf([{ body: ["Body."] }]);

        const document = await extractDocument({ sourceType: "pdf", data });

        expect(document.metadata.title).toBe("Untitled document");
    });

    it("surfaces extractor errors without wrapping them twice", async () => {
        await expect(
            extractDocument({ sourceType: "pdf", data: buildCorruptPdf(), fileName: "x.pdf" }),
        ).rejects.toBeInstanceOf(DocumentProcessingError);
    });

    it("rejects garbage bytes for either source type", async () => {
        await expect(
            extractDocument({ sourceType: "pdf", data: buildGarbageBytes() }),
        ).rejects.toBeInstanceOf(DocumentProcessingError);
        await expect(
            extractDocument({ sourceType: "pptx", data: buildGarbageBytes() }),
        ).rejects.toBeInstanceOf(DocumentProcessingError);
    });
});

describe("validateUpload to extractDocument handoff", () => {
    it("never routes a legacy .ppt file to an extractor", async () => {
        const data = new Uint8Array([...OLE2_HEADER, 1, 2, 3, 4]);

        const validation = validateUpload({
            fileName: "legacy-deck.ppt",
            sizeBytes: data.byteLength,
            declaredMimeType: MIME_TYPES.legacyPpt,
            headerBytes: data,
        });

        expect(validation).toMatchObject({
            ok: false,
            code: "LEGACY_PPT_UNSUPPORTED",
        });
        if (validation.ok) {
            throw new Error("legacy .ppt must never validate");
        }
        // A rejection carries no source type, so there is nothing to dispatch.
        expect("sourceType" in validation).toBe(false);
    });

    it("routes an OLE2 file renamed to .pptx to a rejection, not a parser", async () => {
        const data = new Uint8Array([...OLE2_HEADER, 0, 0, 0, 0]);

        const validation = validateUpload({
            fileName: "renamed-deck.pptx",
            sizeBytes: data.byteLength,
            declaredMimeType: MIME_TYPES.pptx,
            headerBytes: data,
        });

        expect(validation).toMatchObject({ code: "LEGACY_PPT_UNSUPPORTED" });
    });

    it("dispatches based on the verified signature, not the extension", async () => {
        const pdfBytes = buildPdf([{ heading: "Real PDF", body: ["Body."] }]);

        // The signature says PDF; routing must agree with it.
        const validation = validateUpload({
            fileName: "notes.pdf",
            sizeBytes: pdfBytes.byteLength,
            declaredMimeType: MIME_TYPES.pdf,
            headerBytes: pdfBytes,
        });

        expect(validation).toEqual({ ok: true, sourceType: "pdf" });

        if (!validation.ok) throw new Error("expected a valid upload");
        const document = await extractDocument({
            sourceType: validation.sourceType,
            data: pdfBytes,
            fileName: sanitizeFileName("notes.pdf"),
        });
        expect(document.metadata.sourceType).toBe("pdf");
    });

    it("produces a canonical document for both supported formats", async () => {
        const pdf = await extractDocument({
            sourceType: "pdf",
            data: buildPdf([{ heading: "PDF Title", body: ["PDF body."] }]),
            fileName: "a.pdf",
        });
        const pptx = await extractDocument({
            sourceType: "pptx",
            data: await buildPptx({
                slides: [{ title: "PPTX Title", paragraphs: [p("PPTX body.")] }],
            }),
            fileName: "a.pptx",
        });

        for (const document of [pdf, pptx]) {
            expect(document.metadata.title.length).toBeGreaterThan(0);
            expect(document.metadata.totalUnits).toBe(1);
            expect(document.metadata.totalWords).toBeGreaterThan(0);
            expect(document.sections[0]?.unitIndex).toBe(1);
            expect(document.aggregatedText.length).toBeGreaterThan(0);
        }
    });
});
