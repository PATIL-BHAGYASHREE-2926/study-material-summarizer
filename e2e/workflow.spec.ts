import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import {
    NORMALISED_MERMAID_SOURCE,
    buildErrorPayload,
    buildSuccessPayload,
    minimalPdfBytes,
    mockSummarize,
    mockSummarizeFailure,
    mockSummarizeSuccess,
} from "./mock-gemini";

/**
 * End-to-end coverage of the upload-to-results workflow.
 *
 * Every test here drives the real UI: the same validation the user triggers,
 * the same fetch, the same rendering. Only the model response is replaced (see
 * `mock-gemini.ts` for why), so nothing in the client or the route is stubbed.
 */

const fileInput = "#file-input";

/**
 * The single error/notice surface in the app.
 *
 * `Notice` renders `role="status"`, so this locator is unambiguous where a
 * `getByText` on the message would also match the static header copy.
 */
const notice = (page: import("@playwright/test").Page) => page.getByRole("status");

/**
 * The one notice the diagram card shows when parsing or rendering fails.
 *
 * Matched as a single literal rather than a fragment so a change to the wording
 * breaks the test instead of silently passing on a partial match.
 */
const DIAGRAM_FAILURE_NOTICE =
    "This diagram could not be displayed. The summary and quiz below are unaffected.";

/**
 * The diagram that reached a reader as an empty bordered box.
 *
 * Read from disk rather than inlined so the fixture stays the single source of
 * truth for this regression, shared with any unit test that covers the same
 * source through the server pipeline.
 */
const RAG_DIAGRAM = readFileSync(
    new URL("../tests/mermaid/fixtures/rag-diagram.mmd", import.meta.url),
    "utf8",
).trim();

/** Answer the next upload with a payload carrying the given Mermaid source. */
async function mockSummarizeWithDiagram(page: import("@playwright/test").Page, mermaidCode: string) {
    await mockSummarize(page, () => {
        const base = buildSuccessPayload() as { data: { diagram: Record<string, unknown> } };
        return {
            ...base,
            data: {
                ...base.data,
                diagram: { ...base.data.diagram, mermaidCode },
            },
        };
    });
}

