# Rough Project Brief

## 1. What is the project?

A web application with an intuitive UI designed to summarize both PowerPoint presentations (.ppt, .pptx) and PDF documents (.pdf). It generates structured, concise summaries, visual conceptual diagrams (Mermaid.js), and a 20-question multiple-choice quiz (MCQ) for students.

## 2. Who is it for?

Students and self-learners looking to quickly digest lecture slides, research papers, and study material.

## 3. Must-have features

1. **Document Upload & Extraction**: Support for both PPT/PPTX and PDF files.
2. **Balanced Summarization**: A clear, well-structured summary (TL;DR, key takeaways, and section/slide breakdown) that is neither too brief nor overwhelming.
3. **Conceptual Diagrams**: Automatic generation of at least one valid, clean Mermaid diagram visualizing the core concepts or workflows.
4. **Interactive 20-Question MCQ Quiz**: 20 relevant multiple-choice questions based on the content, including answer keys and explanations to test understanding.

## 4. Out of scope

1. Very large files or massive textbooks (e.g., presentations over 100 slides or PDFs over 100 pages).
2. Non-supported formats such as Word (.doc, .docx) or Excel (.xls, .xlsx).
3. OCR processing for scanned or image-only slides/pages (text must be extractable).
4. User authentication and cloud history/database storage (for MVP).

## 5. How will I know it works?

1. A user can upload a valid PPT, PPTX, or PDF file and successfully process it.
2. The resulting summary includes a concise TL;DR, key points, and slide/section-level breakdowns.
3. The system generates valid Mermaid syntax that renders cleanly in the browser interface.
4. The system generates exactly 20 relevant MCQs based on the uploaded document.
5. Unsupported file types, corrupted files, or empty documents are rejected with clear, user-friendly error messages.
6. The entire workflow—from upload to displaying the summary, diagram, and quiz—runs smoothly without manual intervention.