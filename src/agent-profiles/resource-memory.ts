import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { MemoryService } from "../memory/service.js";
import { MemoryRuntime } from "../memory/memory.js";
import { emptyState } from "../memory/validation.js";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { ChangeMemoryStatusRequest, ConsolidateMemoryRequest, DecideMemoryRequest, MemoryQuery, ProposeMemoryRequest } from "../memory/types.js";
import { validateProfileResources } from "./resources.js";
import { digest } from "./validation.js";

/** Each Worker gets a private initial state. No handle to production Memory is acquired. */
export default class ProfileMemory extends MemoryService {
  static readonly Config = s.object({ resourcesJson: s.string().required() });
  readonly libraryId: string;
  readonly initialStateDigest: string;
  private readonly runtime: MemoryRuntime;
  private readonly owner: PluginWorkOwner;
  constructor(ctx: Context, config: { readonly resourcesJson: string }) {
    super(ctx);
    const initial = validateProfileResources(JSON.parse(config.resourcesJson)).memory;
    this.initialStateDigest = digest(initial);
    this.libraryId = initial.kind === "empty" ? "profile-memory" : initial.snapshot.libraryId;
    let state = { ...emptyState(this.libraryId), documents: initial.kind === "empty" ? [] : initial.snapshot.documents };
    this.runtime = new MemoryRuntime({ libraryId: this.libraryId,
      async read(signal) { signal?.throwIfAborted(); return state; },
      async commit(value, expected, signal) {
        signal?.throwIfAborted();
        if (state.revision !== expected || value.revision !== expected + 1) throw new Error("profile_memory_revision_conflict");
        state = value;
      }, async close() {},
    });
    this.owner = new PluginWorkOwner(ctx, { code: "profile_memory", codeReload: true, close: () => this.runtime.close() });
  }
  state(signal?: AbortSignal) { return this.owner.run(() => this.runtime.state(signal)); }
  query(input?: MemoryQuery) { return this.owner.run(() => this.runtime.query(input)); }
  read(id: string, signal?: AbortSignal) { return this.owner.run(() => this.runtime.read(id, signal)); }
  snapshot(input?: MemoryQuery) { return this.owner.run(() => this.runtime.snapshot(input)); }
  propose(input: ProposeMemoryRequest) { return this.owner.run(() => this.runtime.propose(input)); }
  decide(input: DecideMemoryRequest) { return this.owner.run(() => this.runtime.decide(input)); }
  changeStatus(input: ChangeMemoryStatusRequest) { return this.owner.run(() => this.runtime.changeStatus(input)); }
  consolidate(input: ConsolidateMemoryRequest) { return this.owner.run(() => this.runtime.consolidate(input)); }
  close() { return this.owner.close(); }
}
