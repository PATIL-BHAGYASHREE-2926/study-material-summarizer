"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import type { ResolvedDiagram } from "@/lib/mermaid";
import { MERMAID_PARSE_CONFIG } from "@/lib/mermaid/validate";

import { Card, Notice, SectionHeading } from "./ui";

/**
 * Renders one Mermaid diagram.
 *
 * ## Rendering safety
 *
 * This is the only component in the app that turns untrusted text into markup,
 * and it is safe by construction rather than by filtering:
 *
 * 1. The code arrives from the server already sanitised and gated
 *    (`resolveDiagram`), so what this component receives is the sanitised
 *    string - never raw model output.
 * 2. Mermaid is imported dynamically, so the library never enters the server
 *    bundle and never executes during SSR.
 * 3. `mermaid.parse()` runs again here before anything is drawn - the
 *    client-side parse gate from ARCHITECTURE.md Stage 5.3. A parse failure
 *    shows a message instead of a diagram.
 * 4. `mermaid.render()` is called with `securityLevel: "strict"` and
 *    `htmlLabels: false`, so label text is escaped rather than interpreted.
 *
 * **No `dangerouslySetInnerHTML` anywhere.** Mermaid accepts a container element
 * and inserts the SVG into it itself, so this component never touches `innerHTML`
 * and never hands React a markup string. Every value on the page - AI summaries,
 * questions, explanations, the diagram source in the disclosure below - is
 * rendered as an escaped React text node, which is what makes XSS structurally
 * impossible rather than merely filtered.
 */

export interface MermaidDiagramProps {
    diagram: ResolvedDiagram;
}

/** The minimal mermaid surface this component uses. */
type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    parse: (code: string) => Promise<unknown>;
    render: (id: string, code: string, container?: Element) => Promise<unknown>;
};

/**
 * Import and configure Mermaid exactly once per page.
 *
 * `mermaid.initialize` mutates module-global state: it replaces the render API and
 * resets Mermaid's own caches. Calling it on every effect run meant two
 * concurrent runs could reset that state *while the other was mid-render*, which
 * contributes to the empty-SVG failure below. One shared, already-configured
 * instance means a later run can never disturb an earlier one.
 */
let mermaidPromise: Promise<MermaidApi> | undefined;

function loadMermaid(): Promise<MermaidApi> {
    mermaidPromise ??= import("mermaid").then((module) => {
        const mermaid = module.default as unknown as MermaidApi;
        mermaid.initialize({ ...MERMAID_PARSE_CONFIG });
        return mermaid;
    });
    return mermaidPromise;
}

/**
 * Render one diagram and hand back the finished SVG element.
 *
 * ## Why this does not pass a container to Mermaid
 *
 * `mermaid.render(id, text, container)` does **not** draw into `container`. That
 * third argument is a scratch element Mermaid uses while it measures labels and
 * lays the graph out, and it empties it again before resolving. Captured live from
 * the subgraph diagram that reached a reader blank:
 *
 *     REMOVE DIV
 *       at removeTempElements (mermaid core)
 *       at renderDiagram      (mermaid core)
 *       at async render       (mermaid core)
 *
 * so the container held a complete, populated SVG right up to the moment Mermaid
 * deleted it, and was empty by the time the promise settled. Every symptom
 * followed from that: a blank box, and an emptiness guard firing on a diagram that
 * had rendered correctly milliseconds earlier.
 *
 * Rendering without the third argument makes Mermaid use its own internal
 * scratch element and *return* the finished SVG, which this module inserts into
 * the container itself. The component then owns its DOM, so nothing can clear it
 * behind our back.
 *
 * Renders are serialised: `mermaid.render` keeps the diagram under construction in
 * module-global state, so two overlapping renders overwrite each other and one of
 * them produces nothing.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

interface RenderedDiagram {
    /** Mermaid returns the diagram as a markup *string*, not an element. */
    svg: string;
    bindFunctions?: (element: Element) => void;
}

/**
 * Turn Mermaid's SVG string into a real element, without an HTML sink.
 *
 * Mermaid's own internal caller assigns the string with `element.innerHTML = svg`.
 * This module does not, and deliberately will not: it is the one component that
 * turns model-derived text into markup, and giving it an HTML sink would undo the
 * property that makes it safe by construction.
 *
 * `DOMParser` with `image/svg+xml` builds an inert document - it does not execute
 * script and does not run event handlers - so the result is data, not code, at the
 * point it is adopted. `importNode` then brings it into this document. The labels
 * inside were already passed through DOMPurify by Mermaid under
 * `securityLevel: "strict"`.
 */
