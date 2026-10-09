import JSZip from "jszip";

/**
 * Builders for minimal but valid PDF and PPTX byte fixtures.
 *
 * Tests generate documents in-process rather than committing binary fixtures, so
 * the XML and object layout under test stays readable and reviewable.
 */

const textEncoder = new TextEncoder();

export interface PdfPageSpec {
    /** Text drawn at heading size (24pt) and body size (12pt). */
    heading?: string;
    body?: string[];
    /** Produces a page with no drawable text, for blank-page tests. */
    empty?: boolean;
    /**
     * Draw every line inside a single `BT`/`ET` block. pdf.js then reports
     * `hasEOL` per line, exercising a different code path from separate blocks.
     */
    singleTextBlock?: boolean;
    /**
     * Verbatim content-stream operators, bypassing the heading/body helpers.
     * Used to reproduce specific run layouts and malformed documents.
     */
    rawCommands?: string;
}

/**
 * Build a valid single/multi-page PDF with a correct cross-reference table.
 *
 * Only the subset of PDF syntax needed for text extraction is emitted.
 */
export function buildPdf(pages: PdfPageSpec[], info: Record<string, string> = {}): Uint8Array {
    const pageCount = pages.length;
    if (pageCount === 0) {
        return textEncoder.encode(buildCorruptPdfBody());
    }

    const escapePdfText = (value: string) =>
        value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

    const infoEntries = Object.entries(info);
    // Objects: catalog, page tree, then a page+content pair per page, then the
    // Type0 font, its descendant, its ToUnicode CMap and the info dictionary.
    const fontObjNumber = 3 + pageCount * 2;
    const objects: string[] = [];
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${Array.from(
        { length: pageCount },
        (_, index) => `${3 + index * 2} 0 R`,
    ).join(" ")}] /Count ${pageCount} >>`;

    /**
     * Characters needing a CMap entry: everything outside printable ASCII.
     * Each is assigned a synthetic CID so the ToUnicode table can reverse it.
     */
    const specialChars = new Map<string, number>();
    for (const page of pages) {
        for (const text of [page.heading ?? "", ...(page.body ?? [])]) {
            for (const char of text) {
                if (char >= "\x20" && char <= "\x7e") continue;
                if (!specialChars.has(char)) specialChars.set(char, specialChars.size + 1);
            }
        }
    }
    const useCMap = specialChars.size > 0;

    // The info dictionary follows the font objects, whose count depends on
    // whether a ToUnicode CMap was needed.
    const infoObjNumber = useCMap ? fontObjNumber + 3 : fontObjNumber + 1;

    /**
     * Encode text as a PDF hex string of 2-byte CIDs.
     *
     * Real PDFs encode non-ASCII text as Identity-H CIDs mapped back to Unicode
     * through a ToUnicode CMap; mirroring that here is the only way to exercise
     * the extractor's real decoding path.
     */
    const pdfString = (value: string): string => {
        if (!useCMap) return `(${escapePdfText(value)})`;
        const bytes: string[] = [];
        for (const char of value) {
            if (char >= "\x20" && char <= "\x7e") {
                bytes.push("00", char.charCodeAt(0).toString(16).padStart(2, "0"));
            } else {
                const cid = specialChars.get(char) ?? 0;
                bytes.push(cid.toString(16).padStart(4, "0"));
            }
        }
        return `<${bytes.join("")}>`;
    };

    pages.forEach((page, index) => {
        const pageObjNumber = 3 + index * 2;
        const contentObjNumber = pageObjNumber + 1;

        objects[pageObjNumber] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
            `/Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> ` +
            `/Contents ${contentObjNumber} 0 R >>`;

        if (page.rawCommands !== undefined) {
            objects[contentObjNumber] =
                `<< /Length ${page.rawCommands.length} >>\nstream\n${page.rawCommands}\nendstream`;
            return;
        }

        // One `BT`/`ET` per line by default; `singleTextBlock` wraps them all so
        // pdf.js emits `hasEOL` markers between lines.
        const lines: Array<{ text: string; size: number; y: number }> = [];
        if (!page.empty && page.heading) {
            lines.push({ text: page.heading, size: 24, y: 720 });
        }
        if (!page.empty && page.body) {
            page.body.forEach((text, lineIndex) => {
                lines.push({ text, size: 12, y: 680 - lineIndex * 20 });
            });
        }

        let commands: string;
        if (page.singleTextBlock) {
            // `Tm` places each run absolutely; `Td` is relative and would drift.
            commands =
                "BT\n" +
                lines
                    .map(
                        (line) =>
                            `/F1 ${line.size} Tf 1 0 0 1 72 ${line.y} Tm ${pdfString(line.text)} Tj`,
                    )
                    .join("\n") +
                "\nET";
        } else {
            commands = lines
                .map(
                    (line) =>
                        `BT /F1 ${line.size} Tf 72 ${line.y} Td ${pdfString(line.text)} Tj ET`,
                )
                .join("\n");
        }

        const stream = commands;
        objects[contentObjNumber] =
            `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });

    if (useCMap) {
        const descendantObjNumber = fontObjNumber + 1;
        const toUnicodeObjNumber = fontObjNumber + 2;
        const infoObjNumber = fontObjNumber + 3;

        objects[fontObjNumber] =
            `<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H ` +
            `/DescendantFonts [${descendantObjNumber} 0 R] ` +
            `/ToUnicode ${toUnicodeObjNumber} 0 R >>`;
        objects[descendantObjNumber] =
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom " +
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
            "/DW 500 >>";

        // `bfchar` maps one code to one destination; `bfrange` would need a
        // contiguous source range, which these sparse CIDs are not.
        const bfchars = Array.from(specialChars.entries())
            .map(([char, cid]) => {
                const target = Array.from(char)
                    .flatMap((unit) => {
                        // Surrogate pairs must stay intact as UTF-16 code units.
                        const code = unit.charCodeAt(0);
                        const high = Math.floor((code - 0xd800) / 0x400) + 0xd800;
                        if (code >= 0xd800 && code <= 0xdbff) {
                            return [
                                high.toString(16).padStart(4, "0"),
                                (code - 0xd800 + 0xdc00).toString(16).padStart(4, "0"),
                            ];
                        }
                        return [code.toString(16).padStart(4, "0")];
                    })
                    .join("");
                return `<${cid.toString(16).padStart(4, "0")}> <${target}>`;
            })
            .join("\n");
        const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom-UCS2 def
/CMapType 2 def
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${specialChars.size} beginbfchar
${bfchars}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
        objects[toUnicodeObjNumber] =
            `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`;

        if (infoEntries.length > 0) {
            objects[infoObjNumber] =
                `<< ${infoEntries
                    .map(([key, value]) => `/${key} (${escapePdfText(value)})`)
                    .join(" ")} >>`;
        }
    } else {
        objects[fontObjNumber] =
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
        if (infoEntries.length > 0) {
            objects[infoObjNumber] =
                `<< ${infoEntries
                    .map(([key, value]) => `/${key} (${escapePdfText(value)})`)
                    .join(" ")} >>`;
        }
    }

    let pdf = "%PDF-1.7\n";
    const offsets: number[] = [];
    for (let index = 1; index < objects.length; index += 1) {
        const body = objects[index];
        if (body === undefined) continue;
        offsets[index] = pdf.length;
        pdf += `${index} 0 obj\n${body}\nendobj\n`;
    }

    const size = objects.length;
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let index = 1; index < size; index += 1) {
        pdf +=
            offsets[index] !== undefined
                ? `${String(offsets[index]).padStart(10, "0")} 00000 n \n`
                : "0000000000 65535 f \n";
    }
    pdf +=
        `trailer\n<< /Size ${size} /Root 1 0 R` +
        `${infoEntries.length > 0 ? ` /Info ${infoObjNumber} 0 R` : ""} >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF`;

    return textEncoder.encode(pdf);
}

