import { AsyncLocalStorage } from "node:async_hooks";
import { FiberState, type Context, type Fiber } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import type { PluginLifecycleStatus } from "./management-types.js";
import type { PreparePluginStop } from "./stop-contract.js";
import type { PluginChange } from "./change-coordinator.js";

export type { PluginChange } from "./change-coordinator.js";

export interface PluginChangeGuard {
  /** prepare() has already fenced admission; this settles when accepted work drains. */
  readonly drained: Promise<void>;
  /** Close this generation after it has drained. Must be idempotent. */
  deactivate(): Promise<void>;
  /** Reopen admission only while no irreversible action has started. */
  release(): void;
}

/** Canonical declaration for one Fiber generation. */
export interface PluginOwnerRegistration {
  status(signal: AbortSignal): PluginLifecycleStatus | Promise<PluginLifecycleStatus>;
  prepare(change: PluginChange): PluginChangeGuard;
  readonly replacement: "drain" | "generation";
}

/** Compatibility shape used by the existing code-reload adapter. */
export interface PluginReplacementParticipant {
  prepare(): { readonly drained: Promise<void>; release(): void | Promise<void> };
}

export type PluginLifecycleCoverage = "managed" | "observe-only" | "unregistered";
export type PluginCodeReloadCoverage = "registered" | "restart" | "unregistered";

export interface PluginOwnerCoverage {
  readonly registrationId: number | null;
  readonly lifecycle: PluginLifecycleCoverage;
  readonly codeReload: PluginCodeReloadCoverage;
}

interface LifecycleDeclaration {
  readonly status: PluginOwnerRegistration["status"];
  readonly prepare?: (change: PluginChange) => PluginChangeGuard;
  readonly token: symbol;
}

interface ReplacementDeclaration {
  readonly mode: PluginOwnerRegistration["replacement"] | "restart";
  readonly prepare?: (change: PluginChange) => PluginChangeGuard;
  readonly token: symbol;
}

interface MutableOwnerRecord {
  id: number;
  readonly fiber: Fiber;
  readonly fiberId: number;
  readonly entry: Entry | undefined;
  lifecycle?: LifecycleDeclaration;
  replacement?: ReplacementDeclaration;
}

/** Immutable identity captured by readers across async boundaries. */
export interface PluginOwnerRecord {
  readonly id: number;
  readonly fiber: Fiber;
  readonly fiberId: number;
  readonly entry: Entry | undefined;
  readonly status: PluginOwnerRegistration["status"] | undefined;
  readonly replacement: PluginOwnerRegistration["replacement"] | "restart" | undefined;
  /** True only when lifecycle and replacement came from one canonical declaration. */
  readonly canonical: boolean;
  readonly canDisable: boolean;
  readonly canReplace: boolean;
}

interface OwnerContribution {
  readonly lifecycle?: Omit<LifecycleDeclaration, "token">;
  readonly replacement?: Omit<ReplacementDeclaration, "token">;
}

declare module "@deepseek-ai/cordis" {
  interface Context { pluginOwners: PluginOwnerRegistry }
}

/** Optional public seam: standalone modules remain usable without the Host registry. */
export function registerPluginOwner(owner: Context, registration: PluginOwnerRegistration): void {
  owner.root.get("pluginOwners")?.registerOwner(owner, registration);
}

function canonicalContribution(registration: PluginOwnerRegistration): OwnerContribution {
  return {
    lifecycle: {
      status: registration.status,
      prepare: change => registration.prepare(change),
    },
    replacement: {
      mode: registration.replacement,
      prepare: change => registration.prepare(change),
    },
  };
}

export function installPluginOwnerRegistry(root: Context): PluginOwnerRegistry {
  if (root.fiber.uid !== 0) throw new Error("Plugin owner registry must be installed on the process Root");
  if (root.get("pluginOwners") !== undefined) throw new Error("Plugin owner registry is already installed");
  const registry = new PluginOwnerRegistry(root);
  root.provide("pluginOwners", registry);
  return registry;
}

/** Lifecycle/code adapters use this so their standalone tests still compose either order. */
export function getOrInstallPluginOwnerRegistry(root: Context): PluginOwnerRegistry {
  return root.get("pluginOwners") ?? installPluginOwnerRegistry(root);
}

/** Single source of truth for one Fiber generation's stop and replacement declaration. */
export class PluginOwnerRegistry {
  private readonly records = new Map<Fiber, MutableOwnerRecord>();
  private readonly managedFiberIds = new Set<number>();
  private readonly listeners = new Set<(fiberId: number) => void>();
  private readonly configurationUpdate = new AsyncLocalStorage<boolean>();
  private configurationUpdateTail: Promise<void> = Promise.resolve();
  private nextId = 0;
  private currentRevision = 0;
  private closed = false;

