import { describe, expect, it } from "vitest";

import {
    FILE_EXTENSIONS,
    FILE_SIGNATURES,
    MAX_FILE_SIZE_BYTES,
    MIME_TYPES,
    REQUIRED_QUIZ_QUESTION_COUNT,
    SUPPORTED_FILE_ACCEPT,
} from "@/lib/constants/limits";

describe("limits configuration", () => {
    it("matches the documented ingestion limits", () => {
        expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
        expect(REQUIRED_QUIZ_QUESTION_COUNT).toBe(20);
        expect(SUPPORTED_FILE_ACCEPT).toBe(".pdf,.pptx");
    });

    it("exposes stable file signatures", () => {
        expect(FILE_SIGNATURES.pdf).toEqual([0x25, 0x50, 0x44, 0x46]);
        expect(FILE_SIGNATURES.zip).toEqual([0x50, 0x4b, 0x03, 0x04]);
        expect(FILE_SIGNATURES.ole2).toHaveLength(8);
        expect(FILE_EXTENSIONS.legacyPpt).toBe(".ppt");
        expect(MIME_TYPES.legacyPpt).toBe("application/vnd.ms-powerpoint");
    });
});