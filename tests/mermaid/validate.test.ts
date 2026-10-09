// @vitest-environment jsdom
/**
 * Unit tests for the Mermaid parse gate.
 *
 * These run in jsdom because mermaid's own parser is DOM-dependent: it sanitises
 * label text through DOMPurify, which needs a `window`. That is exactly the
 * situation the browser render path is in, so jsdom is not a workaround here -
 * it is the environment the gate is designed for. `tests/mermaid/validate-node.test.ts`
 * covers the server-side context, where the gate reports `deferred`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
    MERMAID_PARSE_CONFIG,
    isMermaidParseAvailable,
    parseMermaidCode,
    resetMermaidForTests,
} from "@/lib/mermaid/validate";
import { resolveDiagram, FALLBACK_DIAGRAM } from "@/lib/mermaid";
import { MAX_DIAGRAM_GENERATION_ATTEMPTS } from "@/lib/constants/limits";

/** Valid diagrams for each type the allowlist promises to support. */
const VALID_DIAGRAMS: Readonly<Record<string, string>> = {
    flowchart: [
        "flowchart TD",
        "    Light[Light energy] --> Reactions[Light-dependent reactions]",
        "    Reactions --> Cycle[Calvin cycle]",
    ].join("\n"),
    sequenceDiagram: [
        "sequenceDiagram",
        "    participant Student",
        "    participant Plant",
        "    Student->>Plant: asks about photosynthesis",
        "    Plant-->>Student: explains the two stages",
    ].join("\n"),
    mindmap: [
        "mindmap",
        "  root((Photosynthesis))",
        "    Light reactions",
        "      Photolysis",
        "    Calvin cycle",
    ].join("\n"),
    classDiagram: [
        "classDiagram",
        "    class Photosynthesis {",
        "        +capturesLight()",
        "        +fixesCarbon()",
        "    }",
    ].join("\n"),
    graph: "graph LR\n    Input[Input] --> Process[Process]\n    Process --> Output[Output]",
};

/**
 * Reset mermaid's module-global config between tests.
 *
 * `mermaid.initialize` is global mutable state, so without this a test that
 * changed configuration would silently affect every later test in the file.
 */
beforeEach(() => {
    resetMermaidForTests();
});

describe("valid diagrams pass the gate", () => {
    // The first entry pays for importing and initialising mermaid under jsdom,
    // which costs well over the 5s default when the whole file runs in parallel.
    // Later entries reuse the warm module and finish in tens of milliseconds.
    it.each(Object.entries(VALID_DIAGRAMS))(
        "accepts a valid %s",
        { timeout: 60_000 },
        async (_type, code) => {
            const result = await parseMermaidCode(code);

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.code).toBe(code);
            // In jsdom the parser really ran; a "deferred" result here would mean
            // the gate silently degraded and the test proved nothing.
            expect(result.gate).toBe("parsed");
        },
    );

    it("runs mermaid under a strict security level with html labels off", () => {
        // These two settings are the reason a label cannot become markup.
        expect(MERMAID_PARSE_CONFIG.securityLevel).toBe("strict");
        expect(MERMAID_PARSE_CONFIG.flowchart.htmlLabels).toBe(false);
    });

    it("does not render anything into the DOM as a side effect of validation", async () => {
        const before = document.body.innerHTML;

        await parseMermaidCode(VALID_DIAGRAMS["flowchart"]!);

        // `parse` builds the diagram database and never touches the document.
        // If this ever changes, validation has become a render and the client
        // gate is no longer a gate.
        expect(document.body.innerHTML).toBe(before);
        expect(document.querySelectorAll("svg")).toHaveLength(0);
    });
});

describe("invalid diagrams are rejected", () => {
    it("rejects an empty diagram", async () => {
        expect(await parseMermaidCode("   ")).toEqual({
            ok: false,
            reason: "EMPTY_CODE",
        });
    });

    it("rejects an unclosed bracket", async () => {
        const result = await parseMermaidCode("flowchart TD\n    A[unclosed --> B");

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe("SYNTAX_ERROR");
    });

    it("rejects a diagram whose first line is not a declaration", async () => {
        const result = await parseMermaidCode("this is not mermaid at all");

        expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_DIAGRAM_TYPE" });
    });

    it("rejects a diagram type outside the allowlist", async () => {
        const result = await parseMermaidCode("html\n  <div>markup</div>");

        expect(result).toMatchObject({ ok: false, reason: "UNSUPPORTED_DIAGRAM_TYPE" });
    });

    it("reads the declaration past a leading comment line", async () => {
        const result = await parseMermaidCode(
            "%% Generated for the student\nflowchart TD\n    A --> B",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.gate).toBe("parsed");
    });

    it("never echoes the offending source back to the caller", async () => {
        // The source is model output derived from an untrusted document, so a
        // reason that quoted it would be a reflected-content channel.
        const marker = "SECRET_DOCUMENT_PHRASE_XYZ";
        const result = await parseMermaidCode(`flowchart TD\n    A[${marker} --> B`);

        expect(JSON.stringify(result)).not.toContain(marker);
    });
});

