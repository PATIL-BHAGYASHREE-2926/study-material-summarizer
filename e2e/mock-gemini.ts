import type { Page, Route } from "@playwright/test";

/**
 * A stand-in for the Gemini API.
 *
 * ## Why this intercepts `/api/summarize` and not the model endpoint
 *
 * The route is the only caller of Gemini, and it runs server-side inside the
 * Next.js process that Playwright starts. A browser-level route handler cannot
 * reach it, so intercepting here would mean bypassing the very code under test -
 * upload validation, extraction, Zod validation of the model output and the
 * Mermaid gate would all be skipped, and a green E2E run would prove nothing.
 *
 * Intercepting the browser's request instead keeps the *entire* server pipeline
 * real and replaces only the one thing that costs money and needs a credential.
 * The 20 questions, the schema and the payload shape below are copied from
 * `tests/fixtures/study-output.ts`, so the mock is the same shape the route
 * would produce from a real model response.
 */

const QUIZ_QUESTION_COUNT = 20;

/** One deterministic question per index, so scoring can be asserted exactly. */
export const MOCK_QUESTIONS = Array.from({ length: QUIZ_QUESTION_COUNT }, (_unused, index) => ({
    id: `q${index + 1}`,
    question: `Mock question number ${index + 1}?`,
    options: [
        `Correct answer for ${index + 1}`,
        `Distractor one for ${index + 1}`,
        `Distractor two for ${index + 1}`,
        `Distractor three for ${index + 1}`,
    ],
    // Always option A, so "answer every question correctly" is a single click
    // per question and the expected score is unambiguous.
    correctIndex: 0,
    explanation: `Explanation for question ${index + 1}.`,
}));

/** The payload shape `/api/summarize` returns on success. */
export function buildSuccessPayload(options: { totalUnits?: number } = {}): unknown {
    return {
        ok: true,
        data: {
            fileName: "mock-study-material.pdf",
            unitNoun: "page",
            totalUnits: options.totalUnits ?? 2,
            summary: {
                tldr: "This is the mocked one-line summary used by the end-to-end tests.",
                keyTakeaways: [
                    "First mocked key takeaway about the material.",
                    "Second mocked key takeaway about the material.",
                    "Third mocked key takeaway about the material.",
                ],
                sectionBreakdowns: [
                    { sectionIndex: 1, title: "Overview", summary: "Mocked overview summary." },
                    { sectionIndex: 2, title: "Stages", summary: "Mocked stages summary." },
                ],
            },
            diagram: {
                mermaidCode:
                    "flowchart TD\n  Light[Light energy] --> Reactions[Light reactions]\n  Reactions --> Cycle[Calvin cycle]",
                diagramType: "flowchart",
                explanation: "Mocked diagram explanation.",
                source: "generated",
                parseGate: "deferred",
            },
            quiz: MOCK_QUESTIONS,
        },
    };
}

/** A typed failure payload, matching the route's error envelope. */
export function buildErrorPayload(message: string, retryable = true): unknown {
    return { ok: false, error: { code: "GEMINI_REQUEST_FAILED", message, retryable } };
}

/**
 * Intercept every `/api/summarize` POST and answer it locally.
 *
 * Registered before the page navigates so no request can escape to the real
 * endpoint. `handler` receives the route and returns the JSON body.
 */
export async function mockSummarize(page: Page, handler: (route: Route) => unknown): Promise<void> {
    await page.route("**/api/summarize", async (route) => {
        if (route.request().method() !== "POST") {
            await route.fulfill({
                status: 405,
                contentType: "application/json",
                body: JSON.stringify(buildErrorPayload("Use POST to upload a document.", false)),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(handler(route)),
        });
    });
}

/** Always succeed with the standard payload. */
export function mockSummarizeSuccess(page: Page, totalUnits?: number): Promise<void> {
    return mockSummarize(page, () => buildSuccessPayload({ totalUnits }));
}

/** Always fail with the given message. */
export function mockSummarizeFailure(page: Page, message: string): Promise<void> {
    return mockSummarize(page, () => buildErrorPayload(message));
}

/**
 * The Mermaid source from the live request whose diagram shipped blank.
 *
 * Reproduced verbatim from a real Groq response: the labels carry superscript
 * characters and, crucially, unquoted parentheses - which Mermaid's flowchart
 * grammar reads as the start of a stadium shape rather than as label text, so
 * the source does not parse. The server-side parse gate is deferred on the Node
 * runtime, so this reached every reader's browser unrendered and the diagram
 * card showed "This diagram could not be displayed" beneath a perfectly valid
 * explanation. Kept as a fixture because its failure mode is not obvious from
 * the text: it looks like perfectly reasonable Mermaid.
 */
export const REPRODUCED_MERMAID_SOURCE = [
    "flowchart TD",
    "    A[Sunlight] --> B[Chlorophyll absorbs photons]",
    "    B --> C[Water splitting (O\u2082 + e\u207b + H\u207a)]",
    "    C --> D[Electron Transport Chain]",
    "    D --> E[Proton gradient across thylakoid membrane]",
    "    E --> F[ATP synthase produces ATP]",
    "    D --> G[NADP\u207a reduced to NADPH]",
    "    F & G --> H[Calvin Cycle in Stroma]",
    "    H --> I[RuBisCO fixes CO\u2082]",
    "    I --> J[Glyceraldehyde\u20113\u2011phosphate (G3P)]",
].join("\n");

/**
 * What the pipeline now emits for {@link REPRODUCED_MERMAID_SOURCE}.
 *
 * Duplicated rather than imported, matching how the payload above is treated:
 * the browser-level mock has to stand in for the server pipeline, so it is
 * given the post-fix output as a fixture. `tests/mermaid/normalize.test.ts`
 * asserts that `resolveDiagram` really does turn the raw source into exactly
 * this, which is what keeps the two from drifting.
 */
export const NORMALISED_MERMAID_SOURCE = [
    "flowchart TD",
    "    A[Sunlight] --> B[Chlorophyll absorbs photons]",
    '    B --> C["Water splitting (O\u2082 + e\u207b + H\u207a)"]',
    "    C --> D[Electron Transport Chain]",
    "    D --> E[Proton gradient across thylakoid membrane]",
    "    E --> F[ATP synthase produces ATP]",
    "    D --> G[NADP\u207a reduced to NADPH]",
    "    F & G --> H[Calvin Cycle in Stroma]",
    "    H --> I[RuBisCO fixes CO\u2082]",
    '    I --> J["Glyceraldehyde\u20113\u2011phosphate (G3P)"]',
].join("\n");

/**
 * A minimal but genuinely valid PDF.
 *
 * Real bytes matter: the route rejects a file by its magic number, so a stub
 * named `.pdf` would be refused before extraction and the test would pass for
 * the wrong reason.
 */
export function minimalPdfBytes(text = "Photosynthesis study material for the mock test."): Buffer {
    const content = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
    const objects = [
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj",
        `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
        "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const object of objects) {
        offsets.push(pdf.length);
        pdf += `${object}\n`;
    }
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
    pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(pdf, "latin1");
}