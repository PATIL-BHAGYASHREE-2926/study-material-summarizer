import {
    AiGenerationError,
    isAiGenerationError,
    type AiErrorCode,
} from "@/lib/ai/errors";
import { logAiFailure } from "@/lib/ai/diagnostics";
import { generateStudyMaterial } from "@/lib/ai/generate-study-material";
import { regenerateDiagram } from "@/lib/ai/regenerate-diagram";
import { MAX_FILE_SIZE_BYTES, SIGNATURE_PREFIX_LENGTH } from "@/lib/constants/limits";
import { extractDocument } from "@/lib/document";
// Imported from `errors` rather than the `document` barrel: the barrel re-exports
// the error class and its guard, and adding a type export to it would mean
// editing a module this feature is required not to touch.
import {
    isDocumentProcessingError,
    DocumentProcessingError,
    type DocumentErrorCode,
} from "@/lib/document/errors";
import { resolveDiagram } from "@/lib/mermaid";
import type { SummarizeResponse } from "@/types/summarize-response";
import {
    sanitizeFileName,
    validateUpload,
    type UploadValidationCode,
} from "@/lib/validation/upload";

/**
 * The single HTTP boundary between the browser and the pipeline.
 *
 * Everything untrusted enters here: the request body, the declared file name,
 * the declared MIME type, and every byte of the file. Nothing leaves here that
 * has not been through extraction, AI validation and the Mermaid safety layer.
 */

/**
 * Server runtime.
 *
 * Explicit, because both halves of the pipeline need Node: `pdfjs-dist` and
 * `jszip` are Node libraries, and the Gemini SDK reads the credential from
 * `process.env`. The edge runtime has no `fs` and no environment, so it would
 * fail at the first import.
 */
export const runtime = "nodejs";

/**
 * Generous serverless budget for one request.
 *
 * Large PDFs are parsed in-process and the model then has to produce a summary,
 * a diagram and twenty questions; the platform default is not enough for the
 * largest supported upload.
 *
 * This must stay an inline literal. Next.js reads route segment config during a
 * separate static analysis pass that cannot follow an imported binding, so
 * referencing a constant from `constants/limits` fails the build with
 * "Invalid segment configuration export detected" and the value is silently
 * discarded. Keep `SUMMARIZE_REQUEST_MAX_DURATION_SECONDS` in sync when changing it.
 */
export const maxDuration = 120;

/** Field name the client uses for the file part. Also the reason a 400 occurs. */
const FILE_FIELD = "file";

/**
 * Status codes by upload-validation failure.
 *
 * Split by whose fault the problem is, so the client can tell a retryable
 * service problem from a bad request and only retry the former.
 */
const UPLOAD_ERROR_STATUS: Readonly<Record<UploadValidationCode, number>> = {
    MISSING_FILENAME: 400,
    EMPTY_FILE: 400,
    UNSUPPORTED_EXTENSION: 415,
    LEGACY_PPT_UNSUPPORTED: 415,
    UNRECOGNIZED_SIGNATURE: 415,
    SIGNATURE_MISMATCH: 415,
    MIME_MISMATCH: 415,
    TOO_LARGE: 413,
};

/** Extraction failures are the document's fault, so a retry would fail again. */
const DOCUMENT_ERROR_STATUS: Readonly<Record<DocumentErrorCode, number>> = {
    EMPTY_FILE: 400,
    UNSUPPORTED_SOURCE_TYPE: 415,
    CORRUPTED_PDF: 422,
    ENCRYPTED_PDF: 422,
    NO_EXTRACTABLE_TEXT: 422,
    TOO_MANY_UNITS: 422,
    CORRUPTED_PPTX: 422,
    INVALID_PPTX_STRUCTURE: 422,
    NO_EXTRACTABLE_SLIDES: 422,
    PACKAGE_TOO_LARGE: 413,
    TOO_MANY_PACKAGE_ENTRIES: 413,
    TEXT_LIMIT_EXCEEDED: 413,
    // The parser itself is unavailable, not the document: a retry is likely to
    // work, and blaming the upload would be wrong.
    PARSER_UNAVAILABLE: 503,
};

