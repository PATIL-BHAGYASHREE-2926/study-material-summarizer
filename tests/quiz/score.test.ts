import { describe, expect, it } from "vitest";

import { QUIZ_OPTION_COUNT, REQUIRED_QUIZ_QUESTION_COUNT } from "@/lib/constants/limits";
import {
    PASS_MARK_PERCENTAGE,
    describeScore,
    hasPassed,
    isCompleteQuiz,
    scoreQuestion,
    scoreQuiz,
    type QuizAnswers,
} from "@/lib/quiz/score";
import {
    QuizSchema,
    type QuizQuestion,
    type StudyQuiz,
} from "@/lib/validation/ai-schemas";

/**
 * Unit tests for quiz scoring.
 *
 * Scoring is tested here, directly, rather than through a rendered score card.
 * Every assertion is about totals and outcomes, so a DOM test would only be
 * asserting on markup that happens to display those same numbers.
 */

const OPTIONS = ["Option A", "Option B", "Option C", "Option D"] as const;

/** Build a valid question, overridable per test. */
function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
    return {
        id: "q1",
        question: "Which statement is correct?",
        options: [...OPTIONS],
        correctIndex: 0,
        explanation: "Because the document says so.",
        ...overrides,
    };
}

/** Build a full-length, schema-valid quiz. */
function quiz(correctIndexes?: number[]): StudyQuiz {
    const questions: QuizQuestion[] = Array.from(
        { length: REQUIRED_QUIZ_QUESTION_COUNT },
        (_unused, index) =>
            question({
                id: `q${index + 1}`,
                correctIndex: correctIndexes?.[index] ?? 0,
            }),
    );

    // Parsed through the real schema so a fixture bug fails here rather than
    // producing a quiz the component could never receive.
    return QuizSchema.parse(questions);
}

/** Answers that mark the first `correctCount` questions right. */
function answerPrefix(correctCount: number): QuizAnswers {
    return Object.fromEntries(
        Array.from({ length: correctCount }, (_unused, index) => [`q${index + 1}`, 0]),
    );
}

describe("scoreQuestion", () => {
    it("counts a matching selection as correct", () => {
        const outcome = scoreQuestion(question({ correctIndex: 2 }), { q1: 2 });

        expect(outcome).toEqual({
            questionId: "q1",
            selectedIndex: 2,
            correctIndex: 2,
            isAnswered: true,
            isCorrect: true,
        });
    });

    it("counts a non-matching selection as answered but wrong", () => {
        const outcome = scoreQuestion(question({ correctIndex: 2 }), { q1: 0 });

        expect(outcome.isAnswered).toBe(true);
        expect(outcome.isCorrect).toBe(false);
    });

    it("treats a missing selection as unanswered, not wrong", () => {
        const outcome = scoreQuestion(question(), {});

        expect(outcome).toEqual({
            questionId: "q1",
            selectedIndex: null,
            correctIndex: 0,
            isAnswered: false,
            isCorrect: false,
        });
    });

    it("rejects a selection outside the option range", () => {
        // Answers come from user interaction; an out-of-range value means a bug
        // or a tampered payload and must not be scored as a guess.
        expect(scoreQuestion(question(), { q1: QUIZ_OPTION_COUNT }).isAnswered).toBe(false);
        expect(scoreQuestion(question(), { q1: -1 }).isAnswered).toBe(false);
    });

    it("rejects a non-integer selection", () => {
        expect(scoreQuestion(question(), { q1: 1.5 }).isAnswered).toBe(false);
        expect(scoreQuestion(question(), { q1: Number.NaN }).isAnswered).toBe(false);
    });

    it("ignores answers keyed to unknown question ids", () => {
        const outcome = scoreQuestion(question(), { q99: 0 });

        expect(outcome.isAnswered).toBe(false);
    });
});

