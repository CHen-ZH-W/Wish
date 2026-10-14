import { memo, useMemo, type ReactNode } from "react";

type Alignment = "left" | "center" | "right" | undefined;
type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "code"; readonly language?: string; readonly text: string }
  | { readonly kind: "quote"; readonly blocks: readonly MarkdownBlock[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly MarkdownListItem[] }
  | { readonly kind: "table"; readonly alignments: readonly Alignment[]; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "rule" };
type MarkdownListItem = { readonly blocks: readonly MarkdownBlock[]; readonly checked?: boolean };

/** Safe, dependency-free Markdown for model output. Raw HTML is always rendered as text. */
export const MarkdownContent = memo(function MarkdownContent({ source }: { readonly source: string }) {
  const blocks = useMemo(() => parseBlocks(source.replace(/\r\n?/gu, "\n")), [source]);
  return <>{blocks.map((block, index) => renderBlock(block, `block-${index}`))}</>;
});

function renderBlock(block: MarkdownBlock, key: string): ReactNode {
  if (block.kind === "paragraph") return <p key={key}>{inlineMarkdown(block.text, key)}</p>;
  if (block.kind === "heading") {
    const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    return <Tag key={key}>{inlineMarkdown(block.text, key)}</Tag>;
  }
  if (block.kind === "code") return <div className="message-code-block" key={key}>{block.language ? <span>{block.language}</span> : null}<pre><code>{block.text}</code></pre></div>;
  if (block.kind === "quote") return <blockquote key={key}>{block.blocks.map((child, index) => renderBlock(child, `${key}-quote-${index}`))}</blockquote>;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    const start = block.ordered && block.start !== 1 ? { start: block.start } : {};
    return <List key={key} {...start}>{block.items.map((item, itemIndex) => <li key={`${key}-item-${itemIndex}`} className={item.checked === undefined ? undefined : "task-list-item"}>{item.checked === undefined ? null : <input type="checkbox" checked={item.checked} readOnly aria-label={item.checked ? "Completed" : "Not completed"} />}{item.blocks.map((child, blockIndex) => renderBlock(child, `${key}-item-${itemIndex}-${blockIndex}`))}</li>)}</List>;
  }
  if (block.kind === "table") return <div className="message-table-scroll" key={key} tabIndex={0}><table><thead><tr>{block.header.map((cell, index) => <th key={`${key}-head-${index}`} style={block.alignments[index] ? { textAlign: block.alignments[index] } : undefined}>{inlineMarkdown(cell, `${key}-head-${index}`)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={`${key}-row-${rowIndex}`}>{block.header.map((_, cellIndex) => <td key={`${key}-cell-${rowIndex}-${cellIndex}`} style={block.alignments[cellIndex] ? { textAlign: block.alignments[cellIndex] } : undefined}>{inlineMarkdown(row[cellIndex] ?? "", `${key}-cell-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>;
  return <hr key={key} />;
}

function parseBlocks(source: string): readonly MarkdownBlock[] {
  const lines = source.split("\n"), blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index++; continue; }

    const fence = /^ {0,3}(`{3,}|~{3,})(?:\s*([A-Za-z0-9_+#.-]+))?.*$/u.exec(line);
    if (fence) {
      const marker = fence[1]!, body: string[] = []; index++;
      while (index < lines.length && !isClosingFence(lines[index] ?? "", marker[0]!, marker.length)) body.push(lines[index++] ?? "");
      if (index < lines.length) index++;
      blocks.push({ kind: "code", ...(fence[2] ? { language: fence[2] } : {}), text: body.join("\n") });
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/u.exec(line);
    if (atx) { blocks.push({ kind: "heading", level: atx[1]!.length, text: atx[2]!.replace(/\s+#+\s*$/u, "").trim() }); index++; continue; }
    const setext = index + 1 < lines.length ? /^ {0,3}(=+|-+)\s*$/u.exec(lines[index + 1] ?? "") : null;
    if (setext) { blocks.push({ kind: "heading", level: setext[1]![0] === "=" ? 1 : 2, text: line.trim() }); index += 2; continue; }
    if (isThematicBreak(line)) { blocks.push({ kind: "rule" }); index++; continue; }

    if (/^ {0,3}>/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = /^ {0,3}> ?(.*)$/u.exec(lines[index] ?? "");
        if (!match) break;
        quoted.push(match[1] ?? ""); index++;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(quoted.join("\n")) }); continue;
    }

    const table = parseTable(lines, index);
    if (table) { blocks.push(table.block); index = table.next; continue; }

    const firstItem = listItem(lines[index] ?? "");
    if (firstItem) {
      const ordered = firstItem.ordered, indent = firstItem.indent, start = firstItem.start, items: MarkdownListItem[] = [];
      while (index < lines.length) {
        const item = listItem(lines[index] ?? "");
        if (!item || item.indent !== indent || item.ordered !== ordered) break;
        const itemLines = [item.text]; let afterBlank = false; index++;
        while (index < lines.length) {
          const current = lines[index] ?? "", nextItem = listItem(current);
          if (nextItem && nextItem.indent === indent && nextItem.ordered === ordered) break;
          if (!current.trim()) { itemLines.push(""); afterBlank = true; index++; continue; }
          const leading = current.match(/^ */u)?.[0].length ?? 0;
          if (leading > indent) { itemLines.push(current.slice(Math.min(current.length, indent + 2))); afterBlank = false; index++; continue; }
          if (!afterBlank && !startsBlock(lines, index)) { itemLines.push(current.trim()); index++; continue; }
          break;
        }
        let itemBlocks = parseBlocks(itemLines.join("\n"));
        const first = itemBlocks[0], task = first?.kind === "paragraph" ? /^\[([ xX])\]\s+(.*)$/su.exec(first.text) : null;
        if (task && first?.kind === "paragraph") itemBlocks = [{ ...first, text: task[2] ?? "" }, ...itemBlocks.slice(1)];
        items.push({ blocks: itemBlocks, ...(task ? { checked: task[1]!.toLowerCase() === "x" } : {}) });
      }
      blocks.push({ kind: "list", ordered, start, items }); continue;
    }

    if (/^ {4}/u.test(line)) {
      const code: string[] = [];
      while (index < lines.length && (/^ {4}/u.test(lines[index] ?? "") || !(lines[index] ?? "").trim())) code.push((lines[index++] ?? "").replace(/^ {4}/u, ""));
      blocks.push({ kind: "code", text: code.join("\n").replace(/\n+$/u, "") }); continue;
    }

    const paragraph = [line.trim()]; index++;
    while (index < lines.length && (lines[index] ?? "").trim() && !startsBlock(lines, index)) paragraph.push((lines[index++] ?? "").trim());
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }
  return blocks;
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^ {0,3}(?:#{1,6})(?:\s+|$)/u.test(line) || /^ {0,3}(?:`{3,}|~{3,})/u.test(line) || /^ {0,3}>/u.test(line) || !!listItem(line) || /^ {4}/u.test(line) || isThematicBreak(line) || !!parseTable(lines, index);
}
function isClosingFence(line: string, marker: string, minimum: number): boolean {
  const value = line.trim();
  return value.length >= minimum && [...value].every(character => character === marker);
}
function isThematicBreak(line: string): boolean {
  const value = line.trim();
  return /^(?:\*\s*){3,}$/u.test(value) || /^(?:-\s*){3,}$/u.test(value) || /^(?:_\s*){3,}$/u.test(value);
}

function listItem(line: string): { readonly indent: number; readonly ordered: boolean; readonly start: number; readonly text: string } | undefined {
  const match = /^( {0,3})([-+*]|(\d{1,9})[.)])\s+(.*)$/u.exec(line);
  if (!match) return;
  return { indent: match[1]!.length, ordered: match[3] !== undefined, start: match[3] === undefined ? 1 : Number(match[3]), text: match[4] ?? "" };
}

function parseTable(lines: readonly string[], index: number): { readonly block: MarkdownBlock; readonly next: number } | undefined {
  const headerLine = lines[index] ?? "", delimiterLine = lines[index + 1] ?? "";
  if (!headerLine.includes("|") || !delimiterLine.includes("|")) return;
  const header = splitTableRow(headerLine), delimiters = splitTableRow(delimiterLine);
  if (!header.length || header.length !== delimiters.length || delimiters.some(cell => !/^:?-{3,}:?$/u.test(cell.trim()))) return;
  const alignments = delimiters.map<Alignment>(cell => { const value = cell.trim(); return value.startsWith(":") && value.endsWith(":") ? "center" : value.endsWith(":") ? "right" : value.startsWith(":") ? "left" : undefined; });
  const rows: string[][] = []; let next = index + 2;
  while (next < lines.length && (lines[next] ?? "").trim() && (lines[next] ?? "").includes("|")) { rows.push(splitTableRow(lines[next] ?? "")); next++; }
  return { block: { kind: "table", header, alignments, rows }, next };
}
function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !isEscaped(value, value.length - 1)) value = value.slice(0, -1);
  const cells: string[] = []; let cell = "", codeTicks = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "`" && !isEscaped(value, index)) { codeTicks = codeTicks ? 0 : 1; cell += character; continue; }
    if (character === "|" && !codeTicks && !isEscaped(value, index)) { cells.push(cell.trim().replace(/\\\|/gu, "|")); cell = ""; continue; }
    cell += character;
  }
  cells.push(cell.trim().replace(/\\\|/gu, "|")); return cells;
}

function inlineMarkdown(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []; let text = "", index = 0, serial = 0;
  const flush = () => { if (text) { nodes.push(text); text = ""; } };
  const nodeKey = () => `${keyPrefix}-inline-${serial++}`;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "\\" && index + 1 < source.length && /[\\`*{}\[\]()#+.!_>|~-]/u.test(source[index + 1]!)) { text += source[index + 1]; index += 2; continue; }
    if (character === "\n") {
      const hard = /(?: {2}|\\)$/u.test(text);
      if (hard) { text = text.replace(/(?: {2}|\\)$/u, ""); flush(); nodes.push(<br key={nodeKey()} />); } else text += " ";
      index++; continue;
    }
    if (character === "`") {
      const size = delimiterRun(source, index, "`"), closing = findClosing(source, "`".repeat(size), index + size);
      if (closing >= 0) { flush(); let value = source.slice(index + size, closing).replace(/\n/gu, " "); if (/^\s.*\s$/su.test(value) && value.trim()) value = value.slice(1, -1); nodes.push(<code key={nodeKey()}>{value}</code>); index = closing + size; continue; }
    }
    if ((character === "!" && source[index + 1] === "[") || character === "[") {
      const image = character === "!", open = index + (image ? 1 : 0), labelEnd = findClosingBracket(source, open + 1);
      if (labelEnd < 0) { text += source.slice(index); break; }
      if (source[labelEnd + 1] === "(") {
        const targetEnd = findClosingParenthesis(source, labelEnd + 2);
        if (targetEnd >= 0) {
          const label = source.slice(open + 1, labelEnd), target = parseLinkTarget(source.slice(labelEnd + 2, targetEnd)); flush();
          if (image) { const src = safeImageSource(target); nodes.push(src ? <img key={nodeKey()} src={src} alt={plainInlineText(label)} loading="lazy" referrerPolicy="no-referrer" /> : <span key={nodeKey()} className="message-image-unavailable">{plainInlineText(label)}</span>); }
          else { const href = safeLinkHref(target); nodes.push(href ? <a key={nodeKey()} href={href} {...externalLinkProps(href)}>{inlineMarkdown(label, nodeKey())}</a> : <span key={nodeKey()}>{inlineMarkdown(label, nodeKey())}</span>); }
          index = targetEnd + 1; continue;
        }
      }
    }
    const strong = source.startsWith("**", index) ? "**" : source.startsWith("__", index) ? "__" : undefined;
    if (strong) {
      const closing = findClosing(source, strong, index + 2);
      if (closing > index + 2) { flush(); nodes.push(<strong key={nodeKey()}>{inlineMarkdown(source.slice(index + 2, closing), nodeKey())}</strong>); index = closing + 2; continue; }
    }
    if (source.startsWith("~~", index)) {
      const closing = findClosing(source, "~~", index + 2);
      if (closing > index + 2) { flush(); nodes.push(<del key={nodeKey()}>{inlineMarkdown(source.slice(index + 2, closing), nodeKey())}</del>); index = closing + 2; continue; }
    }
    if ((character === "*" || character === "_") && !(character === "_" && /[\p{L}\p{N}]/u.test(source[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[index + 1] ?? ""))) {
      const closing = findClosing(source, character, index + 1);
      if (closing > index + 1) { flush(); nodes.push(<em key={nodeKey()}>{inlineMarkdown(source.slice(index + 1, closing), nodeKey())}</em>); index = closing + 1; continue; }
    }
    if (character === "<") {
      const closing = source.indexOf(">", index + 1), value = closing < 0 ? "" : source.slice(index + 1, closing);
      const href = /^https?:\/\/\S+$/iu.test(value) ? value : /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value) ? `mailto:${value}` : undefined;
      if (href) { flush(); nodes.push(<a key={nodeKey()} href={href} {...externalLinkProps(href)}>{value}</a>); index = closing + 1; continue; }
    }
    if ((source.startsWith("http://", index) || source.startsWith("https://", index)) && (index === 0 || /[\s(]/u.test(source[index - 1]!))) {
      const match = /^https?:\/\/[^\s<>]+/iu.exec(source.slice(index));
      if (match) { const href = match[0].replace(/[.,!?;:)]+$/u, ""); flush(); nodes.push(<a key={nodeKey()} href={href} {...externalLinkProps(href)}>{href}</a>); index += href.length; continue; }
    }
    text += character; index++;
  }
  flush(); return nodes;
}

function delimiterRun(source: string, index: number, character: string): number { let size = 0; while (source[index + size] === character) size++; return size; }
function findClosing(source: string, delimiter: string, from: number): number { let index = source.indexOf(delimiter, from); while (index >= 0 && isEscaped(source, index)) index = source.indexOf(delimiter, index + delimiter.length); return index; }
function findClosingBracket(source: string, from: number): number {
  let depth = 0;
  for (let index = from; index < source.length; index++) { if (isEscaped(source, index)) continue; if (source[index] === "[") depth++; else if (source[index] === "]") { if (!depth) return index; depth--; } }
  return -1;
}
function findClosingParenthesis(source: string, from: number): number {
  let depth = 0, angle = false;
  for (let index = from; index < source.length; index++) { if (isEscaped(source, index)) continue; const character = source[index]; if (character === "<") angle = true; else if (character === ">") angle = false; else if (!angle && character === "(") depth++; else if (!angle && character === ")") { if (!depth) return index; depth--; } }
  return -1;
}
function isEscaped(source: string, index: number): boolean { let slashes = 0; while (index - slashes - 1 >= 0 && source[index - slashes - 1] === "\\") slashes++; return slashes % 2 === 1; }
function parseLinkTarget(source: string): string { const value = source.trim(); if (value.startsWith("<")) return value.slice(1, value.indexOf(">") < 0 ? undefined : value.indexOf(">")); return /^\S+/u.exec(value)?.[0] ?? ""; }
function safeLinkHref(value: string): string | undefined { const href = value.trim(); return /^(?:https?:\/\/|mailto:|#)/iu.test(href) ? href : undefined; }
function safeImageSource(value: string): string | undefined { const source = value.trim(); return /^https?:\/\//iu.test(source) ? source : undefined; }
function externalLinkProps(href: string): { readonly target?: "_blank"; readonly rel?: string } { return /^https?:\/\//iu.test(href) ? { target: "_blank", rel: "noreferrer noopener" } : {}; }
function plainInlineText(value: string): string { return value.replace(/[*_~`]/gu, "").trim(); }