/** A byte sequence with a valid-looking PDF header but an unparseable body. */
function buildCorruptPdfBody(): string {
    return "%PDF-1.7\nthis is not a valid pdf body\n%%EOF";
}

/** Bytes with a PDF signature but no valid structure - used for corruption tests. */
export function buildCorruptPdf(): Uint8Array {
    return textEncoder.encode(buildCorruptPdfBody());
}

/** A valid ZIP that is not an OpenXML presentation (e.g. a renamed .docx/.zip). */
export async function buildPlainZip(): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("hello.txt", "not a presentation");
    const content = await zip.generateAsync({ type: "uint8array" });
    return content;
}

/**
 * Rewrite every central-directory "uncompressed size" field to `claimed`.
 *
 * A ZIP declares both its compressed and uncompressed size, and the extractor
 * must not treat either as trustworthy. This produces an archive whose
 * directory lies - the classic "declared 64 bytes, actually expands to
 * megabytes" bomb - while leaving the real compressed stream intact, so the
 * only way to catch it is to count bytes as they are produced.
 *
 * `partName` limits the lie to one entry, which keeps the rest of the package
 * internally consistent: JSZip verifies each entry's declared size once it
 * finishes decompressing, so falsifying every entry would merely surface as a
 * generic corruption error before the real budget was ever consulted.
 */
