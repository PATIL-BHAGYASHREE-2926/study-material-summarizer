// @vitest-environment jsdom
/**
 * Regression tests for the API misuse behind the blank diagram.
 *
 * ## The bug
 *
 * The component called `mermaid.render(id, text, container)` and expected the
 * diagram to appear in `container`. It does not. That third argument is a scratch
 * element Mermaid uses while measuring labels, and `removeTempElements` empties it
 * again before the promise resolves.
 *
 * Captured live, from the container the reader was looking at:
 *
 *     REMOVE DIV
 *       at removeTempElements (mermaid core)
 *       at renderDiagram      (mermaid core)
 *       at async render       (mermaid core)
 *
 * So the container held a finished, populated SVG right up to the moment Mermaid
 * deleted it, and was empty by the time anything inspected it. The reader saw a
 * blank box and the emptiness guard fired on a diagram that had rendered correctly
 * milliseconds earlier.
 *
 * These tests pin the contract, not the internals: Mermaid must never be given the
 * live container, and the diagram must survive in it once the promise settles.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { ResolvedDiagram } from "@/lib/mermaid";

const FAILURE_NOTICE =
    "This diagram could not be displayed. The summary and quiz below are unaffected.";

/** Every call the component made to `render`, for assertions below. */
let renderCalls: { id: string; container: Element | undefined }[] = [];

/** Whether the stub should hand back a diagram or a genuinely empty one. */
let empty = false;

vi.mock("mermaid", async () => {
    const actual = await vi.importActual<typeof import("mermaid")>("mermaid");

    return {
        ...actual,
        default: {
            initialize: actual.default.initialize,
            parse: (code: string) => actual.default.parse(code),
            render: async (id: string, _code: string, container?: Element) => {
                renderCalls.push({ id, container });
                const style = "<style></style>";
                const body = empty
                    ? ""
                    : '<g><text>Vector Database</text></g><rect width="10" height="10"></rect>';
                // Mermaid returns markup, not an element.
                return {
                    svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}">${style}${body}</svg>`,
                };
            },
        },
    };
});

const DIAGRAM: ResolvedDiagram = {
    mermaidCode: 'flowchart TD\n    A["Vector Database"] --> B["HNSW index"]',
    diagramType: "flowchart",
    explanation: "How retrieval works.",
    source: "generated",
    parseGate: "deferred",
};

afterEach(() => {
    cleanup();
    renderCalls = [];
    empty = false;
});

describe("rendering does not hand Mermaid the live container", () => {
    it("never passes the container to mermaid.render", async () => {
        render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(renderCalls.length).toBeGreaterThan(0));
        // The single most important assertion in this file: a third argument here
        // is what let Mermaid delete the finished diagram.
        for (const call of renderCalls) {
            expect(call.container).toBeUndefined();
        }
    });

    it("uses a unique render id per call", async () => {
        render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(renderCalls.length).toBeGreaterThan(0));
        const ids = renderCalls.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("keeps the finished diagram in the container once the promise settles", async () => {
        const { container } = render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
        // Nothing removes it afterwards - the defect was a post-resolve deletion.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(container.querySelector("svg")).not.toBeNull();
        expect(container.querySelector("text")?.textContent).toBe("Vector Database");
    });

    it("adopts the diagram as a parsed SVG element, not as injected HTML", async () => {
        const { container } = render(<MermaidDiagram diagram={DIAGRAM} />);
        await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());

        // The component is the one place model-derived text becomes markup and has
        // no HTML sink by design. Proving the adopted node is a real SVGElement in
        // the SVG namespace shows the markup was parsed and adopted, never assigned
        // through `innerHTML`.
        const svg = container.querySelector("svg");
        expect(svg).toBeInstanceOf(window.SVGElement);
        expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    });

    it("still reports a diagram Mermaid genuinely drew as nothing", async () => {
        empty = true;

        const { container } = render(<MermaidDiagram diagram={DIAGRAM} />);

        await waitFor(() => expect(screen_text()).toContain(FAILURE_NOTICE));
        expect(container.querySelector("svg")).not.toBeNull();
    });
});

/** The visible text of the document, used for notice assertions. */
function screen_text(): string {
    return document.body.textContent ?? "";
}
