"use client";

/**
 * The interactive half of the development-only diagram bench.
 *
 * Kept in its own file so `page.tsx` can stay a server component: the gate that
 * makes this route 404 in production has to run on the server, and mixing
 * `"use client"` into the page would move that decision into the browser, where
 * it could be bypassed by anyone who simply never downloads the code.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { ResolvedDiagram } from "@/lib/mermaid";

/** The minimal Mermaid surface this page drives by hand. */
type MermaidApi = {
    initialize: (config: Record<string, unknown>) => void;
    parse: (code: string) => Promise<unknown>;
    render: (id: string, code: string, container: Element) => Promise<unknown>;
};

/** A deliberately trivial diagram: no brackets, quotes, or parentheses to trip over. */
const TRIVIAL_SOURCE = 'flowchart TD\n    A["Hello"] --> B["World"]';

/**
 * The configuration the app actually ships with.
 *
 * Copied from `MERMAID_PARSE_CONFIG` rather than imported so this page measures
 * the literal values in force at the moment of the bug, and so changing the app's
 * config does not silently change what the bench is comparing against.
 */
const PRODUCTION_CONFIG: Record<string, unknown> = {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    flowchart: { htmlLabels: false },
};

type PanelResult = {
    status: "pending" | "ok" | "error";
    g: number;
    path: number;
    rect: number;
    text: number;
    svgLength: number;
    preview: string;
    error?: string;
};

const PENDING: PanelResult = {
    status: "pending",
    g: 0,
    path: 0,
    rect: 0,
    text: 0,
    svgLength: 0,
    preview: "",
};

/**
 * Measure whatever ended up inside `scope`.
 *
 * The counts are the whole point of this page. An SVG that Mermaid considers a
 * success can still contain nothing but its `<style>` block, and that is what
 * "renders as an empty box" looks like from the inside.
 */
function measure(scope: Element | null): PanelResult {
    const svg = scope?.querySelector("svg");
    if (svg === null || svg === undefined) {
        return { ...PENDING, status: "error", error: "No <svg> was produced." };
    }

    const markup = svg.outerHTML;
    return {
        status: "ok",
        g: svg.querySelectorAll("g").length,
        path: svg.querySelectorAll("path").length,
        rect: svg.querySelectorAll("rect").length,
        text: svg.querySelectorAll("text").length,
        svgLength: markup.length,
        preview: markup.slice(0, 300),
    };
}

/** The shape of the failure notice the production component shows. */
const FAILURE_NOTICE_FRAGMENT = "could not be displayed";

function Panel({
    title,
    description,
    result,
    notice,
}: {
    title: string;
    description: string;
    result: PanelResult;
    notice?: string;
}) {
    return (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <p className="mt-1 text-sm text-slate-600">{description}</p>

            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
                <Stat label="status" value={result.status} />
                <Stat label="g" value={result.g} />
                <Stat label="path" value={result.path} />
                <Stat label="rect" value={result.rect} />
                <Stat label="text" value={result.text} />
                <Stat label="svg length" value={result.svgLength} />
            </dl>

            {result.error !== undefined && (
                <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    {result.error}
                </p>
            )}
            {notice !== undefined && (
                <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    Component notice: {notice}
                </p>
            )}

            <p className="mt-3 text-xs font-medium text-slate-700">First 300 characters</p>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                {result.preview === "" ? "(nothing rendered yet)" : result.preview}
            </pre>
        </section>
    );
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded border border-slate-200 px-2 py-1">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="text-sm font-medium text-slate-900">{value}</dd>
        </div>
    );
}

/**
 * Panel 1: the production component, measured through the DOM it really produced.
 *
 * Polling rather than awaiting is deliberate. `MermaidDiagram` reports success
 * internally and does not hand anything back, so the only way to see what it
 * actually drew is to look at its container after the fact - which is also exactly
 * what a reader sees.
 */
