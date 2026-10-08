---
name: testing
description: Test the document summarizer using unit, integration, and end-to-end tests across upload, extraction, AI output, diagrams, and quiz functionality.
---

# Testing Skill

## Purpose

Ensure the application behaves correctly and fails safely.

## Testing Areas

### Unit Tests

Test:

- file validation
- format detection
- document normalization
- schema validation
- quiz validation
- Mermaid validation
- utility functions

### Integration Tests

Test:

- document extraction pipeline
- Gemini response handling
- API error handling
- malformed AI responses
- Mermaid retry/fallback behavior

### End-to-End Tests

Using Playwright, test:

1. Open application.
2. Upload valid document.
3. Validate processing state.
4. Display summary.
5. Display diagram.
6. Start quiz.
7. Answer questions.
8. Calculate score.
9. Handle invalid files.

## Edge Cases

Test:

- unsupported file
- oversized file
- empty document
- corrupted document
- extraction failure
- Gemini failure
- invalid Mermaid output
- fewer/more than 20 MCQs

## Rules

- Tests should be deterministic where possible.
- Do not expose real API keys in tests.
- Use mocks for external AI calls when appropriate.
- Test both successful and failure paths.