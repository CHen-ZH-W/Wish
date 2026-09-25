import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { FileSubagentExchange } from "../../subagents/files.js";
import type { Subagents, SubagentLaunchIdentity, SpawnSubagentRequest, SubagentRecord, SubagentOwner } from "../../subagents/types.js";
import type { SubagentResource } from "../../subagents/resources.js";
import type { SessionHistorySnapshot } from "../../sessions/types.js";
import { SessionNotFoundError } from "../../sessions/types.js";
import { childMemoryInput, childMemoryState, MEMORY_CANDIDATES_RESOURCE, MEMORY_SNAPSHOT_RESOURCE } from "../child-resources.js";
import type { Memory, MemoryEvidence } from "../types.js";
import { content, hash } from "../validation.js";

export interface ChildMemoryEvidenceReader {
  read(record: SubagentRecord, signal?: AbortSignal): Promise<SessionHistorySnapshot>;
}

export interface SubagentMemoryResourcesOptions {
  readonly memory: Memory;
  readonly exchange: FileSubagentExchange;
  readonly subagents: Pick<Subagents, "inspect">;
  readonly evidence: ChildMemoryEvidenceReader;
  readonly snapshotLimit?: number;
}

/** Parent-only writer; a child's output is always a proposal, never publication. */
export class SubagentMemoryResources {
  private closed = false;
  private readonly abort = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly snapshotLimit: number;
  constructor(private readonly options: SubagentMemoryResourcesOptions) {
    this.snapshotLimit = options.snapshotLimit ?? 10;
    if (!Number.isSafeInteger(this.snapshotLimit) || this.snapshotLimit < 1 || this.snapshotLimit > 20) throw new Error("Invalid child Memory snapshot limit");
  }
  prepare(request: SpawnSubagentRequest, _identity: SubagentLaunchIdentity): Promise<readonly SubagentResource[]> {
    return this.track(async signal => {
      if (!request.allowedCapabilities?.includes("runtime.read")) return Object.freeze([]);
      const snapshot = await this.options.memory.snapshot({ text: request.task.slice(0, 4000), limit: this.snapshotLimit, signal });
      signal.throwIfAborted();
      const allowProposals = request.allowedCapabilities.includes("runtime.control") && request.availableTools?.includes("memory_write") === true;
      return Object.freeze([{ type: MEMORY_SNAPSHOT_RESOURCE, schemaVersion: 1, payload: { snapshot, allowProposals } }]);
    }, request.signal);
  }
  consume(record: SubagentRecord): Promise<void> {
    return this.track(async signal => {
      const run = this.tail.then(() => this.consumeRecord(record, signal));
      this.tail = run.then(() => undefined, () => undefined);
      await run;
    });
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.abort.abort("Memory child resource consumer closed"); }
    await Promise.allSettled([...this.work]);
  }
  private async consumeRecord(observed: SubagentRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (observed.status !== "exited" || observed.result?.status !== "completed") return;
    const record = await this.options.subagents.inspect({ ...ownerOf(observed), id: observed.id, signal });
    if (!record || record.status !== "exited" || record.result?.status !== "completed") return;
    if (record.result.id !== record.id || record.result.childSessionId !== record.childSessionId || record.result.childRunId !== record.childRunId) throw new Error("Child Memory result identity mismatch");
    const manifest = await this.options.exchange.readInputResources({ id: record.id, childSessionId: record.childSessionId, childRunId: record.childRunId }, signal);
    if (!manifest || !manifest.resources.some(item => item.type === MEMORY_SNAPSHOT_RESOURCE)) return;
    if (record.resourceManifestDigest !== manifest.digest) throw new Error("Child Memory manifest differs from the Host-committed snapshot");
    if (JSON.stringify(manifest.owner) !== JSON.stringify(ownerOf(record))) throw new Error("Child Memory owner scope mismatch");
    const input = childMemoryInput(manifest);
    if (input.snapshot.libraryId !== this.options.memory.libraryId) throw new Error("Child Memory snapshot belongs to another library");
    const output = await this.options.exchange.readOutputResource(manifest, MEMORY_CANDIDATES_RESOURCE, signal);
    if (!output) return;
    if (output.schemaVersion !== 1) throw new Error("Invalid child Memory output version");
    const state = childMemoryState(output.payload, input, manifest);
    if (!state.candidates.length) return;
    const history = await this.options.evidence.read(record, signal);
    if (history.sessionId !== record.childSessionId) throw new Error("Child Memory evidence Session mismatch");
    for (const candidate of state.candidates) {
      signal.throwIfAborted();
      for (const evidence of candidate.evidence) verifyEvidence(evidence, record, history);
      const receipt = state.audit.find(item => item.targetId === candidate.id)!;
      const operationId = `child:${hash({ childId: record.id, childRunId: record.childRunId, operationId: receipt.operationId })}`;
      const replay = (await this.options.memory.state(signal)).audit.some(item => item.operationId === operationId);
      // Existing targets must have been visible in the immutable Host snapshot.
      if (!replay && !input.snapshot.documents.some(item => item.id === candidate.targetId) && await this.options.memory.read(candidate.targetId, signal)) throw new Error("Child Memory candidate addresses a document outside its snapshot");
      await this.options.memory.propose({ ...content(candidate), targetId: candidate.targetId, expectedDocumentVersion: candidate.expectedDocumentVersion,
        operationId,
        reviewSessionId: record.parentSessionId,
        actor: { kind: "child", id: record.id, sessionId: record.childSessionId, runId: record.childRunId },
        reason: `Child proposal from ${record.id}: ${candidate.reason}`.slice(0, 2000), signal });
    }
  }
  private track<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Memory child resource consumer is closed"));
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const work = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined); });
    this.work.add(work);
    void work.finally(() => this.work.delete(work)).catch(() => undefined);
    return work;
  }
}

