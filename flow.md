# Project Flow: AI Study Material Summarizer

## 1. End-to-End User Flow

```mermaid
flowchart TD
    A["User Opens Application"] --> B["Upload PDF / PPT / PPTX"]
    B --> C["Validate File"]

    C -->|Invalid| D["Show Validation Error"]
    C -->|Valid| E["Detect File Format"]

    E -->|PDF| F["PDF Extraction"]
    E -->|PPT/PPTX| G["PowerPoint Extraction"]

    F --> H["Canonical Document Representation"]
    G --> H

    H --> I["Clean and Structure Content"]
    I --> J["Build AI Prompt"]

    J --> K["Gemini API"]

    K --> L["Generate Summary"]
    K --> M["Generate Mermaid Diagram"]
    K --> N["Generate 20 MCQs"]

    L --> O["Validate AI Output"]
    M --> O
    N --> O

    O --> P{"Mermaid Valid?"}

    P -->|Yes| Q["Render Results"]
    P -->|No| R["Retry Mermaid Generation Once"]

    R --> S{"Retry Successful?"}
    S -->|Yes| Q
    S -->|No| T["Use Fallback Diagram / Message"]

    T --> Q

    Q --> U["Summary View"]
    Q --> V["Diagram View"]
    Q --> W["Interactive Quiz"]