function toSvgElement(markup: string): SVGElement {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");

    // A malformed document yields a `parsererror` element rather than throwing.
    if (parsed.querySelector("parsererror") !== null) {
        throw new Error("Mermaid returned SVG that could not be parsed");
    }
    const root = parsed.documentElement;
    if (root.tagName.toLowerCase() !== "svg") {
        throw new Error("Mermaid returned markup that is not an SVG element");
    }

    return document.importNode(root, true) as unknown as SVGElement;
}

function renderDiagram(id: string, code: string): Promise<RenderedDiagram> {
    const result = renderQueue.then(async () => {
        const mermaid = await loadMermaid();
        return (await mermaid.render(id, code)) as unknown as RenderedDiagram;
    });
    // Swallow on the chain only, so one failure does not reject every later render.
    renderQueue = result.catch(() => undefined);
    return result as Promise<RenderedDiagram>;
}

/**
 * Resolve once `container` has a usable width, or immediately if it already has one.
 *
 * ## Why this gate exists
 *
 * `results-view.tsx` keeps all three tab panels mounted and toggles them with the
 * `hidden` attribute, so this component mounts - and would render - while its
 * container is `display: none` and reports `clientWidth === 0`.
 *
 * Mermaid measures the container it is handed to lay the graph out. With no width
 * to work in it produces no drawing at all, and it does so *successfully*: the
 * promise resolves, no error is thrown, and nothing appears in the container. The
 * reader gets an empty box with no explanation.
 *
 * Worse, nothing repaired it. The effect's dependencies are `[code, containerRef]`,
 * and opening the Diagram tab changes neither, so the one render pass was already
 * spent - the diagram stays blank for good.
 *
 * Width is the only dimension worth gating on. An empty container legitimately
 * reports `clientHeight === 0`, so requiring a non-zero height would wait for
 * something that can only happen *after* the render, and would deadlock.
 *
 * `ResizeObserver` does not exist under jsdom, where every element reports zero
 * width forever. Its absence means "do not wait", which keeps the component tests
 * meaningful - and jsdom has no layout for this failure to occur in anyway.
 */
function waitForLayout(container: HTMLElement, isCancelled: () => boolean): Promise<void> {
    if (typeof ResizeObserver === "undefined") return Promise.resolve();
    if (container.clientWidth > 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
            if (isCancelled() || container.clientWidth > 0) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(container);
    });
}

/**
 * SVG elements that carry no drawing: grouping, styling and definition wrappers.
 *
 * `<g>` is the important one. Mermaid opens a drawing with empty group elements
 * even when it goes on to draw nothing at all, so counting `g` as evidence of a
 * diagram accepts an SVG holding a single empty group - present, sized, and
 * completely blank. That is the same reader-visible failure the guard exists to
 * catch.
 */
const NON_DRAWING_SVG_ELEMENTS: ReadonlySet<string> = new Set(["g", "style", "defs"]);

/**
 * Whether a rendered SVG actually contains a drawing, at this instant.
 *
 * Mermaid reports success for a diagram it drew as nothing at all: the `<svg>`
 * arrives holding only its `<style>` block and empty group elements. That is
 * invisible to a visibility check - the element has a bounding box - which is how
 * an empty box reached a reader with no warning.
 *
 * Every other element Mermaid can emit is a painted primitive - `path`, `rect`,
 * `text`, `circle`, and so on - so the test is simply "is there anything that is
 * not a wrapper". Written as a scan rather than a long selector list, both because
 * it stays correct if Mermaid adds a shape and because element-name selector lists
 * are handled inconsistently by the DOM emulation in this test environment.
 */
function hasDrawableContent(container: Element): boolean {
    const svg = container.querySelector("svg");
    if (svg === null) return false;

    return [...svg.querySelectorAll("*")].some((element) =>
        !NON_DRAWING_SVG_ELEMENTS.has(element.tagName.toLowerCase()),
    );
}

/**
 * Draw `code` into `containerRef`, or report why it could not be drawn.
 *
 * Never throws: a render failure is a user-visible state, not an exception that
 * should tear down the results view and take the summary and quiz with it.
 */
