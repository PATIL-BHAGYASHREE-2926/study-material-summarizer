import { QUIZ_OPTION_COUNT, REQUIRED_QUIZ_QUESTION_COUNT } from "@/lib/constants/limits";
import type { QuizQuestion, StudyQuiz } from "@/lib/validation/ai-schemas";

/**
 * Pure quiz scoring.
 *
 * Extracted from the React component on purpose: scoring is the one piece of
 * quiz logic with real branching (unanswered vs wrong vs right, ignored
 * selections, out-of-range indexes), and testing it through the DOM would mean
 * asserting on rendered markup to prove arithmetic. As a pure function it is
 * tested directly and the component is left as presentation.
 *
 * Nothing here mutates its inputs, and no answer is trusted until it has been
 * range-checked - the answers object comes from user interaction, so an
 * out-of-range index must count as "not answered" rather than silently matching
 * nothing or, worse, matching by accident.
 */

/** Selected option index per question id. Absent means "not answered". */
export type QuizAnswers = Readonly<Record<string, number>>;

export interface QuestionOutcome {
    questionId: string;
    /** The accepted selection, or `null` when nothing valid was chosen. */
    selectedIndex: number | null;
    correctIndex: number;
    isCorrect: boolean;
    isAnswered: boolean;
}

export interface QuizScore {
    total: number;
    /** Questions with a valid selection. */
    answered: number;
    correct: number;
    incorrect: number;
    unanswered: number;
    /** Correct as a percentage of *all* questions, so unanswered hurt. */
    percentage: number;
    /** Correct as a percentage of *answered*, or `null` when none were answered. */
    answeredPercentage: number | null;
    /** Every question resolved, in quiz order, for explanation rendering. */
    outcomes: QuestionOutcome[];
}

export interface QuizState {
    /** True once the learner has committed their answers. */
    submitted: boolean;
    score: QuizScore | null;
}

/** A correct-answer share below this is reported as "needs review". */
export const PASS_MARK_PERCENTAGE = 50;

/**
 * Normalise a raw selection into a valid option index, or `null`.
 *
 * Rejects non-integers and anything outside `0..QUIZ_OPTION_COUNT - 1`. A
 * stored value comes from a click handler, so an invalid one means a bug or a
 * tampered payload - either way it must not be counted as a guess.
 */
function toValidSelection(value: number | undefined): number | null {
    if (value === undefined) return null;
    if (!Number.isInteger(value)) return null;
    if (value < 0 || value >= QUIZ_OPTION_COUNT) return null;
    return value;
}

/** Resolve one question's outcome against the submitted answers. */
export function scoreQuestion(
    question: QuizQuestion,
    answers: QuizAnswers,
): QuestionOutcome {
    const selectedIndex = toValidSelection(answers[question.id]);

    return {
        questionId: question.id,
        selectedIndex,
        correctIndex: question.correctIndex,
        isAnswered: selectedIndex !== null,
        isCorrect: selectedIndex !== null && selectedIndex === question.correctIndex,
    };
}

/**
 * Score a whole quiz.
 *
 * The totals always add up: `correct + incorrect === answered` and
 * `answered + unanswered === total`. That invariant is what the tests assert,
 * because a score card whose parts do not reconcile is worse than no score card.
 */
export function scoreQuiz(quiz: StudyQuiz, answers: QuizAnswers): QuizScore {
    const outcomes = quiz.map((question) => scoreQuestion(question, answers));

    const correct = outcomes.filter((outcome) => outcome.isCorrect).length;
    const answered = outcomes.filter((outcome) => outcome.isAnswered).length;
    const total = outcomes.length;

    return {
        total,
        answered,
        correct,
        incorrect: answered - correct,
        unanswered: total - answered,
        // Guarded rather than assumed: an empty quiz would otherwise produce
        // `NaN`, which renders as the literal string "NaN%".
        percentage: total === 0 ? 0 : Math.round((correct / total) * 100),
        answeredPercentage:
            answered === 0 ? null : Math.round((correct / answered) * 100),
        outcomes,
    };
}

/** Whether a score clears the pass mark. A blank submission never does. */
export function hasPassed(score: QuizScore): boolean {
    return score.answered > 0 && score.percentage >= PASS_MARK_PERCENTAGE;
}

/** A one-line verdict for the score card. */
export function describeScore(score: QuizScore): string {
    if (score.total === 0) return "No questions were available.";
    if (score.answered === 0) {
        return `No answers selected. ${score.total} questions to work through.`;
    }
    if (hasPassed(score)) {
        return `${score.correct} of ${score.total} correct. Solid understanding.`;
    }
    return `${score.correct} of ${score.total} correct. Review the explanations below.`;
}

/** Whether a quiz is structurally complete enough to present. */
export function isCompleteQuiz(quiz: StudyQuiz): boolean {
    return quiz.length === REQUIRED_QUIZ_QUESTION_COUNT;
}