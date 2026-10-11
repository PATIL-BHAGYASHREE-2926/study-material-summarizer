// @vitest-environment jsdom
/**
 * Regression tests for the Mermaid label-syntax failure that shipped a blank
 * diagram to readers.
 *
 * ## The bug these pin
 *
 * A live Groq response produced this diagram, which is exactly what a model
 * writes for any subject with a parenthetical aside:
 *
 *     C[Water splitting (O2 + e- + H+)]
 *     I --> J[Glyceraldehyde-3-phosphate (G3P)]
 *
 * In Mermaid's flowchart grammar a bare `(` inside `[...]` opens a *stadium*
 * shape, so the label does not parse. The server-side parse gate is deferred on
 * the Node runtime (no DOM for DOMPurify), so the browser was the first parser
 * the diagram ever met, the parse failed there, and the reader saw
 * "This diagram could not be displayed" while the explanation above it read as
 * though the diagram had worked.
 *
 * The fix is `normalizeMermaidSyntax`, applied between sanitisation and the
 * parse gate. These tests assert the rewrite, assert the rewritten source really
 * does parse under mermaid's own parser, and - just as importantly - assert that
 * diagrams it is not confident about are left alone so the fallback still
 * catches genuinely invalid Mermaid.
 */

import { describe, expect, it } from "vitest";

import { normalizeMermaidSyntax } from "@/lib/mermaid/normalize";
import { parseMermaidCode } from "@/lib/mermaid/validate";
import { resolveDiagram } from "@/lib/mermaid";

/**
 * The verbatim Mermaid source from the failing live request.
 *
 * Kept byte-for-byte as received, superscripts and all, because the whole point
 * is that this exact text reached readers unrendered.
 */
const REPRODUCED_MODEL_OUTPUT = [
    "flowchart TD",
    "    A[Sunlight] --> B[Chlorophyll absorbs photons]",
    "    B --> C[Water splitting (O\u2082 + e\u207b + H\u207a)]",
    "    C --> D[Electron Transport Chain]",
    "    D --> E[Proton gradient across thylakoid membrane]",
    "    E --> F[ATP synthase produces ATP]",
    "    D --> G[NADP\u207a reduced to NADPH]",
    "    F & G --> H[Calvin Cycle in Stroma]",
    "    H --> I[RuBisCO fixes CO\u2082]",
    "    I --> J[Glyceraldehyde\u20113\u2011phosphate (G3P)]",
].join("\n");

describe("the reproduced failure", () => {
    // The first test here to touch mermaid pays for importing and initialising
    // it under jsdom, which can exceed the 5s default when the whole suite runs
    // in parallel. Later tests reuse the warm module. Same reason, and the same
    // allowance, as the first case in `validate.test.ts`.
    it(
        "is a real parse error before normalisation",
        { timeout: 60_000 },
        async () => {
            // Guards the premise: if mermaid ever accepts this shape, the whole
            // rewrite is unnecessary and this file should be deleted.
            const before = await parseMermaidCode(REPRODUCED_MODEL_OUTPUT);
            expect(before.ok).toBe(false);
        },
    );

    it("quotes both offending labels", () => {
        const { code, changed } = normalizeMermaidSyntax(REPRODUCED_MODEL_OUTPUT);

        expect(changed).toBe(true);
        expect(code).toContain('C["Water splitting (O\u2082 + e\u207b + H\u207a)"]');
        expect(code).toContain('J["Glyceraldehyde\u20113\u2011phosphate (G3P)"]');
    });

    it("parses under mermaid's own parser after normalisation", async () => {
        const { code } = normalizeMermaidSyntax(REPRODUCED_MODEL_OUTPUT);
        const after = await parseMermaidCode(code);

        expect(after.ok).toBe(true);
    });

    it("emits exactly the source the end-to-end fixture expects", async () => {
        // `e2e/mock-gemini.ts` feeds `NORMALISED_MERMAID_SOURCE` to the browser
        // in place of the real route's output. Pinning it here is what stops the
        // two copies from drifting apart silently.
        const expected = [
            "flowchart TD",
            "    A[Sunlight] --> B[Chlorophyll absorbs photons]",
            '    B --> C["Water splitting (O\u2082 + e\u207b + H\u207a)"]',
            "    C --> D[Electron Transport Chain]",
            "    D --> E[Proton gradient across thylakoid membrane]",
            "    E --> F[ATP synthase produces ATP]",
            "    D --> G[NADP\u207a reduced to NADPH]",
            "    F & G --> H[Calvin Cycle in Stroma]",
            "    H --> I[RuBisCO fixes CO\u2082]",
            '    I --> J["Glyceraldehyde\u20113\u2011phosphate (G3P)"]',
        ].join("\n");

        const resolved = await resolveDiagram({
            mermaidCode: REPRODUCED_MODEL_OUTPUT,
            diagramType: "flowchart",
            explanation: "x",
        });

        expect(resolved.mermaidCode).toBe(expected);
    });

    it("leaves the labels that were already valid untouched", () => {
        const { code } = normalizeMermaidSyntax(REPRODUCED_MODEL_OUTPUT);

        // Guards against a rewrite that mangles the rest of the diagram: node
        // ids, plain labels, and the `F & G -->` multi-source edge all stand.
        expect(code).toContain("A[Sunlight] --> B[Chlorophyll absorbs photons]");
        expect(code).toContain("F & G --> H[Calvin Cycle in Stroma]");
        expect(code).toContain("E[Proton gradient across thylakoid membrane]");
    });

    it("reaches the browser as a diagram rather than a failure notice", async () => {
        // The pipeline-level guarantee: the code handed to the client is the
        // normalised one, and it is accepted with no regeneration needed.
        const resolved = await resolveDiagram({
            mermaidCode: REPRODUCED_MODEL_OUTPUT,
            diagramType: "flowchart",
            explanation: "The diagram follows the sequence from light capture onward.",
        });

        expect(resolved.source).toBe("generated");
        expect(resolved.notice).toBeUndefined();
        expect(resolved.mermaidCode).toContain('C["Water splitting');
        expect(await parseMermaidCode(resolved.mermaidCode)).toMatchObject({ ok: true });
    });
});

