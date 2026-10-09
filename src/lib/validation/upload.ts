import {
    FILE_EXTENSIONS,
    FILE_SIGNATURES,
    GENERIC_MIME_TYPES,
    MAX_FILE_SIZE_BYTES,
    MIME_TYPES,
    SIGNATURE_PREFIX_LENGTH,
    type SupportedSourceType,
} from "@/lib/constants/limits";

export type UploadValidationCode =
    | "MISSING_FILENAME"
    | "EMPTY_FILE"
    | "TOO_LARGE"
    | "UNSUPPORTED_EXTENSION"
    | "LEGACY_PPT_UNSUPPORTED"
    | "UNRECOGNIZED_SIGNATURE"
    | "SIGNATURE_MISMATCH"
    | "MIME_MISMATCH";

export type UploadValidationResult =
    | { ok: true; sourceType: SupportedSourceType }
    | { ok: false; code: UploadValidationCode; message: string };

export interface UploadCandidate {
    fileName: string;
    sizeBytes: number;
    /** MIME type declared by the client. May be empty or generic. */
    declaredMimeType: string;
    /** Leading bytes of the file, used for signature detection. */
    headerBytes: Uint8Array;
}

const ALLOWED_MIME_TYPES: Record<SupportedSourceType, readonly string[]> = {
    pdf: [MIME_TYPES.pdf, ...GENERIC_MIME_TYPES],
    pptx: [MIME_TYPES.pptx, ...GENERIC_MIME_TYPES],
};

const UNSUPPORTED_EXTENSION_MESSAGE =
    "Unsupported file type. Upload a PDF or PPTX file.";

const LEGACY_PPT_MESSAGE =
    "Legacy .ppt files are not supported. Open the presentation and re-save it as .pptx (or export it as PDF), then try again.";

function fail(code: UploadValidationCode, message: string): UploadValidationResult {
    return { ok: false, code, message };
}

function startsWithBytes(
    header: Uint8Array,
    signature: readonly number[],
): boolean {
    if (header.length < signature.length) return false;
    return signature.every((byte, index) => header[index] === byte);
}

function extensionOf(fileName: string): string {
    const trimmed = fileName.trim();
    const dotIndex = trimmed.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return "";
    return trimmed.slice(dotIndex).toLowerCase();
}

function formatMegabytes(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Detect the real container format from the file signature.
 *
 * Extensions and client-supplied MIME types are attacker controlled, so the
 * signature is authoritative.
 */
function detectSourceType(
    header: Uint8Array,
): SupportedSourceType | "ole2" | "unknown" {
    if (startsWithBytes(header, FILE_SIGNATURES.pdf)) return "pdf";
    if (startsWithBytes(header, FILE_SIGNATURES.zip)) return "pptx";
    if (startsWithBytes(header, FILE_SIGNATURES.ole2)) return "ole2";
    return "unknown";
}

/**
 * Validate an upload before any parsing work happens.
 *
 * Order matters: cheap metadata checks first, then signature detection, then
 * agreement checks between the signature and the claimed type.
 */
export function validateUpload(
    candidate: UploadCandidate,
): UploadValidationResult {
    const fileName = candidate.fileName?.trim() ?? "";
    if (fileName.length === 0) {
        return fail("MISSING_FILENAME", "No file name was provided.");
    }

    const extension = extensionOf(fileName);
    if (extension === FILE_EXTENSIONS.legacyPpt) {
        return fail("LEGACY_PPT_UNSUPPORTED", LEGACY_PPT_MESSAGE);
    }
    if (
        extension !== FILE_EXTENSIONS.pdf &&
        extension !== FILE_EXTENSIONS.pptx
    ) {
        return fail("UNSUPPORTED_EXTENSION", UNSUPPORTED_EXTENSION_MESSAGE);
    }

    if (!Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
        return fail(
            "EMPTY_FILE",
            "The selected file is empty. Please choose a file that contains text.",
        );
    }
    if (candidate.sizeBytes > MAX_FILE_SIZE_BYTES) {
        return fail(
            "TOO_LARGE",
            `The selected file is too large. Maximum supported size is ${formatMegabytes(MAX_FILE_SIZE_BYTES)}.`,
        );
    }

    const detected = detectSourceType(candidate.headerBytes);
    if (detected === "ole2") {
        return fail("LEGACY_PPT_UNSUPPORTED", LEGACY_PPT_MESSAGE);
    }
    if (detected === "unknown") {
        return fail(
            "UNRECOGNIZED_SIGNATURE",
            "The file could not be recognised as a PDF or PowerPoint presentation. It may be corrupted.",
        );
    }

    const expectedExtension =
        detected === "pdf" ? FILE_EXTENSIONS.pdf : FILE_EXTENSIONS.pptx;
    if (extension !== expectedExtension) {
        return fail(
            "SIGNATURE_MISMATCH",
            detected === "pdf"
                ? "This file is actually a PDF. Rename it to a .pdf file and try again."
                : "This file is actually a PowerPoint presentation. Rename it to a .pptx file and try again.",
        );
    }

    const declared = candidate.declaredMimeType?.trim().toLowerCase() ?? "";
    if (!ALLOWED_MIME_TYPES[detected].includes(declared)) {
        return fail(
            "MIME_MISMATCH",
            "The file type does not match its contents. Please re-export the file and try again.",
        );
    }

    return { ok: true, sourceType: detected };
}

/** Read the signature bytes of a browser `File` / `Blob` without loading it all. */
export async function readFileHeader(
    file: Blob,
    length: number = SIGNATURE_PREFIX_LENGTH,
): Promise<Uint8Array> {
    const header = new Uint8Array(await file.slice(0, length).arrayBuffer());
    return header;
}

/** Convenience wrapper for browser `File` objects. */
export async function validateUploadFile(file: File): Promise<UploadValidationResult> {
    return validateUpload({
        fileName: file.name,
        sizeBytes: file.size,
        declaredMimeType: file.type,
        headerBytes: await readFileHeader(file),
    });
}

/**
 * Strip directory information and unsafe characters from a client-supplied name.
 *
 * Uploaded files are never written to disk, but the name is shown and later used
 * for downloads, so it must not be able to carry a path or break out of a
 * rendered context.
 */
export function sanitizeFileName(fileName: string): string {
    const baseName = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
    const cleaned = baseName
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[<>:"|?*]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const safe = cleaned.replace(/^\.+/, "");
    return safe.length > 0 ? safe.slice(0, 180) : "document";
}