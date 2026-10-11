// @vitest-environment jsdom
/**
 * Regression tests for the live failure: a diagram that mounted while hidden.
 *
 * ## What actually happened
 *
 * `results-view.tsx` keeps all three tab panels mounted and toggles them with the
 * `hidden` attribute, so `MermaidDiagram` mounts while its container is
 * `display: none` and reports `clientWidth === 0`.
 *
 * Mermaid lays the graph out against the width of the container it is handed.
 * Given none, it drew nothing, resolved its promise without throwing, and left
 * the container empty. The component then reported "drawn" and the reader saw an
 * empty box with no warning. Opening the Diagram tab did not help: the effect
 * depends on `[code, containerRef]`, neither of which the tab click changes, so
 * the single render pass was already spent.
 *
 * ## How this is reproduced deterministically
 *
 * jsdom performs no layout, so `clientWidth` is always 0 there - which is exactly
 * the condition being modelled. `ResizeObserver` is supplied by a stub that
 * records its callbacks, and the width is driven by hand. The test therefore
 * controls precisely when the container "becomes visible", with no reliance on
 * timing, concurrency or load.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { ResolvedDiagram } from "@/lib/mermaid";

const FAILURE_NOTICE =
    "This diagram could not be displayed. The summary and quiz below are unaffected.";

/**
 * The container's width, driven by the test.
 *
 * jsdom gives every element a zero width, which is the very state under test, so
 * the only thing missing is a way to say "the tab is now open".
 */
let containerWidth = 0;

/** Callbacks handed to `observe`, so a test can trigger a resize. */
const resizeCallbacks: (() => void)[] = [];

class StubResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
        resizeCallbacks.push(this.callback);
    }
    disconnect(): void {}
}

/** The renderer stub: draws a real diagram, or one with no geometry. */
let renderOutcome: "drawn" | "empty" | "empty-group" = "drawn";

vi.mock("mermaid", async () => {
    const actual = await vi.importActual<typeof import("mermaid")>("mermaid");

    return {
        ...actual,
        default: {
            initialize: actual.default.initialize,
            parse: (code: string) => actual.default.parse(code),
            render: async (_id: string, _code: string) => {
                // Mermaid resolves with the diagram as a markup *string*, which the
                // component parses and adopts. The three outcomes modelled here are
                // what the live runs actually produced.
                const open = '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg">';
                const style = "<style></style>";

                // With no width to lay out in it produces no drawing and still
                // resolves - modelled as an SVG with nothing in it.
                if (renderOutcome === "empty") {
                    return { svg: open + style + "</svg>" };
                }

                // A sized SVG holding a single empty group: no geometry, no labels.
                if (renderOutcome === "empty-group") {
                    return { svg: open + style + "<g></g></svg>" };
                }

                return {
                    svg: open + style + "<g><text>Chunking Strategies</text></g></svg>",
                };
            },
        },
    };
});

const DIAGRAM: ResolvedDiagram = {
    mermaidCode: 'flowchart TD\n    A["Chunking Strategies"] --> B["Precision@k"]',
    diagramType: "flowchart",
    explanation: "Rendered for the hidden-container regression.",
    source: "generated",
    parseGate: "deferred",
};

/** Make the container visible and let the observer deliver the notification. */
function openTheTab(): void {
    containerWidth = 640;
    for (const callback of resizeCallbacks) callback();
}

/** Report the container width the component will read. */
function installWidth(): void {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get(this: HTMLElement): number {
            return this.getAttribute("role") === "img" ? containerWidth : 640;
        },
    });
}

beforeEach(() => {
    containerWidth = 0;
    resizeCallbacks.length = 0;
    renderOutcome = "drawn";
    installWidth();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("a diagram whose container had no layout box at mount", () => {
    it(
        "waits for the tab to open instead of drawing into a hidden container",
        // Same allowance as the other first-mermaid tests in this suite: importing
        // and initialising mermaid under jsdom can exceed the 5s default when the
        // whole suite runs in parallel.
        { timeout: 60_000 },
        async () => {
            render(<MermaidDiagram diagram={DIAGRAM} />);

            // Still hidden: nothing drawn, and crucially no failure notice either,
            // because nothing has gone wrong yet - the render simply has not happened.
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();

            openTheTab();

            await waitFor(() => expect(screen.queryByText(FAILURE_NOTICE)).toBeNull());
            await waitFor(() =>
                expect(document.querySelector("div[role='img'] svg")).not.toBeNull(),
            );
        },
    );

    it("draws immediately when the container is already visible", async () => {
        // The Summary-tab reader, or a build where the panel is not hidden.
        containerWidth = 640;

        render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() =>
            expect(document.querySelector("div[role='img'] svg")).not.toBeNull(),
        );
        expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();
    });
});

describe("genuinely empty and invalid diagrams keep their fallback behaviour", () => {
    it("still reports a diagram Mermaid drew as nothing", async () => {
        // The guard added for the blank box must survive the layout gate: once the
        // container is visible and Mermaid still produces no drawing, that is a
        // real failure and the reader is told.
        renderOutcome = "empty";
        containerWidth = 640;

        render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(screen.getByText(FAILURE_NOTICE)).toBeDefined());
    });

    it("still reports a drawing that is only an empty group", async () => {
        // Observed live: Mermaid resolved with an `<svg>` holding a single empty
        // `<g>`. It had a real bounding box and satisfied any check that looked for
        // group elements, so the reader saw a blank box with no notice. A wrapper
        // with nothing inside is not a diagram.
        renderOutcome = "empty-group";
        containerWidth = 640;

        render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(screen.getByText(FAILURE_NOTICE)).toBeDefined());
    });

    it("still reports a syntax error", async () => {
        containerWidth = 640;

        render(
            <MermaidDiagram
                diagram={{ ...DIAGRAM, mermaidCode: "flowchart TD\n    A[Broken -->" }}
            />,
        );

        await waitFor(() => expect(screen.getByText(FAILURE_NOTICE)).toBeDefined());
    });

    it("still shows the placeholder notice for a fallback diagram", async () => {
        containerWidth = 640;

        render(
            <MermaidDiagram
                diagram={{
                    ...DIAGRAM,
                    source: "fallback",
                    notice:
                        "The generated diagram could not be shown safely, so a placeholder outline is displayed instead.",
                }}
            />,
        );

        await waitFor(() =>
            expect(screen.getByText(/placeholder outline is displayed instead/i)).toBeDefined(),
        );
        expect(screen.queryByText(FAILURE_NOTICE)).toBeNull();
    });
});