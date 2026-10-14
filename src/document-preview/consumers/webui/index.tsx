import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {} from "../../../apps/webui/client/plugins.js";
import type { UiSessionSidebarViewProps } from "../../../apps/webui/client/slots.js";
import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { ErrorNotice, Icon, readableError } from "../../../apps/webui/client/ui/primitives.js";
import { useText } from "../../../apps/webui/client/i18n.js";
import { WorkspaceFilesClient } from "../../../workspace-files/consumers/webui/index.js";
import type { WorkspaceBinaryFileView, WorkspaceTextFileView } from "../../../workspace-files/types.js";
import { parseOffice, type OfficePreviewData } from "./office.js";

const IMAGE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
});
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "py", "rb", "go", "rs", "java", "c", "h", "cc", "cpp", "cs", "kt", "swift", "php", "sh", "bash", "zsh", "fish", "yaml", "yml", "toml", "ini", "conf", "cfg", "css", "scss", "less", "sql", "xml", "lua", "ps1", "r", "jl", "dart", "scala", "clj", "ex", "exs", "hs", "pl", "proto", "tf", "nix", "vue", "svelte", "mk", "cmake", "gradle", "diff", "patch", "log"]);
const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx"]);
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "ppt", "xls"]);

type Loaded =
  | { readonly kind: "text"; readonly value: WorkspaceTextFileView }
  | { readonly kind: "bytes"; readonly value: WorkspaceBinaryFileView };

function DocumentPreview({ client, sessionId, tab }: { readonly client: WorkspaceFilesClient } & UiSessionSidebarViewProps) {
  const t = useText();
  const path = typeof tab.params?.path === "string" ? tab.params.path : "";
  const extension = suffix(path);
  const binary = extension in IMAGE_TYPES || extension === "pdf" || OFFICE_EXTENSIONS.has(extension) || LEGACY_OFFICE_EXTENSIONS.has(extension);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(undefined); setError(undefined);
    const request = binary ? client.readBytes(sessionId, path).then(value => ({ kind: "bytes" as const, value })) : client.read(sessionId, path).then(value => ({ kind: "text" as const, value }));
    void request.then(value => { if (active) setLoaded(value); }, cause => { if (active) setError(readableError(cause instanceof Error ? cause.message : String(cause))); });
    return () => { active = false; };
  }, [binary, client, path, revision, sessionId]);
  return <section className="document-preview" data-document-kind={viewerKind(extension)}>
    <header className="document-preview-toolbar">
      <span className="document-preview-path" title={path}>{path}</span>
      <span className="document-preview-viewer">{viewerLabel(extension, t)}</span>
      <button aria-label={t("重新加载文件", "Reload file")} title={t("重新加载", "Reload")} onClick={() => setRevision(value => value + 1)}><RefreshIcon /></button>
    </header>
    <ErrorNotice text={error ?? null} />
    {!loaded && !error ? <div className="document-preview-loading" role="status">{t("正在读取文件…", "Loading file…")}</div> : null}
    {loaded ? <DocumentBody client={client} sessionId={sessionId} path={path} extension={extension} loaded={loaded} /> : null}
  </section>;
}

function DocumentBody({ client, sessionId, path, extension, loaded }: { readonly client: WorkspaceFilesClient; readonly sessionId: string; readonly path: string; readonly extension: string; readonly loaded: Loaded }): ReactNode {
  if (loaded.kind === "bytes") {
    if (OFFICE_EXTENSIONS.has(extension)) return <OfficePreview extension={extension} source={loaded.value.contentBase64} />;
    if (LEGACY_OFFICE_EXTENSIONS.has(extension)) return <UnsupportedOfficePreview extension={extension} />;
    const mediaType = IMAGE_TYPES[extension] ?? "application/pdf";
    return <BinaryPreview file={loaded.value} mediaType={mediaType} image={extension in IMAGE_TYPES} />;
  }
  const text = loaded.value.content;
  if (extension === "md" || extension === "markdown") return <MarkdownPreview client={client} sessionId={sessionId} path={path} source={text} />;
  if (extension === "html" || extension === "htm") return <iframe className="document-html" sandbox="" srcDoc={text} title={path} />;
  if (extension === "csv" || extension === "tsv") return <DelimitedPreview source={text} delimiter={extension === "tsv" ? "\t" : ","} />;
  if (CODE_EXTENSIONS.has(extension)) return <CodePreview source={text} />;
  return <pre className="document-plain">{text}</pre>;
}

