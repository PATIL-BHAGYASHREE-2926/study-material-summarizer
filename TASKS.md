# TASKS — AI Study Material Summarizer

## Phase 1 — Project Setup

- [ ] Initialize Next.js + TypeScript application structure.
- [ ] Configure Tailwind CSS v4.
- [ ] Configure project scripts.
- [ ] Configure environment variable handling.
- [ ] Add `.env.example`.
- [ ] Verify TypeScript and build commands.

## Phase 2 — Core Types and Validation

- [ ] Create CanonicalDocument TypeScript model.
- [ ] Create upload validation schemas.
- [ ] Configure supported file types.
- [ ] Configure file-size limits.
- [ ] Configure page/slide limits.
- [ ] Add Zod schemas for AI responses.
- [ ] Add quiz validation requiring exactly 20 questions.

## Phase 3 — Document Processing

### PDF

- [ ] Implement PDF file validation.
- [ ] Implement PDF text extraction.
- [ ] Preserve page numbers.
- [ ] Extract document metadata where available.
- [ ] Handle empty/corrupted PDFs.

### PowerPoint

- [ ] Implement PPTX extraction.
- [ ] Extract slide titles and text.
- [ ] Extract bullet content.
- [ ] Extract tables where practical.
- [ ] Extract speaker notes where supported.
- [ ] Preserve slide numbers.
- [ ] Determine reliable handling of legacy PPT files.
- [ ] Handle corrupted/empty presentations.

### Canonical Representation

- [ ] Normalize PDF and PowerPoint output.
- [ ] Generate CanonicalDocument.
- [ ] Generate aggregated text.
- [ ] Preserve source/page/slide references.

## Phase 4 — Gemini AI Pipeline

- [ ] Configure server-side Gemini API.
- [ ] Load API key from environment variables.
- [ ] Build safe prompt construction.
- [ ] Delimit untrusted document content.
- [ ] Implement structured Gemini response.
- [ ] Generate TL;DR summary.
- [ ] Generate key takeaways.
- [ ] Generate section/page/slide breakdown.
- [ ] Generate conceptual Mermaid diagram.
- [ ] Generate exactly 20 MCQs.
- [ ] Generate explanations for quiz answers.

## Phase 5 — AI Output Validation

- [ ] Validate Gemini response using Zod.
- [ ] Validate summary fields.
- [ ] Validate exactly 20 MCQs.
- [ ] Validate four options per question.
- [ ] Validate correct answer indexes.
- [ ] Reject malformed AI responses.
- [ ] Implement graceful Gemini failure handling.

## Phase 6 — Mermaid

- [ ] Implement Mermaid rendering.
- [ ] Validate Mermaid syntax.
- [ ] Sanitize Mermaid output.
- [ ] Implement one retry for invalid diagrams.
- [ ] Implement fallback diagram/message.
- [ ] Prevent unsafe HTML/script execution.

## Phase 7 — Frontend UI

- [ ] Create application layout.
- [ ] Create upload interface.
- [ ] Add drag-and-drop upload.
- [ ] Display file information.
- [ ] Add processing/loading state.
- [ ] Add validation error states.
- [ ] Create summary view.
- [ ] Create key-takeaway cards.
- [ ] Create page/slide breakdown.
- [ ] Create Mermaid diagram view.
- [ ] Create interactive quiz view.
- [ ] Add quiz score calculation.
- [ ] Add answer explanations.
- [ ] Make interface responsive.

## Phase 8 — Security

- [ ] Review file-upload security.
- [ ] Validate file signatures where practical.
- [ ] Prevent path traversal.
- [ ] Protect Gemini API key.
- [ ] Review prompt injection handling.
- [ ] Sanitize rendered content.
- [ ] Review Mermaid security.
- [ ] Ensure errors do not expose secrets or internal paths.

## Phase 9 — Testing

### Unit Tests

- [ ] File validation tests.
- [ ] Format detection tests.
- [ ] PDF extraction tests.
- [ ] PPTX extraction tests.
- [ ] Canonical document tests.
- [ ] Zod validation tests.
- [ ] Quiz validation tests.
- [ ] Mermaid validation tests.

### Integration Tests

- [ ] Document extraction pipeline.
- [ ] Gemini response processing.
- [ ] Invalid AI response handling.
- [ ] Mermaid retry/fallback.
- [ ] API failure handling.

### E2E Tests

- [ ] Upload valid PDF.
- [ ] Upload valid PPTX.
- [ ] Test invalid file.
- [ ] Test oversized file.
- [ ] Verify summary rendering.
- [ ] Verify diagram rendering.
- [ ] Verify 20-question quiz.
- [ ] Verify quiz scoring.

## Phase 10 — Quality Review

- [ ] Run TypeScript checks.
- [ ] Run unit tests.
- [ ] Run integration tests.
- [ ] Run Playwright tests.
- [ ] Run production build.
- [ ] Run security review.
- [ ] Run code review.
- [ ] Fix critical issues.
- [ ] Remove unnecessary dependencies.
- [ ] Update documentation.

## Phase 11 — Final Submission

- [ ] Verify complete application locally.
- [ ] Verify PDF workflow.
- [ ] Verify PPT/PPTX workflow.
- [ ] Verify summary.
- [ ] Verify Mermaid diagram.
- [ ] Verify 20 MCQs.
- [ ] Verify error handling.
- [ ] Verify `.env` is not committed.
- [ ] Review Git status.
- [ ] Create final commit.
- [ ] Prepare screenshots/demo evidence.
- [ ] Prepare final project submission.