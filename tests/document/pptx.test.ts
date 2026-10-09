import { describe, expect, it } from "vitest";

import { DocumentProcessingError } from "@/lib/document/errors";
import { extractPptxDocument, resolvePartPath } from "@/lib/document/pptx";
import {
    buildGarbageBytes,
    buildPlainZip,
    buildPptx,
    p,
    sub,
    type PptxSlideSpec,
} from "../fixtures/documents";

async function extract(slides: PptxSlideSpec[], title?: string, fileName = "Week 1") {
    return extractPptxDocument(await buildPptx({ slides, title }), fileName);
}

describe("resolvePartPath", () => {
    it("resolves a sibling-relative target", () => {
        expect(resolvePartPath("ppt/presentation.xml", "slides/slide1.xml")).toBe(
            "ppt/slides/slide1.xml",
        );
    });

    it("resolves a parent-relative target", () => {
        expect(
            resolvePartPath("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml"),
        ).toBe("ppt/notesSlides/notesSlide1.xml");
    });

    it("treats a leading slash as a package-absolute target", () => {
        expect(
            resolvePartPath("ppt/presentation.xml", "/ppt/slides/slide1.xml"),
        ).toBe("ppt/slides/slide1.xml");
    });

    it("clamps traversal at the package root instead of escaping it", () => {
        // The resolved path is only ever used as a JSZip entry key, never as a
        // filesystem path, so the clamp keeps the lookup inside the package.
        expect(resolvePartPath("ppt/slide.xml", "../../../../etc/passwd")).toBe(
            "etc/passwd",
        );
        expect(resolvePartPath("ppt/slides/slide1.xml", "../../../..")).toBe("");
    });

    it("ignores redundant separators and dot segments", () => {
        expect(resolvePartPath("ppt/presentation.xml", "./slides//slide1.xml")).toBe(
            "ppt/slides/slide1.xml",
        );
    });

    it("normalises backslash separators", () => {
        expect(resolvePartPath("ppt/presentation.xml", "slides\\slide1.xml")).toBe(
            "ppt/slides/slide1.xml",
        );
    });
});

