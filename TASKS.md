# TASKS — AI Study Material Summarizer

Status verified by running each command on 2026-10-10. Counts come from the
actual runs: 344 Vitest tests across 15 files, 14 Playwright tests, 0 lint
errors, 0 TypeScript errors, successful production build.

## Phase 1 — Project Setup

- [x] Initialize Next.js + TypeScript application structure.
- [x] Configure Tailwind CSS v4.
- [x] Configure project scripts.
- [x] Configure environment variable handling.
- [x] Add `.env.example`.
- [x] Verify TypeScript and build commands.

## Phase 2 — Core Types and Validation

- [x] Create CanonicalDocument TypeScript model.
- [x] Create upload validation schemas.
- [x] Configure supported file types.
- [x] Configure file-size limits.
- [x] Configure page/slide limits.
- [x] Add Zod schemas for AI responses.
- [x] Add quiz validation requiring exactly 20 questions.

## Phase 3 — Document Processing

### PDF

- [x] Implement PDF file validation.
- [x] Implement PDF text extraction.
- [x] Preserve page numbers.
- [x] Extract document metadata where available.
- [x] Handle empty/corrupted PDFs.

### PowerPoint

- [x] Implement PPTX extraction.
- [x] Extract slide titles and text.
- [x] Extract bullet content.
- [x] Extract tables where practical.
- [x] Extract speaker notes where supported.
- [x] Preserve slide numbers.
- [x] Determine reliable handling of legacy PPT files. *(OLE2 signature is
      detected and refused with a re-save instruction; `NO_PPT` support.)*
- [x] Handle corrupted/empty presentations.

### Canonical Representation

- [x] Normalize PDF and PowerPoint output.
- [x] Generate CanonicalDocument.
- [x] Generate aggregated text.
- [x] Preserve source/page/slide references.

## Phase 4 — Gemini AI Pipeline

- [x] Configure server-side Gemini API.
- [x] Load API key from environment variables.
- [x] Build safe prompt construction.
- [x] Delimit untrusted document content.
- [x] Implement structured Gemini response.
- [x] Generate TL;DR summary.
- [x] Generate key takeaways.
- [x] Generate section/page/slide breakdown.
- [x] Generate conceptual Mermaid diagram.
- [x] Generate exactly 20 MCQs.
- [x] Generate explanations for quiz answers.

## Phase 5 — AI Output Validation

- [x] Validate Gemini response using Zod.
- [x] Validate summary fields.
- [x] Validate exactly 20 MCQs.
- [x] Validate four options per question.
- [x] Validate correct answer indexes.
- [x] Reject malformed AI responses.
- [x] Implement graceful Gemini failure handling.

## Phase 6 — Mermaid

- [x] Implement Mermaid rendering.
- [x] Validate Mermaid syntax.
- [x] Sanitize Mermaid output.
- [x] Implement one retry for invalid diagrams.
- [x] Implement fallback diagram/message.
- [x] Prevent unsafe HTML/script execution. *(No `dangerouslySetInnerHTML`
      anywhere; mermaid is handed a container element and runs at
      `securityLevel: "strict"`, so it never receives an HTML sink.)*

## Phase 7 — Frontend UI

- [x] Create application layout.
- [x] Create upload interface.
- [x] Add drag-and-drop upload.
- [x] Display file information.
- [x] Add processing/loading state.
- [x] Add validation error states.
- [x] Create summary view.
- [x] Create key-takeaway cards.
- [x] Create page/slide breakdown.
- [x] Create Mermaid diagram view.
- [x] Create interactive quiz view.
- [x] Add quiz score calculation.
- [x] Add answer explanations.
- [x] Make interface responsive. *(Tailwind breakpoints on the summary and quiz
      grids; tabs wrap on narrow viewports.)*

## Phase 8 — Security

- [x] Review file-upload security.
- [x] Validate file signatures where practical.
- [x] Prevent path traversal.
- [x] Protect Gemini API key.
- [x] Review prompt injection handling.
- [x] Sanitize rendered content.
- [x] Review Mermaid security.
- [x] Ensure errors do not expose secrets or internal paths.
- [x] Bound XML entity expansion. *(Caps moved to `MAX_ENTITY_*` in
      `constants/limits.ts`, including a previously-unset `maxExpansionDepth`;
      regression tests added for numeric-reference floods, entity-count limits,
      expanded-length limits and nesting depth.)*

## Phase 9 — Testing

### Unit Tests

- [x] File validation tests.
- [x] Format detection tests.
- [x] PDF extraction tests.
- [x] PPTX extraction tests.
- [x] Canonical document tests.
- [x] Zod validation tests.
- [x] Quiz validation tests.
- [x] Prompt injection defence tests.
- [x] Mermaid validation tests.

### Integration Tests

- [x] Document extraction pipeline.
- [x] Gemini response processing.
- [x] Invalid AI response handling.
- [x] Mermaid retry/fallback.
- [x] API failure handling.

### E2E Tests

- [x] Upload valid PDF.
- [x] Upload valid PPTX.
- [x] Test invalid file.
- [x] Test oversized file. *(Covered at the API boundary by the 413
      `content-length` pre-check and by upload validation unit tests; no
      50 MB fixture is pushed through a browser test.)*
- [x] Verify summary rendering.
- [x] Verify diagram rendering.
- [x] Verify 20-question quiz.
- [x] Verify quiz scoring.

## Phase 10 — Quality Review

- [x] Run TypeScript checks. *(`npm run typecheck`, exit 0.)*
- [x] Run unit tests. *(`npm test`, 344/344 passing.)*
- [x] Run integration tests. *(Covered within the Vitest suite.)*
- [x] Run Playwright tests. *(`npm run test:e2e`, 14/14 passing, Chromium.)*
- [x] Run production build. *(`npm run build`, exit 0.)*
- [x] Run security review. *(`npm audit --omit=dev`, 0 vulnerabilities.)*
- [x] Run code review.
- [x] Fix critical issues. *(`maxDuration` static-config build failure, one
      ESLint error, one unused import, two test timeouts.)*
- [x] Remove unnecessary dependencies.
- [x] Update documentation.

## Phase 11 — Final Submission

- [x] Verify complete application locally.
- [ ] Verify PDF workflow against the **live** Gemini API.
- [ ] Verify PPTX workflow against the **live** Gemini API.
- [ ] Verify `.env` is not committed. *(`git check-ignore` confirms `.env` is
      ignored and no `.env` file is tracked, but the working tree still has all
      source untracked — re-verify after the first commit.)*
- [ ] Review Git status after committing.
- [ ] Create final commit.
- [ ] Prepare screenshots/demo evidence.
- [ ] Prepare final project submission.

## Verification Commands

```
npm run typecheck   # exit 0
npm run lint        # exit 0, 0 problems
npm test            # 344 passed / 344 total
npm run test:e2e    # 14 passed / 14 total
npm run build       # exit 0
```