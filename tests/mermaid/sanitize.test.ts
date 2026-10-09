import { describe, expect, it } from "vitest";

import { MAX_MERMAID_CODE_LENGTH } from "@/lib/constants/limits";
import { sanitizeMermaidCode } from "@/lib/mermaid/sanitize";

/**
 * Unit tests for the Mermaid sanitiser.
 *
 * Each test states an attack shape and asserts the output is inert. The
 * sanitiser's contract is a *post-condition*, so the assertions are written
 * against the returned string ("no `javascript:` survives") rather than against
 * a particular rule having fired - a test that only checked which rule matched
 * would pass even if a second rule had removed the same payload by accident, and
 * would fail if a rule were reimplemented more effectively.
 */

describe("legitimate diagrams survive untouched", () => {
    it("accepts a flowchart and keeps every label and edge", () => {
        const code = [
            "flowchart TD",
            "    Light[Light energy] --> Reactions[Light-dependent reactions]",
            "    Reactions --> Cycle[Calvin cycle]",
            "    Cycle --> Sugars[Glucose]",
        ].join("\n");

        const result = sanitizeMermaidCode(code);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).toBe(code);
        expect(result.removedRules).toEqual([]);
    });

    it("keeps dashed, dotted and labelled arrows", () => {
        const code = [
            "flowchart LR",
            "    A -.-> B",
            "    B ==> C",
            "    C -->|optional| D",
            "    D ---- E",
        ].join("\n");

        const result = sanitizeMermaidCode(code);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).toBe(code);
    });

    it("keeps sequence, class, mindmap and graph declarations", () => {
        const cases = [
            "sequenceDiagram\n    A->>B: request",
            "classDiagram\n    Animal <|-- Duck",
            "mindmap\n  root((Photosynthesis))\n    Light reactions",
            "graph TD\n    A --> B",
        ];

        for (const code of cases) {
            expect(sanitizeMermaidCode(code).ok).toBe(true);
        }
    });
});

describe("unsafe constructs are neutralised", () => {
    it("removes a click directive and its payload", () => {
        const result = sanitizeMermaidCode(
            ["flowchart TD", "    A[Open me] --> B", 'click A href "https://evil.test"', "    B --> C"].join("\n"),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/click/i);
        expect(result.code).not.toContain("evil.test");
        // The diagram itself survives; only the interaction is gone.
        expect(result.code).toContain("A[Open me]");
        expect(result.removedRules).toContain("interaction-directive");
    });

    it("removes a javascript: URL wherever it appears", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A["Go"] --> B\n    click A call go() "javascript:alert(document.domain)"',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/javascript:/i);
        expect(result.code).not.toMatch(/alert\(/);
    });

    it("removes a data: URL", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A --> B\n    click A href "data:text/html;base64,PHNjcmlwdD4="',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/data:/i);
        expect(result.code).not.toContain("base64");
    });

    it("removes a raw script block including its contents", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A --> B\n    <script>window.location='https://evil.test'</script>",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/script/i);
        expect(result.code).not.toContain("evil.test");
        expect(result.removedRules).toContain("script-block");
    });

    it("removes a raw style block including its contents", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A --> B\n    <style>body{background:url('https://evil.test')}</style>",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/<style/i);
        expect(result.code).not.toContain("background");
    });

    it("removes event-handler attributes on injected tags", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A["<img src=x onerror=alert(1)>"] --> B',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/onerror/i);
        expect(result.code).not.toMatch(/<img/i);
    });

    it("removes a foreignObject that could smuggle HTML into the SVG", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A["<foreignObject><body onload=alert(1)></body></foreignObject>"] --> B',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/foreignObject/i);
        expect(result.code).not.toMatch(/onload/i);
    });

    it("removes an %%{init:...}%% directive", () => {
        const result = sanitizeMermaidCode(
            "%%{init: {'securityLevel': 'loose', 'htmlLabels': true}}%%\nflowchart TD\n    A --> B",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toContain("%%{");
        expect(result.code).not.toContain("securityLevel");
        expect(result.code).toContain("flowchart TD");
        expect(result.removedRules).toContain("directive");
    });

    it("removes an unterminated %%{ directive", () => {
        const result = sanitizeMermaidCode("flowchart TD\n    A --> B\n%%{init: {'htmlLabels': true}");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toContain("%%{");
    });

    it("removes href and src attributes", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A["Label"] --> B\n    classDef evil href="https://evil.test"',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/href/i);
        expect(result.code).not.toContain("evil.test");
    });

    it("removes a markdown-style link target but keeps the label", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A[\"Read more\"](https://evil.test) --> B",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toContain("evil.test");
        expect(result.code).toContain("Read more");
    });

    it("removes a CSS url() reference", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A --> B\n    style A fill:url(https://evil.test/x.svg)",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/url\(/i);
        expect(result.code).not.toContain("evil.test");
    });

    it("normalises CRLF so a click directive cannot hide behind a carriage return", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\r\n    A --> B\r\nclick A href \"https://evil.test\"\r\n",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/click/i);
        expect(result.code).not.toContain("\r");
    });

    it("strips a leading byte-order mark before the declaration", () => {
        const result = sanitizeMermaidCode("\uFEFFflowchart TD\n    A --> B");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code.startsWith("flowchart")).toBe(true);
    });

    it("removes NUL bytes and other control characters", () => {
        const result = sanitizeMermaidCode("flowchart TD\n    A[\u0000x\"] --> B\u0007");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/[\u0000-\u0008]/);
    });
});

