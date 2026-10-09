import {
    LEGACY_PPT_SOURCE_TYPE,
    type SupportedSourceType,
} from "@/lib/constants/limits";
import type { CanonicalDocument } from "@/types/canonical-document";

import { DocumentProcessingError } from "./errors";
import { extractPdfDocument } from "./pdf";
import { extractPptxDocument } from "./pptx";

export interface ExtractDocumentOptions {
    /** Determined by signature inspection in the validation stage, never the extension. */
    sourceType: SupportedSourceType | typeof LEGACY_PPT_SOURCE_TYPE;
    data: Uint8Array;
    /** Sanitised original file name, used as the last-resort document title. */
    fileName?: string;
}

/** Strip the extension from a sanitised file name. */
function titleFromFileName(fileName: string | undefined): string {
    if (!fileName) return "Untitled document";
    const withoutExtension = fileName.replace(/\.[^.]+$/, "");
    return withoutExtension.trim().length > 0 ? withoutExtension.trim() : "Untitled document";
}

/**
 * Format-specific extraction, dispatched by the verified source type.
 *
 * The source type must come from signature detection upstream: an attacker
 * controls the extension, so routing on it would let them pick the parser.
 *
 * Legacy `.ppt` and anything unrecognised are rejected here rather than parsed,
 * so no binary PowerPoint content ever reaches an extractor.
 */
export async function extractDocument(
    options: ExtractDocumentOptions,
): Promise<CanonicalDocument> {
    const fallbackTitle = titleFromFileName(options.fileName);

    switch (options.sourceType) {
        case "pdf":
            return extractPdfDocument(options.data, fallbackTitle);
        case "pptx":
            return extractPptxDocument(options.data, fallbackTitle);
        default:
            throw new DocumentProcessingError("UNSUPPORTED_SOURCE_TYPE");
    }
}

export { DocumentProcessingError, isDocumentProcessingError } from "./errors";
export { extractPdfDocument } from "./pdf";
export { extractPptxDocument } from "./pptx";

export type { CanonicalDocument };
