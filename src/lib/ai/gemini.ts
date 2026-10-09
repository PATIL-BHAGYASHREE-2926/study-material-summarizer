import { z } from "zod";
// Type-only import: erased at compile time, so the SDK is still never reachable
// statically from a client bundle even though its types appear in this signature.
import type { Schema, Type } from "@google/genai";

import { MAX_GEMINI_OUTPUT_TOKENS } from "@/lib/constants/limits";
import { DiagramSchema, StudyOutputSchema } from "@/lib/validation/ai-schemas";

import { AiGenerationError, toAiGenerationError } from "./errors";
import type { StudyPrompt } from "./prompt";

/**
 * Server-only Gemini client.
 *
 * ## Why there is no `import "server-only"`
 *
 * The conventional guard is the one-line `server-only` package. It is not a
 * dependency of this project and adding one purely for a build-time assertion
 * would violate the "do not introduce unnecessary dependencies" rule, so the
 * guarantee is established three other ways instead:
 *
 * 1. The credential is read from a non-`NEXT_PUBLIC_` environment variable,
 *    which Next.js never inlines into a client bundle.
 * 2. `@google/genai` is loaded through a dynamic `import()` inside the request
 *    path. It is never statically reachable from this module's exports, so no
 *    client component can pull the SDK - and the value read from
 *    `GEMINI_API_KEY` - into the browser graph.
 * 3. Nothing here is re-exported from a client module; the entry point
 *    (`generate-study-material.ts`) is a server action target / route handler
 *    only.
 *
 * The key is passed to the SDK and never stored, logged, or returned. It is read
 * per request rather than memoised in module scope so a rotated key takes effect
 * without a restart and so no long-lived module-level copy exists to leak.
 */

/**
 * Model used when `GEMINI_MODEL` is not configured.
 *
 * `gemini-2.5-flash` was the previous default and has since been retired for new
 * API keys: it now answers `404 models/gemini-2.5-flash is no longer available
 * to new users`. Since the failure is indistinguishable from every other
 * transport problem at the user-facing layer, the current name is pinned here
 * and overridable per deployment via `GEMINI_MODEL`. If this one is retired too,
 * the fix is a one-line change plus an updated `.env.example`.
 *
 * Exported so the tests assert against this constant rather than repeating the
 * literal, which would otherwise need editing at every model bump.
 */
export const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Sampling temperature for study material.
 *
 * Low enough that the quiz answer key stays consistent with the summary, high
 * enough that a 20-question quiz does not collapse into twenty paraphrases of
 * the same item.
 */
const GENERATION_TEMPERATURE = 0.4;

/** Mime type that puts the model in JSON structured-output mode. */
const JSON_MIME_TYPE = "application/json";

/** JSON Schema type name to the SDK's `Type` enum value. */
const JSON_TYPE_TO_SDK_TYPE = {
    object: "OBJECT",
    array: "ARRAY",
    string: "STRING",
    number: "NUMBER",
    integer: "INTEGER",
    boolean: "BOOLEAN",
} as const;

/**
 * Derive a Gemini response schema from any of the application's Zod schemas.
 *
 * Generating it from the Zod schema rather than hand-writing a second copy means
 * the shape the model is constrained to and the shape the response is validated
 * against cannot drift apart - a change to `REQUIRED_QUIZ_QUESTION_COUNT` or the
 * option tuple reaches the model automatically.
 */
export function buildResponseSchema(source: z.ZodType): Schema {
    return toGeminiSchema(z.toJSONSchema(source, { io: "output" }));
}

/**
 * Recursively narrow a JSON Schema node to the keywords Gemini accepts.
 *
 * `z.toJSONSchema` emits the full draft 2020-12 vocabulary; forwarding the rest
 * (`$schema`, `additionalProperties`, `minLength`, `prefixItems`, ...) risks a
 * request rejection, and the dropped keywords carry no enforcement value anyway
 * because `validateStudyOutput` is the authority on validity. `minItems` and
 * `maxItems` survive the round trip as the string form the SDK schema declares,
 * which is what keeps the "exactly N questions" constraint reaching the model.
 */
function toGeminiSchema(node: unknown): Schema {
    if (typeof node !== "object" || node === null) return {};

    const source = node as Record<string, unknown>;
    const schema: Schema = {};

    if (typeof source["type"] === "string") {
        // `Type` is a runtime enum whose wire values are these names, so this is
        // the one place the SDK's enum meets JSON Schema.
        const jsonType = source["type"] as keyof typeof JSON_TYPE_TO_SDK_TYPE;
        schema.type = JSON_TYPE_TO_SDK_TYPE[jsonType] as Type;
    }
    if (typeof source["description"] === "string") schema.description = source["description"];
    if (typeof source["format"] === "string") schema.format = source["format"];
    if (typeof source["minimum"] === "number") schema.minimum = source["minimum"];
    if (typeof source["maximum"] === "number") schema.maximum = source["maximum"];
    if (typeof source["minItems"] === "number") schema.minItems = String(source["minItems"]);
    if (typeof source["maxItems"] === "number") schema.maxItems = String(source["maxItems"]);
    if (Array.isArray(source["enum"])) schema.enum = source["enum"] as string[];
    if (Array.isArray(source["required"])) schema.required = source["required"] as string[];

    const properties = source["properties"];
    if (typeof properties === "object" && properties !== null) {
        const converted: Record<string, Schema> = {};
        for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
            converted[key] = toGeminiSchema(value);
        }
        schema.properties = converted;
    }

    const items = arrayItemsSchema(source);
    if (items !== null) schema.items = items;

    return schema;
}

