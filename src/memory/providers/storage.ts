import { Service, type Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import s from "@deepseek-ai/schemastery";
import type { StorageBackendLease } from "../../storage/backend.js";
import { FileJournalStorageBackend } from "../../storage/providers/file/journal.js";
import { MemoryService } from "../service.js";
import { MemoryRuntime } from "../memory.js";
import { JournalMemoryStore } from "../store.js";
import { identity } from "../validation.js";
import { join, resolve } from "node:path";
import { readChildMemoryLibrary } from "../child-resources.js";
import { MemoryWorkspace } from "../curation/workspace.js";
import { workspaceDocuments } from "../files.js";
import { retrieve } from "../retrieval.js";
import { withMemoryLock } from "../file-lock.js";
import type {} from "../../sessions/service.js";
import type { ChangeMemoryStatusRequest, ConsolidateMemoryRequest, DecideMemoryRequest, MemoryLibraryLocation, MemoryQuery, ProposeMemoryRequest } from "../types.js";
export interface Config { readonly backendId?: string; readonly libraryId?: string; readonly directory?: string }
export const Config: s<Config> = s.object({ backendId: s.string(), libraryId: s.string(), directory: s.string() });
export default class StorageMemoryService extends MemoryService {
  static readonly inject = ["storageBackend", "sessions"];
  static readonly Config = Config;
  private libraryIdValue!: string;
  get libraryId() { return this.libraryIdValue; }
  private lease: StorageBackendLease | undefined;
  private runtime!: MemoryRuntime;
  private readonly work: PluginWorkOwner;
  private workspaceValue!: MemoryWorkspace;
  get workspace() { return this.workspaceValue; }
  private readonly readOnly: boolean;
  private location: MemoryLibraryLocation | undefined;
  private childJournals: FileJournalStorageBackend | undefined;
  private allowedSkills: ReadonlySet<string> | undefined;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const launch = ctx.get("launch"), environment = launch?.environment;
    this.readOnly = (launch?.surface === "cli" && launch.argv[0] === "child") ||
      !!environment?.WISH_CHILD_RESOURCES_FILE || !!environment?.WISH_CHILD_RESOURCES_DIGEST;
    this.work = new PluginWorkOwner(ctx, { code: "memory", codeReload: true,
      close: async () => { try { await this.runtime?.close(); } finally { this.lease?.release(); await this.childJournals?.close(); } } });
    if (this.readOnly) return;
    this.libraryIdValue = identity(config.libraryId ?? "default");
    this.workspaceValue = new MemoryWorkspace(resolve(config.directory ?? join(ctx.sessions.dataDirectory, "memories", this.libraryId)));
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { journal: { atomicBatch: true, durability: "fsync" } });
    try {
      const journals = this.lease.resolve(backendId, "journal");
      const journal = journals.open({ namespace: `memory/${this.libraryId}` });
      this.runtime = new MemoryRuntime(new JournalMemoryStore(journal, this.libraryId));
      if (journals instanceof FileJournalStorageBackend) this.location = Object.freeze({ libraryId: this.libraryId,
        directory: this.workspace.directory, journalRoot: journals.rootDirectory });
    } catch (error) { this.lease.release(); throw error; }
  }
  async [Service.init]() {
    if (this.readOnly) {
      const library = await readChildMemoryLibrary(this.ctx.launch);
      this.libraryIdValue = library.libraryId;
      this.workspaceValue = new MemoryWorkspace(library.directory);
      this.allowedSkills = new Set(library.allowedSkills);
      // Only the Memory Journal is opened; Sessions, jobs and other child data stay private.
      // Fail on a torn tail: a reader must never repair or truncate the parent's Journal.
      this.childJournals = new FileJournalStorageBackend({ backendId: "child-memory-read", rootDirectory: library.journalRoot, tornTailRecovery: "fail" });
      const store = new JournalMemoryStore(this.childJournals.open({ namespace: `memory/${this.libraryId}` }), this.libraryId);
      this.runtime = new MemoryRuntime({ libraryId: this.libraryId, read: signal => store.read(signal),
        commit: async () => { throw new Error("Child Memory library is read-only"); }, close: () => store.close() });
    }
    await withMemoryLock(this.workspace.directory, "library-write", () => this.runtime.state());
  }
  override get sharedLibrary() { this.work.assertAttached(); return this.location; }
  state(signal?: AbortSignal) { return this.work.run(() => withMemoryLock(this.workspace.directory, "library-write", () => this.runtime.state(signal), signal)); }
  override files(signal?: AbortSignal) { return this.work.run(() => withMemoryLock(this.workspace.directory, "library-write", () => this.currentFiles(signal), signal)); }
  private async currentFiles(signal?: AbortSignal) {
    const state = await this.runtime.state(signal), files = await this.workspace.files();
    signal?.throwIfAborted();
    const documents = !Object.keys(files).length && !Object.keys(await this.workspace.baseline()).length
      ? state.documents.filter(item => item.status === "accepted")
      : [...state.documents.filter(item => item.status === "accepted" && !item.path), ...workspaceDocuments(state, files)];
    return this.allowedSkills === undefined ? documents : documents.filter(item =>
      !item.path?.startsWith("skills/") || this.allowedSkills!.has(item.path.split("/")[1]!));
  }
  query(input: MemoryQuery = {}) { return this.work.run(() => withMemoryLock(this.workspace.directory, "library-write", async () => retrieve(await this.currentFiles(input.signal), input), input.signal)); }
  read(id: string, signal?: AbortSignal) { return this.work.run(() => withMemoryLock(this.workspace.directory, "library-write", async () => {
    const current = (await this.currentFiles(signal)).find(item => item.id === id);
    if (current) return current;
    const receipt = await this.runtime.read(id, signal);
    return receipt?.path && receipt.status === "accepted" ? undefined : receipt;
  }, signal)); }
  private write<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.work.run(() => {
      if (this.readOnly) throw new Error("Child Memory library is read-only");
      return withMemoryLock(this.workspace.directory, "library-write", operation, signal);
    });
  }
  propose(input: ProposeMemoryRequest) { return this.write(() => this.runtime.propose(input), input.signal); }
  decide(input: DecideMemoryRequest) { return this.write(() => this.runtime.decide(input), input.signal); }
  changeStatus(input: ChangeMemoryStatusRequest) { return this.write(() => this.runtime.changeStatus(input), input.signal); }
  consolidate(input: ConsolidateMemoryRequest) { return this.write(() => this.runtime.consolidate(input), input.signal); }
  snapshot(input: MemoryQuery = {}) { return this.work.run(() => withMemoryLock(this.workspace.directory, "library-write", async () => ({
    schemaVersion: 1 as const, libraryId: this.libraryId, revision: (await this.runtime.state(input.signal)).revision,
    documents: retrieve(await this.currentFiles(input.signal), input),
  }), input.signal)); }
  close() { return this.work.close(); }
}
