import { readDeclaredDiagramType } from "./validate";

/**
 * Mermaid syntax normalisation: quote unquoted flowchart node labels.
 *
 * ## Why this exists
 *
 * Mermaid's flowchart grammar treats several characters as *structure* rather
 * than text when a `[...]` node label is not quoted. A bare `(` inside
 * `[...]` opens a stadium shape (`[(text)]`), a bare `"` opens a quoted string,
 * and `|` is an edge-pipe operator. A model asked for a conceptual diagram about
 * chemistry, or about any subject with a parenthetical aside, writes
 *
 *     C[Water splitting (O2 + e- + H+)]
 *
 * which is not valid Mermaid - the parser reports `Expecting 'SQE', ... got 'PS'`
 * and the browser renders nothing.
 *
 * Writing `C["Water splitting (O2 + e- + H+)"]` is the correct Mermaid and
 * renders identically. This module performs exactly that rewrite, so the
 * pipeline does not depend on the model remembering a rule that is not in its
 * prompt and is easy to get wrong.
 *
 * ## Why the correction belongs here and not in the AI prompt alone
 *
 * The prompt is the first line of defence but not a reliable one: the label is
 * generated inside a JSON schema, per node, with no per-node feedback, and the
 * browser is the only place the diagram is actually parsed (see
 * `isMermaidParseAvailable`). A rule the model must obey at every node is a
 * weaker guarantee than a deterministic rewrite applied to every node.
 *
 * ## Why this is not a security hole
 *
 * This runs *after* `sanitizeMermaidCode`, never before, and it is not a filter:
 * it only ever inserts a pair of `"` delimiters around text that was already
 * inside a `[...]` span. Quoting makes Mermaid treat *more* of the source as
 * literal label text and *less* as grammar, so it cannot activate a construct,
 * cannot re-create a link or directive, and cannot move any byte the
 * sanitiser's post-conditions already approved. Under
 * `securityLevel: "strict"` and `htmlLabels: false` (see `MERMAID_PARSE_CONFIG`)
 * the label text is escaped by DOMPurify whether or not it is quoted.
 *
 * ## Deliberate non-goals
 *
 * * **Only flowcharts and graphs.** `ALLOWED_MERMAID_DIAGRAMS` admits fifteen
 *   other types whose grammars were not verified here. Rewriting a `[...]`
 *   span in, say, a `sequenceDiagram` or an `erDiagram` risks corrupting a
 *   diagram that was already valid, so those are left strictly alone.
 * * **No repair of genuinely broken diagrams.** Code this cannot fix with
 *   confidence is returned untouched and fails the parse gate as before,
 *   which is what preserves the fallback for invalid diagrams.
 */

/**
 * Characters that make an *unquoted* `[...]` label fail to parse.
 *
 * Measured against the installed Mermaid 12.1.0 rather than assumed: every one
 * of these was confirmed to produce a parse error unquoted and to parse once
 * the whole label is quoted.
 */
const LABEL_BREAKING_CHARACTERS: readonly string[] = [
    '"',
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "|",
    "@",
    ">",
    "`",
];

/**
 * Characters that legitimately *open* a shape when they follow `[`.
 *
 * `[(text)]`, `[[text]]`, `[/text/]` and `[\text\]` are the four bracketed
 * shapes. Quoting their label would silently change the node's shape - a
 * stadium would become a plain rectangle - so these are recognised and skipped.
 */
const SHAPE_OPENERS: ReadonlySet<string> = new Set(["(", "[", "/", "\\"]);

/** Diagram types whose `[...]` labels this module rewrites. */
const LABEL_SYNTAX_DIAGRAMS: ReadonlySet<string> = new Set(["flowchart", "graph"]);

export interface NormalizedMermaidCode {
    /** The rewritten source. Byte-identical to the input when nothing changed. */
    code: string;
    /** Whether any label was rewritten. Reported, never rendered. */
    changed: boolean;
}

/**
 * Whether one label needs quoting to survive the parser.
 *
 * Two deliberate refusals, both of which leave the code untouched:
 *
 * * **A label containing `"`.** Quoting it would produce `A["a "b" c"]`, which
 *   the parser rejects. Leaving it alone lets it reach the parse gate and be
 *   handled by the existing regenerate-then-fallback path.
 * * **A label opening with a shape character.** `[(text)]` is already valid and
 *   must keep its shape.
 */
function needsQuoting(label: string): boolean {
    if (label.length === 0) return false;
    if (label.includes('"')) return false;
    if (SHAPE_OPENERS.has(label[0] ?? "")) return false;
    return LABEL_BREAKING_CHARACTERS.some((character) => label.includes(character));
}

/**
 * Index of the `]` closing the `[` at `openIndex`, or -1 if it is unclosed.
 *
 * Nested brackets are counted so `A[[text]]` is read as one label rather than
 * being cut short at its first `]`. An unclosed `[` returns -1 and the rest of
 * the line is emitted verbatim, so a malformed line is never guessed at.
 */
function findLabelEnd(line: string, openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < line.length; index += 1) {
        const character = line[index];
        if (character === "[") depth += 1;
        else if (character === "]") {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

/**
 * Rewrite the `[...]` spans of one line.
 *
 * Working a line at a time is what makes this safe to run on code that has not
 * been parsed yet: a `[` whose `]` is on a later line (a legitimate multi-line
 * quoted label) is simply not matched, and the line is passed through.
 */
function normalizeLine(line: string): { line: string; changed: boolean } {
    let result = "";
    let index = 0;
    let changed = false;

    while (index < line.length) {
        if (line[index] !== "[") {
            result += line[index];
            index += 1;
            continue;
        }

        const end = findLabelEnd(line, index);
        if (end === -1) {
            result += line.slice(index);
            break;
        }

        const label = line.slice(index + 1, end);
        if (needsQuoting(label)) {
            result += `["${label}"]`;
            changed = true;
        } else {
            result += line.slice(index, end + 1);
        }
        index = end + 1;
    }

    return { line: result, changed };
}

/**
 * Quote every unquoted flowchart node label that the Mermaid grammar would
 * otherwise reject.
 *
 * Returns the input unchanged for any diagram type other than flowchart/graph,
 * and for any label it is not confident about - see `needsQuoting`.
 */
export function normalizeMermaidSyntax(code: string): NormalizedMermaidCode {
    const declared = readDeclaredDiagramType(code);
    if (declared === undefined || !LABEL_SYNTAX_DIAGRAMS.has(declared)) {
        return { code, changed: false };
    }

    let changed = false;
    const normalized = code
        .split("\n")
        .map((line) => {
            const result = normalizeLine(line);
            if (result.changed) changed = true;
            return result.line;
        })
        .join("\n");

    return { code: changed ? normalized : code, changed };
}