describe("labels are quoted only when the grammar requires it", () => {
    // Each character below was measured against the installed mermaid 12.1.0:
    // unquoted it is a parse error, quoted it parses. `"`, `[` and `]` are
    // excluded here and covered separately below, because each one either
    // terminates the label span or is refused by design.
    const BREAKING = ["(", ")", "{", "}", "|", "@", ">", "`"] as const;

    it.each(BREAKING)("quotes a label containing %s", (character) => {
        const { code, changed } = normalizeMermaidSyntax(
            `flowchart TD\n    A[Label ${character} tail] --> B[End]`,
        );

        expect(changed).toBe(true);
        expect(code).toBe(`flowchart TD\n    A["Label ${character} tail"] --> B[End]`);
    });

    it("quotes a label containing @ such as Precision@k and parses successfully", async () => {
        const source = "flowchart TD\n    G --> H[Precision@k]";
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(true);
        expect(code).toBe('flowchart TD\n    G --> H["Precision@k"]');
        expect(await parseMermaidCode(code)).toMatchObject({ ok: true });
    });

    // Confirmed harmless unquoted, so quoting them would be churn.
    const HARMLESS = [";", ",", "#", ":", "&", "%", "/", "=", "?", "!", "~", "_", "-", "+"];

    it.each(HARMLESS)("leaves a label containing %s alone", (character) => {
        const source = `flowchart TD\n    A[Label ${character} tail] --> B[End]`;
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(false);
        expect(code).toBe(source);
    });

    it.each([
        ["stadium", "A[(Stadium text)]"],
        ["subroutine", "A[[Subroutine text]]"],
        ["parallelogram", "A[/Parallelogram text/]"],
        ["trapezoid", "A[\\Trapezoid text\\]"],
    ])("preserves the %s shape rather than flattening it to a rectangle", (_name, label) => {
        const source = `flowchart TD\n    ${label}`;
        const { code, changed } = normalizeMermaidSyntax(source);

        // Quoting `[(text)]` would parse, but would silently change the shape
        // the author asked for. Preserving it is the correct behaviour.
        expect(changed).toBe(false);
        expect(code).toBe(source);
    });

    it("nests brackets correctly instead of cutting the label short", () => {
        const { code } = normalizeMermaidSyntax("flowchart TD\n    A[Outer [inner] tail]");
        expect(code).toBe('flowchart TD\n    A["Outer [inner] tail"]');
    });

    it("quotes a label holding a bracket, then parses", async () => {
        // `[` and `]` are only expressible inside a `[...]` label as a nested
        // pair, which is why the loop above cannot cover them.
        const source = "flowchart TD\n    A[Label [ tail]] --> B[End]";
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(true);
        expect(code).toBe('flowchart TD\n    A["Label [ tail]"] --> B[End]');
        expect(await parseMermaidCode(code)).toMatchObject({ ok: true });
    });

    it("is idempotent, so a normalised diagram is never rewritten twice", () => {
        const once = normalizeMermaidSyntax(REPRODUCED_MODEL_OUTPUT);
        const twice = normalizeMermaidSyntax(once.code);

        expect(twice.changed).toBe(false);
        expect(twice.code).toBe(once.code);
    });
});