/**
 * Resolve the element schema for an array node.
 *
 * A plain `z.array(...)` arrives with an `items` schema and is used as-is. A
 * `z.tuple(...)` instead arrives as `prefixItems` plus `items: false`, because
 * that is how draft 2020-12 spells "a fixed-length list of specific types".
 * Gemini's `Schema` has no tuple form, and it *requires* `items` on an
 * `ARRAY`: forwarding the tuple verbatim produces
 *
 *     response_schema.properties[quiz].items.properties[options].items: missing field
 *
 * which upstream rejects with HTTP 400 and no usable detail, so the request dies
 * before the model is ever consulted.
 *
 * The tuple is therefore lowered to its first element's schema, with the tuple's
 * `minItems`/`maxItems` (already carried above) keeping the length constraint.
 * That is exact for a homogeneous tuple - which is what a four-option quiz
 * question is - and lossy only for a heterogeneous one, where Gemini has no way
 * to express the difference anyway. The Zod schema still enforces every
 * position on the way back in, so a mismatch surfaces as a normal validation
 * rejection rather than as silence.
 */
function arrayItemsSchema(source: Record<string, unknown>): Schema | null {
    const items = toGeminiSchema(source["items"]);
    if (Object.keys(items).length > 0) return items;

    // `items: false` means "no elements permitted"; a tuple's element schema
    // lives in `prefixItems` instead.
    const prefixItems = source["prefixItems"];
    if (Array.isArray(prefixItems) && prefixItems.length > 0) {
        return toGeminiSchema(prefixItems[0]);
    }

    return null;
}

/**
 * Read the server-side configuration, failing loudly rather than silently
 * calling an unauthenticated endpoint.
 */
function readConfiguration(): { apiKey: string; model: string } {
    const apiKey = process.env["GEMINI_API_KEY"]?.trim();
    if (!apiKey) {
        throw new AiGenerationError("MISSING_API_KEY");
    }

    const model = process.env["GEMINI_MODEL"]?.trim();
    return { apiKey, model: model && model.length > 0 ? model : DEFAULT_MODEL };
}

/**
 * Parse the model's text into an untrusted value.
 *
 * The result is typed `unknown` on purpose: it is model output, it has not been
 * validated, and nothing downstream may treat it as shaped until Zod has agreed.
 * Markdown fences are stripped because models occasionally wrap JSON even when
 * the response mime type is set.
 */
function parseModelJson(text: string): unknown {
    const withoutFences = text
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();

    if (withoutFences.length === 0) {
        throw new AiGenerationError("EMPTY_MODEL_RESPONSE");
    }

    try {
        return JSON.parse(withoutFences);
    } catch (error) {
        throw new AiGenerationError("MALFORMED_MODEL_RESPONSE", undefined, { cause: error });
    }
}

/** Read the first candidate's text, treating an absent candidate as empty. */
function readResponseText(response: { text?: string }): string {
    return response.text ?? "";
}

/**
 * Send one request to Gemini and return the raw, unvalidated payload.
 *
 * Deliberately stops at `unknown`: validation belongs to the caller's schema,
 * and having a single validation point per response shape is what stops a
 * second, laxer parser from creeping in beside the strict one.
 *
 * The response schema is derived from the caller's Zod schema so the shape the
 * model is constrained to and the shape the response is validated against are
 * the same shape by construction.
 */
async function requestJson(
    prompt: StudyPrompt,
    responseSchema: Schema,
): Promise<unknown> {
    const { apiKey, model } = readConfiguration();

    try {
        // Dynamic import keeps the SDK out of any statically reachable client
        // graph; see the module header for the full rationale.
        const { GoogleGenAI } = await import("@google/genai");

        const client = new GoogleGenAI({ apiKey });
        const response = await client.models.generateContent({
            model,
            contents: prompt.contents,
            config: {
                systemInstruction: prompt.systemInstruction,
                temperature: GENERATION_TEMPERATURE,
                maxOutputTokens: MAX_GEMINI_OUTPUT_TOKENS,
                responseMimeType: JSON_MIME_TYPE,
                responseSchema,
            },
        });

        return parseModelJson(readResponseText(response));
    } catch (error) {
        // `toAiGenerationError` keeps the SDK's own message (which may quote the
        // request URL and the credential) out of the user-visible error, while
        // leaving the parse failures raised above with their own codes.
        throw toAiGenerationError(error, "GEMINI_REQUEST_FAILED");
    }
}

/** Request the full study payload (summary, diagram, twenty-question quiz). */
export async function requestStudyOutput(prompt: StudyPrompt): Promise<unknown> {
    return requestJson(prompt, buildResponseSchema(StudyOutputSchema));
}

/**
 * Request a replacement Mermaid diagram only.
 *
 * Separate from `requestStudyOutput` so the one regeneration attempt in
 * `src/lib/mermaid/index.ts` costs one small diagram response instead of a
 * second full summary-and-quiz payload that would be discarded anyway.
 */
export async function requestDiagramOutput(prompt: StudyPrompt): Promise<unknown> {
    return requestJson(prompt, buildResponseSchema(DiagramSchema));
}