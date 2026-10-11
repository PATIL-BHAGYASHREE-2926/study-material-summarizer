import type { SupportedSourceType } from "@/lib/constants/limits";

/**
 * The single document representation every downstream stage consumes.
 *
 * PDF extractors produce one section per page, PPTX extractors one section per
 * slide. Legacy `.ppt` is rejected at ingestion and therefore not representable.
 */
export interface CanonicalDocument {
    metadata: {
        title: string;
        sourceType: SupportedSourceType;
        /** Pages for PDF, slides for PPTX. */
        totalUnits: number;
        totalWords: number;
    };
    sections: CanonicalDocumentSection[];
    /**
     * Sections joined for prompt assembly. Every value here is untrusted input
     * and must be delimited and never executed as instructions.
     */
    aggregatedText: string;
}

export interface CanonicalDocumentSection {
    /** Page number or slide number, 1-indexed. */
    unitIndex: number;
    title?: string;
    content: string;
    /** Speaker notes for PPTX slides. */
    notes?: string;
}

export type CanonicalDocumentInput = Omit<CanonicalDocument, "aggregatedText">;