---
name: security-review
description: Review the document summarizer for file-upload risks, prompt injection, XSS, secret exposure, and unsafe AI output handling.
---

# Security Review Skill

## Purpose

Identify and prevent security vulnerabilities in the application.

## Review Areas

### File Upload Security

- Validate MIME type.
- Validate file signatures where practical.
- Enforce file-size limits.
- Enforce page/slide limits.
- Reject corrupted or unsupported files.
- Avoid unsafe filesystem paths and filenames.

### Prompt Injection

Treat all extracted PDF/PPT/PPTX content as untrusted.

Document text must never override application instructions.

Use clear delimiters between instructions and document content.

### API Security

- Keep Gemini API keys server-side.
- Read secrets from environment variables.
- Never place secrets in frontend code.
- Never commit `.env` files.

### Output Security

- Validate Gemini responses.
- Sanitize Markdown/HTML rendering.
- Validate Mermaid syntax before rendering.
- Prevent XSS and script injection.

### Error Handling

Do not expose:

- API keys
- environment variables
- internal filesystem paths
- stack traces
- sensitive implementation details

## Review Principle

Prefer secure failure over silently accepting malformed or suspicious input.