export interface MemoryCitationEntry { readonly path: string; readonly lineStart: number; readonly lineEnd: number; readonly note: string }
export interface MemoryCitation { readonly entries: readonly MemoryCitationEntry[]; readonly sourceIds: readonly string[] }

/** Codex citation structure, with legacy flat Wish source-path blocks still readable. */
export function parseMemoryCitations(text: string): MemoryCitation {
  const entries: MemoryCitationEntry[] = [], ids = new Set<string>();
  for (const block of text.matchAll(/<wish-memory-citation>([\s\S]*?)<\/wish-memory-citation>/gu)) {
    for (const section of block[1]!.matchAll(/<citation_entries>([\s\S]*?)<\/citation_entries>/gu)) {
      for (const line of section[1]!.split("\n")) {
        const match = /^\s*(.+):(\d+)-(\d+)\|note=\[(.*)\]\s*$/u.exec(line);
        if (!match) continue;
        const lineStart = Number(match[2]), lineEnd = Number(match[3]);
        if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) continue;
        entries.push({ path: match[1]!.trim(), lineStart, lineEnd, note: match[4]!.trim() });
      }
    }
    for (const section of block[1]!.matchAll(/<(rollout_ids|source_ids|thread_ids)>([\s\S]*?)<\/\1>/gu))
      for (const id of section[2]!.split(/\s+/u)) if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(id)) ids.add(id);
    for (const match of block[1]!.matchAll(/rollout_summaries\/(curation-[a-f0-9]{64})\.md/gu)) ids.add(match[1]!);
  }
  return { entries, sourceIds: [...ids] };
}