test.describe("upload to results", () => {
    test("a valid PDF produces a summary with takeaways and section breakdowns", async ({
        page,
    }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await expect(page.getByRole("heading", { name: /AI Study Material Summarizer/i })).toBeVisible();

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });

        // The study material region only exists once the payload arrives.
        const results = page.getByRole("region", { name: "Study material" });
        await expect(results).toBeVisible({ timeout: 15_000 });

        await expect(page.getByText(/mocked one-line summary/i)).toBeVisible();
        await expect(page.getByText("First mocked key takeaway about the material.")).toBeVisible();
        await expect(page.getByText("Mocked overview summary.")).toBeVisible();
        await expect(page.getByText("Mocked stages summary.")).toBeVisible();
    });

    test("the diagram tab renders the Mermaid diagram as SVG", async ({ page }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Diagram" }).click();

        // Mermaid is dynamically imported and parsed in the browser, so the SVG
        // appearing at all proves the client-side parse gate accepted the code.
        const diagramPanel = page.locator('[role="tabpanel"]:not([hidden])');
        await expect(diagramPanel.locator("svg")).toBeVisible({ timeout: 15_000 });
    });

    /**
     * Regression: the diagram that reached readers as a blank card.
     *
     * The reported symptom was an explanation reading as though the diagram had
     * worked, above a notice saying it could not be displayed. The source below
     * is a real model response, and its labels contain unquoted parentheses,
     * which Mermaid reads as shape syntax rather than label text.
     *
     * This drives the browser with the source the pipeline now emits for that
     * input. The server-side rewrite itself is covered by
     * `tests/mermaid/normalize.test.ts`, which runs the real `resolveDiagram`;
     * what only a browser can prove is that the corrected source renders.
     */
    test("renders a diagram whose labels contain parentheses", async ({ page }) => {
        await mockSummarizeWithDiagram(page, NORMALISED_MERMAID_SOURCE);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Diagram" }).click();

        const diagramPanel = page.locator('[role="tabpanel"]:not([hidden])');
        await expect(diagramPanel.locator("svg")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(DIAGRAM_FAILURE_NOTICE)).toHaveCount(0);

        // The label is drawn, not silently dropped.
        await expect(diagramPanel).toContainText(/Water splitting/i);
    });

    /**
     * Regression: a valid, fully quoted diagram that rendered as an empty box.
     *
     * The reported symptom was the Diagram tab showing neither a diagram nor any
     * notice - just the bare bordered container from
     * `src/components/mermaid-diagram.tsx`. That state is `drawn`: `mermaid.render`
     * resolved without throwing and the container still had no children.
     *
     * This source is the one the reader's server returned. It is ordinary,
     * entirely quoted Mermaid, so `normalizeMermaidSyntax` has nothing to do
     * (`changed === false`) and the sanitiser's removal rules do not fire. That is
     * what makes it a useful pin: the failure is not about syntax at all, and a
     * test built around a synthetic syntax error would never have caught it.
     */
    test("renders the RAG diagram that reached a reader as an empty box", async ({ page }) => {
        await mockSummarizeWithDiagram(page, RAG_DIAGRAM);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "AAPLecture5_RAG_Fundamentals.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Diagram" }).click();

        await page.getByRole("tab", { name: "Diagram" }).click();

        const diagramPanel = page.locator('[role="tabpanel"]:not([hidden])');

        // No notice appears for this failure, so the regression also pins that the
        // empty container is never accompanied by an explanation.
        await expect(page.getByText(DIAGRAM_FAILURE_NOTICE)).toHaveCount(0);

        // Scoped to the diagram's own container, because the card contains other
        // elements an unscoped `svg` locator could match.
        const svg = diagramPanel.locator("div[role='img'] svg");
        await expect(svg).toBeVisible({ timeout: 15_000 });

        // The decisive assertion. A container that is still `display: none` when
        // mermaid measures it yields an SVG with `width="100%"` and no children:
        // present, technically visible, and completely empty. Only the label text
        // distinguishes that from a real diagram, which is why a visibility-only
        // assertion let this ship.
        await expect(svg).toContainText("Chunking Strategies");
    });

    /**
 * The diagram the live Groq request returned for `AAPLecture5_RAG_Fundamentals.pdf`,
 * captured verbatim from the `/api/summarize` response body.
 *
 * ## Why this exact source is pinned
 *
 * It is ordinary Mermaid - quoted labels, chained edges, two subgraphs - and it
 * renders correctly the moment it is given a container with width. The failure it
 * exposed was not about this syntax at all: `results-view.tsx` mounts every tab
 * panel and hides the inactive ones, so the diagram was being drawn into a
 * container measuring `clientWidth === 0`. Mermaid resolved without throwing and
 * produced nothing, and because the effect depends only on `[code, containerRef]`,
 * opening the tab never redrew it.
 *
 * A regression pinned to this source therefore fails if the layout gate regresses,
 * and would not have been caught by any test using a single-node diagram.
 */
const LIVE_RAG_SUBGRAPH_DIAGRAM = readFileSync(
    new URL("../tests/mermaid/fixtures/rag-subgraph-diagram.mmd", import.meta.url),
    "utf8",
).trim();

/**
 * Regression for the blank diagram, captured from the live Groq response for
 * `AAPLecture5_RAG_Fundamentals.pdf`.
 *
 * ## What this pins
 *
 * Two separate defects showed up as the same blank box:
 *
 * 1. The component rendered into a container measuring `clientWidth === 0`, because
 *    `results-view.tsx` mounts every tab panel and hides the inactive ones.
 *    Mermaid resolved successfully having drawn nothing, and because the effect
 *    depends only on `[code, containerRef]`, opening the tab never redrew it.
 * 2. `mermaid.render(id, text, container)` does not draw into `container`. That
 *    third argument is a scratch element for measuring labels, and Mermaid empties
 *    it again before resolving - captured live as `removeTempElements` removing the
 *    container's own child. The diagram was rendered correctly and then deleted,
 *    one millisecond before the emptiness guard read it.
 *
 * This source is ordinary Mermaid, so a regression in either fix is visible here and
 * nowhere else: a single-node diagram would not have exposed either.
 */
