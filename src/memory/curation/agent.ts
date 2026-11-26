import { readFile, rm } from "node:fs/promises";
import { AgentLoop } from "../../core/agent-loop/agent-loop.js";
import { ContextProjector } from "../../core/context/projector.js";
import { Runtime } from "../../core/runtime/runtime.js";
import { BoundedToolScheduler, ToolExecutor, ToolRegistry } from "../../core/tools/scheduler.js";
import { assertActiveToolAuthorizationGrant } from "../../core/tools/authorization.js";
import type { Model, ModelRef } from "../../core/model/model.js";
import { memoryPath } from "../validation.js";
import { CONSOLIDATION_PROMPT } from "./prompts.js";
import { readMemoryFiles, scopedPath, writeMemoryFile } from "./workspace.js";

/** An ephemeral Core AgentLoop, with no user transcript, recursive learning or step budget. */
export async function runMemoryAgent(model: Model, ref: ModelRef, directory: string, signal: AbortSignal): Promise<void> {
  const tools = new ToolRegistry();
  const definitions = {
    memory_files: { description: "List all files in this memory workspace.", properties: {} },
    memory_read_file: { description: "Read a memory file. Optional line offset and limit support progressive reading without truncating the stored file.", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } } },
    memory_search_files: { description: "Search workspace text for a literal string, returning paths and matching lines.", properties: { query: { type: "string" } } },
    memory_write_file: { description: "Create or replace a complete UTF-8 file in this memory workspace, including Skills and their resources.", properties: { path: { type: "string" }, content: { type: "string" } } },
    memory_edit_file: { description: "Replace an exact, unique text occurrence in a memory file.", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } },
    memory_delete_file: { description: "Remove an obsolete file or Skill directory from this memory workspace.", properties: { path: { type: "string" } } },
  };
  for (const [name, definition] of Object.entries(definitions)) tools.register({
    name, description: definition.description, inputSchemaJson: JSON.stringify({ type: "object", additionalProperties: false,
      properties: definition.properties, required: Object.keys(definition.properties).filter(key => !["offset", "limit"].includes(key)) }),
    executionMode: "sequential", recoveryPolicy: "retry-safe",
    parse(input) {
      try {
        if (Object.keys(input).some(key => !Object.hasOwn(definition.properties, key))) throw new Error("Unknown workspace Tool argument");
        if ("path" in definition.properties) memoryPath(input.path);
        for (const key of ["content", "query", "oldText", "newText"]) if (key in definition.properties && typeof input[key] !== "string") throw new Error(`Missing ${key}`);
        if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error("Invalid line offset");
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1)) throw new Error("Invalid line limit");
        return { ok: true as const, input };
      } catch (error) { return { ok: false as const, message: String(error) }; }
    },
    resolveCapabilities: () => ({ requirements: [] }),
    async execute(input, _context, grant, toolSignal) {
      assertActiveToolAuthorizationGrant(grant, { toolName: name, authorityVersion: "memory-workspace" });
      toolSignal?.throwIfAborted(); signal.throwIfAborted();
      if (name === "memory_files") return Object.keys(await readMemoryFiles(directory));
      if (name === "memory_search_files") return Object.entries(await readMemoryFiles(directory)).flatMap(([path, value]) =>
        value.split("\n").flatMap((line, index) => line.includes(input.query as string) ? [{ path, line: index + 1, text: line }] : []));
      const path = input.path as string, target = await scopedPath(directory, path);
      if (name === "memory_write_file") await writeMemoryFile(directory, path, input.content as string);
      else if (name === "memory_delete_file") await rm(target, { recursive: true, force: true });
      else {
        const value = await readFile(target, "utf8");
        if (name === "memory_read_file") {
          const lines = value.split("\n"), start = input.offset as number | undefined ?? 0;
          if (start > lines.length) throw new Error("Line offset exceeds file");
          const end = input.limit === undefined ? lines.length : Math.min(lines.length, start + Number(input.limit));
          return { path, content: lines.slice(start, end).join("\n"), nextOffset: end < lines.length ? end : null };
        }
        const old = input.oldText as string;
        if (!old || value.split(old).length !== 2) throw new Error("Edit requires one exact occurrence");
        await writeMemoryFile(directory, path, value.replace(old, () => input.newText as string));
      }
      return { path, status: "saved" };
    },
  });
  const executor = new ToolExecutor({ registry: tools, authorization: {
    authorize: () => ({ status: "allowed", policyVersion: "memory-workspace" }),
    revalidate: () => ({ status: "valid", policyVersion: "memory-workspace" }),
  } });
  const checked: Model = { async *stream(request, requestSignal) {
    let ended = false;
    for await (const event of model.stream(request, requestSignal)) {
      if (ended) throw new Error("Memory model emitted after terminal event");
      if (event.type === "done") {
        if (event.finishReason && !["stop", "completed", "end_turn", "tool_calls", "tool_use"].includes(event.finishReason)) throw new Error("Memory consolidation response was incomplete");
        ended = true;
      }
      yield event;
    }
    if (!ended) throw new Error("Memory consolidation stream was incomplete");
  } };
  const loop = new AgentLoop<unknown, string>({ model: checked, tools, context: new ContextProjector(),
    toolScheduler: new BoundedToolScheduler({ executor, maxParallelCalls: 1 }),
    input: { renderUserInput: input => ({ role: "user", content: input.payload }), renderSteering: input => ({ role: "user", content: input.message.text }) },
    environment: { resolve: () => ({ model: ref, instructions: [{ role: "system", content: CONSOLIDATION_PROMPT }],
      context: { providers: [], input: {} }, tools: { context: {}, authorityVersion: "memory-workspace" },
      request: { metadata: { purpose: "memory-consolidation" } } }) },
  });
  const runtime = new Runtime({ stepPipeline: loop });
  signal.throwIfAborted();
  const handle = runtime.startRun({ id: "memory-consolidator" }, { scope: directory, inputSource: "continuation", payload: "Read phase2_workspace_diff.md and consolidate the memory workspace. Save the resulting files, including any useful Skill updates." });
  const abort = () => runtime.control("memory-consolidator", handle.runId, { type: "abort", reason: "Memory consolidation cancelled" });
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const completion = await handle.completion;
    signal.throwIfAborted();
    if (completion.status !== "completed") throw new Error(`Memory consolidation agent ${completion.status}: ${completion.status === "failed" ? completion.error.message : completion.cancellation.reason}`);
  } finally { signal.removeEventListener("abort", abort); }
}