export function falsifyDeclaredUncompressedSizes(
    archive: Uint8Array,
    claimed: number,
    partName?: string,
): Uint8Array {
    const bytes = Uint8Array.from(archive);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Locate the End Of Central Directory record, which points at the directory.
    let eocd = -1;
    for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
        if (view.getUint32(offset, true) === 0x06054b50) {
            eocd = offset;
            break;
        }
    }
    if (eocd === -1) throw new Error("fixture: no end-of-central-directory record");

    const entryCount = view.getUint16(eocd + 10, true);
    let cursor = view.getUint32(eocd + 16, true);

    for (let index = 0; index < entryCount; index += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) {
            throw new Error("fixture: malformed central directory");
        }
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);

        const name = new TextDecoder().decode(
            bytes.subarray(cursor + 46, cursor + 46 + nameLength),
        );
        if (partName === undefined || name === partName) {
            // Uncompressed size is the 4-byte field at offset 24 of a central
            // directory record; compressed size (offset 20) stays truthful so
            // the stream itself still reads correctly.
            view.setUint32(cursor + 24, claimed, true);
        }

        cursor += 46 + nameLength + extraLength + commentLength;
    }

    return bytes;
}

/**
 * A structurally valid PPTX whose *slide* part expands far beyond the size its
 * central directory declares.
 *
 * The padding lives inside a slide (not an unused part) so extraction actually
 * decompresses it: the declared 64-byte size means the pre-filter passes and
 * only counting real decompressed bytes can reject the file. The payload is
 * NUL characters because they compress to almost nothing, so the archive on
 * disk stays small while the real expansion is enormous.
 */
export async function buildFalsifiedSizeBombPptx(
    inflateBytes: number,
    falsifyDeclaredSize = true,
): Promise<Uint8Array> {
    const padding = "\u0000".repeat(inflateBytes);
    const slideXml =
        '<?xml version="1.0"?><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><p:cSld><p:spTree>' +
        "<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>Real content</a:t></a:r></a:p>" +
        `<a:p><a:r><a:t>${padding}</a:t></a:r></a:p>` +
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>";

    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
    zip.file(
        "ppt/presentation.xml",
        `${XML_HEADER}
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
    );
    zip.file(
        "ppt/_rels/presentation.xml.rels",
        wrapRels([
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`,
        ]),
    );
    zip.file("ppt/slides/slide1.xml", slideXml);

    const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    if (!falsifyDeclaredSize) return archive;
    return falsifyDeclaredUncompressedSizes(archive, 64, "ppt/slides/slide1.xml");
}

