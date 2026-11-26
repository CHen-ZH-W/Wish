import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { SpawnSubagentRequest } from "../../subagents/types.js";
import type { SubagentResource } from "../../subagents/resources.js";
import { MEMORY_LIBRARY_RESOURCE } from "../child-resources.js";
import type { Memory } from "../types.js";
import { modelMemoryFiles } from "../files.js";

/** Delegate read-only access to the current library, without copying its contents. */
export class SubagentMemoryResources {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  constructor(private readonly options: { readonly memory: Memory }) {}
  prepare(request: SpawnSubagentRequest): Promise<readonly SubagentResource[]> {
    if (this.closed) return Promise.reject(new Error("Memory child resource provider is closed"));
    const signal = request.signal ? AbortSignal.any([request.signal, this.abort.signal]) : this.abort.signal;
    const run = (async () => {
      signal.throwIfAborted();
      if (!request.allowedCapabilities?.includes("runtime.read")) return Object.freeze([]);
      const location = this.options.memory.sharedLibrary;
      if (!location) return Object.freeze([]);
      const files = await modelMemoryFiles(this.options.memory, signal);
      signal.throwIfAborted();
      const allowedSkills = [...new Set(files.flatMap(file => file.path?.startsWith("skills/") ? [file.path.split("/")[1]!] : []))];
      return Object.freeze([{ type: MEMORY_LIBRARY_RESOURCE, schemaVersion: 1, payload: { ...location, allowedSkills } }]);
    })();
    this.work.add(run);
    void run.finally(() => this.work.delete(run)).catch(() => {});
    return run;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort("Memory child resource provider closed");
    await Promise.allSettled([...this.work]);
  }
}

export default {
  name: "memory-subagent-resources",
  inject: ["memory", "subagentLauncher"],
  apply(ctx: Context): void {
    if (!ctx.memory.sharedLibrary) return;
    const resources = new SubagentMemoryResources({ memory: ctx.memory });
    const work = new PluginWorkOwner(ctx, { code: "memory_subagent_resources", codeReload: true, close: () => resources.close() });
    ctx.subagentLauncher.registerResourceProvider({ id: "memory", runtimeFeatures: ["memory.read"],
      prepare: request => work.run(() => resources.prepare(request)) });
  },
};