function verifyEvidence(evidence: MemoryEvidence, record: SubagentRecord, history: SessionHistorySnapshot): void {
  if (evidence.kind !== "session" || evidence.id !== `${record.childSessionId}:${record.childRunId}`) throw new Error("Child Memory evidence has a foreign owner");
  const records = history.records.filter(item => item.kind === "message" && item.runId === record.childRunId);
  if (!records.length || records.length > 2000) throw new Error("Child Memory evidence is empty or exceeds verification bounds");
  // Older proposals may point at a committed prefix; they never require replay.
  const through = evidence.throughSequence;
  if (through !== undefined) {
    const prefix = records.filter(item => item.sequence <= through);
    if (!Number.isSafeInteger(through) || !prefix.length || prefix.at(-1)?.sequence !== through || hash(prefix) !== evidence.digest) throw new Error("Child Memory evidence digest mismatch");
    return;
  }
  if (records.length > 128) throw new Error("Legacy child Memory evidence requires a bounded sequence locator");
  for (let length = records.length; length > 0; length--) if (hash(records.slice(0, length)) === evidence.digest) return;
  throw new Error("Child Memory evidence digest mismatch");
}

function ownerOf(record: SubagentOwner): SubagentOwner {
  return { parentAgentId: record.parentAgentId, parentSessionId: record.parentSessionId, parentRunId: record.parentRunId, workspaceRoot: record.workspaceRoot };
}

/** Optional parent adapter. It is absent from every internal child graph. */
export default {
  name: "memory-subagent-resources",
  inject: ["memory", "subagentLauncher", "subagents", "sessions", "runtimeLifecycle"],
  apply(ctx: Context): void {
    const exchange = new FileSubagentExchange(ctx.sessions.dataDirectory);
    const resources = new SubagentMemoryResources({ memory: ctx.memory, exchange, subagents: ctx.subagents,
      evidence: { async read(record, signal) {
        // The process must have exited before opening a process-local Session Store.
        if (record.status !== "exited") throw new Error("Child Session evidence is not sealed");
        const handle = ctx.sessions.acquire(exchange.childDataDirectory(record.id));
        try { return await handle.manager.readHistory({ sessionId: record.childSessionId, ...(signal === undefined ? {} : { signal }) }); }
        finally { handle.release(); }
      } },
    });
    let closed = false;
    let scanning: Promise<void> | undefined;
    let unsubscribe: (() => void) | undefined;
    const work = new PluginWorkOwner(ctx, { code: "memory_subagent_resources", codeReload: true,
      close: async () => { closed = true; unsubscribe?.(); await resources.close(); } });
    ctx.subagentLauncher.registerResourceProvider({ id: "memory", prepare: (request, identity) => work.run(() => resources.prepare(request, identity)) });
    const deletedParentReported = new Set<string>();
    const report = (error: unknown) => { if (!closed) process.stderr.write(`wish: Memory child proposal import failed: ${String(error)}\n`); };
    const reportScan = (error: unknown) => { if (!closed) process.stderr.write(`wish: Memory child recovery scan failed: ${String(error)}\n`); };
    const consume = async (record: SubagentRecord): Promise<void> => {
      // Events can arrive after the parent Session was deleted. Never import a
      // proposal into a review scope that no longer exists.
      let parent;
      try {
        parent = await ctx.sessions.manager.get({ sessionId: record.parentSessionId });
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
        if (await ctx.sessions.manager.wasDeleted({ sessionId: record.parentSessionId })) {
          if (record.status === "exited" && record.result?.status === "completed" && !deletedParentReported.has(record.id)) {
            deletedParentReported.add(record.id);
            if (!closed) process.stderr.write(`wish: Memory child result not imported: parent Session ${record.parentSessionId} was deleted (child ${record.id})\n`);
          }
          return;
        }
        // A live Application may own a different Session data root. The child
        // manifest and Subagent owner binding remain its import authority.
      }
      if (parent !== undefined && (parent.agentId !== record.parentAgentId || parent.scope !== record.workspaceRoot)) {
        throw new Error("Child Memory parent Session identity mismatch");
      }
      await resources.consume(record);
    };
    const scan = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (scanning) return scanning;
      scanning = (async () => {
        const events = await ctx.runtimeLifecycle.readEvents();
        const opened = events.filter(event => event.type === "run.opened");
        for (const event of opened) {
          if (closed) return;
          if (!event.scope || !event.agentId) continue;
          let session;
          try {
            session = await ctx.sessions.manager.get({ sessionId: event.scope });
          } catch (error) {
            // A deleted parent cannot be revived by retrying its historical Run.
            if (error instanceof SessionNotFoundError) continue;
            reportScan(error);
            continue;
          }
          try {
            if (session.agentId !== event.agentId) continue;
            const records = await ctx.subagents.list({ parentAgentId: event.agentId, parentSessionId: session.sessionId, parentRunId: event.runId, workspaceRoot: session.scope });
            for (const record of records) { if (closed) return; await consume(record).catch(report); }
          } catch (error) { reportScan(error); }
        }
      })().finally(() => { scanning = undefined; });
      return scanning;
    };
    // Subscribe during activation, but admit reads only after the durable
    // receipt. The subsequent scan reconciles events arriving while fenced.
    unsubscribe = ctx.subagents.subscribe(event => { void work.run(() => consume(event.record)).catch(report); });
    const start = () => {
      void work.run(scan).catch(reportScan);
    };
    if (ctx.root.get("codeReload")) ctx.root.get("codeReload")!.startWhenReady(ctx, start);
    else start();
  },
};