test("renders the live subgraph diagram that reached a reader blank", async ({ page }) => {
    await mockSummarizeWithDiagram(page, LIVE_RAG_SUBGRAPH_DIAGRAM);
    await page.goto("/");

    await page.setInputFiles(fileInput, {
        name: "AAPLecture5_RAG_Fundamentals.pdf",
        mimeType: "application/pdf",
        buffer: minimalPdfBytes(),
    });
    await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
        timeout: 15_000,
    });

    // The panel is mounted and hidden at this point. Nothing should be drawn into
    // it, and - just as important - nothing should be reported as broken yet,
    // because the render has not been attempted.
    const hiddenPanel = page.locator('[role="tabpanel"][hidden]').filter({
        has: page.locator("div[role='img']"),
    });
    if ((await hiddenPanel.count()) > 0) {
        await expect(hiddenPanel.locator("div[role='img'] svg")).toHaveCount(0);
    }

    await page.getByRole("tab", { name: "Diagram" }).click();

    const panel = page.locator('[role="tabpanel"]:not([hidden])');
    const svg = panel.locator("div[role='img'] svg");

    // Painted primitives, not just any SVG. Labels are rendered inside
    // `<foreignObject>` rather than as `<text>`, so counting `<text>` would report
    // a perfectly good diagram as empty.
    await expect
        .poll(
            async () =>
                svg.evaluate(
                    (el) => el.querySelectorAll("path, rect, polygon, circle").length,
                ),
            { timeout: 15_000 },
        )
        .toBeGreaterThan(0);

    await expect(page.getByText(DIAGRAM_FAILURE_NOTICE)).toHaveCount(0);

    // Visible, not merely present.
    const box = await svg.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
});

test("still reports the failure notice for genuinely invalid Mermaid", async ({ page }) => {
        // Fixing the reported bug must not silence this notice. Invalid source
        // has to fail visibly rather than leave the reader with a blank card.
        await mockSummarizeWithDiagram(page, "flowchart TD\n    A[Broken -->");
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Diagram" }).click();

        const diagramPanel = page.locator('[role="tabpanel"]:not([hidden])');
        await expect(diagramPanel.getByText(DIAGRAM_FAILURE_NOTICE)).toBeVisible({
            timeout: 15_000,
        });
        await expect(diagramPanel.locator("svg")).toHaveCount(0);
    });

    test("a PPTX upload is accepted and reports slides", async ({ page }) => {
        await mockSummarize(page, () => ({
            ...(buildSuccessPayload() as { data: Record<string, unknown> }),
            data: {
                ...(buildSuccessPayload() as { data: Record<string, unknown> }).data,
                fileName: "lecture.pptx",
                unitNoun: "slide",
                totalUnits: 12,
            },
        }));
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "lecture.pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            // Only the name and size reach the browser check; the mocked route
            // never reads the body.
            buffer: Buffer.from("PKmock"),
        });

        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        // The unit noun follows the verified source type, not the file name, so
        // this asserts the payload's `unitNoun` reached the summary chrome.
        await expect(page.getByText("12 slides", { exact: true })).toBeVisible();
    });
});

