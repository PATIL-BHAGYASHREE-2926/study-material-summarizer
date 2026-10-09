/**
 * Typed, user-presentable failures from the document-processing layer.
 *
 * Extractor errors never leak file system paths or library internals: every
 * message here is safe to hand straight to the UI.
 */

export type DocumentErrorCode =
    | "EMPTY_FILE"
    | "CORRUPTED_PDF"
    | "ENCRYPTED_PDF"
    | "NO_EXTRACTABLE_TEXT"
    | "TOO_MANY_UNITS"
    | "CORRUPTED_PPTX"
    | "INVALID_PPTX_STRUCTURE"
    | "NO_EXTRACTABLE_SLIDES"
    | "PACKAGE_TOO_LARGE"
    | "TOO_MANY_PACKAGE_ENTRIES"
    | "TEXT_LIMIT_EXCEEDED"
    | "PARSER_UNAVAILABLE"
    | "UNSUPPORTED_SOURCE_TYPE";

const DEFAULT_MESSAGES: Record<DocumentErrorCode, string> = {
    EMPTY_FILE: "The selected file is empty. Please choose a file that contains text.",
    CORRUPTED_PDF:
        "The PDF could not be read. It may be corrupted or damaged - try re-exporting or re-downloading it.",
    ENCRYPTED_PDF:
        "The PDF is password protected. Remove the password and upload the unlocked file.",
    NO_EXTRACTABLE_TEXT:
        "No readable text could be extracted from this document. It may be a scanned image with no text layer - try a text-based document.",
    TOO_MANY_UNITS: "The document has more pages or slides than this app can process.",
    CORRUPTED_PPTX:
        "The PowerPoint file could not be opened. It may be corrupted or incomplete - try re-saving the presentation.",
    INVALID_PPTX_STRUCTURE:
        "This file is not a valid PowerPoint (.pptx) presentation, even though its extension says so.",
    NO_EXTRACTABLE_SLIDES:
        "No slides with readable content were found in this presentation.",
    PACKAGE_TOO_LARGE:
        "This file expands to far more content than this app can process, which usually means it is malformed or compressed unusually.",
    TOO_MANY_PACKAGE_ENTRIES:
        "This presentation contains an unusually large number of internal files. It may be malformed - try re-saving the presentation.",
    TEXT_LIMIT_EXCEEDED:
        "This document contains more text than this app can process. Try splitting it into smaller parts.",
    PARSER_UNAVAILABLE:
        "The document reader is temporarily unavailable, so this file could not be processed. Please try again in a moment.",
    UNSUPPORTED_SOURCE_TYPE:
        "This file type is not supported. Upload a PDF or PPTX file.",
};

/**
 * Raised by extractors when a document cannot be turned into a canonical
 * document. Carries a stable `code` so the UI can branch without string
 * matching, plus an already-safe message.
 */
export class DocumentProcessingError extends Error {
    readonly code: DocumentErrorCode;

    constructor(code: DocumentErrorCode, message?: string, options?: { cause?: unknown }) {
        super(message ?? DEFAULT_MESSAGES[code], options);
        this.name = "DocumentProcessingError";
        this.code = code;
    }
}

/** Narrow an unknown thrown value to a `DocumentProcessingError`. */
export function isDocumentProcessingError(
    error: unknown,
): error is DocumentProcessingError {
    return error instanceof DocumentProcessingError;
}

/**
 * Wrap an arbitrary thrown value into a `DocumentProcessingError` without
 * leaking the original message, which may contain internal paths or raw parser
 * internals.
 */
export function toDocumentProcessingError(
    error: unknown,
    fallbackCode: DocumentErrorCode,
): DocumentProcessingError {
    if (isDocumentProcessingError(error)) return error;
    return new DocumentProcessingError(fallbackCode, undefined, { cause: error });
}