function useMermaidRender(
    code: string,
    containerRef: RefObject<HTMLDivElement | null>,
): "pending" | "drawn" | "failed" {
    const [state, setState] = useState<"pending" | "drawn" | "failed">("pending");

    useEffect(() => {
        const container = containerRef.current;
        // The container must exist before mermaid is handed it, so it is mounted
        // unconditionally and the pending/failed notices render beside it.
        if (container === null) return;

        let cancelled = false;
        setState("pending");

        const run = async (): Promise<void> => {
            try {
                /**
                 * Do not draw into a container with no layout box. See
                 * `waitForLayout` - without this, mounting while the tab panel is
                 * hidden produces a rendering that is empty yet reported as a
                 * success, and no later code path ever redraws it.
                 */
                await waitForLayout(container, () => cancelled);
                if (cancelled) return;

                const mermaid = await loadMermaid();

                // The browser-side parse gate. Sanitisation already happened on
                // the server; this is the syntax check that only a DOM allows.
                await mermaid.parse(code);

                /**
                 * Ignore a run that has already been superseded.
                 *
                 * React Strict Mode runs an effect twice in development, and because
                 * the import and the parse are both awaited, the two runs overlap
                 * rather than queue. A discarded run must not draw, or it races the
                 * surviving one for the container. Guarding `setState` alone was not
                 * enough: a cancelled run still reached `render`.
                 */
                if (cancelled) return;

                // The container is handed to mermaid rather than receiving its
                // output as a string: no HTML sink exists in this component.
                // `useId` cannot be used for the element id because mermaid also
                // queries it, and its colons are awkward in a CSS selector.
const renderId = `mermaid-diagram-${crypto.randomUUID().slice(0, 8)}`;
                const { svg, bindFunctions } = await renderDiagram(renderId, code);

                if (cancelled) return;

                // The component owns its DOM from here. Mermaid is given no
                // container, so nothing can clear it out from under us - see
                // `renderDiagram`.
                container.replaceChildren();
                container.appendChild(toSvgElement(svg));
                // Attaches the handlers Mermaid wires for HTML labels. No-op for
                // `htmlLabels: false`, but harmless and correct if that ever changes.
                bindFunctions?.(container);

                /**
                 * A resolved promise is not proof of a diagram.
                 *
                 * Now that this component inserts the SVG itself, this check is a
                 * straightforward assertion about what was just appended rather than
                 * a race against Mermaid's own DOM churn - and it is the check that
                 * turns a blank box into a visible notice instead of silence.
                 */
                if (!hasDrawableContent(container)) {
                    console.error("[diagram] Mermaid resolved without drawing any graph nodes");
                    setState("failed");
                    return;
                }

                setState("drawn");
            } catch (error) {
                // Logged, not swallowed. A parse error here is the only signal
                // that a diagram was rejected: the server-side parse gate is
                // deferred on the Node runtime, so the browser is the first and
                // only parser a shipped diagram meets, and a bare `catch {}`
                // makes that rejection invisible to everyone but the reader.
                //
                // Safe to log because the text involved is not secret - the same
                // source is rendered to the reader in the disclosure below this
                // diagram - and it never carries document text or a credential.
                console.error("[diagram] Mermaid parse or render failed", error);
                if (!cancelled) setState("failed");
            }
        };

        void run();

        return () => {
            // Stops a slow render from writing state after unmount.
            //
            // This deliberately does NOT clear the container. Measured on the live
            // subgraph diagram: a completed, populated SVG was present 14ms before
            // this cleanup ran, and clearing the container here emptied it at the
            // exact moment the emptiness guard read it - so the guard correctly
            // reported "no graph nodes" about a container that had just held a
            // finished diagram.
            //
            // Nothing stacks instead. Mermaid clears the container itself when it
            // renders into it, and renders are serialised through `renderQueue`, so
            // each draw replaces the previous one rather than adding to it.
            cancelled = true;
        };
    }, [code, containerRef]);

    return state;
}

export function MermaidDiagram({ diagram }: MermaidDiagramProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const state = useMermaidRender(diagram.mermaidCode, containerRef);

    return (
        <Card>
            <SectionHeading title="Conceptual diagram" hint={diagram.explanation} />

            {diagram.source === "fallback" && diagram.notice !== undefined && (
                <div className="mb-4">
                    <Notice>{diagram.notice}</Notice>
                </div>
            )}

            {state === "pending" && (
                <p className="py-8 text-center text-sm text-slate-500">
                    Rendering the diagram...
                </p>
            )}

            {state === "failed" && (
                <Notice>
                    This diagram could not be displayed. The summary and quiz below
                    are unaffected.
                </Notice>
            )}

            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4">
                <div
                    ref={containerRef}
                    role="img"
                    aria-label="Conceptual diagram of the study material"
                    className="flex justify-center"
                />
            </div>

            <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-slate-600">
                    View diagram source
                </summary>
                {/* Rendered as a text node: the source is model-derived text, not markup. */}
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
                    {diagram.mermaidCode}
                </pre>
            </details>
        </Card>
    );
}
