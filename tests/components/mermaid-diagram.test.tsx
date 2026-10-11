// @vitest-environment jsdom
/**
 * Component regression tests for the diagram viewer's failure notice.
 *
 * This is the symptom readers actually reported: a diagram that explained
 * itself perfectly, above a notice saying it could not be displayed. The
 * pipeline tests in `normalize.test.ts` cover the rewrite; these cover the
 * consequence - whether the component draws the diagram or shows the notice.
 *
 * Mermaid is mocked rather than run. Real rendering needs layout primitives
 * (`getBBox`, `getComputedTextLength`) that jsdom does not implement, so a
 * real-mermaid component test would either fail for reasons unrelated to this
 * bug or need so much DOM shimming that it stops testing anything. What is
 * under test here is the component's contract with mermaid's parser: accept
 * what parses, and show the notice for what does not. `e2e/workflow.spec.ts`
 * covers the real render in a real browser.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import { resolveDiagram } from "@/lib/mermaid";
import type { ResolvedDiagram } from "@/lib/mermaid";

/** The verbatim source of the diagram that shipped blank to readers. */
const REPRODUCED_MODEL_OUTPUT = [
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

const FAILURE_NOTICE =
    "This diagram could not be displayed. The summary and quiz below are unaffected.";

/**
 * The real mermaid parser, with only the renderer stubbed.
 *
 * `parse` is genuine, so the valid/invalid split in these tests is mermaid's own
 * grammar rather than a rule invented here - `tests/mermaid/normalize.test.ts`
 * asserts the same things against the real parser without any component at all.
 * That is the whole point of this file: it must fail if the pipeline stops
 * producing parseable code, not if a hand-written stand-in disagrees.
 *
 * Only `render` is replaced. Real rendering needs layout primitives
 * (`getBBox`, `getComputedTextLength`) that jsdom does not implement, so the
 * stub inserts an `<svg>` the way the real library does - into the container it
 * is handed - and the assertions stay about what the reader sees.
 */
vi.mock("mermaid", async () => {
    const actual = await vi.importActual<typeof import("mermaid")>("mermaid");

    return {
        ...actual,
        default: {
            initialize: actual.default.initialize,
            parse: (code: string) => actual.default.parse(code),
            render: async (_id: string, _code: string, container: Element) => {
                const ns = "http://www.w3.org/2000/svg";
                const svg = container.ownerDocument.createElementNS(ns, "svg");
                svg.setAttribute("data-testid", "mermaid-svg");

                // Real Mermaid output always carries drawing primitives, and the
                // component rejects an SVG that contains none - that is how an empty
                // rendering becomes a visible notice instead of a blank box. A bare
                // `<svg>` here would model a rendering that cannot occur, and would
                // make these tests contradict that guard.
                const group = container.ownerDocument.createElementNS(ns, "g");
                const label = container.ownerDocument.createElementNS(ns, "text");
                label.textContent = "A rendered node";
                group.appendChild(label);
                svg.appendChild(group);

                container.appendChild(svg);
                return svg;
            },
        },
    };
});

/** Resolve a diagram the way the API route does, so the component gets real data. */
async function resolve(mermaidCode: string): Promise<ResolvedDiagram> {
    return resolveDiagram({
        mermaidCode,
        diagramType: "flowchart",
        explanation: "The diagram follows the sequence from light capture onward.",
    });
}

afterEach(cleanup);

describe("a diagram the pipeline resolved is drawn", () => {
    // The first test here to touch mermaid pays for importing it under jsdom, which
    // can exceed the 5s default when the suite runs in parallel. Same reason,
    // and the same allowance, as the first case in `validate.test.ts`.
    it(
        "renders the reproduced model output instead of the failure notice",
        { timeout: 60_000 },
        async () => {
            // End to end through the real pipeline: the model text goes in, and what
            // comes out must be the reader's own diagram.
            //
            // `source` is asserted as well as the drawing because the two failure
            // modes look different in different environments and only the source
            // distinguishes them. In a DOM context (jsdom, here) the parse gate runs
            // and an unfixed diagram is rejected into the placeholder; in the
            // browser the gate is deferred server-side and an unfixed diagram
            // reaches the parser here, producing the "could not be displayed" notice
            // the readers reported. Asserting only "an SVG appeared" would let the
            // placeholder satisfy it.
            const diagram = await resolve(REPRODUCED_MODEL_OUTPUT);
            expect(diagram.source).toBe("generated");

            const { container } = render(<MermaidDiagram diagram={diagram} />);

            expect(await screen.findByTestId("mermaid-svg")).toBeDefined();
            expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();
            // The placeholder notice must be absent too: this is the real diagram.
            expect(screen.queryByText(/placeholder outline is displayed instead/i)).toBeNull();
            expect(container.querySelector("pre")?.textContent).toContain(
                'C["Water splitting (O\u2082 + e\u207b + H\u207a)"]',
            );
        },
    );

    it("still shows the reader's explanation alongside the drawing", async () => {
        // The symptom was an explanation that read as though the diagram had
        // worked, next to a notice that it had not. Both must now be coherent.
        const diagram = await resolve(REPRODUCED_MODEL_OUTPUT);

        render(<MermaidDiagram diagram={diagram} />);
        await screen.findByTestId("mermaid-svg");

        expect(
            screen.getByText("The diagram follows the sequence from light capture onward."),
        ).toBeDefined();
    });

    it("offers the diagram source as text, not as markup", async () => {
        const diagram = await resolve(REPRODUCED_MODEL_OUTPUT);

        const { container } = render(<MermaidDiagram diagram={diagram} />);
        await screen.findByTestId("mermaid-svg");

        // The source is model-derived text and must stay a text node.
        const source = container.querySelector("pre");
        expect(source?.textContent).toContain("flowchart TD");
        expect(source?.children).toHaveLength(0);
    });
});

describe("a diagram that genuinely cannot be drawn keeps the notice", async () => {
    it("shows the notice and draws nothing", async () => {
        // Fixing the reported bug must not turn the notice off. Invalid Mermaid
        // still has to fail visibly rather than silently rendering nothing.
        const { container } = render(
            <MermaidDiagram
                diagram={{
                    mermaidCode: "flowchart TD\n    A[Broken -->",
                    diagramType: "flowchart",
                    explanation: "An explanation.",
                    source: "generated",
                    parseGate: "deferred",
                }}
            />,
        );

        await waitFor(() => expect(screen.queryByText(FAILURE_NOTICE)).not.toBeNull());
        expect(container.querySelector("svg")).toBeNull();
    });

    it("surfaces the placeholder notice for a fallback diagram", async () => {
        const diagram = await resolve("not a diagram at all");

        expect(diagram.source).toBe("fallback");

        const { container } = render(<MermaidDiagram diagram={diagram} />);
        await screen.findByTestId("mermaid-svg");

        // Both notices are present and distinguishable: the placeholder reason,
        // and no rendering failure, because the fallback does render.
        expect(screen.getByText(/placeholder outline is displayed instead/i)).toBeDefined();
        expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();
        expect(container.querySelector("svg")).not.toBeNull();
    });
});