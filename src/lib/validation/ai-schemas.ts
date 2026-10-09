import { z } from "zod";

import {
    MAX_MERMAID_CODE_LENGTH,
    QUIZ_OPTION_COUNT,
    REQUIRED_QUIZ_QUESTION_COUNT,
} from "@/lib/constants/limits";

const nonEmptyString = (max: number) => z.string().trim().min(1).max(max);

export const SummarySectionSchema = z.object({
    /** Matches `unitIndex` on the originating canonical section (1-indexed). */
    sectionIndex: z.number().int().min(1),
    title: nonEmptyString(200),
    summary: nonEmptyString(2_000),
});

export const SummarySchema = z.object({
    tldr: nonEmptyString(2_000),
    keyTakeaways: z.array(nonEmptyString(500)).min(1).max(12),
    sectionBreakdowns: z.array(SummarySectionSchema).max(200),
});

/**
 * Diagram metadata only. The Mermaid source is sanitized and parse-checked
 * separately (see `src/lib/mermaid`), so only shape is enforced here.
 */
export const DiagramSchema = z.object({
    mermaidCode: nonEmptyString(MAX_MERMAID_CODE_LENGTH),
    diagramType: nonEmptyString(100),
    explanation: nonEmptyString(2_000),
});

export const QuizQuestionSchema = z.object({
    id: nonEmptyString(50),
    question: nonEmptyString(1_000),
    options: z.tuple([
        nonEmptyString(300),
        nonEmptyString(300),
        nonEmptyString(300),
        nonEmptyString(300),
    ]),
    correctIndex: z.number().int().min(0).max(QUIZ_OPTION_COUNT - 1),
    explanation: nonEmptyString(1_500),
});

export const QuizSchema = z
    .array(QuizQuestionSchema)
    .length(REQUIRED_QUIZ_QUESTION_COUNT, {
        error: `Quiz must contain exactly ${REQUIRED_QUIZ_QUESTION_COUNT} questions.`,
    })
    .superRefine((questions, ctx) => {
        const seen = new Set<string>();
        questions.forEach((question, position) => {
            if (seen.has(question.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: [position, "id"],
                    message: `Duplicate quiz question id "${question.id}".`,
                });
            }
            seen.add(question.id);
        });
    });

export const StudyOutputSchema = z.object({
    summary: SummarySchema,
    diagram: DiagramSchema,
    quiz: QuizSchema,
});

export type SummarySection = z.infer<typeof SummarySectionSchema>;
export type StudySummary = z.infer<typeof SummarySchema>;
export type StudyDiagram = z.infer<typeof DiagramSchema>;
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>;
export type StudyQuiz = z.infer<typeof QuizSchema>;
export type StudyOutput = z.infer<typeof StudyOutputSchema>;

export type ValidationSuccess<T> = { success: true; data: T };
export type ValidationFailure = { success: false; issues: string[] };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function toIssues(error: z.ZodError): string[] {
    return error.issues.map(
        (issue) => `${issue.path.join(".") || "response"}: ${issue.message}`,
    );
}

/** Validate an untrusted Gemini payload against the application schemas. */
export function validateStudyOutput(input: unknown): ValidationResult<StudyOutput> {
    const result = StudyOutputSchema.safeParse(input);
    return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: toIssues(result.error) };
}

/** Validate the quiz in isolation, e.g. when regenerating only the quiz. */
export function validateQuiz(input: unknown): ValidationResult<StudyQuiz> {
    const result = QuizSchema.safeParse(input);
    return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: toIssues(result.error) };
}

/**
 * Validate a diagram in isolation.
 *
 * Used by the single diagram-regeneration attempt, which produces a
 * `diagram` object on its own rather than a whole study payload. Shape only:
 * sanitisation and parse-gating happen in `src/lib/mermaid`.
 */
export function validateDiagram(input: unknown): ValidationResult<StudyDiagram> {
    const result = DiagramSchema.safeParse(input);
    return result.success
        ? { success: true, data: result.data }
        : { success: false, issues: toIssues(result.error) };
}