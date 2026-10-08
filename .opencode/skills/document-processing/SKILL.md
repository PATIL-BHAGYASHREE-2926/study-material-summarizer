---
name: document-processing
description: Extract, normalize, validate, and structure content from PDF, PPT, and PPTX study materials for the unified document pipeline.
---

# Document Processing Skill

## Purpose

Handle document ingestion and content extraction for PDF, PPT, and PPTX files.

## Responsibilities

- Validate supported file types and file size.
- Detect the actual file format rather than trusting only the extension.
- Extract readable content page-by-page or slide-by-slide.
- Preserve page/slide numbering.
- Extract titles, headings, paragraphs, bullets, tables, and speaker notes when available.
- Normalize extracted content into the project's Canonical Document Representation.
- Handle corrupted, empty, or unsupported documents gracefully.

## Canonical Representation

Use:

```typescript
interface CanonicalDocument {
  metadata: {
    title: string;
    sourceType: "pdf" | "pptx" | "ppt";
    totalUnits: number;
    totalWords: number;
  };
  sections: Array<{
    unitIndex: number;
    title?: string;
    content: string;
    notes?: string;
  }>;
  aggregatedText: string;
}