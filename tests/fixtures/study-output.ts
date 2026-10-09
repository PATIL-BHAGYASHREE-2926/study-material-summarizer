import { REQUIRED_QUIZ_QUESTION_COUNT } from "@/lib/constants/limits";
import type { CanonicalDocument } from "@/types/canonical-document";

/**
 * Canonical-document and study-output builders for the AI-stage tests.
 *
 * Model output is validated by shape, so the fixtures are built to be genuinely
 * valid (twenty four-option questions, a Mermaid body, a summary) and can then
 * be broken in one place to drive a specific failure path.
 */

export function buildTestDocument(overrides: Partial<CanonicalDocument> = {}): CanonicalDocument {
    const base: CanonicalDocument = {
        metadata: {
            title: "Photosynthesis",
            sourceType: "pdf",
            totalUnits: 2,
            totalWords: 12,
        },
        sections: [
            { unitIndex: 1, title: "Overview", content: "Plants convert light into chemical energy." },
            { unitIndex: 2, title: "Stages", content: "Light-dependent reactions, then the Calvin cycle." },
        ],
        aggregatedText:
            "## page 1: Overview\nPlants convert light into chemical energy.\n\n## page 2: Stages\nLight-dependent reactions, then the Calvin cycle.",
    };

    return { ...base, ...overrides };
}

/** A minimal but fully valid `StudyOutput` payload as raw JSON-ready data. */
export function buildValidStudyOutput(): Record<string, unknown> {
    return {
        summary: {
            tldr: "Photosynthesis turns light into chemical energy in two stages.",
            keyTakeaways: [
                "Light-dependent reactions capture energy from light.",
                "The Calvin cycle fixes that energy into sugars.",
            ],
            sectionBreakdowns: [
                { sectionIndex: 1, title: "Overview", summary: "Defines the overall reaction." },
                { sectionIndex: 2, title: "Stages", summary: "Describes the two stages." },
            ],
        },
        diagram: {
            mermaidCode: "flowchart TD\n  Light[Light] --> Reactions[Light reactions]\n  Reactions --> Cycle[Calvin cycle]",
            diagramType: "flowchart",
            explanation: "Shows energy flowing from light into sugars.",
        },
        quiz: Array.from(
            { length: REQUIRED_QUIZ_QUESTION_COUNT },
            (_unused, index) => ({
                id: `q${index + 1}`,
                question: `Which statement is correct? (${index + 1})`,
                options: ["Option A", "Option B", "Option C", "Option D"],
                correctIndex: index % 4,
                explanation: "Because the document says so.",
            }),
        ),
    };
}