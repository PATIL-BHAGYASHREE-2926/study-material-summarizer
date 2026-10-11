"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import type { StudyMaterialPayload } from "@/types/summarize-response";

import { QuizView } from "./quiz-view";
import { SummaryView } from "./summary-view";

/**
 * The results view: three tabs over one study-material payload.
 *
 * Tabbed rather than stacked so the diagram and the twenty-question quiz each
 * get the vertical space they need. The tab state is the only state here; the
 * summary is the default tab so the response is readable the moment it arrives.
 */

type Tab = "summary" | "diagram" | "quiz";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: "summary", label: "Summary" },
    { id: "diagram", label: "Diagram" },
    { id: "quiz", label: "Quiz" },
];

export interface ResultsViewProps {
    data: StudyMaterialPayload;
}

export function ResultsView({ data }: ResultsViewProps) {
    const [tab, setTab] = useState<Tab>("summary");

    return (
        <section aria-label="Study material" className="flex flex-col gap-6">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Result sections">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === entry.id}
                        onClick={() => setTab(entry.id)}
                        className={[
                            "rounded-lg px-4 py-2 text-sm font-medium transition",
                            tab === entry.id
                                ? "bg-slate-900 text-white"
                                : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50",
                        ].join(" ")}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {/*
                Every tab is kept mounted and hidden with `hidden` rather than
                unmounted. Unmounting the quiz would discard the learner's
                answers when they check the diagram mid-quiz.
            */}
            <div role="tabpanel" hidden={tab !== "summary"}>
                <SummaryView
                    summary={data.summary}
                    fileName={data.fileName}
                    unitNoun={data.unitNoun}
                    totalUnits={data.totalUnits}
                />
            </div>

            <div role="tabpanel" hidden={tab !== "diagram"}>
                {/*
                    Code-split behind a dynamic import: mermaid is a large
                    library and is of no use to a reader who only wants the
                    summary or the quiz.
                */}
                <MermaidDiagram diagram={data.diagram} />
            </div>

            <div role="tabpanel" hidden={tab !== "quiz"}>
                <QuizView quiz={data.quiz} />
            </div>
        </section>
    );
}

/**
 * The mermaid view, loaded only in the browser.
 *
 * `ssr: false` keeps it out of the server render: mermaid's parser needs a DOM,
 * so rendering this on the server would fail. The dynamic boundary also splits
 * the library out of the initial bundle - it is large, and a reader who only
 * wants the summary never downloads it.
 */
const MermaidDiagram = dynamic(
    () => import("./mermaid-diagram").then((module) => module.MermaidDiagram),
    {
        ssr: false,
        loading: () => (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                Loading the diagram viewer...
            </div>
        ),
    },
);