/**
 * AI failures are the *service's* fault, so 503 is the honest answer: the same
 * upload will most likely succeed later.
 *
 * `EMPTY_DOCUMENT` is the exception - the document genuinely has no text, and a
 * retry would fail identically, so it is a 422.
 */
const AI_ERROR_STATUS: Readonly<Record<AiErrorCode, number>> = {
    MISSING_API_KEY: 503,
    GEMINI_REQUEST_FAILED: 503,
    GROQ_REQUEST_FAILED: 503,
    AI_REQUEST_TIMEOUT: 503,
    EMPTY_MODEL_RESPONSE: 503,
    MALFORMED_MODEL_RESPONSE: 503,
    OUTPUT_SCHEMA_MISMATCH: 503,
    EMPTY_DOCUMENT: 422,
};

/** Message for a failure the pipeline has no specific code for. */
const UNEXPECTED_ERROR_MESSAGE =
    "Something went wrong while processing this document. Please try again.";

/**
 * Build the JSON error response.
 *
 * `Retry-After` accompanies 5xx so a client that chooses to retry has a server-
 * supplied backoff rather than inventing one.
 */
function errorResponse(
    status: number,
    code: string,
    message: string,
): Response {
    const payload: SummarizeResponse = {
        ok: false,
        error: { code, message, retryable: status >= 500 },
    };

    return Response.json(payload, {
        status,
        headers: status >= 500 ? { "Retry-After": "5" } : undefined,
    });
}

/** Map a typed document error onto a status and its own already-safe message. */
function documentErrorResponse(error: DocumentProcessingError): Response {
    // `PARSER_UNAVAILABLE` is defined as "this deployment is broken", so it is
    // the one document error that must never pass silently: without this the
    // real cause - a pdf.js module that will not load - is invisible in the logs
    // and the only symptom users ever see is a generic 503. The cause stays
    // server-side; it is never part of the response.
    if (error.code === "PARSER_UNAVAILABLE") {
        console.error("[summarize] document reader unavailable", error.cause ?? error);
    }

    return errorResponse(
        DOCUMENT_ERROR_STATUS[error.code],
        error.code,
        error.message,
    );
}

/** Map a typed AI error onto a status and its own already-safe message. */
function aiErrorResponse(error: AiGenerationError): Response {
    // Logged, never returned: the browser gets the fixed sentence from the
    // error's own message, and this line exists so an operator can tell a
    // revoked key from an exhausted quota from a model name that does not
    // exist. The API key, the request headers and the upstream message body are
    // all deliberately excluded from that line - see `lib/ai/diagnostics`.
    logAiFailure("summarize", error);
    return errorResponse(AI_ERROR_STATUS[error.code], error.code, error.message);
}

/**
 * Read the uploaded file from a multipart body.
 *
 * The body is parsed in memory and the bytes are never written to disk: the
 * extractors accept a `Uint8Array`, and a temporary file would create a path
 * that has to be cleaned up correctly on every error path - a place where a
 * leftover copy of an untrusted upload would be much worse than the problem it
 * was meant to solve.
 */
async function readUploadedFile(request: Request): Promise<
    | { ok: true; fileName: string; declaredMimeType: string; bytes: Uint8Array }
    | { ok: false; response: Response }
> {
    let formData: FormData;
    try {
        formData = await request.formData();
    } catch {
        return {
            ok: false,
            response: errorResponse(
                400,
                "INVALID_REQUEST",
                "No file was received. Choose a PDF or PPTX file and try again.",
            ),
        };
    }

    const entry = formData.get(FILE_FIELD);
    if (!(entry instanceof File)) {
        return {
            ok: false,
            response: errorResponse(
                400,
                "MISSING_FILE",
                "No file was received. Choose a PDF or PPTX file and try again.",
            ),
        };
    }

    // The byte count is taken from the body itself, not from any declared
    // length: `File.size` is what actually arrived over the socket, and it is
    // the only size an attacker cannot understate.
    const bytes = new Uint8Array(await entry.arrayBuffer());

    return {
        ok: true,
        fileName: sanitizeFileName(entry.name),
        // Forwarded so `validateUpload` can apply its own MIME agreement rule.
        // Browsers report PPTX as a generic type, which that rule tolerates.
        declaredMimeType: entry.type,
        bytes,
    };
}

