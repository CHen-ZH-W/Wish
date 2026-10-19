import { FiberState, type Context, type Fiber } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonical, copy, digest, fail, sha, snapshot } from "./codec.js";
import type { PluginStateDefinition, PluginStateHandle, PluginStateIndex, PluginStatePersistence, PluginStateSnapshot } from "./types.js";

interface Writer {
  readonly fiber: Fiber;
  readonly entryId: string;
  readonly key: string;
  readonly definition: PluginStateDefinition & { readonly identity: import("./types.js").PluginStateIdentity };
  readonly configurationDigest: string;
  tail: Promise<unknown>;
  fenced: boolean;
  closed: boolean;
  closing?: Promise<void>;
  latest?: PluginStateSnapshot;
}
interface Change {
  readonly selected: Set<string>;
  readonly originals: Set<Writer>;
  readonly successors: Map<string, Fiber>;
  readonly restorePreviousState: boolean;
  restoring: boolean;
}
declare module "@deepseek-ai/cordis" { interface Context { pluginState: PluginStateRegistry } }

/** Private-state ownership survives replacement of the Loader-managed business tree. */
export class PluginStateRegistry {
  private readonly writers = new Map<string, Writer>();
  private readonly scopes = new WeakMap<Fiber, string>();
  private readonly artifacts = new WeakMap<object, Promise<string>>();
  private persistence?: Promise<PluginStatePersistence>;
  private value: PluginStateIndex = { heads: {}, pending: null };
  private revision: string | undefined;
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
  private change: Change | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private poisoned = false;

  constructor(private readonly provider: () => Promise<PluginStatePersistence>,
    private readonly committed: (requestId: string) => boolean = () => false) {}

