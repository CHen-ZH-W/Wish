import { rm } from "node:fs/promises";
import type { Model, ModelRef } from "../../core/model/model.js";
import type { MemoryEvidence } from "../types.js";
import { content, hash } from "../validation.js";
import type { ConsolidationInput, MemoryChanges, MemoryConsolidator } from "./types.js";
import { runMemoryAgent } from "./agent.js";
import { MemoryWorkspace, readMemoryFiles, workspaceDiff, type MemoryFiles } from "./workspace.js";

export class WorkspaceMemoryConsolidator implements MemoryConsolidator {
  constructor(readonly workspace: MemoryWorkspace,
    private readonly open: (signal: AbortSignal) => Promise<{ model: Model; ref: ModelRef }>) {}
  inputFingerprint() { return this.workspace.inputFingerprint(); }
  publish(files: MemoryFiles, signal: AbortSignal, before?: MemoryFiles) { return this.workspace.publish(files, signal, before); }
  async consolidate(input: ConsolidationInput, signal: AbortSignal): Promise<MemoryChanges> {
    const before = await this.workspace.baseline(), files = await this.workspace.files(), workspaceBefore = { ...files };
    // Restore a lost mirror from the committed library; user deletions remain changes when a baseline exists.
    if (!Object.keys(before).length) for (const item of input.documents.filter(item => item.status === "accepted")) {
      const path = item.path ?? `legacy/${item.id}.md`;
      files[path] ??= item.path ? item.content : `# ${item.title}\n\nScope: ${item.appliesTo}\n\n${item.content}\n`;
    }
    for (const path of Object.keys(files)) if (path.startsWith("rollout_summaries/")) delete files[path];
    const raw: string[] = ["# Raw memories\n"];
    for (const job of [...(input.jobs ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
      if (job.evidence.sourceId === "memory-notes") {
        const path = `extensions/ad_hoc/notes/${job.id}.md`;
        if (job.status !== "completed" && !Object.hasOwn(files, path) && !Object.hasOwn(before, path)) files[path] = job.evidence.text;
        if (Object.hasOwn(files, path)) raw.push(`## Explicit memory note\nrecorded_at: ${job.evidence.occurredAt ?? job.createdAt}\nnote_file: ${path}\n\n${files[path]}`);
        continue;
      }
      const header = `source_id: ${job.id}\nupdated_at: ${job.evidence.occurredAt ?? job.updatedAt}\nsession_id: ${job.evidence.sessionId ?? "unknown"}\nrun_id: ${job.evidence.runId ?? "unknown"}\napplies_to: ${job.evidence.appliesTo}\n`;
      const memories = job.rawMemories ?? [];
      files[`rollout_summaries/${job.id}.md`] = header + "\n" + memories.map(item => item.rolloutSummary ?? item.content).join("\n\n");
      raw.push(`## ${job.id}\n${header}rollout_summary_file: rollout_summaries/${job.id}.md\n\n` + memories.map(item => item.content).join("\n\n"));
    }
    files["raw_memories.md"] = raw.length > 1 ? raw.join("\n\n") : "# Raw memories\n\nNo raw memories currently selected.\n";
    files["phase2_workspace_diff.md"] = workspaceDiff(before, files);
    const directory = await this.workspace.scratch(files);
    try {
      const { model, ref } = await this.open(signal);
      await runMemoryAgent(model, ref, directory, signal);
      signal.throwIfAborted();
      const result = await readMemoryFiles(directory);
      delete result["phase2_workspace_diff.md"];
      if (result["MEMORY.md"] === undefined || result["memory_summary.md"]?.split(/\r?\n/u)[0] !== "v1") throw new Error("Memory agent must leave MEMORY.md and a v1 memory_summary.md");
      const references = [...new Map([...input.rawMemories, ...input.documents].flatMap(item => item.evidence).map(item => [hash(item), item])).values()];
      const versions = new Map(input.documents.map(item => [item.id, item]));
      const upserts = Object.entries(result).flatMap(([path, value]) => {
        const id = `file-${hash(path)}`, previous = versions.get(id);
        if (previous?.status === "accepted" && previous.content === value) return [];
        const sources: MemoryEvidence[] = (input.jobs ?? []).filter(job => value.includes(job.id) || path.includes(job.id)).flatMap(job => job.evidence.references);
        const evidence = [...new Map((sources.length ? sources : references).map(item => [hash(item), item])).values()];
        return [{ ...content({ path, title: path, content: value, appliesTo: "Shared memory workspace; verify each entry's project scope and current evidence.", keywords: path.split(/[/.]/u), evidence }), id, expectedVersion: previous?.version ?? 0 }];
      });
      const retirements = input.documents.filter(item => item.status === "accepted" && (!item.path || !Object.hasOwn(result, item.path)))
        .map(item => ({ id: item.id, expectedVersion: item.version }));
      return { upserts, retirements, files: result, workspaceBefore };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