/**
 * A valid PPTX made of many individually legal parts whose *total* expansion
 * exceeds the package budget.
 *
 * No single part breaches `MAX_PART_BYTES`, so this can only be caught by a
 * running total across the package.
 */
export async function buildManyPartOversizedPptx(): Promise<Uint8Array> {
    const slideCount = 40;
    const paddingPerSlide = 2 * 1024 * 1024;
    const padding = "\u0000".repeat(paddingPerSlide);

    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
    zip.file(
        "ppt/presentation.xml",
        `${XML_HEADER}
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst>${Array.from(
            { length: slideCount },
            (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
        ).join("")}</p:sldIdLst>
</p:presentation>`,
    );

    const relationships: string[] = [];
    for (let index = 0; index < slideCount; index += 1) {
        relationships.push(
            `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
        );
        zip.file(
            `ppt/slides/slide${index + 1}.xml`,
            '<?xml version="1.0"?><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><p:cSld><p:spTree>' +
                `<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>${padding}</a:t></a:r></a:p>` +
                "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>",
        );
    }
    zip.file("ppt/_rels/presentation.xml.rels", wrapRels(relationships));

    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A valid PPTX that declares an implausible number of internal entries. */
export async function buildEntryFloodPptx(entryCount: number): Promise<Uint8Array> {
    const archive = await buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
    });
    const zip = await JSZip.loadAsync(archive);
    for (let index = 0; index < entryCount; index += 1) {
        zip.file(`ppt/embeddings/pad${index}.bin`, "x");
    }
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * A PPTX whose slide part declares a DOCTYPE with nested entity definitions
 * (the billion-laughs shape) so entity expansion has to be bounded.
 *
 * NOTE: this is the *classic* shape only. Every definition contains a literal
 * `&`, which fast-xml-parser drops by design before expansion, so this fixture
 * expands to a handful of characters and does not by itself prove the caps hold.
 * `buildNumericRefFloodPptx`, `buildEntityCountPptx` and
 * `buildEntityExpansionPptx` are the fixtures that actually exercise the limits.
 */
export async function buildEntityBombPptx(): Promise<Uint8Array> {
    const entities = [
        '<!ENTITY lol "lol">',
        ...Array.from(
            { length: 9 },
            (_, level) =>
                `<!ENTITY lol${level + 1} "&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};&lol${level};">`,
        ),
    ].join(" ");

    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml:
            `<?xml version="1.0"?><!DOCTYPE p:sld [${entities}]>` +
            '<p:sld xmlns:p="urn:p"><p:cSld><p:spTree><p:sp/></p:spTree></p:cSld></p:sld>',
    });
}

/** Builds a slide part with a caller-supplied prologue and body markup. */
function bombSlideXml(prologue: string, body: string): string {
    return (
        `<?xml version="1.0"?>${prologue}` +
        `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>` +
        `<p:sp><p:txBody><a:p><a:r>${body}</a:r></a:p></p:txBody></p:sp>` +
        `</p:spTree></p:cSld></p:sld>`
    );
}

/**
 * Builds a slide part whose shape tree is wrapped in `depth` nested group shapes,
 * with the given body text at the centre.
 *
 * The nesting goes around the shape tree rather than inside a run: the
 * extractor walks `spTree > grpSp*`, so this is the nesting the depth guards
 * actually have to traverse, and the text stays reachable at every legal depth.
 */
function nestedShapeTreeXml(depth: number, text: string): string {
    let inner = `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
    for (let level = 0; level < depth; level += 1) {
        inner =
            `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${level + 9}" name="Group ${level}"/>` +
            `</p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;
    }

    return (
        `<?xml version="1.0"?>` +
        `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`
    );
}

/**
 * A PPTX whose slide body is a flood of numeric character references
 * (`&#65;`), the bypass vector for GHSA-8gc5-j5rx-235r.
 *
 * This is the vector that matters: every reference expands to one character, so
 * a five-byte input becomes one character of output *n* times over without any
 * named entity being involved. A named-entity fixture cannot exercise it.
 */
export async function buildNumericRefFloodPptx(
    referenceCount: number,
): Promise<Uint8Array> {
    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml: bombSlideXml("", `<a:t>${"&#65;".repeat(referenceCount)}</a:t>`),
    });
}

/**
 * A PPTX declaring far more named entities than the parser will accept.
 *
 * Targets `maxEntityCount`, which is a separate limit from expansion size: a
 * document can stay small in expanded bytes while declaring hundreds of
 * entities, so this asserts the declaration-count cap in isolation.
 */
export async function buildEntityCountPptx(entityCount: number): Promise<Uint8Array> {
    const entities = Array.from(
        { length: entityCount },
        (_, index) => `<!ENTITY e${index} "x">`,
    ).join(" ");

    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml: bombSlideXml(`<!DOCTYPE p:sld [${entities}]>`, "<a:t>hi</a:t>"),
    });
}

