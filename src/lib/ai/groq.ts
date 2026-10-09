import { z } from "zod";
// Type-only import: erased at compile time, so the SDK is never statically
// reachable from a client bundle even though its types appear in this signature.
import type {
    ChatCompletionCreateParams,
    ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";

import { MAX_GROQ_OUTPUT_TOKENS, GROQ_REQUEST_TIMEOUT_MS } from "@/lib/constants/limits";
import { DiagramSchema, StudyOutputSchema } from "@/lib/validation/ai-schemas";

import { AiGenerationError, toAiGenerationError } from "./errors";
import type { StudyPrompt } from "./prompt";

/**
 * Server-only Groq client (GroqCloud, `openai/gpt-oss-120b`).
 *
 * ## Server-only, by the same three means as `gemini.ts`
 *
 * 1. `GROQ_API_KEY` has no `NEXT_PUBLIC_` prefix, so Next.js never inlines it
 *    into a client bundle.
 * 2. `groq-sdk` is loaded through a dynamic `import()` inside the request path,
 *    so no client component can pull the SDK - and the value read from the
 *    environment - into the browser graph.
 * 3. Nothing here is re-exported from a client module; the entry point is
 *    `generate-study-material.ts`, a route-handler target only.
 *
 * The key is passed to the SDK and never stored, logged, or returned. It is read
 * per request rather than memoised, so a rotated key takes effect without a
 * restart and no long-lived module-level copy exists to leak.
 *
 * ## Why `strict: false`
 *
 * Groq documents Structured Outputs for `openai/gpt-oss-120b` in two modes.
 * `strict: true` uses constrained decoding and *requires* every object to set
 * `additionalProperties: false` with all properties listed in `required`, and
 * supports only a subset of JSON Schema. The schemas this application generates
 * come from Zod via `z.toJSONSchema`, which emits draft 2020-12 constructs
 * (`prefixItems`, `minLength`, numeric `minimum`/`maximum`) that constrained
 * decoding does not accept - forwarding them verbatim risks a 400 on every
 * request.
 *
 * `strict: false` is the documented best-effort mode and is supported for this
 * model. It attempts schema compliance without the hard requirements. That is
 * the correct trade here because the application already treats the provider's
 * structured-output mode as advisory and not authoritative: `validateStudyOutput`
 * is the sole gate, and `generate-study-material.ts` spends one corrective retry
 * when it rejects a response. Guaranteeing schema adherence at the provider
 * would only duplicate work the Zod layer already does, at the cost of a
 * request shape that cannot be verified without live quota.
 */

/**
 * Model used when `GROQ_MODEL` is not configured.
 *
 * `openai/gpt-oss-120b` is a known model literal in the SDK's own union type, so
 * a typo here is a compile-time error rather than a runtime 404.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

/**
 * Sampling temperature for study material.
 *
 * Matches the Gemini stage's value so switching providers does not change the
 * character of the output: low enough that the quiz answer key stays consistent
 * with the summary, high enough that twenty questions do not collapse into
 * paraphrases of one item.
 */
const GENERATION_TEMPERATURE = 0.4;

/**
 * Reasoning effort for GPT-OSS.
 *
 * GPT-OSS is a reasoning model, and Groq documents `low`/`medium`/`high` for
 * `openai/gpt-oss-120b` with `medium` as the default. `low` is chosen because
 * reasoning tokens are drawn from the same completion budget as the answer: a
 * long document summarised into twenty questions does not benefit from extended
 * deliberation, and the saving shows up as latency and cost on every request.
 *
 * The reasoning trace is left hidden (the API default), so only the final answer
 * reaches `parseModelJson`.
 */
const REASONING_EFFORT = "low";

/** Response-format name; must match the SDK's charset and length rules. */
const SCHEMA_NAME_STUDY_OUTPUT = "study_output";
const SCHEMA_NAME_DIAGRAM = "study_diagram";

/**
 * Derive a Groq `response_format.json_schema` body from any of the application's
 * Zod schemas.
 *
 * Generated from the same Zod schema that later validates the response, so the
 * shape the model is steered toward and the shape it is judged against cannot
 * drift apart - a change to `REQUIRED_QUIZ_QUESTION_COUNT` or the option tuple
 * reaches the model automatically.
 */
export function buildGroqResponseSchema(
    source: z.ZodType,
    name: string,
    description: string,
): NonNullable<ChatCompletionCreateParams["response_format"]> {
    return {
        type: "json_schema",
        json_schema: {
            name,
            description,
            schema: toGroqJsonSchema(z.toJSONSchema(source, { io: "output" })),
        },
    };
}

/**
 * Recursively narrow a JSON Schema node to keywords Groq's JSON-Schema mode
 * accepts.
 *
 * `z.toJSONSchema` emits the full draft 2020-12 vocabulary. `additionalProperties`
 * and `$schema` are dropped: the first is a constraint that contradicts nothing
 * we need, and forwarding it invites the strict-mode requirement discussed in
 * the module header. `minLength`/`maxLength` and numeric `minimum`/`maximum` are
 * dropped as well - they carry no enforcement value here, because Zod re-checks
 * every one of them on the way back in. `minItems`/`maxItems` survive, because
 * the length of the quiz array is the single constraint most worth steering the
 * model toward.
 */
function toGroqJsonSchema(node: unknown): Record<string, unknown> {
    if (typeof node !== "object" || node === null) return {};

    const source = node as Record<string, unknown>;
    const schema: Record<string, unknown> = {};

    if (typeof source["type"] === "string") schema["type"] = source["type"];
    if (typeof source["description"] === "string") schema["description"] = source["description"];
    if (typeof source["minItems"] === "number") schema["minItems"] = source["minItems"];
    if (typeof source["maxItems"] === "number") schema["maxItems"] = source["maxItems"];
    if (Array.isArray(source["enum"])) schema["enum"] = source["enum"];
    if (Array.isArray(source["required"])) schema["required"] = source["required"];

    const properties = source["properties"];
    if (typeof properties === "object" && properties !== null) {
        const converted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
            converted[key] = toGroqJsonSchema(value);
        }
        schema["properties"] = converted;
    }

    const items = arrayItemsSchema(source);
    if (items !== null) schema["items"] = items;

    return schema;
}

