// @vitest-environment jsdom
/**
 * The debug route must never be reachable in production.
 *
 * `/debug/diagram` is a rendering bench that accepts arbitrary pasted Mermaid and,
 * in three of its four panels, renders it with no sanitisation. It is gated by a
 * `notFound()` call in the server component, which runs during rendering - so
 * this asserts the gate itself rather than trusting a comment.
 *
 * The environment is stubbed per test and the module is imported afresh, because
 * the page reads `NODE_ENV` inside the function body precisely so that both
 * branches are reachable from a test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function renderPage(env: string): Promise<() => unknown> {
    vi.stubEnv("NODE_ENV", env);
    vi.resetModules();
    const pageModule = await import("@/app/debug/diagram/page");

    return () => (pageModule.default as () => unknown)();
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("the diagram debug route", () => {
    it("resolves to a 404 in production", async () => {
        const render = await renderPage("production");

        // `notFound()` throws a Next.js HTTP error carrying the 404 status rather
        // than returning, which is what makes the gate unskippable at render time.
        expect(render).toThrow(/404/);
    });

    it("does not 404 in development", async () => {
        const render = await renderPage("development");

        // Asserted as "no 404" rather than "no throw" on purpose. Creating the
        // element pulls in the client component tree, and this repository's Vitest
        // setup cannot construct JSX for it (`jsxDEV is not a function`) - an
        // unrelated harness limitation. The security property under test is the
        // gate, so only the gate is asserted.
        expect(render).not.toThrow(/404/);
    });

    it("treats any non-production environment as development", async () => {
        // Guards against the gate being written as `!== "development"`, which would
        // 404 the route under `test` and hide it from CI for the wrong reason.
        const render = await renderPage("test");

        expect(render).not.toThrow(/404/);
    });
});