/**
 * A PPTX whose body repeats one large named entity far past what the expanded
 * length limit allows.
 *
 * Unlike the classic billion-laughs shape, the definitions here are plain
 * literals with no `&` in them, so the parser genuinely expands them. This is
 * the fixture that proves `maxExpandedLength` actually fires.
 */
export async function buildEntityExpansionPptx(
    repeatCount: number,
): Promise<Uint8Array> {
    const entities = `<!ENTITY big "${"A".repeat(9_000)}">`;

    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml: bombSlideXml(
            `<!DOCTYPE p:sld [${entities}]>`,
            `<a:t>${"&big;".repeat(repeatCount)}</a:t>`,
        ),
    });
}

/**
 * A PPTX whose slide nests `depth` group shapes deep.
 *
 * Exercises the nesting guards on the traversal path the extractor actually
 * takes (`spTree > grpSp*`), rather than nesting inside a run where no text
 * would be reachable.
 */
export async function buildDeepNestingPptx(depth: number): Promise<Uint8Array> {
    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml: nestedShapeTreeXml(depth, "Deeply nested body text."),
    });
}

/**
 * A PPTX whose slide body is a very wide, flat run of sibling text nodes.
 *
 * Width is not depth, so this is the shape the nesting guard cannot catch: it
 * is the node-count/visit budget in `findTable` that has to keep the traversal
 * linear rather than quadratic.
 */
export async function buildWideSiblingPptx(siblingCount: number): Promise<Uint8Array> {
    return buildPptx({
        slides: [{ title: "T", paragraphs: [p("Body")] }],
        malformedSlideXml: bombSlideXml(
            "",
            Array.from({ length: siblingCount }, () => "<a:t>y</a:t>").join(""),
        ),
    });
}

/**
 * A PPTX whose presentation relationship part lists far more relationships
 * than any real deck contains.
 */
