import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readlink, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { PluginChangeOperationView, PluginChangePhase } from "./change-coordinator.js";
import type { ManagedPluginState } from "./managed-types.js";

export class ManagedPluginStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}

type ManagedPluginCommit = Omit<ManagedPluginState, "schemaVersion" | "revision" | "operations">;
interface ParsedState { readonly state: ManagedPluginState; readonly changed: boolean }

const terminalPhases = new Set<PluginChangePhase>(["succeeded", "rejected", "recovery-required"]);
const cancellablePhases = new Set<PluginChangePhase>(["queued", "preflight", "waiting-safe-point"]);
const operationPhases = new Set<PluginChangePhase>([
  "queued", "preflight", "waiting-safe-point", "fencing", "draining", "staging", "switching", "retiring", "verifying",
  "succeeded", "rejected", "recovery-required",
]);

/** Dedicated process control persistence: never leases the business Storage subtree. */
export class ManagedPluginStore {
  private state: ManagedPluginState;
  private closed = false;
  private closing = false;
  private uncertain = false;
  private writes: Promise<void> = Promise.resolve();
  private constructor(readonly filename: string, private readonly lock: string, private readonly nonce: string, state: ManagedPluginState) { this.state = state; }

  static async open(filename: string): Promise<ManagedPluginStore> {
    filename = resolve(filename);
    await mkdir(dirname(filename), { recursive: true });
    const lock = `${filename}.lock`, nonce = randomUUID();
    const identity = await processNamespace();
    // Reclaim only a proven-dead process in this exact host/boot/PID namespace.
    // A live reused PID, foreign host, corrupt lock or unknown identity fails closed.
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ManagedPluginStoreError("management_store_locked");
      handle = await reclaimDeadLock(lock, identity);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, identity }));
      await handle.sync();
      let parsed: ParsedState;
      try { parsed = parseState(await readFile(filename, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        parsed = { state: freeze({ schemaVersion: 2, revision: "initial", preferences: {}, pending: null, receipts: [], operations: [] }), changed: false };
      }
      const store = new ManagedPluginStore(filename, lock, nonce, parsed.state);
      // Schema migration and interrupted-operation classification become durable
      // before this process exposes the store. Side effects are never replayed.
      if (parsed.changed) await store.write(parsed.state.revision, parsed.state);
      return store;
    } catch (error) {
      try { if (JSON.parse(await readFile(lock, "utf8")).nonce === nonce) await unlink(lock); }
      catch { /* An unverified/replaced lock is never removed by failed startup. */ }
      throw error;
    }
    finally { await handle.close(); }
  }

  snapshot(): ManagedPluginState { return this.state; }
  operation(id: string): PluginChangeOperationView | undefined { return this.state.operations.find(operation => operation.id === id); }

  async commit(expectedRevision: string, update: ManagedPluginCommit): Promise<ManagedPluginState> {
    return this.enqueue(async () => {
      if (expectedRevision !== this.state.revision) throw new ManagedPluginStoreError("management_revision_conflict");
      const next = parseState(JSON.stringify({ ...update, schemaVersion: 2, revision: randomUUID(), operations: this.state.operations }), false).state;
      await this.write(expectedRevision, next);
      return next;
    });
  }

  /** Operation journal writes are serialized with business commits but do not mutate the public configuration revision. */
  async recordOperation(operation: PluginChangeOperationView): Promise<void> {
    const captured = parseOperation(structuredClone(operation));
    await this.enqueue(async () => {
      const operations = [...this.state.operations];
      const existing = operations.findIndex(item => item.id === captured.id);
      if (existing >= 0) {
        const previous = operations[existing]!;
        if (!sameOperationIdentity(previous, captured) || phaseRank(captured.phase) < phaseRank(previous.phase) ||
          terminalPhases.has(previous.phase) && (captured.phase !== previous.phase || captured.code !== previous.code)) {
          throw new ManagedPluginStoreError("management_operation_conflict");
        }
        operations[existing] = captured;
      } else operations.push(captured);
      const next = freeze({ ...this.state, operations: retainOperations(operations) });
      await this.write(this.state.revision, next);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.writes;
    this.closed = true;
    if (JSON.parse(await readFile(this.lock, "utf8")).nonce !== this.nonce) throw new ManagedPluginStoreError("management_store_locked");
    await unlink(this.lock);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing || this.uncertain) return Promise.reject(new ManagedPluginStoreError("management_store_closed"));
    const run = this.writes.then(task);
    this.writes = run.then(() => undefined, () => undefined);
    return run;
  }

  private async write(expectedRevision: string, next: ManagedPluginState): Promise<void> {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      if (JSON.parse(await readFile(this.lock, "utf8")).nonce !== this.nonce) throw new ManagedPluginStoreError("management_store_locked");
      let disk: ManagedPluginState | undefined;
      try { disk = parseState(await readFile(this.filename, "utf8"), false).state; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if ((disk?.revision ?? "initial") !== expectedRevision) throw new ManagedPluginStoreError("management_revision_conflict");
      const checked = parseState(JSON.stringify(next), false).state;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(checked)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.filename); renamed = true;
      const directory = await open(dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.state = checked;
    } catch (error) {
      if (renamed) this.uncertain = true;
      if (error instanceof ManagedPluginStoreError) throw error;
      throw new ManagedPluginStoreError(renamed ? "management_save_uncertain" : "management_save_failed");
    } finally { await unlink(temporary).catch(() => {}); }
  }
}

