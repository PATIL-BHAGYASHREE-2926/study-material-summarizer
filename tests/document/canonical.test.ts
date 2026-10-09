import { describe, expect, it } from "vitest";

import { MAX_AGGREGATED_TEXT_CHARS } from "@/lib/constants/limits";
import { buildAggregatedText, buildCanonicalDocument } from "@/lib/document/canonical";
import { DocumentProcessingError } from "@/lib/document/errors";
import type { CanonicalDocumentSection } from "@/types/canonical-document";

function section(overrides: Partial<CanonicalDocumentSection> = {}): CanonicalDocumentSection {
    return {
        unitIndex: 1,
        content: "Some extracted content.",
        ...overrides,
    };
}

describe("buildAggregatedText", () => {
    it("labels each section with its unit number and title", () => {
        const text = buildAggregatedText(
            [section({ unitIndex: 3, title: "Loops", content: "A loop repeats work." })],
            "page",
        );

        expect(text).toBe("## page 3: Loops\nA loop repeats work.");
    });

    it("omits the title when the section has none", () => {
        expect(buildAggregatedText([section()], "slide")).toBe(
            "## slide 1\nSome extracted content.",
        );
    });

    it("includes speaker notes when present", () => {
        const text = buildAggregatedText(
            [section({ notes: "Emphasise this." })],
            "slide",
        );

        expect(text).toContain("Speaker notes: Emphasise this.");
    });

    it("separates sections with a blank line", () => {
        const text = buildAggregatedText(
            [section({ unitIndex: 1 }), section({ unitIndex: 2 })],
            "page",
        );

        expect(text).toBe(
            "## page 1\nSome extracted content.\n\n## page 2\nSome extracted content.",
        );
    });
});