export async function buildRelationshipFloodPptx(
    relationshipCount: number,
): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);

    zip.file(
        "ppt/presentation.xml",
        `${XML_HEADER}
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`,
    );

    const relationships = [
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`,
        ...Array.from(
            { length: relationshipCount },
            (_, index) =>
                `<Relationship Id="flood${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/flood${index}.xml"/>`,
        ),
    ];
    zip.file("ppt/_rels/presentation.xml.rels", wrapRels(relationships));
    zip.file("ppt/slides/slide1.xml", slideXml({ title: "T", paragraphs: [p("Body")] }));

    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * A valid single-page PDF whose extracted text exceeds the per-page budget.
 *
 * Density matters here: pdf.js yields text in short runs, so a page is filled
 * with many closely spaced lines rather than one enormous string. The
 * `singleTextBlock` path is used so every line is positioned absolutely and none
 * are merged or dropped.
 */
export function buildOversizedTextPdf(lineCount: number, charsPerLine: number): Uint8Array {
    const raw =
        "BT\n" +
        Array.from(
            { length: lineCount },
            (_, index) =>
                `/F1 12 Tf 1 0 0 1 72 ${700 - index * 0.5} Tm (${"x".repeat(charsPerLine)}) Tj`,
        ).join("\n") +
        "\nET";

    return buildPdf([{ rawCommands: raw }]);
}

/** A file that is neither a ZIP nor a PDF. */
export function buildGarbageBytes(): Uint8Array {
    return new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
}

export interface PptxSlideSpec {
    title?: string;
    /** Body paragraphs; `level` sets the outline indent (0-indexed). */
    paragraphs?: Array<{ text: string; level?: number }>;
    table?: string[][];
    notes?: string;
    /** Slide part file name, e.g. "slide7.xml". Defaults to positional order. */
    partName?: string;
    relationshipId?: string;
}

/** Shorthand for a plain top-level paragraph. */
export function p(text: string): { text: string; level?: number } {
    return { text };
}

/** Shorthand for an indented paragraph. */
export function sub(text: string, level: number): { text: string; level?: number } {
    return { text, level };
}

export interface BuildPptxOptions {
    slides?: PptxSlideSpec[];
    title?: string;
    /** Emit a package without `ppt/presentation.xml`. */
    omitPresentation?: boolean;
    /** Emit a package with an empty `p:sldIdLst`. */
    omitSlideList?: boolean;
    /** Write invalid markup into the first slide part. */
    malformedSlideXml?: string;
    /** Emit relationship targets as package-absolute (`/ppt/slides/...`). */
    absoluteRelationshipTargets?: boolean;
    /** Add a highly compressible filler part to exceed the size budget. */
    oversizedFillerBytes?: number;
    /** Namespace prefix used for DrawingML, to prove prefixes are not assumed. */
    drawingPrefix?: string;
    /** Emit the first slide's body text inside a group shape. */
    wrapBodyInGroup?: boolean;
    /** Emit `xml:space="preserve"` on the first run's text node. */
    preserveSpaceAttribute?: boolean;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CONTENT_TYPES_XML = `${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

function shapeXml(
    placeholderType: string | null,
    paragraphs: Array<{ text: string; level?: number }>,
    index: number,
    a = "a",
    options: { preserveSpace?: boolean } = {},
): string {
    const ph = placeholderType
        ? `<p:nvPr><p:ph type="${placeholderType}"/></p:nvPr>`
        : "<p:nvPr/>";

    const body = paragraphs
        .map((paragraph, paragraphIndex) => {
            const level = paragraph.level ?? 0;
            const pPr = level > 0 ? `<${a}:pPr lvl="${level}"/>` : "";
            // `xml:space` makes `a:t` parse to an object with `#text`, which is
            // how real producers preserve leading and trailing spaces.
            const space =
                options.preserveSpace && paragraphIndex === 0
                    ? ' xml:space="preserve"'
                    : "";
            return (
                `<${a}:p>${pPr}<${a}:r><${a}:t${space}>` +
                `${escapeXml(paragraph.text)}</${a}:t></${a}:r></${a}:p>`
            );
        })
        .join("");

    return (
        `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Placeholder ${index}"/>${ph}</p:nvSpPr>` +
        `<p:txBody><${a}:bodyPr/><${a}:lstStyle/>${body}</p:txBody></p:sp>`
    );
}

function tableXml(rows: string[][], a = "a"): string {
    const grid = rows.map((row) => {
        const cells = row
            .map(
                (value) =>
                    `<${a}:tc><${a}:txBody><${a}:bodyPr/><${a}:p><${a}:r><${a}:t>${escapeXml(value)}</${a}:t></${a}:r></${a}:p></${a}:txBody></${a}:tc>`,
            )
            .join("");
        return `<${a}:tr>${cells}</${a}:tr>`;
    }).join("");

    return (
        `<p:graphicFrame><${a}:graphic><${a}:graphicData>` +
        `<${a}:tbl><${a}:tblPr/><${a}:tblGrid/>${grid}</${a}:tbl>` +
        `</${a}:graphicData></${a}:graphic></p:graphicFrame>`
    );
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function notesXml(notes: string): string {
    return `${XML_HEADER}
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(notes)}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder"/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/><a:p><a:fld id="{00000000-0000-0000-0000-000000000001}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
}

function slideXml(slide: PptxSlideSpec, options: BuildPptxOptions = {}): string {
    const a = options.drawingPrefix ?? "a";
    const shapes: string[] = [];
    let index = 0;
    if (slide.title) shapes.push(shapeXml("title", [p(slide.title)], index++, a));
    if (slide.paragraphs) {
        const body = shapeXml("body", slide.paragraphs, index++, a, {
            preserveSpace: options.preserveSpaceAttribute,
        });
        shapes.push(options.wrapBodyInGroup ? wrapInGroup(body) : body);
    }
    if (slide.table) shapes.push(tableXml(slide.table, a));

    return `${XML_HEADER}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
${shapes.join("\n")}
</p:spTree></p:cSld></p:sld>`;
}

/** Nest a shape inside a `p:grpSp`, as grouped text boxes are authored. */
function wrapInGroup(shape: string): string {
    return (
        "<p:grpSp><p:nvGrpSpPr><p:cNvPr id=\"9\" name=\"Group 9\"/></p:nvGrpSpPr>" +
        `<p:grpSpPr/>${shape}</p:grpSp>`
    );
}

/** Build a structurally valid PPTX package for extraction tests. */
export async function buildPptx(options: BuildPptxOptions = {}): Promise<Uint8Array> {
    const slides = options.slides ?? [];
    const zip = new JSZip();

    zip.file("[Content_Types].xml", CONTENT_TYPES_XML);

    if (!options.omitPresentation) {
        zip.file(
            "ppt/presentation.xml",
            `${XML_HEADER}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
${options.omitSlideList ? "" : `<p:sldIdLst>${slides
                .map(
                    (slide, index) =>
                        `<p:sldId id="${256 + index}" r:id="${slide.relationshipId ?? `rId${index + 2}`}"/>`,
                )
                .join("")}</p:sldIdLst>`}
<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
</p:presentation>`,
        );
    }

    const presentationRels: string[] = [
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    ];
    for (let index = 0; index < slides.length; index += 1) {
        const slide = slides[index] as PptxSlideSpec;
        const partName = slide.partName ?? `slide${index + 1}.xml`;
        const relId = slide.relationshipId ?? `rId${index + 2}`;

        const malformed = index === 0 ? options.malformedSlideXml : undefined;
        zip.file(
            `ppt/slides/${partName}`,
            malformed ?? slideXml(slide, options),
        );

        const slideRels = [
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
        ];
        if (slide.notes) {
            const notesPartName = `notesSlide${index + 1}.xml`;
            zip.file(`ppt/notesSlides/${notesPartName}`, notesXml(slide.notes));
            slideRels.push(
                `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${notesPartName}"/>`,
            );
        }
        zip.file(`ppt/slides/_rels/${partName}.rels`, wrapRels(slideRels));

        // OPC permits a leading slash to mark a package-absolute target.
        const target = options.absoluteRelationshipTargets
            ? `/ppt/slides/${partName}`
            : `slides/${partName}`;
        presentationRels.push(
            `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target}"/>`,
        );
    }

    if (!options.omitPresentation) {
        zip.file("ppt/_rels/presentation.xml.rels", wrapRels(presentationRels));
    }

    if (options.oversizedFillerBytes) {
        // Highly compressible filler: a tiny archive that declares a huge part.
        zip.file("ppt/embeddings/filler.bin", "\u0000".repeat(options.oversizedFillerBytes));
    }

    if (options.title) {
        zip.file(
            "docProps/core.xml",
            `${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(options.title)}</dc:title>
</cp:coreProperties>`,
        );
    }

    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function wrapRels(relationships: string[]): string {
    return `${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.join("\n")}
</Relationships>`;
}
