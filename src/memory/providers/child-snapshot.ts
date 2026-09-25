import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { resolve } from "node:path";
import { FileSubagentExchange } from "../../subagents/files.js";
import type { SubagentResourceManifest } from "../../subagents/resources.js";
import { childMemoryInput, childMemoryState, MEMORY_CANDIDATES_RESOURCE, type ChildMemoryInput } from "../child-resources.js";
import { MemoryRuntime } from "../memory.js";
import { retrieve } from "../retrieval.js";
import { MemoryService } from "../service.js";
import { emptyState } from "../validation.js";
import type { ChangeMemoryStatusRequest, DecideMemoryRequest, MemoryQuery, MemoryState, MemoryStateStore, ProposeMemoryRequest } from "../types.js";

class ChildProposalStore implements MemoryStateStore {
  readonly libraryId: string;
  constructor(private readonly exchange: FileSubagentExchange, private readonly manifest: SubagentResourceManifest, private readonly input: ChildMemoryInput, private value: MemoryState) { this.libraryId = input.snapshot.libraryId; }
  async read(signal?: AbortSignal) { signal?.throwIfAborted(); return this.value; }
  async commit(value: MemoryState, expectedRevision: number, signal?: AbortSignal) {
    const state = childMemoryState(value, this.input, this.manifest);
    if (this.value.revision !== expectedRevision || state.revision !== expectedRevision + 1 || JSON.stringify(state.audit.slice(0, -1)) !== JSON.stringify(this.value.audit)) throw new Error("Child Memory proposal revision conflict");
    await this.exchange.writeOutputResource(this.manifest, { type: MEMORY_CANDIDATES_RESOURCE, schemaVersion: 1, payload: state }, signal);
    this.value = state;
  }
  async close() {}
}

/** Read-only accepted knowledge plus a private, durable proposal outbox. */
export class ChildSnapshotMemory {
  readonly libraryId: string;
  private constructor(private readonly runtime: MemoryRuntime, private readonly input: ChildMemoryInput, private readonly manifest: SubagentResourceManifest) { this.libraryId = input.snapshot.libraryId; }
  static async open(exchange: FileSubagentExchange, manifest: SubagentResourceManifest): Promise<ChildSnapshotMemory> {
    const input = childMemoryInput(manifest);
    const output = await exchange.readOutputResource(manifest, MEMORY_CANDIDATES_RESOURCE);
    if (output && output.schemaVersion !== 1) throw new Error("Invalid child Memory candidate resource version");
    const state = childMemoryState(output?.payload ?? { ...emptyState(input.snapshot.libraryId), documents: input.snapshot.documents }, input, manifest);
    return new ChildSnapshotMemory(new MemoryRuntime(new ChildProposalStore(exchange, manifest, input, state)), input, manifest);
  }
  state(signal?: AbortSignal) { return this.runtime.state(signal); }
  query(input?: MemoryQuery) { return this.runtime.query(input); }
  read(id: string, signal?: AbortSignal) { return this.runtime.read(id, signal); }
  async snapshot(input: MemoryQuery = {}) {
    await this.runtime.state(input.signal);
    return Object.freeze({ ...this.input.snapshot, documents: retrieve(this.input.snapshot.documents, input) });
  }
  propose(input: ProposeMemoryRequest) {
    if (!this.input.allowProposals) return Promise.reject(new Error("Child Memory proposal authority was not delegated"));
    if (input.actor.sessionId !== this.manifest.identity.childSessionId || input.actor.runId !== this.manifest.identity.childRunId) return Promise.reject(new Error("Child Memory proposal belongs to another execution"));
    return this.runtime.propose({ ...input, actor: { kind: "child", id: this.manifest.identity.id, sessionId: this.manifest.identity.childSessionId, runId: this.manifest.identity.childRunId } });
  }
  async decide(_input: DecideMemoryRequest): Promise<never> { throw new Error("Child Memory snapshot cannot accept or reject knowledge"); }
  async changeStatus(_input: ChangeMemoryStatusRequest): Promise<never> { throw new Error("Child Memory snapshot cannot mutate accepted knowledge"); }
  close() { return this.runtime.close(); }
}

/** Selected only for the internal CLI child surface with Host-pinned resources. */
export default class ChildSnapshotMemoryService extends MemoryService {
  static readonly inject = ["launch"];
  private runtime: ChildSnapshotMemory | undefined;
  private readonly work: PluginWorkOwner;
  get libraryId() { return this.ready().libraryId; }
  constructor(ctx: Context) {
    super(ctx);
    this.work = new PluginWorkOwner(ctx, { code: "memory_child_snapshot", codeReload: true,
      close: () => this.runtime?.close() });
  }
  async [Service.init]() {
    const launch = this.ctx.launch;
    const environment = launch.environment;
    const id = environment.WISH_CHILD_ID, childSessionId = environment.WISH_CHILD_SESSION_ID, childRunId = environment.WISH_CHILD_RUN_ID;
    const dataDirectory = environment.WISH_DATA_DIR, exchangeDirectory = environment.WISH_CHILD_EXCHANGE_DATA_DIR;
    if (launch.surface !== "cli" || launch.argv[0] !== "child" || !id || !childSessionId || !childRunId || !exchangeDirectory || !dataDirectory) throw new Error("Child Memory snapshot requires Host-owned child identity");
    const exchange = new FileSubagentExchange(resolve(launch.cwd, exchangeDirectory));
    if (resolve(launch.cwd, dataDirectory) !== exchange.childDataDirectory(id) || environment.WISH_CHILD_RESOURCES_FILE !== exchange.inputResourcesPath(id)) throw new Error("Child Memory resource path does not match its isolated data directory");
    const manifest = await exchange.readInputResources({ id, childSessionId, childRunId });
    if (!manifest || manifest.digest !== environment.WISH_CHILD_RESOURCES_DIGEST || manifest.owner.workspaceRoot !== launch.cwd) throw new Error("Child Memory snapshot does not match its Host grant");
    this.runtime = await ChildSnapshotMemory.open(exchange, manifest);
  }
  state(signal?: AbortSignal) { return this.work.run(() => this.runtime!.state(signal)); }
  query(input?: MemoryQuery) { return this.work.run(() => this.runtime!.query(input)); }
  read(id: string, signal?: AbortSignal) { return this.work.run(() => this.runtime!.read(id, signal)); }
  snapshot(input?: MemoryQuery) { return this.work.run(() => this.runtime!.snapshot(input)); }
  propose(input: ProposeMemoryRequest) { return this.work.run(() => this.runtime!.propose(input)); }
  decide(input: DecideMemoryRequest) { return this.work.run(() => this.runtime!.decide(input)); }
  changeStatus(input: ChangeMemoryStatusRequest) { return this.work.run(() => this.runtime!.changeStatus(input)); }
  close() { return this.work.close(); }
  private ready() { this.work.assertAttached(); if (!this.runtime) throw new Error("Child Memory snapshot is not active"); return this.runtime; }
}