describe("scoreQuiz", () => {
    it("scores a perfect run", () => {
        const score = scoreQuiz(quiz(), answerPrefix(REQUIRED_QUIZ_QUESTION_COUNT));

        expect(score).toMatchObject({
            total: REQUIRED_QUIZ_QUESTION_COUNT,
            answered: REQUIRED_QUIZ_QUESTION_COUNT,
            correct: REQUIRED_QUIZ_QUESTION_COUNT,
            incorrect: 0,
            unanswered: 0,
            percentage: 100,
            answeredPercentage: 100,
        });
    });

    it("scores a blank submission as all unanswered", () => {
        const score = scoreQuiz(quiz(), {});

        expect(score).toMatchObject({
            answered: 0,
            correct: 0,
            incorrect: 0,
            unanswered: REQUIRED_QUIZ_QUESTION_COUNT,
            percentage: 0,
        });
        // A percentage of the answered subset is undefined with nothing answered.
        expect(score.answeredPercentage).toBeNull();
    });

    it("keeps the totals reconciling for a partial submission", () => {
        const score = scoreQuiz(quiz(), answerPrefix(5));

        expect(score.correct + score.incorrect).toBe(score.answered);
        expect(score.answered + score.unanswered).toBe(score.total);
        expect(score.correct).toBe(5);
        expect(score.answered).toBe(5);
        expect(score.unanswered).toBe(REQUIRED_QUIZ_QUESTION_COUNT - 5);
    });

    it("separates wrong from unanswered", () => {
        // Three right, one wrong, one answered-but-blank is impossible by
        // construction, so: three right, one wrong, rest untouched.
        const answers: QuizAnswers = { q1: 0, q2: 0, q3: 0, q4: 1 };

        const score = scoreQuiz(quiz([0, 0, 0, 0, 0]), answers);

        expect(score.correct).toBe(3);
        expect(score.incorrect).toBe(1);
        expect(score.answered).toBe(4);
    });

    it("counts unanswered questions against the overall percentage", () => {
        // All four answered are right, but five were left blank, so the score
        // over the whole quiz is not 100 - unanswered must not be free.
        const score = scoreQuiz(quiz(), answerPrefix(4));

        expect(score.answeredPercentage).toBe(100);
        expect(score.percentage).toBe(Math.round((4 / REQUIRED_QUIZ_QUESTION_COUNT) * 100));
        expect(score.percentage).toBeLessThan(100);
    });

    it("handles a varying correct index per question", () => {
        const varied = quiz([0, 1, 2, 3, 0]);
        const score = scoreQuiz(
            varied,
            { q1: 0, q2: 1, q3: 2, q4: 3, q5: 0 },
        );

        expect(score.correct).toBe(5);
    });

    it("returns one outcome per question, in quiz order", () => {
        const score = scoreQuiz(quiz(), { q2: 1 });

        expect(score.outcomes).toHaveLength(REQUIRED_QUIZ_QUESTION_COUNT);
        expect(score.outcomes[0]?.questionId).toBe("q1");
        expect(score.outcomes[1]?.questionId).toBe("q2");
        expect(score.outcomes[1]?.isAnswered).toBe(true);
    });

    it("does not produce NaN for an empty quiz", () => {
        // `NaN` would render as the literal string "NaN%" in the UI.
        const score = scoreQuiz([], {});

        expect(score.percentage).toBe(0);
        expect(Number.isNaN(score.percentage)).toBe(false);
        expect(describeScore(score)).toBe("No questions were available.");
    });
});

describe("pass mark and description", () => {
    it("passes at or above the pass mark", () => {
        const passing = quiz();
        const score = scoreQuiz(passing, answerPrefix(REQUIRED_QUIZ_QUESTION_COUNT));
        // Force an exact-boundary score to prove the comparison is inclusive.
        const boundary = { ...score, percentage: PASS_MARK_PERCENTAGE, answered: 1 };

        expect(hasPassed(boundary)).toBe(true);
    });

    it("fails below the pass mark", () => {
        const score = scoreQuiz(quiz(), answerPrefix(1));

        expect(hasPassed(score)).toBe(false);
    });

    it("never passes a blank submission", () => {
        expect(hasPassed(scoreQuiz(quiz(), {}))).toBe(false);
    });

    it("describes a blank submission as having nothing selected", () => {
        expect(describeScore(scoreQuiz(quiz(), {}))).toContain("No answers selected");
    });

    it("describes a pass and a fail differently", () => {
        const full = scoreQuiz(quiz(), answerPrefix(REQUIRED_QUIZ_QUESTION_COUNT));
        const low = scoreQuiz(quiz(), answerPrefix(1));

        expect(describeScore(full)).toContain("Solid understanding");
        expect(describeScore(low)).toContain("Review the explanations");
    });
});

describe("isCompleteQuiz", () => {
    it("accepts a full-length quiz and rejects a short one", () => {
        expect(isCompleteQuiz(quiz())).toBe(true);
        expect(isCompleteQuiz(quiz().slice(1))).toBe(false);
    });
});