async function processNamespace(): Promise<string | null> {
  try {
    return JSON.stringify([hostname(), (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      await readlink("/proc/self/ns/pid")]);
  } catch { return null; }
}

async function reclaimDeadLock(lock: string, identity: string | null) {
  if (!identity) throw new ManagedPluginStoreError("management_store_locked");
  // Serialize reclaimers so a second one cannot unlink a newly acquired lock.
  const recovery = `${lock}.recover`;
  let guard;
  try { guard = await open(recovery, "wx", 0o600); }
  catch { throw new ManagedPluginStoreError("management_store_locked"); }
  try {
    const bytes = await readFile(lock, "utf8"), owner = JSON.parse(bytes);
    if (owner.identity !== identity || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== "string") {
      throw new ManagedPluginStoreError("management_store_locked");
    }
    let dead = false;
    try { process.kill(owner.pid, 0); }
    catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!dead || await readFile(lock, "utf8") !== bytes) throw new ManagedPluginStoreError("management_store_locked");
    await unlink(lock);
    return await open(lock, "wx", 0o600);
  } catch { throw new ManagedPluginStoreError("management_store_locked"); }
  finally { await guard.close(); await unlink(recovery); }
}

export function managementFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseState(text: string, recover = true): ParsedState {
  try {
    if (Buffer.byteLength(text) > 1_048_576) throw new Error();
    const raw = JSON.parse(text);
    if (!raw || ![1, 2].includes(raw.schemaVersion) || !id(raw.revision) || !raw.preferences || typeof raw.preferences !== "object" ||
      Array.isArray(raw.preferences) || Object.keys(raw.preferences).length > 512 || !Array.isArray(raw.receipts) || raw.receipts.length > 100 ||
      Object.keys(raw).some(key => !["schemaVersion", "revision", "preferences", "pending", "receipts", ...(raw.schemaVersion === 2 ? ["operations"] : [])].includes(key)) ||
      raw.schemaVersion === 2 && (!Array.isArray(raw.operations) || raw.operations.length > 256)) throw new Error();
    for (const [key, preference] of Object.entries(raw.preferences) as [string, { name: unknown; preference: unknown }][]) {
      if (!id(key) || !preference || !id(preference.name) || !["enabled", "disabled"].includes(String(preference.preference)) ||
        Object.keys(preference).some(key => !["name", "preference"].includes(key))) throw new Error();
    }
    validatePending(raw.pending);
    for (const receipt of raw.receipts) {
      if (!receipt || !id(receipt.requestId) || !/^[a-f0-9]{64}$/u.test(receipt.fingerprint) ||
        !["succeeded", "rejected", "failed"].includes(receipt.status) || !/^[a-z][a-z0-9_]{0,79}$/u.test(receipt.code) ||
        Object.keys(receipt).some(key => !["requestId", "fingerprint", "status", "code", "operationId"].includes(key)) ||
        (receipt.operationId !== undefined && !id(receipt.operationId))) throw new Error();
    }
    let changed = raw.schemaVersion === 1;
    const seen = new Set<string>();
    const operations = (raw.schemaVersion === 2 ? raw.operations : []).map((value: unknown) => {
      let operation = parseOperation(value);
      if (seen.has(operation.id)) throw new Error();
      seen.add(operation.id);
      if (recover && !terminalPhases.has(operation.phase)) {
        const pending = raw.pending?.requestId === operation.requestId;
        operation = freeze({ ...operation, phase: pending ? "recovery-required" as const : "rejected" as const,
          code: pending ? "management_recovery_required" : "plugin_change_interrupted", cancellable: false });
        changed = true;
      }
      return operation;
    });
    return { state: freeze({ schemaVersion: 2, revision: raw.revision, preferences: raw.preferences, pending: raw.pending,
      receipts: raw.receipts, operations }), changed };
  } catch { throw new ManagedPluginStoreError("management_store_corrupt"); }
}

