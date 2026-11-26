import type { MemoryDocument, MemoryQuery } from "./types.js";

/** Compatibility document query: stable substring filtering without invented relevance weights. */
export function retrieve(documents: readonly MemoryDocument[], input: MemoryQuery = {}): readonly MemoryDocument[] {
  input.signal?.throwIfAborted();
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new TypeError("Invalid Memory query limit");
  if (input.text !== undefined && typeof input.text !== "string") throw new TypeError("Invalid Memory query");
  const query = input.text?.toLowerCase();
  const matches = documents.filter(item => item.status === "accepted" && (!query ||
    `${item.path ?? ""}\n${item.title}\n${item.keywords.join(" ")}\n${item.appliesTo}\n${item.content}`.toLowerCase().includes(query)))
    .sort((a, b) => (a.path ?? a.id).localeCompare(b.path ?? b.id));
  return Object.freeze(input.limit === undefined ? matches : matches.slice(0, input.limit));
}

export interface MemorySearchInput {
  readonly queries: readonly string[];
  readonly path?: string;
  readonly matchMode?: "any" | "all_on_same_line" | { readonly type: "all_within_lines"; readonly lineCount: number };
  readonly caseSensitive?: boolean;
  readonly normalized?: boolean;
  readonly contextLines?: number;
  readonly offset?: number;
  readonly limit?: number;
}
export interface MemorySearchMatch {
  readonly path: string;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly title: string;
  readonly appliesTo: string;
  readonly matchLineNumber: number;
  readonly contentStartLineNumber: number;
  readonly content: string;
  readonly matchedQueries: readonly string[];
}

/** Codex local search semantics: line-level substring matching and explicit nearby context. */
export function searchMemoryFiles(documents: readonly MemoryDocument[], input: MemorySearchInput) {
  if (!input.queries.length || input.queries.some(query => typeof query !== "string" || !query.trim())) throw new TypeError("Memory search requires non-empty queries");
  const context = input.contextLines ?? 0, offset = input.offset ?? 0;
  for (const count of [context, offset]) if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Invalid Memory search offset or context");
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new TypeError("Invalid Memory search limit");
  const mode = input.matchMode ?? "any";
  if (typeof mode === "object" && (!Number.isSafeInteger(mode.lineCount) || mode.lineCount < 1)) throw new TypeError("Invalid Memory search line window");
  const prepare = (text: string) => {
    const value = input.caseSensitive === false ? text.toLowerCase() : text;
    return input.normalized ? value.replace(/[^\p{L}\p{N}]/gu, "") : value;
  };
  const queries = input.queries.map(query => prepare(query.trim()));
  if (queries.some(query => !query)) throw new TypeError("Memory search query is empty after normalization");
  const matches: MemorySearchMatch[] = [];
  for (const item of documents.filter(item => item.status === "accepted" && (!input.path || item.path === input.path || item.path?.startsWith(`${input.path.replace(/\/$/u, "")}/`)))
    .sort((a, b) => (a.path ?? a.id).localeCompare(b.path ?? b.id))) {
    const lines = item.content.split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    const flags = lines.map(line => queries.map(query => prepare(line).includes(query)));
    const windows: { start: number; end: number; found: boolean[] }[] = [];
    for (let start = 0; start < lines.length; start++) {
      if (!flags[start]!.some(Boolean)) continue;
      const found = [...flags[start]!];
      if (mode === "any" || (mode === "all_on_same_line" && found.every(Boolean))) windows.push({ start, end: start, found });
      else if (typeof mode === "object") {
        for (let end = start; end < Math.min(lines.length, start + mode.lineCount); end++) {
          flags[end]!.forEach((match, index) => { found[index] ||= match; });
          if (found.every(Boolean)) { windows.push({ start, end, found }); break; }
        }
      }
    }
    for (const window of windows) {
      if (typeof mode === "object" && windows.some(other => other !== window && other.start >= window.start && other.end <= window.end && (other.start !== window.start || other.end !== window.end))) continue;
      const first = Math.max(0, window.start - context), last = Math.min(lines.length, window.end + context + 1);
      matches.push({ path: item.path ?? item.id, id: item.id, version: item.version, digest: item.digest, title: item.title, appliesTo: item.appliesTo,
        matchLineNumber: window.start + 1, contentStartLineNumber: first + 1, content: lines.slice(first, last).join("\n"),
        matchedQueries: input.queries.filter((_query, index) => window.found[index]) });
    }
  }
  if (offset > matches.length) throw new TypeError("Memory search offset exceeds result count");
  const end = input.limit === undefined ? matches.length : Math.min(matches.length, offset + input.limit);
  return { matches: matches.slice(offset, end), nextOffset: end < matches.length ? end : null, totalMatches: matches.length, truncated: end < matches.length };
}