describe("extractPptxDocument", () => {
    it("extracts one section per slide with 1-indexed slide numbers", async () => {
        const document = await extract([
            { title: "Intro", paragraphs: [p("Welcome")] },
            { title: "Agenda", paragraphs: [p("Topics")] },
            { title: "Thanks", paragraphs: [p("Questions")] },
        ]);

        expect(document.metadata.sourceType).toBe("pptx");
        expect(document.sections.map((section) => section.unitIndex)).toEqual([1, 2, 3]);
        expect(document.metadata.totalUnits).toBe(3);
    });

    it("extracts slide titles", async () => {
        const document = await extract([
            { title: "Photosynthesis", paragraphs: [p("Plants convert light.")] },
        ]);

        expect(document.sections[0]?.title).toBe("Photosynthesis");
    });

    it("extracts body paragraphs as separate lines", async () => {
        const document = await extract([
            {
                title: "Types",
                paragraphs: [p("Cellular respiration"), p("Fermentation"), p("Glycolysis")],
            },
        ]);

        expect(document.sections[0]?.content).toBe(
            "Cellular respiration\nFermentation\nGlycolysis",
        );
    });

    it("does not repeat the title in the body content", async () => {
        const document = await extract([
            { title: "Unique Title", paragraphs: [p("Body text here.")] },
        ]);

        expect(document.sections[0]?.content).toBe("Body text here.");
    });

    it("preserves bullet hierarchy as indentation", async () => {
        const document = await extract([
            {
                title: "Outline",
                paragraphs: [p("Top level"), sub("Nested level", 1), sub("Deeply nested", 2)],
            },
        ]);

        expect(document.sections[0]?.content).toBe(
            "Top level\n  Nested level\n    Deeply nested",
        );
    });

    it("extracts tables as pipe-delimited rows", async () => {
        const document = await extract([
            {
                title: "Grades",
                table: [
                    ["Name", "Score"],
                    ["Ada", "95"],
                    ["Alan", "88"],
                ],
            },
        ]);

        const content = document.sections[0]?.content ?? "";
        expect(content).toContain("Table:");
        expect(content).toContain("| Name | Score |");
        expect(content).toContain("| Ada | 95 |");
        expect(content).toContain("| Alan | 88 |");
    });

    it("appends table content after body paragraphs", async () => {
        const document = await extract([
            {
                title: "Data",
                paragraphs: [p("Results below.")],
                table: [["a", "b"]],
            },
        ]);

        const content = document.sections[0]?.content ?? "";
        expect(content.indexOf("Results below.")).toBeLessThan(content.indexOf("Table:"));
    });

    it("extracts speaker notes when present", async () => {
        const document = await extract([
            { title: "With Notes", paragraphs: [p("Body")], notes: "Mention the exam date." },
        ]);

        expect(document.sections[0]?.notes).toBe("Mention the exam date.");
    });

    it("omits notes when a slide has none", async () => {
        const document = await extract([{ title: "No Notes", paragraphs: [p("Body")] }]);

        expect(document.sections[0]?.notes).toBeUndefined();
    });

    it("excludes slide-image and slide-number placeholders from notes", async () => {
        const document = await extract([
            { title: "S", paragraphs: [p("B")], notes: "Real speaker note." },
        ]);

        const notes = document.sections[0]?.notes ?? "";
        expect(notes).toBe("Real speaker note.");
        expect(notes).not.toMatch(/^\d+$/m);
    });

    it("includes notes in the aggregated text", async () => {
        const document = await extract([
            { title: "S", paragraphs: [p("B")], notes: "Remember this." },
        ]);

        expect(document.aggregatedText).toContain("Speaker notes: Remember this.");
    });

    it("uses the core properties title as the document title", async () => {
        const document = await extract(
            [{ title: "First Slide", paragraphs: [p("Body")] }],
            "Biology Revision",
        );

        expect(document.metadata.title).toBe("Biology Revision");
    });

    it("falls back to the first slide title when metadata has no title", async () => {
        const document = await extract([{ title: "Intro Deck", paragraphs: [p("Body")] }]);

        expect(document.metadata.title).toBe("Intro Deck");
    });

    it("falls back to the file name when neither source has a title", async () => {
        const document = await extract(
            [{ paragraphs: [p("Body without a title placeholder.")] }],
            undefined,
            "Physics Week 3",
        );

        expect(document.metadata.title).toBe("Physics Week 3");
    });

    it("orders slides by the presentation slide list, not by file name", async () => {
        const document = await extract([
            { title: "Shown First", paragraphs: [p("A")], partName: "slide9.xml" },
            { title: "Shown Second", paragraphs: [p("B")], partName: "slide2.xml" },
        ]);

        expect(document.sections[0]?.title).toBe("Shown First");
        expect(document.sections[1]?.title).toBe("Shown Second");
    });

    it("preserves slide numbering when an early slide is empty", async () => {
        const document = await extract([
            {},
            { title: "Second", paragraphs: [p("content")] },
        ]);

        expect(document.sections.map((section) => section.unitIndex)).toEqual([2]);
    });

    it("does not invent a title when no title placeholder exists", async () => {
        const document = await extract([{ paragraphs: [p("First Line"), p("body")] }]);

        // Guessing a title here would either mislabel the slide or drop a line
        // of content, so the shape's text stays entirely in the content.
        expect(document.sections[0]?.title).toBeUndefined();
        expect(document.sections[0]?.content).toBe("First Line\nbody");
    });

    it("joins a multi-line title placeholder into one phrase", async () => {
        const document = await extract([
            { title: "Neural Networks", paragraphs: [p("body")] },
        ]);

        expect(document.sections[0]?.title).toBe("Neural Networks");
    });

    it("labels aggregated text with slide numbers", async () => {
        const document = await extract([
            { title: "Alpha", paragraphs: [p("one")] },
            { title: "Beta", paragraphs: [p("two")] },
        ]);

        expect(document.aggregatedText).toContain("## slide 1: Alpha");
        expect(document.aggregatedText).toContain("## slide 2: Beta");
    });

    it("strips literal bullet glyphs from paragraph text", async () => {
        const document = await extract([
            { title: "Bullets", paragraphs: [p("\u2022 first item"), p("\u25cf second item")] },
        ]);

        expect(document.sections[0]?.content).toBe("first item\nsecond item");
    });

    it("counts words across content, titles and notes", async () => {
        const document = await extract([
            {
                title: "Two Words",
                paragraphs: [p("alpha beta gamma")],
                notes: "delta epsilon",
            },
        ]);

        expect(document.metadata.totalWords).toBe(7);
    });

    it("decodes XML entities in text", async () => {
        const document = await extract([
            { title: "Operators", paragraphs: [p("a < b && c > d")] },
        ]);

        expect(document.sections[0]?.content).toBe("a < b && c > d");
    });

    it("rejects empty input", async () => {
        await expect(
            extractPptxDocument(new Uint8Array(0), "empty"),
        ).rejects.toMatchObject({ code: "EMPTY_FILE" });
    });

    it("rejects bytes that are not a ZIP archive", async () => {
        await expect(
            extractPptxDocument(buildGarbageBytes(), "garbage"),
        ).rejects.toBeInstanceOf(DocumentProcessingError);
    });

    it("rejects a ZIP that is not an OpenXML presentation", async () => {
        const error = await extractPptxDocument(await buildPlainZip(), "deck").catch(
            (thrown: unknown) => thrown,
        );

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect((error as DocumentProcessingError).code).toBe("INVALID_PPTX_STRUCTURE");
    });

    it("rejects a package missing the presentation part", async () => {
        const bytes = await buildPptx({
            slides: [{ title: "T", paragraphs: [p("P")] }],
            omitPresentation: true,
        });

        await expect(extractPptxDocument(bytes, "deck")).rejects.toMatchObject({
            code: "INVALID_PPTX_STRUCTURE",
        });
    });

    it("rejects a presentation with no slides", async () => {
        await expect(extract([])).rejects.toMatchObject({
            code: "NO_EXTRACTABLE_SLIDES",
        });
    });

    it("rejects a presentation whose slide list is empty", async () => {
        const bytes = await buildPptx({ slides: [{ title: "T", paragraphs: [p("P")] }], omitSlideList: true });

        await expect(extractPptxDocument(bytes, "deck")).rejects.toMatchObject({
            code: "NO_EXTRACTABLE_SLIDES",
        });
    });

    it("rejects presentations over the slide limit", async () => {
        const slides = Array.from({ length: 101 }, (_, index) => ({
            title: `Slide ${index + 1}`,
            paragraphs: [p("content")],
        }));

        await expect(extract(slides)).rejects.toMatchObject({ code: "TOO_MANY_UNITS" });
    });

    it("accepts a presentation exactly at the slide limit", async () => {
        const slides = Array.from({ length: 100 }, (_, index) => ({
            title: `Slide ${index + 1}`,
            paragraphs: [p("content")],
        }));

        const document = await extract(slides);
        expect(document.metadata.totalUnits).toBe(100);
    });

    it("never leaks parser internals in the error message", async () => {
        const error = (await extractPptxDocument(buildGarbageBytes(), "deck").catch(
            (thrown: unknown) => thrown,
        )) as DocumentProcessingError;

        expect(error.message).not.toMatch(/[A-Za-z]:\\|\/home\/|node_modules|JSZip/);
        expect(error.code).toBe("CORRUPTED_PPTX");
    });
});

