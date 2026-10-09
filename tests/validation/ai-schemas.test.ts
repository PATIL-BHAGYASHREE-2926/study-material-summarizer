import { describe, expect, it } from "vitest";

import { REQUIRED_QUIZ_QUESTION_COUNT } from "@/lib/constants/limits";
import {
    QuizQuestionSchema,
    StudyOutputSchema,
    validateQuiz,
    validateStudyOutput,
    type QuizQuestion,
} from "@/lib/validation/ai-schemas";

function makeQuestion(index: number, overrides: Partial<QuizQuestion> = {}) {
    return {
        id: `q${index}`,
        question: `Question ${index}?`,
        options: [`A${index}`, `B${index}`, `C${index}`, `D${index}`],
        correctIndex: 0,
        explanation: `Because ${index}.`,
        ...overrides,
    } as const;
}

function makeQuiz(count = REQUIRED_QUIZ_QUESTION_COUNT): QuizQuestion[] {
    return Array.from({ length: count }, (_, index) =>
        makeQuestion(index + 1) as unknown as QuizQuestion,
    );
}

const validSummary = {
    tldr: "A short summary of the material.",
    keyTakeaways: ["First takeaway.", "Second takeaway."],
    sectionBreakdowns: [
        { sectionIndex: 1, title: "Slide 1", summary: "Introduces the topic." },
    ],
};

const validDiagram = {
    mermaidCode: "flowchart TD\n  A[Start] --> B[End]",
    diagramType: "flowchart",
    explanation: "Shows the flow of the process.",
};

describe("validateQuiz", () => {
    it("accepts exactly 20 valid questions", () => {
        const result = validateQuiz(makeQuiz());

        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toHaveLength(20);
    });

    it("rejects fewer than 20 questions", () => {
        const result = validateQuiz(makeQuiz(19));

        expect(result.success).toBe(false);
        if (!result.success) expect(result.issues[0]).toContain("exactly 20");
    });

    it("rejects more than 20 questions", () => {
        const result = validateQuiz(makeQuiz(21));

        expect(result.success).toBe(false);
    });

    it("rejects an empty quiz", () => {
        expect(validateQuiz([]).success).toBe(false);
    });

    it("rejects duplicate question ids", () => {
        const quiz = makeQuiz();
        const duplicate = quiz[1];
        if (!duplicate) throw new Error("fixture missing");

        const result = validateQuiz([...quiz.slice(0, 19), { ...duplicate }]);

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.issues.join(" ")).toContain("Duplicate quiz question id");
        }
    });

    it.each([0, 1, 2, 3])("accepts correctIndex %i", (correctIndex) => {
        const result = validateQuiz([
            ...makeQuiz().slice(0, 19),
            makeQuestion(20, { correctIndex }) as unknown as QuizQuestion,
        ]);

        expect(result.success).toBe(true);
    });

    it.each([-1, 4, 1.5, Number.NaN])("rejects correctIndex %p", (correctIndex) => {
        const result = validateQuiz([
            ...makeQuiz().slice(0, 19),
            makeQuestion(20, { correctIndex }) as unknown as QuizQuestion,
        ]);

        expect(result.success).toBe(false);
    });

    it("rejects a question with the wrong number of options", () => {
        const threeOptions = makeQuestion(20, {
            options: ["A", "B", "C"],
        } as unknown as Partial<QuizQuestion>);

        expect(QuizQuestionSchema.safeParse(threeOptions).success).toBe(false);
    });

    it("rejects a question with five options", () => {
        const fiveOptions = makeQuestion(20, {
            options: ["A", "B", "C", "D", "E"],
        } as unknown as Partial<QuizQuestion>);

        expect(QuizQuestionSchema.safeParse(fiveOptions).success).toBe(false);
    });

    it("rejects an empty option", () => {
        const emptyOption = makeQuestion(20, {
            options: ["A", "   ", "C", "D"],
        } as unknown as Partial<QuizQuestion>);

        expect(QuizQuestionSchema.safeParse(emptyOption).success).toBe(false);
    });

    it("rejects a blank explanation", () => {
        const noExplanation = makeQuestion(20, { explanation: "  " });

        expect(QuizQuestionSchema.safeParse(noExplanation).success).toBe(false);
    });
});

describe("validateStudyOutput", () => {
    it("accepts a complete payload", () => {
        const result = validateStudyOutput({
            summary: validSummary,
            diagram: validDiagram,
            quiz: makeQuiz(),
        });

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.summary.keyTakeaways).toHaveLength(2);
            expect(result.data.diagram.diagramType).toBe("flowchart");
            expect(result.data.quiz).toHaveLength(20);
        }
    });

    it("rejects a payload missing the diagram", () => {
        const result = validateStudyOutput({
            summary: validSummary,
            quiz: makeQuiz(),
        });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.issues.join(" ")).toContain("diagram");
        }
    });

    it("rejects a payload with no takeaways", () => {
        const result = validateStudyOutput({
            summary: { ...validSummary, keyTakeaways: [] },
            diagram: validDiagram,
            quiz: makeQuiz(),
        });

        expect(result.success).toBe(false);
    });

    it("rejects an empty TL;DR", () => {
        const result = validateStudyOutput({
            summary: { ...validSummary, tldr: "   " },
            diagram: validDiagram,
            quiz: makeQuiz(),
        });

        expect(result.success).toBe(false);
    });

    it("rejects a section breakdown with a non-positive index", () => {
        const result = validateStudyOutput({
            summary: {
                ...validSummary,
                sectionBreakdowns: [
                    { sectionIndex: 0, title: "Slide 0", summary: "Bad index." },
                ],
            },
            diagram: validDiagram,
            quiz: makeQuiz(),
        });

        expect(result.success).toBe(false);
    });

    it("rejects a payload that is not an object", () => {
        expect(validateStudyOutput(null).success).toBe(false);
        expect(validateStudyOutput("summary").success).toBe(false);
    });

    it("is exported as a schema usable for nested parsing", () => {
        expect(StudyOutputSchema.safeParse({}).success).toBe(false);
    });
});