/**
 * Validate the upload, then run the full pipeline.
 *
 * Order matters: validation first so an unsupported or oversized file never
 * reaches the extractors, extraction before the AI stage because the AI stage
 * needs a canonical document, and the Mermaid layer last because it only has
 * something to work on once the diagram exists.
 */
async function processUpload(
    fileName: string,
    declaredMimeType: string,
    bytes: Uint8Array,
): Promise<Response> {
    // Enforced against the bytes actually received rather than the declared
    // `Content-Length`: a client can understate the header, so only the body is
    // trustworthy. `MAX_FILE_SIZE_BYTES` is the same limit the browser checks,
    // so this is the authoritative half of one rule, not a second rule.
    if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
        return errorResponse(
            413,
            "TOO_LARGE",
            `The selected file is too large. Maximum supported size is ${Math.round(
                MAX_FILE_SIZE_BYTES / (1024 * 1024),
            )} MB.`,
        );
    }

    // Reused verbatim from the client-side validator rather than restated: one
    // set of rules means the browser's instant feedback and the server's
    // authoritative answer can never disagree about what is acceptable.
    const validation = validateUpload({
        fileName,
        sizeBytes: bytes.byteLength,
        declaredMimeType,
        headerBytes: bytes.subarray(0, SIGNATURE_PREFIX_LENGTH),
    });

    if (!validation.ok) {
        return errorResponse(
            UPLOAD_ERROR_STATUS[validation.code],
            validation.code,
            validation.message,
        );
    }

    const document = await extractDocument({
        sourceType: validation.sourceType,
        data: bytes,
        fileName,
    });

    const material = await generateStudyMaterial(document);

    const diagram = await resolveDiagram(material.diagram, (reasons) =>
        regenerateDiagram(document, reasons),
    );

    return Response.json({
        ok: true,
        data: {
            fileName,
            // Derived from the verified source type, never from the extension:
            // an attacker who renames a deck to `.pdf` gets the PDF parser and
            // the word "page", not a different vocabulary.
            unitNoun: document.metadata.sourceType === "pptx" ? "slide" : "page",
            totalUnits: document.metadata.totalUnits,
            summary: material.summary,
            diagram,
            quiz: material.quiz,
        },
    } satisfies SummarizeResponse);
}

/**
 * The one route handler.
 *
 * Every exit is a typed `SummarizeResponse`: a validation rejection, a typed
 * document or AI error, or the success payload. Unexpected throws are caught and
 * reported as a generic 500 - an unhandled error would otherwise reach the
 * framework's default handler, whose body is platform- and build-dependent and
 * can include a stack trace or an absolute path.
 */
export async function POST(request: Request): Promise<Response> {
    // Declared here rather than delegating to `validateUpload` alone: the
    // per-file limits below are on the bytes received, and this is the only
    // place that knows them.
    const contentLength = Number(request.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE_BYTES) {
        return errorResponse(
            413,
            "TOO_LARGE",
            `The selected file is too large. Maximum supported size is ${Math.round(
                MAX_FILE_SIZE_BYTES / (1024 * 1024),
            )} MB.`,
        );
    }

    const upload = await readUploadedFile(request);
    if (!upload.ok) return upload.response;

    try {
        return await processUpload(upload.fileName, upload.declaredMimeType, upload.bytes);
    } catch (error) {
        if (isDocumentProcessingError(error)) return documentErrorResponse(error);
        if (isAiGenerationError(error)) return aiErrorResponse(error);

        // Nothing about `error` is returned: its message may quote a file system
        // path, a library internal, or the request that carried the credential.
        // Server-side logging keeps the detail; the client gets a fixed sentence.
        console.error("[summarize] unexpected failure", error);
        return errorResponse(500, "UNEXPECTED_ERROR", UNEXPECTED_ERROR_MESSAGE);
    }
}

/** Any other method is a client mistake; nothing here accepts one. */
export async function GET(): Promise<Response> {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Use POST to upload a document.");
}