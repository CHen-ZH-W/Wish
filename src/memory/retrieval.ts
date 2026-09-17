import type { MemoryDocument, MemoryQuery } from "./types.js";

/** Deterministic lexical retrieval. Applicability is guidance, not authorization. */
export function retrieve(documents: readonly MemoryDocument[], input: MemoryQuery = {}): readonly MemoryDocument[] {
  input.signal?.throwIfAborted();
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 4000))) throw new TypeError("Invalid Memory query");
  const terms = [...new Set((input.text ?? "").toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean))].slice(0, 64);
  const ranked = documents.filter(item => item.status === "accepted").map(item => {
    const title = `${item.title} ${item.keywords.join(" ")}`.toLowerCase();
    const body = `${item.appliesTo} ${item.content}`.toLowerCase();
    return { item, score: terms.reduce((score, term) => score + (title.includes(term) ? 3 : body.includes(term) ? 1 : 0), 0) };
  }).filter(hit => !terms.length || hit.score > 0);
  ranked.sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  input.signal?.throwIfAborted();
  return Object.freeze(ranked.slice(0, limit).map(hit => hit.item));
}
