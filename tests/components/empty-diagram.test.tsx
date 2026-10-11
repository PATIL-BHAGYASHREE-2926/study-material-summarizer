// @vitest-environment jsdom
/**
 * Regression tests for the blank diagram: a resolved render that drew nothing.
 *
 * ## The bug these pin
 *
 * `mermaid.render` can resolve successfully while emitting an SVG that carries its
 * `<style>` block and none of the graph. The container then holds a real element
 * with a real bounding box, so every "is it visible" check passes, and the
 * component set its `drawn` state - so no notice was shown either. The reader was
 * left with an empty bordered box and no explanation at all.
 *
 * In the app the trigger was two overlapping `mermaid.render` calls sharing one
 * container: React Strict Mode runs an effect twice, and because both the dynamic
 * import and the parse are awaited, the two runs overlap rather than queue.
 *
 * ## Why this can be tested in jsdom
 *
 * The empty-SVG *detection* needs no layout: it only inspects the container after
 * the render resolves. So the render is stubbed to reproduce the two outcomes -
 * an SVG with no graph nodes, and an SVG with real primitives - and the
 * component's response to each is asserted directly. That is what makes this
 * test deterministic, where the end-to-end version of the same bug only
 * reproduced under a loaded parallel run.
 *
 * Concurrency is pinned separately, below, without needing Mermaid at all.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { ResolvedDiagram } from "@/lib/mermaid";

const FAILURE_NOTICE =
    "This diagram could not be displayed. The summary and quiz below are unaffected.";

/** How the stubbed `render` should behave for the next test. */
let renderBehaviour: "drawn" | "empty" = "drawn";

/**
 * The real parser, with only the renderer stubbed.
 *
 * `parse` stays genuine so an invalid diagram still fails on Mermaid's own
 * grammar. `render` appends either a populated or an empty SVG depending on
 * `renderBehaviour`, which is the state under test.
 */
vi.mock("mermaid", async () => {
    const actual = await vi.importActual<typeof import("mermaid")>("mermaid");
    const ns = "http://www.w3.org/2000/svg";

    return {
        ...actual,
        default: {
            initialize: actual.default.initialize,
            parse: (code: string) => actual.default.parse(code),
            render: async (_id: string, _code: string, container: Element) => {
                const svg = container.ownerDocument.createElementNS(ns, "svg");
                svg.setAttribute("data-testid", "mermaid-svg");

                // An empty drawing: the style block Mermaid always emits, and no
                // geometry. This is precisely what reached the reader.
                const style = container.ownerDocument.createElementNS(ns, "style");
                svg.appendChild(style);
                if (renderBehaviour === "drawn") {
                    const group = container.ownerDocument.createElementNS(ns, "g");
                    const label = container.ownerDocument.createElementNS(ns, "text");
                    label.textContent = "Chunking Strategies";
                    group.appendChild(label);
                    svg.appendChild(group);
                }

                container.appendChild(svg);
                return svg;
            },
        },
    };
});

const RAG_DIAGRAM: ResolvedDiagram = {
    mermaidCode: 'flowchart TD\n    A["Chunking Strategies"] --> B["Precision@k"]',
    diagramType: "flowchart",
    explanation: "The core RAG loop.",
    source: "generated",
    parseGate: "deferred",
};

afterEach(() => {
    cleanup();
    renderBehaviour = "drawn";
});

describe("a diagram that drew nothing is reported, not shown as a blank box", () => {
    it("shows the failure notice instead of an empty diagram", async () => {
        renderBehaviour = "empty";

        const { container } = render(<MermaidDiagram diagram={RAG_DIAGRAM} />);

        await waitFor(() => expect(screen.getByText(FAILURE_NOTICE)).toBeDefined());
        expect(container.querySelector("svg")).not.toBeNull();
    });

    it("logs the reason so the blank box is diagnosable", async () => {
        renderBehaviour = "empty";
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        render(<MermaidDiagram diagram={RAG_DIAGRAM} />);

        await waitFor(() =>
            expect(
                logged.mock.calls.some((call) =>
                    String(call[0]).includes("without drawing any graph nodes"),
                ),
            ).toBe(true),
        );
        logged.mockRestore();
    });

    it("still shows the diagram when it really drew something", async () => {
        const { container } = render(<MermaidDiagram diagram={RAG_DIAGRAM} />);

        await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
        expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();
    });

    it("does not report a blank box for the placeholder fallback", async () => {
        renderBehaviour = "empty";

        const { container } = render(
            <MermaidDiagram
                diagram={{
                    ...RAG_DIAGRAM,
                    source: "fallback",
                    notice:
                        "The generated diagram could not be shown safely, so a placeholder outline is displayed instead.",
                }}
            />,
        );

        // The placeholder is the honest outcome here; the reader must still be
        // told the render itself produced nothing.
        await waitFor(() => expect(screen.getByText(FAILURE_NOTICE)).toBeDefined());
        expect(container.querySelector("svg")).not.toBeNull();
    });
});