function ProductionPanel({ source }: { source: string }) {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [result, setResult] = useState<PanelResult>(PENDING);
    const [notice, setNotice] = useState<string | undefined>(undefined);

    const diagram: ResolvedDiagram = useMemo(
        () => ({
            mermaidCode: source,
            diagramType: "flowchart",
            explanation: "Rendered by the diagram debug bench.",
            source: "generated",
            parseGate: "deferred",
        }),
        [source],
    );

    useEffect(() => {
        let cancelled = false;

        const deadline = Date.now() + 15_000;
        const poll = (): void => {
            if (cancelled) return;
            const wrapper = wrapperRef.current;
            if (wrapper !== null && wrapper.querySelector("svg") !== null) {
                const shown = wrapper
                    .querySelector("p[role='status']")
                    ?.textContent?.trim();
                setResult(measure(wrapper));
                setNotice(shown?.includes(FAILURE_NOTICE_FRAGMENT) ? shown : undefined);
                return;
            }
            if (Date.now() > deadline) {
                setResult({
                    ...PENDING,
                    status: "error",
                    error: "Timed out waiting for the component to render anything.",
                });
                return;
            }
            setTimeout(poll, 150);
        };

        // Deferred rather than run inline: polling starts outside the effect body so
        // the first state update is not a synchronous setState during the effect.
        const handle = setTimeout(poll, 0);

        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [source]);

    return (
        <>
            <Panel
                title="1. MermaidDiagram (production path)"
                description="The real component, including its render queue, empty-SVG guard and failure notice."
                result={result}
                notice={notice}
            />
            <div ref={wrapperRef}>
                <MermaidDiagram diagram={diagram} />
            </div>
        </>
    );
}

/**
 * Panels 2 to 4: bare Mermaid, one configuration each.
 *
 * No sanitiser and no queue, on purpose - the point is to see what Mermaid does
 * when nothing stands between it and the text. Unique ids per panel because
 * Mermaid keys internal state on the render id.
 */
function BarePanel({
    title,
    description,
    renderId,
    config,
    source,
}: {
    title: string;
    description: string;
    renderId: string;
    config: Record<string, unknown>;
    source: string;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [result, setResult] = useState<PanelResult>(PENDING);

    useEffect(() => {
        const container = containerRef.current;
        if (container === null) return;

        let cancelled = false;

        const run = async (): Promise<void> => {
            try {
                const mermaidModule = await import("mermaid");
                const mermaid = mermaidModule.default as unknown as MermaidApi;
                mermaid.initialize(config);
                await mermaid.render(renderId, source, container);
                if (!cancelled) setResult(measure(container));
            } catch (error) {
                if (!cancelled) {
                    setResult({
                        ...PENDING,
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
            container.replaceChildren();
        };
    }, [renderId, config, source]);

    return (
        <>
            <Panel title={title} description={description} result={result} />
            <div
                ref={containerRef}
                className="mt-2 min-h-8 overflow-x-auto rounded border border-dashed border-slate-300 p-2"
            />
        </>
    );
}

export default function DiagramDebug() {
    const [source, setSource] = useState(TRIVIAL_SOURCE);

    return (
        <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
            <header>
                <h1 className="text-2xl font-bold text-slate-900">Mermaid render bench</h1>
                <p className="mt-1 text-sm text-slate-600">
                    Development only. This route is a 404 in production.
                </p>
            </header>

            <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                Pasted source is rendered <strong>without sanitisation</strong> in panels 2 to 4. Do not
                paste anything from an untrusted document or the internet.
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-4">
                <label htmlFor="source" className="text-sm font-medium text-slate-700">
                    Mermaid source
                </label>
                <textarea
                    id="source"
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="mt-2 w-full rounded border border-slate-300 p-2 font-mono text-xs"
                />
                <div className="mt-2 flex gap-2">
                    <button
                        type="button"
                        onClick={() => setSource(TRIVIAL_SOURCE)}
                        className="rounded border border-slate-300 px-3 py-1 text-sm"
                    >
                        Reset to trivial source
                    </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                    The RAG fixture at <code>tests/mermaid/fixtures/rag-diagram.mmd</code> is not
                    loaded from disk: importing a <code>.mmd</code> file needs a bundler loader, and
                    adding one would mean touching build configuration. Paste its contents instead.
                </p>
            </section>

            <ProductionPanel key={`production-${source}`} source={source} />

            <BarePanel
                key={`strict-${source}`}
                title="2. Bare render, production config"
                description="securityLevel strict, htmlLabels false. No queue, no sanitiser."
                renderId="bench-strict"
                config={PRODUCTION_CONFIG}
                source={source}
            />
            <BarePanel
                key={`htmllabels-${source}`}
                title="3. Bare render, htmlLabels true"
                description="Only difference from panel 2. Labels become real DOM nodes."
                renderId="bench-htmllabels"
                config={{ ...PRODUCTION_CONFIG, flowchart: { htmlLabels: true } }}
                source={source}
            />
            <BarePanel
                key={`default-${source}`}
                title="4. Bare render, default config"
                description="No initialise options at all, i.e. whatever Mermaid ships with."
                renderId="bench-default"
                config={{}}
                source={source}
            />
        </main>
    );
}