/**
 * Resolve the element schema for an array node.
 *
 * A plain `z.array(...)` arrives with an `items` schema and is used as-is. A
 * `z.tuple(...)` instead arrives as `prefixItems` plus `items: false`, because
 * that is how draft 2020-12 spells "a fixed-length list of specific types". The
 * tuple is lowered to its first element's schema, with the tuple's
 * `minItems`/`maxItems` (already carried above) keeping the length constraint.
 *
 * That is exact for a homogeneous tuple - which is what a four-option quiz
 * question is - and lossy only for a heterogeneous one. The Zod schema still
 * enforces every position on the way back in, so a mismatch surfaces as a normal
 * validation rejection rather than as silence.
 */
function arrayItemsSchema(source: Record<string, unknown>): Record<string, unknown> | null {
    const items = toGroqJsonSchema(source["items"]);
    if (Object.keys(items).length > 0) return items;

    // `items: false` means "no elements permitted"; a tuple's element schema
    // lives in `prefixItems` instead.
    const prefixItems = source["prefixItems"];
    if (Array.isArray(prefixItems) && prefixItems.length > 0) {
        return toGroqJsonSchema(prefixItems[0]);
    }

    return null;
}

/**
 * Read the server-side configuration, failing loudly rather than silently
 * calling an unauthenticated endpoint.
 */
function readConfiguration(): { apiKey: string; model: string } {
    const apiKey = process.env["GROQ_API_KEY"]?.trim();
    if (!apiKey) {
        throw new AiGenerationError("MISSING_API_KEY");
    }

    const model = process.env["GROQ_MODEL"]?.trim();
    return { apiKey, model: model && model.length > 0 ? model : DEFAULT_GROQ_MODEL };
}

