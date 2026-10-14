import { unzipSync } from "fflate";

export type OfficePreviewData =
  | { readonly kind: "document"; readonly paragraphs: readonly string[] }
  | { readonly kind: "presentation"; readonly slides: readonly { readonly title: string; readonly lines: readonly string[] }[] }
  | { readonly kind: "workbook"; readonly rows: readonly (readonly string[])[]; readonly truncated: boolean };

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Bounded read-only preview for the XML-based Office formats. */
export function parseOffice(bytes: Uint8Array, extension: string): OfficePreviewData {
  let expandedBytes = 0;
  let entryCount = 0;
  const archive = unzipSync(bytes, {
    filter: file => {
      entryCount += 1;
      expandedBytes += file.originalSize;
      if (entryCount > 5_000 || expandedBytes > 64 * 1024 * 1024) {
        throw new Error("The Office archive is too large to preview safely");
      }
      return file.originalSize <= 16 * 1024 * 1024;
    },
  });
  if (extension === "docx") return parseDocument(archive);
  if (extension === "pptx") return parsePresentation(archive);
  if (extension === "xlsx") return parseWorkbook(archive);
  throw new Error(`Unsupported Office format: ${extension}`);
}

function parseDocument(archive: Readonly<Record<string, Uint8Array>>): OfficePreviewData {
  const document = xml(archive, "word/document.xml");
  const paragraphs = [...document.getElementsByTagNameNS("*", "p")]
    .map(paragraph => textNodes(paragraph, "t").join(""))
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 10_000);
  return Object.freeze({ kind: "document", paragraphs: Object.freeze(paragraphs) });
}

function parsePresentation(archive: Readonly<Record<string, Uint8Array>>): OfficePreviewData {
  const paths = Object.keys(archive).filter(path => /^ppt\/slides\/slide\d+\.xml$/u.test(path)).sort(naturalPathOrder);
  const slides = paths.slice(0, 500).map((path, index) => {
    const document = xml(archive, path);
    const lines = textNodes(document, "t").map(value => value.trim()).filter(Boolean);
    return Object.freeze({ title: lines[0] ?? `Slide ${index + 1}`, lines: Object.freeze(lines) });
  });
  return Object.freeze({ kind: "presentation", slides: Object.freeze(slides) });
}

function parseWorkbook(archive: Readonly<Record<string, Uint8Array>>): OfficePreviewData {
  const shared = archive["xl/sharedStrings.xml"] === undefined ? [] : [...xml(archive, "xl/sharedStrings.xml").getElementsByTagNameNS("*", "si")].map(item => textNodes(item, "t").join(""));
  const sheetPath = Object.keys(archive).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path)).sort(naturalPathOrder)[0];
  if (!sheetPath) throw new Error("The workbook has no readable worksheets");
  const document = xml(archive, sheetPath);
  const rows: string[][] = [];
  let truncated = false;
  for (const row of [...document.getElementsByTagNameNS("*", "row")]) {
    if (rows.length >= 1_000) { truncated = true; break; }
    const values: string[] = [];
    for (const cell of [...row.getElementsByTagNameNS("*", "c")]) {
      const column = cellColumn(cell.getAttribute("r") ?? "");
      if (column >= 100) { truncated = true; continue; }
      while (values.length < column) values.push("");
      const type = cell.getAttribute("t");
      const raw = firstText(cell, type === "inlineStr" ? "t" : "v");
      values[column] = type === "s" ? shared[Number(raw)] ?? "" : type === "b" ? raw === "1" ? "TRUE" : "FALSE" : raw;
    }
    rows.push(values);
  }
  return Object.freeze({ kind: "workbook", rows: Object.freeze(rows.map(row => Object.freeze(row))), truncated });
}

function xml(archive: Readonly<Record<string, Uint8Array>>, path: string): XMLDocument {
  const value = archive[path];
  if (!value) throw new Error(`The document is missing ${path}`);
  const document = new DOMParser().parseFromString(decoder.decode(value), "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The document contains invalid XML");
  return document;
}

function textNodes(root: Document | Element, localName: string): string[] {
  return [...root.getElementsByTagNameNS("*", localName)].map(node => node.textContent ?? "");
}
function firstText(root: Element, localName: string): string { return root.getElementsByTagNameNS("*", localName)[0]?.textContent ?? ""; }
function cellColumn(reference: string): number { const letters = /^[A-Z]+/u.exec(reference)?.[0] ?? "A"; let result = 0; for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64; return Math.max(0, result - 1); }
function naturalPathOrder(left: string, right: string): number { return left.localeCompare(right, undefined, { numeric: true }); }
