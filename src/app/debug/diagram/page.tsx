import { notFound } from "next/navigation";

import DiagramDebug from "./diagram-debug";

/**
 * Development-only Mermaid render bench.
 *
 * This page exists to answer one question at a time: when a diagram renders empty,
 * which layer is responsible? It renders the same source four ways - through the
 * production component, then bare through Mermaid under three different
 * configurations - and reports, for each, the element counts, the serialised SVG
 * length and the opening of the SVG.
 *
 * ## Why it must never ship
 *
 * It is a debugging surface, not a feature. It accepts arbitrary pasted Mermaid,
 * and three of its four panels deliberately skip the sanitiser and the render
 * queue so that they show what Mermaid does on its own. That is exactly why it is
 * unreachable outside development: in production the route resolves to a 404 and
 * the client chunk that backs it is never linked from a live page.
 *
 * `notFound()` is the gate rather than a `NODE_ENV` check hidden in the client,
 * because it is enforced on the server during rendering. `tests/debug/diagram-page.test.ts`
 * pins both halves of that: that the route throws a 404 under production, and that
 * it still renders under development.
 */
export default function DebugDiagramPage() {
    // Checked on every render, not at module scope, so a test can toggle the
    // environment and prove both branches of the gate.
    if (process.env.NODE_ENV === "production") notFound();

    return <DiagramDebug />;
}