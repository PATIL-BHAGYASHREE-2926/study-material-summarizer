"use client";

import { useMemo, useState } from "react";

import type { StudyQuiz } from "@/lib/validation/ai-schemas";
import {
    describeScore,
    hasPassed,
    scoreQuiz,
    type QuizAnswers,
    type QuizScore,
} from "@/lib/quiz/score";

import { Card, Notice, SectionHeading } from "./ui";

/**
 * The interactive 20-question quiz.
 *
 * All quiz text is model output and is rendered as escaped React text nodes
 * throughout - no `dangerouslySetInnerHTML`, no markdown pipeline.
 *
 * Scoring lives in `src/lib/quiz/score.ts` as a pure function rather than in
 * this component: it is the one part of the quiz with real branching, and keeping
 * it out of the component means it is unit-tested directly instead of through
 * rendered markup.
 */

export interface QuizViewProps {
    quiz: StudyQuiz;
}

/** One question with its four options and, once submitted, its explanation. */
function QuestionCard({
    index,
    question,
    selectedIndex,
    submitted,
    onSelect,
}: {
    index: number;
    question: StudyQuiz[number];
    selectedIndex: number | null;
    submitted: boolean;
    onSelect: (optionIndex: number) => void;
}) {
    return (
        <li className="rounded-lg border border-slate-200 p-5">
            <fieldset>
                <legend className="text-sm font-semibold text-slate-900">
                    {index + 1}. {question.question}
                </legend>

                <div className="mt-3 grid gap-2">
                    {question.options.map((option, optionIndex) => {
                        const isSelected = selectedIndex === optionIndex;
                        // Read from the question rather than from the answer key
                        // the learner supplied, so a tampered selection cannot
                        // mark its own option correct.
                        const isCorrect = submitted && optionIndex === question.correctIndex;
                        const isWrongPick = submitted && isSelected && !isCorrect;

                        return (
                            <label
                                key={optionIndex}
                                className={[
                                    "flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-sm",
                                    isWrongPick
                                        ? "border-red-300 bg-red-50"
                                        : isCorrect
                                            ? "border-emerald-300 bg-emerald-50"
                                            : "border-slate-200 hover:border-slate-300",
                                    submitted ? "cursor-default" : "",
                                ].join(" ")}
                            >
                                <input
                                    type="radio"
                                    name={question.id}
                                    value={optionIndex}
                                    checked={isSelected}
                                    disabled={submitted}
                                    onChange={() => onSelect(optionIndex)}
                                    className="mt-1 h-4 w-4"
                                    aria-label={`${question.question} option ${optionIndex + 1}`}
                                />
                                <span className="text-slate-700">{option}</span>
                            </label>
                        );
                    })}
                </div>
            </fieldset>

            {submitted && (
                <p className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
                    <span className="font-semibold text-slate-800">Why: </span>
                    {question.explanation}
                </p>
            )}
        </li>
    );
}

/** The score card shown after submission. */
function ScoreCard({
    score,
    onReset,
}: {
    score: QuizScore;
    onReset: () => void;
}) {
    return (
        <Card className="border-slate-300">
            <SectionHeading title="Your result" hint={describeScore(score)} />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Correct" value={score.correct} />
                <Stat label="Incorrect" value={score.incorrect} />
                <Stat label="Unanswered" value={score.unanswered} />
                <Stat label="Score" value={`${score.percentage}%`} />
            </dl>
            {score.answeredPercentage !== null && score.unanswered > 0 && (
                <p className="mt-3 text-sm text-slate-500">
                    Of the questions you answered, you got {score.answeredPercentage}%
                    correct.
                </p>
            )}
            <button
                type="button"
                onClick={onReset}
                className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
                Try again
            </button>
        </Card>
    );
}

/** One labelled number in the score card. */
function Stat({ label, value }: { label: string; value: number | string }) {
    return (
        <div className="rounded-lg bg-slate-50 p-4 text-center">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-900">{value}</dd>
        </div>
    );
}

export function QuizView({ quiz }: QuizViewProps) {
    const [answers, setAnswers] = useState<QuizAnswers>({});
    const [submitted, setSubmitted] = useState(false);

    // Recomputed from state rather than stored, so the score can never drift out
    // of sync with the answers that produced it.
    const score = useMemo(
        () => (submitted ? scoreQuiz(quiz, answers) : null),
        [quiz, answers, submitted],
    );

    const selectAnswer = (questionId: string, optionIndex: number): void => {
        setAnswers((previous) => ({ ...previous, [questionId]: optionIndex }));
    };

    const reset = (): void => {
        setAnswers({});
        setSubmitted(false);
    };

    return (
        <div className="flex flex-col gap-6">
            <Card>
                <SectionHeading
                    title="Test yourself"
                    hint="Answer every question, then submit to see your score and an explanation for each answer."
                />
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        onClick={() => setSubmitted(true)}
                        className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700"
                    >
                        Submit answers
                    </button>
                    <span className="text-sm text-slate-500">
                        {Object.keys(answers).length} of {quiz.length} answered
                    </span>
                </div>
            </Card>

            {submitted && score !== null && (
                <>
                    <ScoreCard score={score} onReset={reset} />
                    {!hasPassed(score) && (
                        <Notice>
                            Read the explanations below, then use Try again to test
                            yourself a second time.
                        </Notice>
                    )}
                </>
            )}

            <ol className="flex flex-col gap-4">
                {quiz.map((question, index) => (
                    <QuestionCard
                        key={question.id}
                        index={index}
                        question={question}
                        selectedIndex={answers[question.id] ?? null}
                        submitted={submitted}
                        onSelect={(optionIndex) => selectAnswer(question.id, optionIndex)}
                    />
                ))}
            </ol>
        </div>
    );
}