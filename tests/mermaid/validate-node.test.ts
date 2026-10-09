import { describe, expect, it } from "vitest";

import { isMermaidParseAvailable, parseMermaidCode } from "@/lib/mermaid/validate";
import { resolveDiagram } from "@/lib/mermaid";

/**
 * The parse gate in a server-side context.
 *
 * `vitest.config.ts` sets `environment: "node"` globally, which is exactly the
 * environment `/api/summarize` runs in. Mermaid's parser sanitises label text
 * through DOMPurify and so needs a DOM; the gate reports `deferred` here rather
 * than pretending it parsed. This file pins that behaviour so the server cannot
 * quietly start claiming a parse it never performed - and so the sanitiser,
 * which does run server-side, is demonstrably still doing its job.
 */

describe("the parse gate in a DOM-less context", () => {
    it("reports the parser as unavailable", () => {
        expect(isMermaidParseAvailable()).toBe(false);
    });

    it("defers rather than failing a structurally valid diagram", async () => {
        const result = await parseMermaidCode("flowchart TD\n    A[Light] --> B[Reactions]");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // `deferred` is the honest report: sanitisation and the declaration
        // allowlist ran, the grammar check is the browser's job.
        expect(result.gate).toBe("deferred");
    });

    it("still rejects an unallowed diagram type", async () => {
        expect(await parseMermaidCode("html\n  <b>x</b>")).toMatchObject({
            ok: false,
            reason: "UNSUPPORTED_DIAGRAM_TYPE",
        });
    });

    it("still rejects empty input", async () => {
        expect(await parseMermaidCode("  ")).toMatchObject({ ok: false, reason: "EMPTY_CODE" });
    });
});

describe("resolveDiagram degrades safely without a DOM", () => {
    it("returns a valid diagram and marks the parse gate as deferred", async () => {
        const resolved = await resolveDiagram({
            mermaidCode: "flowchart TD\n    A[Light] --> B[Reactions]",
            diagramType: "flowchart",
            explanation: "x",
        });

        expect(resolved.source).toBe("generated");
        expect(resolved.parseGate).toBe("deferred");
    });

    it("rejects an unsafe diagram even though the grammar was never checked", async () => {
        const resolved = await resolveDiagram({
            mermaidCode: 'flowchart TD\n    A --> B\n    click A href "javascript:alert(1)"',
            diagramType: "flowchart",
            explanation: "x",
        });

        // The sanitiser is the server-side half of the gate; it runs regardless
        // of whether mermaid's parser can.
        expect(resolved.mermaidCode).not.toMatch(/click/i);
        expect(resolved.mermaidCode).not.toMatch(/javascript:/i);
    });

    it("falls back for a diagram with no declaration, without a regenerator", async () => {
        const resolved = await resolveDiagram({
            mermaidCode: "just some prose",
            diagramType: "flowchart",
            explanation: "x",
        });

        expect(resolved.source).toBe("fallback");
        expect(resolved.notice).toBeTruthy();
    });
});