describe("resolveDiagram: sanitise, validate, retry once, fall back", () => {
    it("returns a valid generated diagram unchanged", async () => {
        const diagram = {
            mermaidCode: VALID_DIAGRAMS["flowchart"]!,
            diagramType: "flowchart",
            explanation: "Energy flows from light into sugars.",
        };

        const resolved = await resolveDiagram(diagram);

        expect(resolved.source).toBe("generated");
        expect(resolved.mermaidCode).toBe(diagram.mermaidCode);
        expect(resolved.notice).toBeUndefined();
    });

    it("never lets an unsafe construct through", async () => {
        const diagram = {
            mermaidCode: 'flowchart TD\n    A --> B\n    click A href "javascript:alert(1)"',
            diagramType: "flowchart",
            explanation: "x",
        };

        const resolved = await resolveDiagram(diagram);

        expect(resolved.mermaidCode).not.toMatch(/click/i);
        expect(resolved.mermaidCode).not.toMatch(/javascript:/i);
    });

    it("regenerates exactly once when the first diagram is unusable", async () => {
        let calls = 0;
        const resolved = await resolveDiagram(
            {
                mermaidCode: "not a diagram",
                diagramType: "flowchart",
                explanation: "x",
            },
            async () => {
                calls += 1;
                return {
                    mermaidCode: VALID_DIAGRAMS["flowchart"]!,
                    diagramType: "flowchart",
                    explanation: "Corrected diagram.",
                };
            },
        );

        expect(calls).toBe(MAX_DIAGRAM_GENERATION_ATTEMPTS);
        expect(resolved.source).toBe("regenerated");
        expect(resolved.explanation).toBe("Corrected diagram.");
    });

    it("falls back when the regeneration is also unusable", async () => {
        const resolved = await resolveDiagram(
            {
                mermaidCode: "not a diagram",
                diagramType: "flowchart",
                explanation: "x",
            },
            async () => ({
                mermaidCode: "<script>alert(1)</script>",
                diagramType: "html",
                explanation: "y",
            }),
        );

        expect(resolved.source).toBe("fallback");
        expect(resolved.notice).toContain("placeholder");
        expect(resolved.mermaidCode).toBe(FALLBACK_DIAGRAM.mermaidCode);
    });

    it("falls back without throwing when the regenerator fails outright", async () => {
        // A missing API key rejects here; that must degrade to the fallback
        // diagram rather than failing an upload whose summary and quiz are fine.
        const resolved = await resolveDiagram(
            {
                mermaidCode: "not a diagram",
                diagramType: "flowchart",
                explanation: "x",
            },
            async () => {
                throw new Error("MISSING_API_KEY");
            },
        );

        expect(resolved.source).toBe("fallback");
    });

    it("falls back immediately when no regenerator is supplied", async () => {
        const resolved = await resolveDiagram({
            mermaidCode: "not a diagram",
            diagramType: "flowchart",
            explanation: "x",
        });

        expect(resolved.source).toBe("fallback");
    });

    it("returns a fallback that itself passes the gate", async () => {
        const resolved = await resolveDiagram({
            mermaidCode: "not a diagram",
            diagramType: "flowchart",
            explanation: "x",
        });

        // The fallback is validated like anything else, so there is no
        // "trusted because we wrote it" exemption that could rot unnoticed.
        const revalidated = await parseMermaidCode(resolved.mermaidCode);
        expect(revalidated.ok).toBe(true);
        expect(resolved.parseGate).toBe("parsed");
    });

    it("does not send the rejected source back to the regenerator", async () => {
        // Replaying it would give document-authored text a second turn in the
        // instruction voice.
        const marker = "SECRET_DOCUMENT_PHRASE_XYZ";
        let seen: unknown;
        await resolveDiagram(
            {
                mermaidCode: `flowchart TD\n    A[${marker}\n    A -->`,
                diagramType: "flowchart",
                explanation: "x",
            },
            async (reasons) => {
                seen = reasons;
                return { mermaidCode: "flowchart TD\n    A --> B", diagramType: "flowchart", explanation: "z" };
            },
        );

        expect(JSON.stringify(seen)).not.toContain(marker);
        expect(Array.isArray(seen)).toBe(true);
    });
});

describe("parse availability is reported honestly", () => {
    it("reports the parser as available in a DOM context", () => {
        expect(isMermaidParseAvailable()).toBe(true);
    });
});