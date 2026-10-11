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
    render: (id: string, code: string, container: Element) => Promise<unknown>;
};

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
                const mermaidModule = await import("mermaid");
                const mermaid = mermaidModule.default as unknown as MermaidApi;
                mermaid.initialize({ ...MERMAID_PARSE_CONFIG });

                // The browser-side parse gate. Sanitisation already happened on
                // the server; this is the syntax check that only a DOM allows.
                await mermaid.parse(code);

                // The container is handed to mermaid rather than receiving its
                // output as a string: no HTML sink exists in this component.
                // `useId` cannot be used for the element id because mermaid also
                // queries it, and its colons are awkward in a CSS selector.
                const renderId = `mermaid-diagram-${crypto.randomUUID().slice(0, 8)}`;
                await mermaid.render(renderId, code, container);

                if (!cancelled) setState("drawn");
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
            // Stops a slow render from writing state after unmount, and clears
            // any half-drawn SVG so a re-render cannot stack two diagrams.
            cancelled = true;
            container.replaceChildren();
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