function BinaryPreview({ file, mediaType, image }: { readonly file: WorkspaceBinaryFileView; readonly mediaType: string; readonly image: boolean }): ReactNode {
  const url = useMemo(() => URL.createObjectURL(new Blob([decodeBase64(file.contentBase64)], { type: mediaType })), [file.contentBase64, mediaType]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return image
    ? <div className="document-image-viewport"><img src={url} alt={file.path.split("/").at(-1) ?? file.path} draggable={false} /></div>
    : <object className="document-pdf" data={url} type={mediaType}><a href={url}>Open PDF</a></object>;
}

function OfficePreview({ extension, source }: { readonly extension: string; readonly source: string }): ReactNode {
  const t = useText();
  const result = useMemo<{ readonly value?: OfficePreviewData; readonly error?: string }>(() => {
    try { return { value: parseOffice(decodeBase64(source), extension) }; }
    catch (cause) { return { error: readableError(cause instanceof Error ? cause.message : String(cause)) }; }
  }, [extension, source]);
  if (result.error) return <div className="document-office-status"><Icon name="book" /><p>{t("无法解析这个文档。", "This document could not be parsed.")}</p><small>{result.error}</small></div>;
  const value = result.value;
  if (!value) return null;
  if (value.kind === "workbook") return <div className="document-table-wrap"><table><tbody>{value.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>{value.truncated ? <p className="document-office-note">{t("工作表较大，仅显示前 1000 行和 100 列。", "Large workbook: showing the first 1,000 rows and 100 columns.")}</p> : null}</div>;
  if (value.kind === "presentation") return <div className="document-presentation">{value.slides.map((slide, index) => <section key={index}><header><span>{index + 1}</span><strong>{slide.title}</strong></header>{slide.lines.slice(1).map((line, lineIndex) => <p key={lineIndex}>{line}</p>)}</section>)}</div>;
  return <article className="document-office-text">{value.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article>;
}

function UnsupportedOfficePreview({ extension }: { readonly extension: string }): ReactNode {
  const t = useText();
  return <div className="document-office-status"><Icon name="book" /><p>{t(`暂不支持旧版 .${extension} 二进制格式`, `Legacy .${extension} binary files are not supported`)}</p><small>{t("请另存为 DOCX、PPTX 或 XLSX 后重新打开。", "Save it as DOCX, PPTX, or XLSX and open it again.")}</small></div>;
}

function MarkdownPreview({ client, sessionId, path, source }: { readonly client: WorkspaceFilesClient; readonly sessionId: string; readonly path: string; readonly source: string }): ReactNode {
  const markdown = extractFrontmatter(source), blocks = markdownBlocks(markdown.body);
  return <article className="document-markdown">{markdown.frontmatter ? <pre className="document-markdown-frontmatter">{markdown.frontmatter}</pre> : null}{blocks.map((block, index) => {
    if (block.kind === "heading") { const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; return <Tag key={index}>{inlineMarkdown(block.text, client, sessionId, path)}</Tag>; }
    if (block.kind === "code") return <pre key={index}><code>{block.text}</code></pre>;
    if (block.kind === "quote") return <blockquote key={index}>{inlineMarkdown(block.text, client, sessionId, path)}</blockquote>;
    if (block.kind === "list") return block.ordered ? <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, client, sessionId, path)}</li>)}</ol> : <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, client, sessionId, path)}</li>)}</ul>;
    if (block.kind === "rule") return <hr key={index} />;
    return <p key={index}>{inlineMarkdown(block.text, client, sessionId, path)}</p>;
  })}</article>;
}

