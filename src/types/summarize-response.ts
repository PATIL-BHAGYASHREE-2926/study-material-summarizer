import type { ResolvedDiagram } from "@/lib/mermaid";
import type { StudySummary, StudyQuiz } from "@/lib/validation/ai-schemas";

/**
 * The wire contract between `/api/summarize` and the browser.
 *
 * Declared as a discriminated union on `ok` so every client branch is
 * type-checked: there is no "partially successful" state a caller could
 * accidentally read from. Both arms carry only values that are already safe to
 * render as text - no raw model output, no internal paths, no credential.
 */

export interface StudyMaterialPayload {
    /** Sanitised original file name, safe to display and to download under. */
    fileName: string;
    /** "page" for PDF, "slide" for PPTX - chosen by signature, not extension. */
    unitNoun: UnitNoun;
    /** Pages or slides in the extracted document. */
    totalUnits: number;
    summary: StudySummary;
    diagram: ResolvedDiagram;
    quiz: StudyQuiz;
}

/** Page or slide, chosen by the verified source type. */
export type UnitNoun = "page" | "slide";

/**
 * A failed request.
 *
 * `code` is a stable machine-readable reason; `message` is the safe, actionable
 * sentence to show. `retryable` tells the UI whether offering a retry makes
 * sense, which the route derives from the status code rather than duplicating
 * the judgement on the client.
 */
export interface SummarizeError {
    code: string;
    message: string;
    retryable: boolean;
}

export type SummarizeResponse =
    | { ok: true; data: StudyMaterialPayload }
    | { ok: false; error: SummarizeError };