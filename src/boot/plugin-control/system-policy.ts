import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedPluginState } from "./managed-types.js";
import { readManagedPluginState } from "./managed-store.js";

export class SystemPluginPolicyError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const emptyPluginPolicy: ManagedPluginState = Object.freeze({
  schemaVersion: 2, revision: "initial", preferences: Object.freeze({}), pending: null,
  receipts: Object.freeze([]), operations: Object.freeze([]),
});

interface Participant {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly pid: number;
  readonly namespace: string;
  readonly started: string;
  readonly entries: readonly string[];
}

/** A management directory is one policy authority, independent of process data roots. */
export class SystemPluginPolicy {
  readonly directory: string;
  readonly filename: string;
  readonly participants: string;
  constructor(directory: string, private readonly current?: () => ManagedPluginState) {
    this.directory = resolve(directory);
    this.filename = join(this.directory, "plugins.json");
    this.participants = join(this.directory, "policy-participants");
  }
  async read(): Promise<ManagedPluginState | undefined> {
    return this.current ? this.current() : readManagedPluginState(this.filename);
  }
  async assertEnabled(entryIds: readonly string[]): Promise<void> {
    const state = await this.read();
    if (state?.pending) throw new SystemPluginPolicyError("system_plugin_policy_changing");
    for (const id of entryIds) if (state?.preferences[id]?.preference === "disabled") {
      throw new SystemPluginPolicyError(`system_plugin_disabled:${id}`);
    }
  }
  /** Called after durable intent blocks new admissions, before local shutdown commits. */
  async drain(entryIds: readonly string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<void> {
    const selected = new Set(entryIds), namespace = await processNamespace();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      let files: string[];
      try { files = await readdir(this.participants); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      let live = false;
      for (const name of files) {
        if (!/^[0-9a-f-]{36}\.json$/u.test(name)) continue;
        const filename = join(this.participants, name);
        let participant: Participant;
        try { participant = parseParticipant(await readFile(filename, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!participant.entries.some(id => selected.has(id))) continue;
        if (participant.namespace !== namespace) throw new SystemPluginPolicyError("system_plugin_policy_foreign_participant");
        const started = await processStart(participant.pid);
        if (started === undefined || started !== participant.started) {
          await unlink(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
        } else live = true;
      }
      if (!live) return;
      if (Date.now() >= deadline) throw new SystemPluginPolicyError("system_plugin_policy_drain_timeout");
      await delay(25, undefined, signal ? { signal } : {});
    }
  }
}

/** A follower leases its loaded capabilities until all owned work has been cleaned up. */
export class PluginPolicyFollower {
  readonly state: ManagedPluginState;
  private readonly filename: string;
  private participant: Participant;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private tail: Promise<void> = Promise.resolve();
  private checking = false;
  private closed = false;
  private seenState: boolean;
  private revocation: string | undefined;
  private constructor(readonly policy: SystemPluginPolicy, participant: Participant,
    state: ManagedPluginState | undefined, private readonly onRevoke: (reason: string) => void) {
    this.participant = participant;
    this.filename = join(policy.participants, `${participant.id}.json`);
    this.state = state ?? emptyPluginPolicy;
    this.seenState = state !== undefined;
  }
  get revoked(): boolean { return this.revocation !== undefined; }
  static async open(policy: SystemPluginPolicy, entries: readonly string[], onRevoke: (reason: string) => void): Promise<PluginPolicyFollower> {
    const state = await policy.read();
    if (state?.pending) throw new SystemPluginPolicyError("system_plugin_policy_changing");
    const started = await processStart(process.pid);
    if (!started) throw new SystemPluginPolicyError("system_plugin_policy_process_identity_unavailable");
    const follower = new PluginPolicyFollower(policy, { schemaVersion: 1, id: randomUUID(), pid: process.pid,
      namespace: await processNamespace(), started,
      entries: Object.freeze(entries.filter(id => state?.preferences[id]?.preference !== "disabled")) }, state, onRevoke);
    await mkdir(policy.participants, { recursive: true });
    try {
      await follower.publish();
      // Intent is persisted before the manager enumerates leases. Recheck after
      // registering so a process racing with shutdown never starts unobserved.
      const current = await policy.read();
      if (current?.pending || (current?.revision ?? "initial") !== follower.state.revision) {
        throw new SystemPluginPolicyError("system_plugin_policy_changed");
      }
      follower.watcher = watch(policy.directory, { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === "plugins.json") follower.schedule();
      });
      follower.watcher.on("error", () => follower.revoke("system_plugin_policy_unavailable"));
      follower.timer = setInterval(() => follower.schedule(), 100);
      follower.timer.unref();
      return follower;
    } catch (error) { await follower.close(); throw error; }
  }
  async ready(entries: readonly string[]): Promise<void> {
    if (this.revocation) throw new SystemPluginPolicyError(this.revocation);
    this.participant = { ...this.participant, entries: Object.freeze([...entries]) };
    await this.publish();
    await this.check();
    if (this.revocation) throw new SystemPluginPolicyError(this.revocation);
  }
  private async publish(): Promise<void> {
    // Admission and ready updates must both be atomic to concurrent drain readers.
    const temporary = `${this.filename}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.participant), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filename);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  private schedule(): void {
    if (this.closed || this.revoked || this.checking) return;
    this.checking = true;
    this.tail = this.check().catch(() => this.revoke("system_plugin_policy_unavailable"))
      .finally(() => { this.checking = false; });
  }
  private async check(): Promise<void> {
    if (this.closed || this.revoked) return;
    const state = await this.policy.read();
    if (state === undefined && this.seenState) { this.revoke("system_plugin_policy_unavailable"); return; }
    this.seenState ||= state !== undefined;
    const entries = new Set(this.participant.entries);
    if (state?.pending && (state.pending.preference === "disabled" || state.pending.configuration) &&
      state.pending.selection.entryIds.some(id => entries.has(id))) {
      this.revoke("system_plugin_policy_revoked"); return;
    }
    if (Object.entries(state?.preferences ?? {}).some(([id, value]) => entries.has(id) && value.preference === "disabled")) {
      this.revoke("system_plugin_policy_revoked");
    }
  }
  private revoke(reason: string): void {
    if (this.closed || this.revoked) return;
    this.revocation = reason;
    this.watcher?.close();
    clearInterval(this.timer);
    this.onRevoke(reason);
  }
  /** Release only after the process graph has finished teardown, never before. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    clearInterval(this.timer);
    await this.tail;
    await unlink(this.filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

async function processNamespace(): Promise<string> {
  return JSON.stringify([hostname(), (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), await readlink("/proc/self/ns/pid")]);
}
async function processStart(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!started || !/^\d+$/u.test(started)) throw new SystemPluginPolicyError("system_plugin_policy_process_identity_invalid");
    return started;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function parseParticipant(text: string): Participant {
  if (Buffer.byteLength(text) > 1_048_576) throw new SystemPluginPolicyError("system_plugin_policy_participant_invalid");
  const value = JSON.parse(text) as Participant;
  if (!value || value.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/u.test(value.id) || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.namespace !== "string" || typeof value.started !== "string" || !/^\d+$/u.test(value.started) ||
    !Array.isArray(value.entries) || value.entries.some(id => typeof id !== "string" || !id.startsWith("include:"))) {
    throw new SystemPluginPolicyError("system_plugin_policy_participant_invalid");
  }
  return value;
}

declare module "@deepseek-ai/cordis" {
  interface Context { systemPluginPolicy: SystemPluginPolicy; }
}