describe("diagrams it cannot safely fix are left alone", () => {
    it("does not quote a label that already contains a double quote", () => {
        // `A["a "b" c"]` is itself a parse error, so quoting would not help.
        // Leaving it untouched hands it to the parse gate, which regenerates and
        // then falls back - the behaviour that must be preserved.
        const source = 'flowchart TD\n    A[He said "yes" (loudly)]';
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(false);
        expect(code).toBe(source);
    });

    it("does not rewrite diagram types whose grammar was never verified", () => {
        // `[(...)]`, `[[...]]` and `[/.../]` are meaningful in these grammars in
        // ways this module has not tested, so it stays out of them entirely.
        for (const source of [
            "sequenceDiagram\n    participant A as [Caller]\n    A->>A: self",
            "classDiagram\n    class Shape [abstract]\n    Shape : +area()",
            "mindmap\n  root((Topic))\n    Idea",
            "stateDiagram-v2\n    s1 : [still running]",
        ]) {
            const { code, changed } = normalizeMermaidSyntax(source);

            expect(changed).toBe(false);
            expect(code).toBe(source);
        }
    });

    it("passes a multi-line quoted label through without touching it", () => {
        const source = 'flowchart TD\n    A["first line\nsecond (line)"]';
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(false);
        expect(code).toBe(source);
    });

    it("leaves an unclosed bracket alone rather than guessing at the line's end", () => {
        const source = "flowchart TD\n    A[Broken (label";
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(false);
        expect(code).toBe(source);
    });

    it.each([
        ["empty label", "flowchart TD\n    A[] --> B[End]"],
        ["no labels at all", "flowchart TD\n    A --> B --> C"],
        ["comment only", "%%{note: (not a label)}%%\nflowchart TD\n    A --> B"],
    ])("leaves %s unchanged", (_name, source) => {
        const { code, changed } = normalizeMermaidSyntax(source);

        expect(changed).toBe(false);
        expect(code).toBe(source);
    });
});

describe("genuinely invalid diagrams still reach the fallback", () => {
    it.each([
        ["truncated edge", "flowchart TD\n    A[Start] -->"],
        ["nonsense statement", "flowchart TD\n    A[Start] --"],
        ["unterminated quoted label", 'flowchart TD\n    A[Start] --> B["never closed'],
    ])("falls back rather than rendering %s", async (_name, source) => {
        const resolved = await resolveDiagram({
            mermaidCode: source,
            diagramType: "flowchart",
            explanation: "An explanation the reader still sees.",
        });

        expect(resolved.source).toBe("fallback");
        expect(resolved.notice).toContain("placeholder");
        // The reader is told what happened, and the fallback itself is valid.
        expect(await parseMermaidCode(resolved.mermaidCode)).toMatchObject({ ok: true });
    });
});

describe("normalisation cannot weaken the sanitiser", () => {
    it("never rescues content the sanitiser rejects", async () => {
        // Normalisation runs *after* sanitisation and only adds quote
        // delimiters, so an unsafe label is still rejected before it is seen -
        // and the reader gets the fallback, not a quoted `javascript:` link.
        for (const source of [
            'flowchart TD\n    A["javascript:alert(1)" (unsafe)]',
            "flowchart TD\n    A[Click me (here) \"javascript:alert(1)\"]",
        ]) {
            const resolved = await resolveDiagram({
                mermaidCode: source,
                diagramType: "flowchart",
                explanation: "x",
            });

            expect(resolved.source).toBe("fallback");
            expect(resolved.mermaidCode).not.toContain("javascript:");
        }
    });

    it("adds delimiters only, never new content", () => {
        // The rewrite is a re-delimiting of existing bytes: stripping the
        // delimiters it added must give back the original source exactly.
        const source = "flowchart TD\n    A[Alpha (beta)]";
        const { code } = normalizeMermaidSyntax(source);

        expect(code.replace(/["\[\]]/g, "")).toBe(source.replace(/[[\]]/g, ""));
    });
});