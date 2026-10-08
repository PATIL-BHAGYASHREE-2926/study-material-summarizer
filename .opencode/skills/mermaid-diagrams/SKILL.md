---
name: mermaid-diagrams
description: Generate, validate, sanitize, and safely render Mermaid diagrams from AI-generated study content.
---

# Mermaid Diagram Skill

## Purpose

Create useful conceptual diagrams from summarized study material.

## Responsibilities

- Generate Mermaid diagrams representing important concepts and relationships.
- Prefer clear flowcharts, mindmaps, or relationship diagrams.
- Keep diagrams readable and appropriately sized.
- Validate Mermaid syntax before rendering.
- Sanitize generated Mermaid content.
- Prevent unsafe HTML or script content.
- Attempt one targeted correction when validation fails.
- Provide a fallback message or simple diagram if validation still fails.

## Rules

- Never assume AI-generated Mermaid syntax is valid.
- Never render unvalidated Mermaid code.
- Do not allow arbitrary scripts or unsafe HTML.
- Prefer semantic clarity over diagram complexity.
- The diagram must represent the uploaded study material rather than unrelated information.