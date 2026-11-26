import type { Memory, MemoryDocument, MemoryState } from "./types.js";
import { content, document, hash } from "./validation.js";

export async function memoryFiles(memory: Pick<Memory, "state" | "files">, signal?: AbortSignal): Promise<readonly MemoryDocument[]> {
  signal?.throwIfAborted();
  const files = memory.files ? await memory.files(signal) : (await memory.state(signal)).documents;
  signal?.throwIfAborted();
  return files.filter(item => item.status === "accepted");
}

export async function modelMemoryFiles(memory: Memory, signal?: AbortSignal): Promise<readonly MemoryDocument[]> {
  const files = memory.modelFiles ? await memory.modelFiles(signal) : await memoryFiles(memory, signal);
  signal?.throwIfAborted(); return files;
}

/** Journal receipts remain auditable; direct user file edits are visible without a model roundtrip. */
export function workspaceDocuments(state: MemoryState, files: Readonly<Record<string, string>>): readonly MemoryDocument[] {
  const previous = new Map(state.documents.filter(item => item.path).map(item => [item.path!, item]));
  const reference = { kind: "operator" as const, id: "memory-workspace", revision: hash(files), digest: hash(files) };
  return Object.entries(files).map(([path, value]) => {
    const existing = previous.get(path);
    if (existing?.status === "accepted" && existing.content === value) return existing;
    const body = content({ path, title: path, content: value, appliesTo: existing?.appliesTo ?? "Verify the project and scope recorded in this memory file.",
      keywords: existing?.keywords ?? path.split(/[/.]/u), evidence: existing ? [...existing.evidence, reference] : [reference] });
    return document({ ...body, id: existing?.id ?? `file-${hash(path)}`, version: existing?.version ?? 1,
      status: "accepted", digest: hash(body), updatedAt: existing?.updatedAt ?? new Date(0).toISOString() });
  });
}
