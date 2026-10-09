import { describe, expect, it } from "vitest";

import { buildResponseSchema } from "@/lib/ai/gemini";
import {
    QUIZ_OPTION_COUNT,
    REQUIRED_QUIZ_QUESTION_COUNT,
} from "@/lib/constants/limits";
import { DiagramSchema, StudyOutputSchema } from "@/lib/validation/ai-schemas";

/**
 * The response schema the app sends to Gemini.
 *
 * These cases exist because the schema is generated rather than hand-written,
 * which is the right design - one source of truth - but also means a change to a
 * Zod schema can silently produce a request Google rejects. The failure mode is
 * unusually opaque: a malformed schema comes back as a bare HTTP 400 with no
 * usable detail, and the request dies before the model is consulted, so every
 * upload fails identically with no clue why.
 *
 * The rule pinned here is the one Gemini enforces strictly: an `ARRAY` must
 * carry `items`. Anything else is rejected outright.
 */

/** Walk every node of a converted schema, depth first. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
    if (typeof node !== "object" || node === null) return;
    const source = node as Record<string, unknown>;
    yield source;

    const properties = source["properties"];
    if (typeof properties === "object" && properties !== null) {
        for (const value of Object.values(properties as Record<string, unknown>)) {
            yield* walk(value);
        }
    }
    yield* walk(source["items"]);
}

/** Every path in the schema whose node is an array, with whether it has `items`. */
function arrayNodes(schema: unknown): Array<{ path: string; hasItems: boolean }> {
    const found: Array<{ path: string; hasItems: boolean }> = [];

    const visit = (node: unknown, path: string): void => {
        if (typeof node !== "object" || node === null) return;
        const source = node as Record<string, unknown>;

        if (source["type"] === "ARRAY") {
            const items = source["items"];
            found.push({
                path,
                hasItems: typeof items === "object" && items !== null,
            });
        }

        const properties = source["properties"];
        if (typeof properties === "object" && properties !== null) {
            for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
                visit(value, `${path}.${key}`);
            }
        }
        visit(source["items"], `${path}[]`);
    };

    visit(schema, "$");
    return found;
}

describe("buildResponseSchema", () => {
    it("gives every array in the study schema an items schema", () => {
        const arrays = arrayNodes(buildResponseSchema(StudyOutputSchema));

        // Guards the guard: if the schema ever stops containing arrays, the
        // every() below would pass on an empty list and prove nothing.
        expect(arrays.length).toBeGreaterThan(0);
        for (const node of arrays) {
            expect(node, `array at ${node.path} has no items schema`).toMatchObject({
                hasItems: true,
            });
        }
    });

    it("lowers the fixed-length option tuple to an array Gemini accepts", () => {
        // The regression: `options` is a `z.tuple`, which draft 2020-12 spells as
        // `prefixItems` + `items: false`. Those keywords do not exist in Gemini's
        // `Schema`, so forwarding the tuple verbatim produced
        //   response_schema...properties[options].items: missing field
        // and every upload failed with HTTP 400 before the model was reached.
        const schema = buildResponseSchema(StudyOutputSchema);
        const options = (
            (schema.properties?.["quiz"] as { items?: { properties?: unknown } } | undefined)
                ?.items?.properties as Record<string, Record<string, unknown>> | undefined
        )?.["options"];

        expect(options).toMatchObject({ type: "ARRAY" });
        expect(options?.["items"]).toMatchObject({ type: "STRING" });
        // The tuple's length constraint still reaches the model.
        expect(options?.["minItems"]).toBe(String(QUIZ_OPTION_COUNT));
        expect(options?.["maxItems"]).toBe(String(QUIZ_OPTION_COUNT));
    });

    it("keeps the exact question count in the model-facing schema", () => {
        const quiz = (
            buildResponseSchema(StudyOutputSchema).properties as Record<string, Record<string, unknown>>
        )["quiz"];

        expect(quiz?.["minItems"]).toBe(String(REQUIRED_QUIZ_QUESTION_COUNT));
        expect(quiz?.["maxItems"]).toBe(String(REQUIRED_QUIZ_QUESTION_COUNT));
    });

    it("gives every array in the diagram schema an items schema", () => {
        const arrays = arrayNodes(buildResponseSchema(DiagramSchema));

        expect(arrays).toHaveLength(0);
    });

    it("does not forward draft-2020-12 keywords Gemini has no field for", () => {
        // `$schema` and `additionalProperties` are what `z.toJSONSchema` emits and
        // Gemini does not accept; a tuple's `prefixItems` is the third.
        for (const node of walk(buildResponseSchema(StudyOutputSchema))) {
            expect(node).not.toHaveProperty("$schema");
            expect(node).not.toHaveProperty("additionalProperties");
            expect(node).not.toHaveProperty("prefixItems");
        }
    });

    it("keeps nested objects reachable", () => {
        const schema = buildResponseSchema(StudyOutputSchema);
        const summary = (schema.properties as Record<string, Record<string, unknown>>)["summary"];

        expect(summary?.["properties"]).toHaveProperty("tldr");
        expect(
            (summary?.["properties"] as Record<string, unknown>)["keyTakeaways"],
        ).toMatchObject({ type: "ARRAY", minItems: "1", maxItems: "12" });
    });
});