describe("HTML entity smuggling is defeated", () => {
    it("decodes a numerically encoded tag and removes it", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A[\"&#60;script&#62;alert(1)&#60;/script&#62;\"] --> B",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/script/i);
        expect(result.code).not.toMatch(/&#x?0*3c/i);
    });

    it("decodes a hex-encoded tag and removes it", () => {
        const result = sanitizeMermaidCode(
            'flowchart TD\n    A["&#x3C;img src=x onerror=alert(1)&#x3E;"] --> B',
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/onerror/i);
        expect(result.code).not.toMatch(/<img/i);
    });

    it("decodes named lt/gt entities and removes the reconstructed tag", () => {
        const result = sanitizeMermaidCode(
            "flowchart TD\n    A[\"&lt;script&gt;alert(1)&lt;/script&gt;\"] --> B",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).not.toMatch(/script/i);
    });

    it("leaves an unknown entity untouched so legitimate text survives", () => {
        const result = sanitizeMermaidCode("flowchart TD\n    A[&copy; 2024] --> B");

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).toContain("&copy;");
    });
});

describe("the post-condition rejects anything the removals missed", () => {
    it("rejects output whose only content was an unsafe construct", () => {
        const result = sanitizeMermaidCode("<script>alert(1)</script>");

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("EMPTY_CODE");
    });

    it("does not return a partial result when content is emptied", () => {
        const result = sanitizeMermaidCode("flowchart TD\n    A[\"<b>x</b>\"] --> B");

        // The tag is removed but the surrounding diagram is not, so this one
        // still succeeds - which is the point: removal is surgical.
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.code).toContain("flowchart TD");
    });
});

describe("size and emptiness limits", () => {
    it("rejects an empty or whitespace-only diagram", () => {
        expect(sanitizeMermaidCode("")).toMatchObject({ ok: false, reason: "EMPTY_CODE" });
        expect(sanitizeMermaidCode("   \n  ")).toMatchObject({ ok: false, reason: "EMPTY_CODE" });
    });

    it("rejects a diagram longer than the configured maximum", () => {
        // Built by explicit length rather than by repeating a line, so the
        // fixture cannot drift away from the constant it is testing.
        const oversized = `flowchart TD\n    A${"x".repeat(MAX_MERMAID_CODE_LENGTH)}`;

        expect(oversized.length).toBeGreaterThan(MAX_MERMAID_CODE_LENGTH);
        expect(sanitizeMermaidCode(oversized)).toMatchObject({ ok: false, reason: "TOO_LONG" });
    });

    it("accepts a diagram just under the limit", () => {
        const body = "flowchart TD\n    A --> B";
        const padding = "\n".repeat(MAX_MERMAID_CODE_LENGTH - body.length);

        expect(sanitizeMermaidCode(body + padding).ok).toBe(true);
    });
});