describe("extractPptxDocument resilience", () => {
    it("converts malformed slide XML into a typed, safe error", async () => {
        const bytes = await buildPptx({
            slides: [{ title: "T", paragraphs: [p("Body")] }],
            // An external entity declaration: parsers must refuse it, and the
            // refusal has to surface as a typed error rather than raw output.
            malformedSlideXml:
                '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
                "<p:sld xmlns:p=\"urn:p\"><p:cSld><p:spTree><p:sp/></p:spTree></p:cSld></p:sld>",
        });

        const error = (await extractPptxDocument(bytes, "deck").catch(
            (thrown: unknown) => thrown,
        )) as DocumentProcessingError;

        expect(error).toBeInstanceOf(DocumentProcessingError);
        expect(error.code).toBe("CORRUPTED_PPTX");
        expect(error.message).not.toMatch(/node_modules|fast-xml-parser|passwd/);
    });

    // Generous timeout: this test really does inflate ~64MB of zeroes through
    // JSZip before the budget trips, which is the behaviour under test. It costs
    // ~2.5s alone and overruns the 5s default when the file runs alongside the
    // PDF suites, so the limit is raised rather than the work weakened.
    it("rejects a package that expands beyond the size budget", { timeout: 60_000 }, async () => {
        const bytes = await buildPptx({
            slides: [{ title: "T", paragraphs: [p("Body")] }],
            oversizedFillerBytes: 96 * 1024 * 1024,
        });

        // The archive itself is tiny; only the declared expansion is large.
        expect(bytes.byteLength).toBeLessThan(200 * 1024);

        await expect(extractPptxDocument(bytes, "bomb.pptx")).rejects.toMatchObject({
            code: "PACKAGE_TOO_LARGE",
        });
    });

    it("resolves package-absolute relationship targets", async () => {
        const document = await extractPptxDocument(
            await buildPptx({
                slides: [
                    { title: "Absolute One", paragraphs: [p("A")] },
                    { title: "Absolute Two", paragraphs: [p("B")] },
                ],
                absoluteRelationshipTargets: true,
            }),
            "deck",
        );

        expect(document.sections.map((section) => section.title)).toEqual([
            "Absolute One",
            "Absolute Two",
        ]);
    });

    it("extracts text nested inside group shapes", async () => {
        const document = await extractPptxDocument(
            await buildPptx({
                slides: [{ title: "Grouped", paragraphs: [p("Grouped body text.")] }],
                wrapBodyInGroup: true,
            }),
            "deck",
        );

        expect(document.sections[0]?.content).toBe("Grouped body text.");
    });

    it("reads text nodes that carry xml:space", async () => {
        const document = await extractPptxDocument(
            await buildPptx({
                slides: [{ title: "Preserved", paragraphs: [p("Leading and trailing")] }],
                preserveSpaceAttribute: true,
            }),
            "deck",
        );

        expect(document.sections[0]?.content).toBe("Leading and trailing");
    });

    it("does not assume the DrawingML namespace prefix", async () => {
        const document = await extractPptxDocument(
            await buildPptx({
                slides: [{ title: "Prefixed", paragraphs: [p("Body under a custom prefix.")] }],
                drawingPrefix: "dml",
            }),
            "deck",
        );

        expect(document.sections[0]?.title).toBe("Prefixed");
        expect(document.sections[0]?.content).toBe("Body under a custom prefix.");
    });

    it("keeps numeric-looking cell values as text", async () => {
        const document = await extract([
            {
                title: "Numbers",
                table: [
                    ["Metric", "Value"],
                    ["Attempts", "42"],
                ],
            },
        ]);

        expect(document.sections[0]?.content).toContain("| Attempts | 42 |");
    });

    it("keeps boolean-looking text values", async () => {
        const document = await extract([
            { title: "Flags", paragraphs: [p("true"), p("false")] },
        ]);

        expect(document.sections[0]?.content).toBe("true\nfalse");
    });
});