  /** Explicit keys support embeddings; Loader plugins always use their qualified Entry identity. */
  async open(owner: Context, definition: PluginStateDefinition, key?: string): Promise<PluginStateHandle> {
    const declared = copy(definition.identity);
    let artifactDigest = declared.artifactDigest;
    if (owner.fiber.entry) {
      const callback = owner.fiber.runtime?.callback as object | undefined;
      if (!callback) fail("plugin_state_requires_stable_entry");
      let captured = this.artifacts.get(callback);
      if (!captured) {
        const entry = owner.fiber.entry, name = entry.options.name;
        const module = /^(?:\.{1,2}\/|\/|file:)/.test(name) ? new URL(name, entry.ctx.baseUrl).href : import.meta.resolve(name);
        captured = readFile(new URL(module)).then(bytes => createHash("sha256").update(bytes).digest("hex"));
        this.artifacts.set(callback, captured);
      }
      const observed = await captured;
      if (artifactDigest && artifactDigest !== observed) fail("plugin_state_artifact_mismatch");
      artifactDigest = observed;
    }
    const identity = { ...declared, artifactDigest: artifactDigest ?? "" };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(identity.pluginId) ||
      typeof identity.pluginVersion !== "string" || !identity.pluginVersion.trim() || identity.pluginVersion.length > 128 || !sha(identity.artifactDigest) ||
      !Number.isSafeInteger(identity.schemaVersion) || identity.schemaVersion < 1 ||
      !Array.isArray(definition.readableVersions) || !definition.readableVersions.includes(identity.schemaVersion) ||
      [...definition.readableVersions, ...(definition.migratableVersions ?? [])].some(v => !Number.isSafeInteger(v) || v < 1) ||
      new Set(definition.readableVersions).size !== definition.readableVersions.length ||
      definition.migratableVersions?.some(v => definition.readableVersions.includes(v)) ||
      [definition.snapshot, definition.restore, definition.validate].some(fn => typeof fn !== "function") ||
      (definition.migratableVersions?.length && typeof definition.migrate !== "function")) fail("plugin_state_invalid_definition");
    const entryId = owner.fiber.entry?.id ?? key;
    if (!entryId || owner.fiber.uid === null) fail("plugin_state_requires_stable_entry");
    const manifest = owner.root.get("pluginInspection")?.inspect().entries.find(entry => entry.id === entryId)?.manifest;
    if (manifest && (manifest.id !== identity.pluginId || manifest.state.mode !== "versioned" ||
      manifest.state.schemaVersion !== identity.schemaVersion ||
      canonical([...manifest.state.readableVersions].sort()) !== canonical([...definition.readableVersions].sort()) ||
      canonical([...(manifest.state.migratableVersions ?? [])].sort()) !== canonical([...(definition.migratableVersions ?? [])].sort()))) {
      fail("plugin_state_manifest_mismatch");
    }
    const stateKey = `${entryId}/${identity.pluginId}`;
    const writer: Writer = { fiber: owner.fiber, entryId, key: stateKey,
      definition: { ...definition, identity, readableVersions: [...definition.readableVersions],
        ...(definition.migratableVersions ? { migratableVersions: [...definition.migratableVersions] } : {}) },
      configurationDigest: digest(owner.fiber.config ?? null), tail: Promise.resolve(), fenced: false, closed: false };
    await this.serialize(async () => {
      this.assertWritable(); await this.load(); this.assertWritable();
      if (this.writers.has(stateKey) || this.scopes.has(owner.fiber)) fail("plugin_state_already_owned");
      this.writers.set(stateKey, writer); this.scopes.set(owner.fiber, stateKey);
      try {
        let hash = this.value.heads[stateKey];
        if (this.selected(entryId)) {
          const baseline = this.value.pending?.before[stateKey];
          const retained = baseline ? await (await this.persistence!).readSnapshot(baseline) : undefined;
          // Native HMR restores the retained callback before reporting failure.
          // Its immutable build/config identity selects the pre-change checkpoint.
          hash = retained && this.sameWriter(retained, writer) ? baseline : this.value.pending?.staged[stateKey] ?? baseline;
        }
        if (hash) {
          let saved = await (await this.persistence!).readSnapshot(hash);
          if (this.selected(entryId) && this.change!.restorePreviousState) {
            // Explicit operator rollback rewinds private data to the exact old
            // build/config checkpoint. Ordinary upgrades never search history.
            let hops = 0;
            while (!this.sameWriter(saved, writer)) {
              if (!saved.previous || ++hops > 10000) fail("plugin_state_rollback_checkpoint_missing");
              saved = await (await this.persistence!).readSnapshot(saved.previous);
            }
          }
          if (saved.key !== stateKey || saved.writer.pluginId !== identity.pluginId) fail("plugin_state_identity_mismatch");
          let restored = saved;
          if (!writer.definition.readableVersions.includes(saved.writer.schemaVersion)) {
            if (!writer.definition.migrate || !writer.definition.migratableVersions?.includes(saved.writer.schemaVersion)) fail("plugin_state_incompatible");
            const migrated = copy(await writer.definition.migrate(copy(saved)));
            writer.definition.validate(migrated);
            const body = { ...saved, writer: identity, value: migrated };
            const { digest: _old, ...data } = body;
            restored = snapshot({ ...data, digest: digest(data) });
          }
          writer.definition.validate(copy(restored.value));
          await writer.definition.restore(copy(restored));
        }
        // Check restored/default state before any service can be published.
        await this.checkpoint(writer);
        if (this.selected(entryId)) this.change!.successors.set(entryId, owner.fiber);
      } catch (error) {
        this.writers.delete(stateKey); this.scopes.delete(owner.fiber); throw error;
      }
    });
    const handle: PluginStateHandle = {
      key: stateKey,
      run: action => this.enqueue(writer, async () => {
        let result!: Awaited<ReturnType<typeof action>>;
        try { result = await action(); }
        finally { await this.serialize(() => this.checkpoint(writer)); }
        return result;
      }),
      flush: () => this.enqueue(writer, () => this.serialize(() => this.checkpoint(writer))),
      close: () => this.closeWriter(writer),
    };
    owner.effect(() => () => handle.close(), "plugin private-state writer");
    return Object.freeze(handle);
  }

  /** OwnerRegistry calls this after fencing the plugin's ordinary work admission. */
  prepare(fiber: Fiber, drained: Promise<void>): { drained: Promise<void>; release(): void } {
    const writer = [...this.writers.values()].find(item => item.fiber.uid === fiber.uid);
    if (!writer) return { drained, release() {} };
    writer.fenced = true;
    return { drained: drained.then(async () => { await writer.tail; await this.serialize(() => this.checkpoint(writer)); }),
      release: () => { if (!writer.closed && !writer.closing) writer.fenced = false; } };
  }
  conforms(fiberId: number, declaration: { schemaVersion: number; readableVersions: readonly number[]; migratableVersions?: readonly number[] }, pluginId: string): boolean {
    const writer = [...this.writers.values()].find(item => item.fiber.uid === fiberId);
    return !!writer && !writer.closed && writer.definition.identity.pluginId === pluginId &&
      writer.definition.identity.schemaVersion === declaration.schemaVersion &&
      canonical([...writer.definition.readableVersions].sort()) === canonical([...declaration.readableVersions].sort()) &&
      canonical([...(writer.definition.migratableVersions ?? [])].sort()) === canonical([...(declaration.migratableVersions ?? [])].sort());
  }
  hasWriter(fiberId: number): boolean { return [...this.writers.values()].some(writer => writer.fiber.uid === fiberId && !writer.closed); }

  /** One Root PluginChangeCoordinator already serializes all change transactions. */
  async begin(requestId: string, entryIds: readonly string[], restorePreviousState = false): Promise<boolean> {
    this.assertWritable();
    // Stateless graphs incur no private-state I/O or lifecycle obligations.
    if (!this.persistence && !this.writers.size) {
      if (this.change) fail("plugin_state_change_pending");
      this.change = { selected: new Set(entryIds), originals: new Set(), successors: new Map(), restorePreviousState, restoring: false };
      // Delay creating a store until the first stateful plugin actually opens.
      this.value = { heads: {}, pending: { requestId, before: {}, staged: {} } };
      return true;
    }
    return this.serialize(async () => {
      this.assertWritable(); await this.load(); this.assertWritable();
      if (this.change || this.value.pending) fail("plugin_state_change_pending");
      const selected = new Set(entryIds), originals = new Set([...this.writers.values()].filter(writer => selected.has("*") || selected.has(writer.entryId)));
      const before = Object.fromEntries(Object.entries(this.value.heads).filter(([key]) => entryIds.includes("*") || entryIds.some(id => key.startsWith(`${id}/`))));
      const next = { heads: this.value.heads, pending: { requestId, before, staged: {} } };
      await this.save(next);
      this.change = { selected, originals, successors: new Map(), restorePreviousState, restoring: false };
      return true;
    });
  }
  /** Disable candidate writes before reconstructing any old service. */
  async rollback(): Promise<void> {
    if (!this.change) return;
    if (!this.persistence) { this.change.restoring = true; return; }
    await this.serialize(async () => {
      this.change!.restoring = true;
      await this.save({ heads: { ...this.value.heads, ...this.value.pending!.before }, pending: { ...this.value.pending!, staged: {} } });
    });
  }
  /** Called only after the Root success/rejection receipt is durable. */
  async finish(success: boolean): Promise<void> {
    if (!this.change) return;
    if (!this.persistence) { this.change = undefined; this.value = { heads: {}, pending: null }; return; }
    await this.serialize(async () => {
      const pending = this.value.pending!;
      if (success && [...this.change!.successors.values()].some(fiber => fiber.state !== FiberState.ACTIVE)) fail("plugin_state_activation_incomplete");
      await this.save({ heads: { ...this.value.heads, ...(success ? pending.staged : pending.before) }, pending: null });
      this.change = undefined;
    });
  }
  async inspect(key: string): Promise<PluginStateSnapshot | undefined> {
    return this.serialize(async () => { if (this.closed) fail("plugin_state_closed"); await this.load(); const hash = this.value.heads[key]; return hash ? copy(await (await this.persistence!).readSnapshot(hash)) : undefined; });
  }
  close(): Promise<void> { return this.closing ??= this.drainAndClose(); }
  private async drainAndClose(): Promise<void> {
    this.closed = true;
    const outcomes = await Promise.allSettled([...this.writers.values()].map(writer => this.closeWriter(writer)));
    await this.tail;
    // Do not release exclusion while an unflushed writer still owns state.
    const errors = outcomes.filter((v): v is PromiseRejectedResult => v.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(v => v.reason), "plugin_state_close_failed");
    if (this.persistence) await (await this.persistence).close();
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    const provider = await (this.persistence ??= this.provider());
    const lazyRequest = this.change && !this.loaded ? this.value.pending?.requestId : undefined;
    const found = await provider.readIndex(); this.value = found.value; this.revision = found.revision;
    if (this.value.pending) {
      const pending = this.value.pending;
      // A dead Host never replays a migration or a business operation.
      await this.save({ heads: { ...this.value.heads, ...(this.committed(pending.requestId) ? pending.staged : pending.before) }, pending: null });
    }
    if (lazyRequest) {
      const before = Object.fromEntries(Object.entries(this.value.heads).filter(([key]) => this.change!.selected.has("*") || [...this.change!.selected].some(id => key.startsWith(`${id}/`))));
      await this.save({ heads: this.value.heads, pending: { requestId: lazyRequest, before, staged: {} } });
    }
    this.loaded = true;
  }
  private async save(value: PluginStateIndex): Promise<void> {
    try { this.revision = await (await this.persistence!).writeIndex(copy(value), this.revision); this.value = copy(value); }
    catch (error) { this.poisoned = true; throw error; }
  }
  private sameWriter(saved: PluginStateSnapshot, writer: Writer): boolean {
    return canonical(saved.writer) === canonical(writer.definition.identity) && saved.configurationDigest === writer.configurationDigest;
  }
  private async checkpoint(writer: Writer): Promise<PluginStateSnapshot> {
    if (this.poisoned) fail("plugin_state_recovery_required");
    if (writer.closed || this.writers.get(writer.key) !== writer) fail("plugin_state_owner_lost");
    const pending = this.value.pending, selected = this.selected(writer.entryId);
    // A failed candidate may be disposed after rollback has selected the old head.
    if (selected && this.change!.restoring && !this.change!.originals.has(writer)) {
      const old = pending?.before[writer.key];
      if (!old || !this.sameWriter(await (await this.persistence!).readSnapshot(old), writer)) {
        if (old) return (await this.persistence!).readSnapshot(old);
        if (writer.latest) return copy(writer.latest);
        fail("plugin_state_candidate_retired");
      }
    }
    const value = copy(await writer.definition.snapshot()); writer.definition.validate(copy(value));
    const previous = selected ? pending!.staged[writer.key] ?? pending!.before[writer.key] ?? null : this.value.heads[writer.key] ?? null;
    if (previous) {
      const old = await (await this.persistence!).readSnapshot(previous);
      if (this.sameWriter(old, writer) && canonical(old.value) === canonical(value)) { writer.latest = old; return copy(old); }
    }
    const body = { formatVersion: 1 as const, key: writer.key, writer: writer.definition.identity,
      configurationDigest: writer.configurationDigest, value, previous };
    const saved = snapshot({ ...body, digest: digest(body) });
    await (await this.persistence!).writeSnapshot(saved);
    if (selected && this.change!.originals.has(writer)) {
      await this.save({ heads: { ...this.value.heads, [writer.key]: saved.digest },
        pending: { ...pending!, before: { ...pending!.before, [writer.key]: saved.digest } } });
    } else if (selected) {
      await this.save({ ...this.value, pending: { ...pending!, staged: { ...pending!.staged, [writer.key]: saved.digest } } });
    } else await this.save({ ...this.value, heads: { ...this.value.heads, [writer.key]: saved.digest } });
    writer.latest = saved; return copy(saved);
  }
  private async enqueue<T>(writer: Writer, action: () => Promise<T>): Promise<T> {
    this.assertWritable();
    if (writer.fenced || writer.closed || writer.closing) return Promise.reject(new Error("plugin_state_closed"));
    const work = writer.tail.then(action); writer.tail = work.catch(() => {}); return work;
  }
  private closeWriter(writer: Writer): Promise<void> {
    writer.fenced = true;
    return writer.closing ??= writer.tail.then(() => this.serialize(() => this.checkpoint(writer))).then(() => {
      writer.closed = true; this.writers.delete(writer.key); this.scopes.delete(writer.fiber);
    });
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(action); this.tail = work.catch(() => {}); return work;
  }
  private assertWritable(): void {
    if (this.closed || this.poisoned) fail(this.poisoned ? "plugin_state_recovery_required" : "plugin_state_closed");
  }
  private selected(entryId: string): boolean { return !!this.change && (this.change.selected.has("*") || this.change.selected.has(entryId)); }
}