/**
 * Parse the model's text into an untrusted value.
 *
 * Mirrors `gemini.ts`: the result is `unknown` until Zod has agreed, and markdown
 * fences are stripped because models occasionally wrap JSON even under a JSON
 * response format.
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

/**
 * Read the assistant message's text.
 *
 * `content` is nullable on a reasoning model: a response truncated mid-answer
 * arrives as `null` rather than as a partial string, and treating that as an
 * empty body produces the correct `EMPTY_MODEL_RESPONSE` instead of a crash.
 */
function readResponseText(response: {
    choices?: Array<{ message?: { content?: string | null } | null }>;
}): string {
    const content = response.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
}

/** The study prompt mapped onto Groq's two-message chat shape. */
function toMessages(prompt: StudyPrompt): ChatCompletionMessageParam[] {
    return [
        { role: "system", content: prompt.systemInstruction },
        { role: "user", content: prompt.contents },
    ];
}

/**
 * Send one request to Groq and return the raw, unvalidated payload.
 *
 * Deliberately stops at `unknown`: validation belongs to the caller's schema,
 * and having a single validation point per response shape is what stops a
 * second, laxer parser from creeping in beside the strict one.
 */
async function requestJson(
    prompt: StudyPrompt,
    responseFormat: NonNullable<ChatCompletionCreateParams["response_format"]>,
): Promise<unknown> {
    const { apiKey, model } = readConfiguration();

    try {
        // Dynamic import keeps the SDK out of any statically reachable client
        // graph; see the module header for the full rationale.
        const { default: Groq } = await import("groq-sdk");

        const client = new Groq({
            apiKey,
            // The SDK retries by default, which would multiply latency on the
            // requests this stage has already given up on. The stage owns its own
            // retry policy - one corrective attempt, no transport retries - so
            // the client is configured not to add a second, invisible one.
            maxRetries: 0,
            timeout: GROQ_REQUEST_TIMEOUT_MS,
        });

        const response = await client.chat.completions.create({
            model,
            messages: toMessages(prompt),
            temperature: GENERATION_TEMPERATURE,
            max_completion_tokens: MAX_GROQ_OUTPUT_TOKENS,
            reasoning_effort: REASONING_EFFORT,
            response_format: responseFormat,
        });

        return parseModelJson(readResponseText(response));
    } catch (error) {
        // A timeout gets its own code so the caller can tell "the model was too
        // slow" apart from "the service refused the request"; both stay
        // user-safe, and neither carries the SDK's message.
        if (error instanceof AiGenerationError) throw error;
        if (error instanceof Error && error.name === "APIConnectionTimeoutError") {
            throw new AiGenerationError("AI_REQUEST_TIMEOUT", undefined, { cause: error });
        }
        throw toAiGenerationError(error, "GROQ_REQUEST_FAILED");
    }
}

/** Request the full study payload (summary, diagram, twenty-question quiz). */
export async function requestStudyOutput(prompt: StudyPrompt): Promise<unknown> {
    return requestJson(
        prompt,
        buildGroqResponseSchema(
            StudyOutputSchema,
            SCHEMA_NAME_STUDY_OUTPUT,
            "A study summary, a Mermaid diagram, and exactly twenty multiple-choice quiz questions.",
        ),
    );
}

/**
 * Request a replacement Mermaid diagram only.
 *
 * Separate from `requestStudyOutput` so the one regeneration attempt in
 * `src/lib/mermaid/index.ts` costs one small diagram response instead of a
 * second full summary-and-quiz payload that would be discarded anyway.
 */
export async function requestDiagramOutput(prompt: StudyPrompt): Promise<unknown> {
    return requestJson(
        prompt,
        buildGroqResponseSchema(
            DiagramSchema,
            SCHEMA_NAME_DIAGRAM,
            "A single Mermaid diagram source string with its type and an explanation.",
        ),
    );
}