function validatePending(pending: any): void {
  if (pending === null) return;
  if (!pending || !id(pending.requestId) || !id(pending.revision) || !["enabled", "disabled", "inherit"].includes(pending.preference) ||
    !id(pending.selection?.instanceId) || !Array.isArray(pending.selection?.entryIds) || !pending.selection.entryIds.length ||
    pending.selection.entryIds.length > 512 || pending.selection.entryIds.some((entry: unknown) => !id(entry)) ||
    new Set(pending.selection.entryIds).size !== pending.selection.entryIds.length ||
    Object.keys(pending).some(key => !["requestId", "revision", "preference", "selection", "configuration"].includes(key)) ||
    Object.keys(pending.selection).some(key => !["instanceId", "entryIds"].includes(key))) throw new Error();
  if (pending.configuration === undefined) return;
  const configuration = pending.configuration;
  if (!pending.requestId.startsWith("configuration:") || pending.preference !== "inherit" || !configuration ||
    !/^[a-f0-9]{64}$/u.test(configuration.beforeDigest) || !/^[a-f0-9]{64}$/u.test(configuration.afterDigest) ||
    !Array.isArray(configuration.changes) || configuration.changes.length !== pending.selection.entryIds.length ||
    Object.keys(configuration).some(key => !["beforeDigest", "afterDigest", "changes"].includes(key))) throw new Error();
  const seen = new Set<string>();
  for (const change of configuration.changes) {
    if (!change || !id(change.entryId) || !pending.selection.entryIds.includes(change.entryId) || seen.has(change.entryId) ||
      Object.keys(change).some(key => !["kind", "entryId", "beforeName", "afterName",
        ...(change.kind === "retype" ? ["beforeGroup", "afterGroup"] : [])].includes(key))) throw new Error();
    seen.add(change.entryId);
    const before = change.beforeName, after = change.afterName;
    if (!(change.kind === "add" ? before === null && id(after) :
      change.kind === "remove" ? id(before) && after === null :
      change.kind === "update" || change.kind === "reorder" ? id(before) && before === after :
      change.kind === "replace" ? id(before) && id(after) && before !== after :
      change.kind === "retype" ? id(before) && id(after) && typeof change.beforeGroup === "boolean" &&
        typeof change.afterGroup === "boolean" && change.beforeGroup !== change.afterGroup : false)) throw new Error();
  }
}

function parseOperation(value: any): PluginChangeOperationView {
  if (!value || !id(value.id) || !["enable", "disable", "reconfigure", "replace"].includes(value.kind) ||
    !["management", "configuration", "hmr", "standalone-stop"].includes(value.source) ||
    value.requestId !== null && !id(value.requestId) || !Array.isArray(value.entryIds) || value.entryIds.length > 512 ||
    value.entryIds.some((entry: unknown) => !id(entry)) || new Set(value.entryIds).size !== value.entryIds.length ||
    value.fingerprint !== null && !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
    value.submittedRevision !== null && !id(value.submittedRevision) || !operationPhases.has(value.phase) ||
    value.code !== null && !/^[a-z][a-z0-9_]{0,79}$/u.test(value.code) || typeof value.cancellable !== "boolean" ||
    value.cancellable !== cancellablePhases.has(value.phase) ||
    Object.keys(value).some(key => !["id", "kind", "source", "requestId", "entryIds", "fingerprint", "submittedRevision", "phase", "code", "cancellable"].includes(key))) throw new Error();
  return freeze({ ...value, entryIds: [...value.entryIds] }) as PluginChangeOperationView;
}

function retainOperations(operations: readonly PluginChangeOperationView[]): readonly PluginChangeOperationView[] {
  if (operations.length <= 256) return Object.freeze([...operations]);
  const live = operations.filter(operation => !terminalPhases.has(operation.phase));
  const terminal = operations.filter(operation => terminalPhases.has(operation.phase));
  return Object.freeze([...terminal.slice(-(256 - live.length)), ...live]);
}

function sameOperationIdentity(left: PluginChangeOperationView, right: PluginChangeOperationView): boolean {
  return left.kind === right.kind && left.source === right.source && left.requestId === right.requestId &&
    (!left.entryIds.length || JSON.stringify(left.entryIds) === JSON.stringify(right.entryIds)) && left.fingerprint === right.fingerprint &&
    left.submittedRevision === right.submittedRevision;
}

function phaseRank(phase: PluginChangePhase): number {
  return ["queued", "preflight", "waiting-safe-point", "fencing", "draining", "staging", "switching", "retiring", "verifying",
    "succeeded", "rejected", "recovery-required"].indexOf(phase);
}

function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f]/u.test(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