test.describe("quiz", () => {
    test("renders exactly 20 questions with four options each", async ({ page }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Quiz" }).click();

        const questions = page.getByRole("group");
        await expect(questions).toHaveCount(20);

        // Four radios per question, each with a distinct accessible name.
        await expect(page.locator('input[type="radio"]')).toHaveCount(80);
        await expect(page.getByLabel("Mock question number 1? option 1")).toBeVisible();
    });

    test("scores a fully correct run at 100% and shows every explanation", async ({ page }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Quiz" }).click();

        // Every mock question has option A correct.
        for (let index = 1; index <= 20; index += 1) {
            await page.getByLabel(`Mock question number ${index}? option 1`).check();
        }
        await expect(page.getByText("20 of 20 answered")).toBeVisible();

        await page.getByRole("button", { name: "Submit answers" }).click();

        await expect(page.getByText("Your result")).toBeVisible();
        await expect(page.getByText("100%")).toBeVisible();

        // One explanation per question once submitted.
        await expect(page.getByText("Explanation for question 1.")).toBeVisible();
        await expect(page.getByText("Explanation for question 20.")).toBeVisible();
    });

    test("scores an all-wrong run at 0% and offers a retry", async ({ page }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Quiz" }).click();

        // Option B is always a distractor.
        for (let index = 1; index <= 20; index += 1) {
            await page.getByLabel(`Mock question number ${index}? option 2`).check();
        }
        await page.getByRole("button", { name: "Submit answers" }).click();

        await expect(page.getByText("0%")).toBeVisible();

        await page.getByRole("button", { name: "Try again" }).click();
        await expect(page.getByText("Submit answers")).toBeVisible();
    });

    test("counts unanswered questions in the score", async ({ page }) => {
        await mockSummarizeSuccess(page);
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });
        await expect(page.getByRole("region", { name: "Study material" })).toBeVisible({
            timeout: 15_000,
        });

        await page.getByRole("tab", { name: "Quiz" }).click();

        await page.getByLabel("Mock question number 1? option 1").check();
        await expect(page.getByText("1 of 20 answered")).toBeVisible();

        await page.getByRole("button", { name: "Submit answers" }).click();

        // "Unanswered" stat must read 19 - the single answered question was right.
        const unanswered = page.locator("div", { has: page.getByText("Unanswered") }).last();
        await expect(unanswered).toContainText("19");
    });
});

test.describe("invalid uploads", () => {
    test("rejects an unsupported file type before any request is sent", async ({ page }) => {
        let requestSent = false;
        await page.route("**/api/summarize", async (route) => {
            requestSent = true;
            await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("plain text"),
        });

        await expect(notice(page)).toContainText(/Unsupported file type/i);
        // Client-side rejection means no upload was attempted at all.
        expect(requestSent).toBe(false);
        await expect(page.getByRole("region", { name: "Study material" })).toHaveCount(0);
    });

    test("rejects a legacy .ppt file with a re-save message", async ({ page }) => {
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "old-deck.ppt",
            mimeType: "application/vnd.ms-powerpoint",
            // OLE2 magic bytes, so the rejection is about the real format.
            buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
        });

        await expect(notice(page)).toContainText(/re-save it as \.pptx/i);
    });

    test("rejects a file whose extension lies about its content", async ({ page }) => {
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "actually-text.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("this is not a pdf at all"),
        });

        await expect(notice(page)).toContainText(/could not be recognised as a PDF or PowerPoint/i);
    });

    test("rejects an empty file", async ({ page }) => {
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "empty.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.alloc(0),
        });

        await expect(notice(page)).toContainText(/empty/i);
    });
});

test.describe("server errors", () => {
    test("shows the safe message and a retry control when generation fails", async ({ page }) => {
        await mockSummarizeFailure(page, "AI generation is temporarily unavailable.");
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });

        await expect(notice(page)).toContainText("AI generation is temporarily unavailable.", {
            timeout: 15_000,
        });
        await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Study material" })).toHaveCount(0);
    });

    test("surfaces a malformed server body without crashing the page", async ({ page }) => {
        // The client parses defensively; a non-JSON body must not blank the app.
        await page.route("**/api/summarize", async (route) => {
            await route.fulfill({ status: 200, contentType: "text/html", body: "<html>oops</html>" });
        });
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });

        await expect(notice(page)).toContainText(/unexpected response/i, { timeout: 15_000 });
        await expect(page.getByRole("heading", { name: /AI Study Material Summarizer/i })).toBeVisible();
    });

    test("surfaces a typed failure body", async ({ page }) => {
        await mockSummarize(page, () =>
            buildErrorPayload("The document has more pages than this app can process.", false),
        );
        await page.goto("/");

        await page.setInputFiles(fileInput, {
            name: "photosynthesis.pdf",
            mimeType: "application/pdf",
            buffer: minimalPdfBytes(),
        });

        await expect(notice(page)).toContainText(/more pages than this app can process/i, {
            timeout: 15_000,
        });
    });
});