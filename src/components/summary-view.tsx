import type { StudySummary } from "@/lib/validation/ai-schemas";

import { Badge, Card, Notice, SectionHeading } from "./ui";

/**
 * The summary view: TL;DR, key takeaways, and a page/slide breakdown.
 *
 * Every value rendered here is AI text. React escapes text nodes, so it is
 * rendered as a plain string child throughout - there is no markdown pipeline
 * and no `dangerouslySetInnerHTML` anywhere in this component, which is what
 * makes XSS structurally impossible rather than filtered.
 */

export interface SummaryViewProps {
    summary: StudySummary;
    fileName: string;
    /** Page or slide, chosen by the verified source type. */
    unitNoun: "page" | "slide";
    /** Total pages or slides, from the canonical document. */
    totalUnits: number;
}

export function SummaryView({
    summary,
    fileName,
    unitNoun,
    totalUnits,
}: SummaryViewProps) {
    return (
        <div className="flex flex-col gap-6">
            <Card>
                <SectionHeading title="In short" hint={fileName} />
                <div className="mb-4">
<Badge>
                        {totalUnits} {pluralise(totalUnits, unitNoun)}
                    </Badge>
                </div>
                <p className="text-base leading-relaxed text-slate-700">
                    {summary.tldr}
                </p>
            </Card>

            <Card>
                <SectionHeading title="Key takeaways" />
                {summary.keyTakeaways.length === 0 ? (
                    <Notice>
                        The AI service did not return any key takeaways for this
                        document.
                    </Notice>
                ) : (
                    <ul className="grid gap-3 sm:grid-cols-2">
                        {summary.keyTakeaways.map((takeaway, index) => (
                            <li
                                key={`${index}-${takeaway.slice(0, 24)}`}
                                className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700"
                            >
                                {takeaway}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Card>
                <SectionHeading
                    title={capitalise(`${unitNoun} breakdown`)}
                    hint={`How the material is organised across ${totalUnits} ${pluralise(totalUnits, unitNoun)}.`}
                />
                {summary.sectionBreakdowns.length === 0 ? (
                    <Notice>
                        No per-{unitNoun} breakdown was returned. The TL;DR and the
                        quiz above still cover the document.
                    </Notice>
                ) : (
                    <ol className="flex flex-col gap-3">
                        {summary.sectionBreakdowns.map((section) => (
                            <li
                                key={section.sectionIndex}
                                className="rounded-lg border border-slate-200 p-4"
                            >
                                <p className="text-sm font-semibold text-slate-900">
                                    {unitNoun === "page"
                                        ? `Page ${section.sectionIndex}: ${section.title}`
                                        : `Slide ${section.sectionIndex}: ${section.title}`}
                                </p>
                                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                                    {section.summary}
                                </p>
                            </li>
                        ))}
                    </ol>
                )}
            </Card>
        </div>
    );
}

/** Pluralise a unit noun without a hard-coded "1 page/2 pages" duplication. */
function pluralise(count: number, unitNoun: "page" | "slide"): string {
    return count === 1 ? unitNoun : `${unitNoun}s`;
}

/** Upper-case the first letter of a unit noun for a heading. */
function capitalise(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}