describe("buildCanonicalDocument", () => {
    it("builds a canonical document from PDF sections", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "Lecture 1",
            sections: [
                section({ unitIndex: 1, title: "Intro", content: "one two three" }),
                section({ unitIndex: 2, content: "four five" }),
            ],
        });

        expect(document.metadata).toEqual({
            title: "Lecture 1",
            sourceType: "pdf",
            totalUnits: 2,
            // 3 + 1 (title) + 2
            totalWords: 6,
        });
        expect(document.sections).toHaveLength(2);
        expect(document.sections[0]?.title).toBe("Intro");
        expect(document.sections[1]?.title).toBeUndefined();
    });

    it("labels aggregated text with the correct unit noun per source type", () => {
        const pdf = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [section()],
        });
        const pptx = buildCanonicalDocument({
            sourceType: "pptx",
            title: "t",
            sections: [section()],
        });

        expect(pdf.aggregatedText).toContain("## page 1");
        expect(pptx.aggregatedText).toContain("## slide 1");
    });

    it("counts words across content, titles and notes", () => {
        const document = buildCanonicalDocument({
            sourceType: "pptx",
            title: "Deck",
            sections: [
                section({
                    unitIndex: 1,
                    title: "Two Words",
                    content: "three four five",
                    notes: "six seven",
                }),
            ],
        });

        expect(document.metadata.totalWords).toBe(7);
    });

    it("drops sections with no usable content", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [
                section({ unitIndex: 1, content: "kept" }),
                section({ unitIndex: 2, content: "   \n  " }),
                section({ unitIndex: 3, content: "- - -" }),
            ],
        });

        expect(document.sections.map((entry) => entry.unitIndex)).toEqual([1]);
        expect(document.metadata.totalUnits).toBe(1);
    });

    it("rejects a document where every section is empty", () => {
        expect(() =>
            buildCanonicalDocument({
                sourceType: "pdf",
                title: "t",
                sections: [section({ content: "" })],
            }),
        ).toThrow(DocumentProcessingError);
    });

    it("rejects an empty section list", () => {
        expect(() =>
            buildCanonicalDocument({ sourceType: "pdf", title: "t", sections: [] }),
        ).toThrow(/No readable text/);
    });

    it("sorts sections by unit index", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [
                section({ unitIndex: 10, content: "c" }),
                section({ unitIndex: 2, content: "a" }),
                section({ unitIndex: 5, content: "b" }),
            ],
        });

        expect(document.sections.map((entry) => entry.unitIndex)).toEqual([2, 5, 10]);
    });

    it("de-duplicates repeated unit indexes", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [
                section({ unitIndex: 1, content: "first" }),
                section({ unitIndex: 1, content: "second" }),
            ],
        });

        expect(document.sections).toHaveLength(1);
        expect(document.sections[0]?.content).toBe("first");
    });

    it("discards non-positive and non-integer unit indexes", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [
                section({ unitIndex: 0, content: "zero" }),
                section({ unitIndex: -3, content: "negative" }),
                section({ unitIndex: 1.5, content: "fraction" }),
                section({ unitIndex: 4, content: "valid" }),
            ],
        });

        expect(document.sections.map((entry) => entry.unitIndex)).toEqual([4]);
    });
    it("normalises whitespace in titles, content and notes", () => {
        const document = buildCanonicalDocument({
            sourceType: "pptx",
            title: "  Spaced   Title  ",
            sections: [
                section({
                    unitIndex: 1,
                    title: "\u00a0Title\u00a0With\u00a0Spaces",
                    content: "line one\n\n\n\nline two",
                    notes: "note with trailing space  ",
                }),
            ],
        });

        expect(document.metadata.title).toBe("Spaced Title");
        expect(document.sections[0]?.title).toBe("Title With Spaces");
        expect(document.sections[0]?.content).toBe("line one\nline two");
        expect(document.sections[0]?.notes).toBe("note with trailing space");
    });

    it("preserves outline indentation in PPTX content", () => {
        const document = buildCanonicalDocument({
            sourceType: "pptx",
            title: "Deck",
            sections: [
                section({
                    unitIndex: 1,
                    content: "Top level\n  Nested level\n    Deeply nested",
                }),
            ],
        });

        expect(document.sections[0]?.content).toBe(
            "Top level\n  Nested level\n    Deeply nested",
        );
    });

    it("falls back to a placeholder title when none is supplied", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "   ",
            sections: [section()],
        });

        expect(document.metadata.title).toBe("Untitled document");
    });

    it("caps a single oversized section", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [section({ unitIndex: 1, content: "word ".repeat(5_000) })],
        });

        const content = document.sections[0]?.content ?? "";
        expect(content.length).toBeLessThan(12_100);
        expect(content.endsWith("...")).toBe(true);
    });

    it("caps a very long section title", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [section({ unitIndex: 1, title: "T".repeat(500) })],
        });

        expect(document.sections[0]?.title?.length).toBe(200);
    });

    it("truncates aggregated text with a notice when over the prompt budget", () => {
        const oversized = "word ".repeat(4_000);
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: Array.from({ length: 100 }, (_, index) =>
                section({ unitIndex: index + 1, content: oversized }),
            ),
        });

        expect(document.aggregatedText).toContain("[Content truncated:");
        expect(document.aggregatedText.length).toBeLessThanOrEqual(
            MAX_AGGREGATED_TEXT_CHARS + 200,
        );
    });

    it("keeps aggregated text within budget for ordinary documents", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: Array.from({ length: 20 }, (_, index) =>
                section({ unitIndex: index + 1, content: "short content" }),
            ),
        });

        expect(document.aggregatedText.length).toBeLessThan(
            MAX_AGGREGATED_TEXT_CHARS,
        );
        expect(document.aggregatedText).not.toContain("[Content truncated:");
    });

    it("preserves source references for every section in aggregated text", () => {
        const document = buildCanonicalDocument({
            sourceType: "pdf",
            title: "t",
            sections: [
                section({ unitIndex: 7, title: "Trees", content: "root node" }),
            ],
        });

        expect(document.aggregatedText).toContain("## page 7: Trees");
    });
});
