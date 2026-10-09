import { describe, expect, it } from "vitest";

import { DocumentProcessingError } from "@/lib/document/errors";
import { extractPdfDocument } from "@/lib/document/pdf";
import {
    buildCorruptPdf,
    buildGarbageBytes,
    buildPdf,
    type PdfPageSpec,
} from "../fixtures/documents";

async function extract(
    pages: PdfPageSpec[],
    info: Record<string, string> = {},
    fileName = "Lecture 1",
) {
    return extractPdfDocument(buildPdf(pages, info), fileName);
}

describe("extractPdfDocument", () => {
    it("extracts one section per page with 1-indexed page numbers", async () => {
        const document = await extract([
            { heading: "Introduction", body: ["Welcome to the course."] },
            { heading: "Definitions", body: ["A term is a word."] },
            { heading: "Summary", body: ["That is all."] },
        ]);

        expect(document.metadata.sourceType).toBe("pdf");
        expect(document.sections.map((section) => section.unitIndex)).toEqual([1, 2, 3]);
        expect(document.metadata.totalUnits).toBe(3);
    });

    it("extracts body text for every page", async () => {
        const document = await extract([
            { heading: "Page One", body: ["Alpha content."] },
            { heading: "Page Two", body: ["Beta content.", "Gamma content."] },
        ]);

        expect(document.sections[0]?.content).toBe("Alpha content.");
        expect(document.sections[1]?.content).toBe("Beta content.\nGamma content.");
    });

    it("captures the largest text on a page as the section title", async () => {
        const document = await extract([
            { heading: "Sorting Algorithms", body: ["Bubble sort is O(n squared)."] },
        ]);

        expect(document.sections[0]?.title).toBe("Sorting Algorithms");
    });

    it("does not duplicate the title inside the section content", async () => {
        const document = await extract([
            { heading: "Unique Heading", body: ["Body line."] },
        ]);

        const section = document.sections[0];
        expect(section?.title).toBe("Unique Heading");
        expect(section?.content).toBe("Body line.");
        expect(section?.content).not.toContain("Unique Heading");
    });

    it("uses the PDF info dictionary title as the document title", async () => {
        const document = await extract(
            [{ heading: "Chapter", body: ["Text."] }],
            { Title: "Operating Systems Notes" },
        );

        expect(document.metadata.title).toBe("Operating Systems Notes");
    });

    it("prefers document metadata over the file name", async () => {
        const document = await extract(
            [{ heading: "Chapter", body: ["Text."] }],
            { Title: "From Metadata" },
            "notes.pdf",
        );

        expect(document.metadata.title).toBe("From Metadata");
    });

    it("falls back to the file name when neither metadata nor page one yields a title", async () => {
        const document = await extractPdfDocument(
            buildPdf([{ body: ["Just body text, no heading."] }], { Author: "Ada" }),
            "Networking Basics",
        );

        expect(document.metadata.title).toBe("Networking Basics");
    });

    it("uses the first page heading when the PDF has no metadata title", async () => {
        const document = await extractPdfDocument(
            buildPdf([{ heading: "Transport Layer", body: ["TCP content."] }]),
            "notes.pdf",
        );

        expect(document.metadata.title).toBe("Transport Layer");
    });

    it("ignores a blank metadata title", async () => {
        const document = await extract(
            [{ body: ["Body without a heading."] }],
            { Title: "   " },
            "Fallback Name",
        );

        expect(document.metadata.title).toBe("Fallback Name");
    });

    it("counts words across all sections", async () => {
        const document = await extract([
            { heading: "One", body: ["alpha beta gamma"] },
            { heading: "Two", body: ["delta epsilon"] },
        ]);

        expect(document.metadata.totalWords).toBeGreaterThan(4);
    });

    it("produces aggregated text labelled with page numbers", async () => {
        const document = await extract([
            { heading: "First Page", body: ["Page one body."] },
            { heading: "Second Page", body: ["Page two body."] },
        ]);

        expect(document.aggregatedText).toContain("## page 1: First Page");
        expect(document.aggregatedText).toContain("## page 2: Second Page");
        expect(document.aggregatedText).toContain("Page two body.");
    });

    it("preserves the original page numbering when some pages have no text", async () => {
        const document = await extract([
            { heading: "First", body: ["Text one."] },
            { empty: true },
            { heading: "Third", body: ["Text three."] },
        ]);

        expect(document.sections.map((section) => section.unitIndex)).toEqual([1, 3]);
        expect(document.metadata.totalUnits).toBe(2);
    });

    it("rejects a document where no page has extractable text", async () => {
        await expect(extract([{ empty: true }, { empty: true }])).rejects.toMatchObject({
            name: "DocumentProcessingError",
            code: "NO_EXTRACTABLE_TEXT",
        });
    });

    it("rejects empty input", async () => {
        await expect(extractPdfDocument(new Uint8Array(0), "empty")).rejects.toMatchObject(
            { code: "EMPTY_FILE" },
        );
    });

    it("rejects a corrupted PDF", async () => {
        const error = await extractPdfDocument(buildCorruptPdf(), "broken").catch(
            (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect(["CORRUPTED_PDF", "NO_EXTRACTABLE_TEXT"]).toContain(
            (error as DocumentProcessingError).code,
        );
    });

    it("rejects bytes that are not a PDF at all", async () => {
        await expect(
            extractPdfDocument(buildGarbageBytes(), "garbage"),
        ).rejects.toBeInstanceOf(DocumentProcessingError);
    });

    it("never exposes parser internals or file paths in the error message", async () => {
        const error = (await extractPdfDocument(buildCorruptPdf(), "broken").catch(
            (thrown: unknown) => thrown,
        )) as DocumentProcessingError;

        expect(error.message).not.toMatch(/[A-Za-z]:\\|\/home\/|node_modules|pdf\.js/);
        expect(error.message).not.toMatch(/InvalidPDFException|Name:\s/);
        // The original failure is retained for logging but never shown.
        expect(error.cause).toBeDefined();
        expect(String(error.cause)).not.toBe(error.message);
    });

    it("rejects documents over the page limit", async () => {
        const pages = Array.from({ length: 101 }, (_, index) => ({
            heading: `Page ${index + 1}`,
            body: ["content"],
        }));

        await expect(extract(pages)).rejects.toMatchObject({
            code: "TOO_MANY_UNITS",
        });
    });

    it("accepts a document exactly at the page limit", async () => {
        const pages = Array.from({ length: 100 }, (_, index) => ({
            heading: `Page ${index + 1}`,
            body: ["content"],
        }));

        const document = await extract(pages);
        expect(document.metadata.totalUnits).toBe(100);
    });

    it("handles special characters and escapes in text", async () => {
        const document = await extract([
            {
                heading: "Operators",
                body: ["A (b) and C \\ d and 50% and $money"],
            },
        ]);

        expect(document.sections[0]?.content).toContain("(b)");
        expect(document.sections[0]?.content).toContain("50%");
        expect(document.sections[0]?.content).toContain("$money");
    });

    it("normalises non-ASCII text without mangling it", async () => {
        const document = await extract([
            { heading: "Café naïve", body: ["Résumé with accents: éàü"] },
        ]);

        expect(document.sections[0]?.title).toContain("Café");
        expect(document.sections[0]?.content).toContain("éàü");
    });

    it("handles lines reported via hasEOL inside a single text block", async () => {
        // pdf.js flags `hasEOL` on the run that *ends* a line. The extractor has
        // to flush after appending that run, or every line loses its last word.
        const document = await extract([
            {
                heading: "Single Block",
                body: ["First body line.", "Second body line."],
                singleTextBlock: true,
            },
        ]);

        expect(document.sections[0]?.content).toContain("First body line.");
        expect(document.sections[0]?.content).toContain("Second body line.");
        // A truncated line would show up as text bleeding into the next line.
        expect(document.sections[0]?.content).not.toMatch(/line\.Second/);
    });

    it("keeps the heading separate from the body in a single text block", async () => {
        const document = await extract([
            {
                heading: "Heading Here",
                body: ["Body follows."],
                singleTextBlock: true,
            },
        ]);

        expect(document.sections[0]?.title).toBe("Heading Here");
        expect(document.sections[0]?.content).not.toContain("Heading Here");
        expect(document.sections[0]?.content).toContain("Body follows.");
    });

    it("separates runs of one line that change font mid-line", async () => {
        // Two runs on the same baseline: without spacing they fuse into
        // "Helloworld".
        const document = await extract([
            {
                rawCommands:
                    "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj /F1 14 Tf 1 0 0 1 110 700 Tm (world) Tj ET",
            },
        ]);

        expect(document.sections[0]?.content).toContain("Hello");
        expect(document.sections[0]?.content).toContain("world");
        expect(document.sections[0]?.content).not.toMatch(/Helloworld/);
    });

    it("does not invent a heading from a uniformly sized page", async () => {
        const document = await extract([
            { rawCommands: "BT /F1 12 Tf 72 700 Td (Only one line.) Tj ET" },
        ]);

        expect(document.sections[0]?.title).toBeUndefined();
        expect(document.sections[0]?.content).toBe("Only one line.");
    });

    it("de-duplicates a heading that only differs by whitespace", async () => {
        const document = await extract([
            {
                heading: "Spaced   Heading",
                body: ["Body line."],
            },
        ]);

        expect(document.sections[0]?.title).toBe("Spaced Heading");
        expect(document.sections[0]?.content).not.toContain("Heading");
        expect(document.sections[0]?.content).toBe("Body line.");
    });

    it("maps a failure on a valid-header PDF to a typed error", async () => {
        // Valid header and cross-reference table, but the page tree points at a
        // page object that is missing.
        const bytes = buildPdf([{ body: ["content"] }]);
        const text = new TextDecoder().decode(bytes);
        const broken = text.replace("3 0 obj", "9 0 obj").replace("/Kids [3 0 R]", "/Kids [9 0 R]");

        const error = (await extractPdfDocument(
            new TextEncoder().encode(broken),
            "broken.pdf",
        ).catch((thrown: unknown) => thrown)) as DocumentProcessingError;

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect(error.message).not.toMatch(/[A-Za-z]:\\|\/home\/|node_modules|pdf\.js/);
    });

    it("reports a single, specific code for a truncated PDF", async () => {
        const bytes = buildPdf([{ body: ["content"] }]);
        const truncated = bytes.slice(0, Math.floor(bytes.byteLength / 2));

        const error = (await extractPdfDocument(truncated, "cut.pdf").catch(
            (thrown: unknown) => thrown,
        )) as DocumentProcessingError;

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect(["CORRUPTED_PDF", "NO_EXTRACTABLE_TEXT"]).toContain(error.code);
        expect(error.message).not.toMatch(/node_modules|pdf\.js/);
    });
});