  constructor(private readonly root: Context) {
    const registry = this;
    root.on("internal/update", function (_config, _noSave, next) {
      const candidate = this as Fiber & { readonly fiber?: Fiber };
      const fiber = candidate.fiber ?? candidate;
      if (fiber.uid === null || !registry.managedFiberIds.has(fiber.uid)) return next();
      return registry.serializeConfigurationUpdate(async () => {
        if (fiber.state !== FiberState.ACTIVE) {
          // Another managed sibling may have refreshed this Consumer through
          // dependency propagation after update() entered its waterfall. Let
          // that generation settle before next() starts this update's restart,
          // otherwise epoch old -> inactive -> old can swallow the new config.
          try { await fiber.await(); } catch { /* next() may repair a failed generation. */ }
        }
        const result = await next();
        await fiber.await();
        return result;
      });
    }, { global: true, prepend: true });
    root.effect(() => () => {
      this.closed = true;
      const ids = [...this.records.values()].map(record => record.fiberId);
      this.records.clear();
      this.managedFiberIds.clear();
      this.currentRevision += 1;
      for (const id of ids) this.emit(id);
      this.listeners.clear();
    }, "plugin owner registry");
  }

  get revision(): number { return this.currentRevision; }

  subscribe(listener: (fiberId: number) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  coverage(fiberId: number): PluginOwnerCoverage {
    const record = this.find(fiberId);
    return Object.freeze({
      registrationId: record?.id ?? null,
      lifecycle: record?.lifecycle === undefined ? "unregistered" : record.lifecycle.prepare === undefined ? "observe-only" : "managed",
      codeReload: record?.replacement === undefined ? "unregistered" : record.replacement.mode === "restart" ? "restart" : "registered",
    });
  }

  recordsWithStatus(): readonly PluginOwnerRecord[] {
    return Object.freeze([...this.records.values()].filter(record => record.lifecycle !== undefined).map(record => this.snapshot(record)));
  }

  record(fiberId: number): PluginOwnerRecord | undefined {
    const record = this.find(fiberId);
    return record === undefined ? undefined : this.snapshot(record);
  }

  current(record: PluginOwnerRecord): boolean {
    const current = this.records.get(record.fiber);
    return !this.closed && current !== undefined && current.id === record.id && current.fiberId === record.fiberId &&
      current.entry === record.entry && current.fiber.uid === record.fiberId;
  }

  prepare(record: PluginOwnerRecord, change: PluginChange): PluginChangeGuard {
    this.assertOpen();
    if (!this.current(record)) throw new Error("plugin_owner_changed");
    if (change.kind === "enable") throw new Error("plugin_owner_unsupported");
    const prepare = change.kind === "disable" || change.kind === "reconfigure"
      ? this.records.get(record.fiber)?.lifecycle?.prepare
      : this.records.get(record.fiber)?.replacement?.prepare;
    if (!prepare) throw new Error("plugin_owner_unsupported");
    return validateGuard(prepare(change));
  }

  registerOwner(owner: Context, registration: PluginOwnerRegistration): void {
    if (!registration || typeof registration.status !== "function" || typeof registration.prepare !== "function") {
      throw new TypeError("Plugin owner registration is invalid");
    }
    this.add(owner, canonicalContribution(registration), "plugin owner");
  }

  /** Compatibility adapter for the former lifecycle registration API. */
  registerLifecycle(owner: Context, status: PluginOwnerRegistration["status"], prepare?: PreparePluginStop): void {
    this.add(owner, {
      lifecycle: {
        status,
        ...(prepare ? { prepare: () => {
          const guard = prepare();
          if (!guard || typeof guard.close !== "function" || typeof guard.release !== "function") {
            throw new TypeError("Plugin stop returned an invalid guard");
          }
          return {
            drained: Promise.resolve(),
            deactivate: () => Promise.resolve().then(() => guard.close()),
            release: () => guard.release(),
          };
        } } : {}),
      },
    }, "plugin lifecycle compatibility");
  }

  /** Compatibility adapter for the former code-reload registration API. */
  registerReplacement(owner: Context, participant?: PluginReplacementParticipant): void {
    this.add(owner, {
      replacement: {
        mode: "drain",
        prepare: () => {
          const legacy = participant?.prepare();
          if (legacy && (!legacy.drained || typeof legacy.release !== "function")) {
            throw new TypeError("Code reload returned an invalid guard");
          }
          return {
            drained: Promise.resolve(legacy?.drained),
            deactivate: async () => {},
            release: () => legacy?.release(),
          };
        },
      },
    }, "code reload compatibility");
  }

  /** Compatibility-only debt. A conforming owner must use drain or generation. */
  registerRestart(owner: Context): void {
    this.add(owner, { replacement: { mode: "restart" } }, "process restart compatibility");
  }

  /** One declaration for existing restart-only modules; does not claim managed stop support. */
  registerRestartOwner(owner: Context, status: PluginOwnerRegistration["status"]): void {
    this.add(owner, {
      lifecycle: { status },
      replacement: { mode: "restart" },
    }, "restart owner compatibility");
  }

  private add(owner: Context, contribution: OwnerContribution, label: string): void {
    this.assertOwner(owner);
    if (!contribution.lifecycle && !contribution.replacement) throw new TypeError("Plugin owner declaration is empty");
    if (contribution.lifecycle && typeof contribution.lifecycle.status !== "function") throw new TypeError("Plugin owner requires a status query");
    if (contribution.lifecycle?.prepare !== undefined && typeof contribution.lifecycle.prepare !== "function") {
      throw new TypeError("Plugin owner stop preparation must be a function");
    }
    if (contribution.replacement && !["drain", "generation", "restart"].includes(contribution.replacement.mode)) {
      throw new TypeError("Plugin owner replacement mode is invalid");
    }
    if (contribution.replacement && contribution.replacement.mode !== "restart" && contribution.replacement.prepare !== undefined &&
      typeof contribution.replacement.prepare !== "function") throw new TypeError("Plugin owner replacement preparation must be a function");
    if (contribution.replacement && contribution.replacement.mode !== "restart" && contribution.replacement.prepare === undefined) {
      throw new TypeError("Replaceable plugin owner requires preparation");
    }
    if (contribution.replacement?.mode === "restart" && contribution.replacement.prepare !== undefined) {
      throw new TypeError("Restart plugin owner cannot prepare online replacement");
    }

    const fiber = owner.fiber;
    const token = Symbol(label);
    owner.effect(() => {
      let record = this.records.get(fiber);
      if (!record) {
        record = { id: 0, fiber, fiberId: fiber.uid!, entry: fiber.entry };
        this.records.set(fiber, record);
      }
      if (contribution.lifecycle && record.lifecycle) throw new Error("Plugin owner lifecycle is already registered");
      if (contribution.replacement && record.replacement) throw new Error("Plugin owner replacement is already registered");
      if (contribution.lifecycle) record.lifecycle = { ...contribution.lifecycle, token };
      if (contribution.replacement) record.replacement = { ...contribution.replacement, token };
      this.managedFiberIds.add(record.fiberId);
      this.changed(record);
      return () => this.remove(fiber, token);
    }, label);
  }

  private find(fiberId: number): MutableOwnerRecord | undefined {
    return [...this.records.values()].find(record => record.fiberId === fiberId);
  }

  private snapshot(record: MutableOwnerRecord): PluginOwnerRecord {
    const canonical = record.lifecycle !== undefined && record.replacement !== undefined &&
      record.lifecycle.token === record.replacement.token && record.replacement.mode !== "restart";
    return Object.freeze({
      id: record.id,
      fiber: record.fiber,
      fiberId: record.fiberId,
      entry: record.entry,
      status: record.lifecycle?.status,
      replacement: record.replacement?.mode,
      canonical,
      canDisable: record.lifecycle?.prepare !== undefined,
      canReplace: record.replacement?.mode !== undefined && record.replacement.mode !== "restart" && record.replacement.prepare !== undefined,
    });
  }

  private remove(fiber: Fiber, token: symbol): void {
    const record = this.records.get(fiber);
    if (!record) return;
    let changed = false;
    if (record.lifecycle?.token === token) { delete record.lifecycle; changed = true; }
    if (record.replacement?.token === token) { delete record.replacement; changed = true; }
    if (!changed) return;
    if (!record.lifecycle && !record.replacement) {
      this.records.delete(fiber);
      // Dependency refresh keeps the same live Fiber and must retain its
      // managed update gate. Final disposal clears uid and can forget it.
      if (fiber.uid === null) this.managedFiberIds.delete(record.fiberId);
    }
    this.changed(record);
  }

  private changed(record: MutableOwnerRecord): void {
    record.id = ++this.nextId;
    this.currentRevision += 1;
    this.emit(record.fiberId);
  }

  /** Loader groups update siblings concurrently. Serialize managed Fiber config
   * updates so a Provider cascade cannot re-enter a Consumer that is also updating.
   */
  private serializeConfigurationUpdate<T>(action: () => T | PromiseLike<T>): Promise<T> {
    if (this.configurationUpdate.getStore()) return Promise.resolve(action());
    const execute = () => this.configurationUpdate.run(true, () => Promise.resolve(action()));
    const pending = this.configurationUpdateTail.then(execute, execute);
    this.configurationUpdateTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private emit(fiberId: number): void {
    for (const listener of [...this.listeners]) {
      try { listener(fiberId); } catch { /* Observation cannot govern registration cleanup. */ }
    }
  }

  private assertOwner(owner: Context): void {
    this.assertOpen();
    if (owner.root !== this.root.root) throw new Error("Plugin owner belongs to another Root");
    if (owner.fiber.uid === null || (owner.fiber.state !== FiberState.LOADING && owner.fiber.state !== FiberState.ACTIVE)) {
      throw new Error("Plugin owner is not active");
    }
  }

  private assertOpen(): void {
    if (this.closed || this.root.fiber.state !== FiberState.ACTIVE) throw new Error("Plugin owner registry is closed");
  }
}

function validateGuard(guard: PluginChangeGuard): PluginChangeGuard {
  if (!guard || !guard.drained || typeof guard.deactivate !== "function" || typeof guard.release !== "function") {
    throw new TypeError("Plugin owner returned an invalid change guard");
  }
  return Object.freeze({
    drained: Promise.resolve(guard.drained),
    deactivate: () => Promise.resolve().then(() => guard.deactivate()),
    release: () => guard.release(),
  });
}