function MarkdownImage({ client, sessionId, documentPath, source, alt }: { readonly client: WorkspaceFilesClient; readonly sessionId: string; readonly documentPath: string; readonly source: string; readonly alt: string }): ReactNode {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (/^data:image\//iu.test(source) || source.startsWith("blob:")) { setUrl(source); return; }
    if (/^[a-z][a-z\d+.-]*:/iu.test(source) || source.startsWith("//")) return;
    let active = true, objectUrl: string | undefined;
    const base = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
    const resolved = normalizeRelativePath(base + (source.split(/[?#]/u, 1)[0] ?? ""));
    if (resolved === undefined) return;
    void client.readBytes(sessionId, resolved).then(file => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([decodeBase64(file.contentBase64)], { type: IMAGE_TYPES[suffix(resolved)] ?? "application/octet-stream" }));
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, documentPath, sessionId, source]);
  return url ? <img src={url} alt={alt} loading="lazy" /> : <span className="document-markdown-image-missing"><Icon name="model" />{alt}</span>;
}

function CodePreview({ source }: { readonly source: string }): ReactNode { return <div className="document-code">{source.split("\n").map((line, index) => <div key={index} className="document-code-line"><span>{index + 1}</span><code>{line || " "}</code></div>)}</div>; }
function DelimitedPreview({ source, delimiter }: { readonly source: string; readonly delimiter: string }): ReactNode { const rows = source.split(/\r?\n/u).filter(Boolean).slice(0, 1000).map(line => splitDelimited(line, delimiter)); return <div className="document-table-wrap"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>; }

type MarkdownBlock = { readonly kind: "heading"; readonly level: number; readonly text: string } | { readonly kind: "code" | "quote" | "paragraph"; readonly text: string } | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] } | { readonly kind: "rule" };
function markdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.split(/\r?\n/u), blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index++; continue; }
    if (/^```/u.test(line)) { const body: string[] = []; index++; while (index < lines.length && !/^```/u.test(lines[index] ?? "")) body.push(lines[index++] ?? ""); index++; blocks.push({ kind: "code", text: body.join("\n") }); continue; }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line); if (heading) { blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! }); index++; continue; }
    if (/^(?:---+|\*\*\*+)\s*$/u.test(line)) { blocks.push({ kind: "rule" }); index++; continue; }
    if (/^>\s?/u.test(line)) { const quoted: string[] = []; while (index < lines.length && /^>\s?/u.test(lines[index] ?? "")) quoted.push((lines[index++] ?? "").replace(/^>\s?/u, "")); blocks.push({ kind: "quote", text: quoted.join(" ") }); continue; }
    const list = /^(\s*)([-*+] |\d+\. )(.+)$/u.exec(line); if (list) { const ordered = /\d/u.test(list[2]!); const items: string[] = []; while (index < lines.length) { const match = /^(\s*)([-*+] |\d+\. )(.+)$/u.exec(lines[index] ?? ""); if (!match || /\d/u.test(match[2]!) !== ordered) break; items.push(match[3]!); index++; } blocks.push({ kind: "list", ordered, items }); continue; }
    const paragraph = [line.trim()]; index++; while (index < lines.length && lines[index]?.trim() && !/^(#{1,6})\s|^```|^>|^(\s*)([-*+] |\d+\. )/u.test(lines[index] ?? "")) paragraph.push(lines[index++]!.trim()); blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}
function inlineMarkdown(text: string, client: WorkspaceFilesClient, sessionId: string, path: string): ReactNode[] {
  const pattern = /(!?\[([^\]]*)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*)/gu, nodes: ReactNode[] = []; let start = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) { if (match.index > start) nodes.push(text.slice(start, match.index)); const key = `${match.index}:${match[0]}`; if (match[3] !== undefined && match[0].startsWith("!")) nodes.push(<MarkdownImage key={key} client={client} sessionId={sessionId} documentPath={path} source={match[3]} alt={match[2] ?? ""} />); else if (match[3] !== undefined) { const href = safeMarkdownHref(match[3]); nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{match[2]}</a> : <span key={key}>{match[2]}</span>); } else if (match[4]) nodes.push(<code key={key}>{match[4]}</code>); else if (match[5]) nodes.push(<strong key={key}>{match[5]}</strong>); else nodes.push(<em key={key}>{match[6]}</em>); start = pattern.lastIndex; }
  if (start < text.length) nodes.push(text.slice(start)); return nodes;
}
function splitDelimited(line: string, delimiter: string): string[] { const values: string[] = []; let value = "", quoted = false; for (let index = 0; index < line.length; index++) { const char = line[index]!; if (char === '"') { if (quoted && line[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; } else if (char === delimiter && !quoted) { values.push(value); value = ""; } else value += char; } values.push(value); return values; }
function normalizeRelativePath(path: string): string | undefined { const parts: string[] = []; for (const part of path.replaceAll("\\", "/").split("/")) { if (!part || part === ".") continue; if (part === "..") { if (!parts.length) return; parts.pop(); } else parts.push(part); } return parts.join("/"); }
function safeMarkdownHref(value: string): string | undefined { const href = value.trim(); return /^(?:https?:|mailto:)/iu.test(href) || (!/^[a-z][a-z\d+.-]*:/iu.test(href) && !href.startsWith("//")) ? href : undefined; }
function extractFrontmatter(source: string): { readonly frontmatter?: string; readonly body: string } { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source); return match ? { frontmatter: match[1] ?? "", body: source.slice(match[0].length) } : { body: source }; }
function suffix(path: string): string { const name = path.split("/").at(-1) ?? ""; return name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : ""; }
function viewerKind(extension: string): string { return extension in IMAGE_TYPES ? "image" : extension === "md" || extension === "markdown" ? "markdown" : extension === "pdf" ? "pdf" : OFFICE_EXTENSIONS.has(extension) || LEGACY_OFFICE_EXTENSIONS.has(extension) ? "office" : extension === "csv" || extension === "tsv" ? "table" : extension === "html" || extension === "htm" ? "html" : CODE_EXTENSIONS.has(extension) ? "code" : "text"; }
function viewerLabel(extension: string, t: ReturnType<typeof useText>): string { const kind = viewerKind(extension); return kind === "image" ? t("图片", "Image") : kind === "markdown" ? "Markdown" : kind === "pdf" ? "PDF" : kind === "office" ? extension.toUpperCase() : kind === "table" ? t("表格", "Table") : kind === "html" ? "HTML" : kind === "code" ? t("代码", "Code") : t("文本", "Text"); }
function decodeBase64(value: string): Uint8Array<ArrayBuffer> { const binary = atob(value), bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9m16 6-2 2.5A7 7 0 0 1 5.5 15" /></svg>; }

export const DocumentPreviewClientUi = {
  name: "ui-document-preview",
  inject: ["wishConnection", "wishUiSlots"],
  apply(ctx: Context): void {
    const client = new WorkspaceFilesClient(ctx.wishConnection as ClientConnection);
    ctx.effect(() => ctx.wishUiSlots.sessionSidebar({ id: "document-preview", kind: "document", label: "文档", labelEn: "Document", guide: false, accepts: resource => resource.kind === "file", icon: "book", View: props => <DocumentPreview client={client} {...props} /> }));
  },
};
