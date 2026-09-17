import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Service, type Context } from "@deepseek-ai/cordis";
import { EntryGroup, EntryTree, isJsExpr, type Entry, type EntryOptions, type JsExpr } from "@deepseek-ai/cordis-plugin-loader";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import type { ManagedPluginActivationControl, ManagedPluginState } from "./managed-types.js";
import type { PluginPreference } from "./management-types.js";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string, options: { schema: unknown }): unknown };
export class ManagedProfileError extends Error { constructor(readonly code: string) { super(code); } }
type ManagedGate = boolean | null | JsExpr;
interface UserActivationPolicy { readonly activation: "user"; readonly constraint: ManagedGate }
type ManagedEntryInput = EntryOptions & { readonly management?: unknown };

/** One validated deployment revision plus a separate preference overlay. No base-file writes. */
export class ManagedProfileSource {
  readonly entries: readonly EntryOptions[];
  private readonly originals = new Map<string, EntryOptions>();
  private readonly activations = new Map<string, UserActivationPolicy>();
  readonly digest: string;
  private readonly parents = new Map<string, string>();
  constructor(readonly filename: string, readonly rootId: string, readonly state: ManagedPluginState) {
    const text = readFileSync(filename, "utf8"); this.digest = hash(text);
    const input = yaml.load(text, { schema: entryListSchema });
    if (!Array.isArray(input)) throw new ManagedProfileError("management_profile_invalid");
    const collect = (items: ManagedEntryInput[], parent = rootId): EntryOptions[] => {
      const normalized: EntryOptions[] = [];
      for (const raw of items) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(raw.id) ||
          typeof raw.name !== "string" || !raw.name || this.originals.has(`${rootId}:${raw.id}`)) {
          throw new ManagedProfileError("management_profile_invalid");
        }
        const id = `${rootId}:${raw.id}`;
        const activation = activationPolicy(raw.management, !!raw.group);
        const { management: _management, ...loaderOptions } = raw;
        const item = structuredClone(loaderOptions) as EntryOptions;
        this.parents.set(id, parent);
        if (activation) this.activations.set(id, activation);
        if (item.group) {
          if (!Array.isArray(raw.config)) throw new ManagedProfileError("management_profile_invalid");
          item.config = collect(raw.config as ManagedEntryInput[], id);
        }
        this.originals.set(id, structuredClone(item));
        normalized.push(item);
      }
      return normalized;
    };
    const entries = collect(structuredClone(input) as ManagedEntryInput[]);
    for (const [id, preference] of Object.entries(state.preferences)) {
      if (this.originals.get(id)?.name !== preference.name) throw new ManagedProfileError("management_profile_entry_changed");
    }
    const pending = new Set(state.pending?.selection.entryIds ?? []);
    for (const id of pending) if (!this.originals.has(id)) throw new ManagedProfileError("management_profile_entry_changed");
    const overlay = (items: EntryOptions[]) => {
      for (const item of items) {
        const id = `${rootId}:${item.id}`;
        const preference = state.preferences[id]?.preference;
        if (pending.has(id) || preference === "disabled") item.disabled = true;
        else if (preference === "enabled" && this.activations.has(id)) {
          item.disabled = structuredClone(this.activations.get(id)!.constraint) as Exclude<EntryOptions["disabled"], undefined>;
        }
        if (item.group) overlay(item.config);
      }
    };
    overlay(entries); this.entries = entries;
  }
  unchanged(): boolean { try { return hash(readFileSync(this.filename, "utf8")) === this.digest; } catch { return false; } }
  /** Shape/identity changes need explicit migration, not silent preference reassignment. */
  changes(next: ManagedProfileSource): readonly string[] {
    if (this.filename !== next.filename || this.rootId !== next.rootId || !isDeepStrictEqual([...this.originals.keys()], [...next.originals.keys()]) ||
      !isDeepStrictEqual([...this.activations], [...next.activations])) {
      throw new ManagedProfileError("management_profile_structure_changed");
    }
    const changed: string[] = [];
    for (const [id, previous] of this.originals) {
      const candidate = next.originals.get(id);
      if (!candidate || candidate.name !== previous.name || !!candidate.group !== !!previous.group || this.parents.get(id) !== next.parents.get(id)) {
        throw new ManagedProfileError("management_profile_structure_changed");
      }
      if (previous.group) {
        const { config: _oldChildren, ...oldGroup } = previous;
        const { config: _newChildren, ...newGroup } = candidate;
        if (!isDeepStrictEqual(oldGroup, newGroup)) throw new ManagedProfileError("management_profile_structure_changed");
      } else if (!isDeepStrictEqual(previous, candidate)) changed.push(id);
    }
    return Object.freeze(changed);
  }
  original(id: string): EntryOptions {
    const entry = this.originals.get(id);
    if (!entry) throw new ManagedProfileError("management_entry_unmanaged");
    return structuredClone(entry);
  }
  activation(id: string): UserActivationPolicy | undefined {
    const policy = this.activations.get(id);
    return policy ? structuredClone(policy) : undefined;
  }
  gate(id: string, preference: PluginPreference): ManagedGate {
    if (preference === "disabled") return true;
    const activation = this.activations.get(id);
    if (preference === "enabled" && activation) return structuredClone(activation.constraint);
    return this.original(id).disabled as ManagedGate | undefined ?? null;
  }
}

/** A separate Loader tree; Include's writer and HMR never own this deployment file. */
export function managedProfilePlugin(source: ManagedProfileSource, ready: (profile: ManagedProfile) => void): typeof ManagedProfile {
  return class Profile extends ManagedProfile {
    constructor(ctx: Context) { super(ctx, source); ready(this); }
  };
}
export class ManagedProfile extends EntryTree {
  static inject = ["loader"];
  static readonly [EntryGroup.key] = true;
  private externalMutation = false;
  private applying = false;
  constructor(ctx: Context, private currentSource: ManagedProfileSource) {
    super(ctx);
    this.ctx.baseUrl = new URL(".", pathToFileURL(currentSource.filename)).href;
  }
  get source(): ManagedProfileSource { return this.currentSource; }
  async* [Service.init]() {
    yield () => this.root.stop();
    await this.root.update(structuredClone(this.source.entries) as EntryOptions[]);
  }
  override write(): void {
    // Never silently persist an out-of-band Loader mutation into the deployment file.
    if (!this.applying) this.externalMutation = true;
  }
  healthy(): boolean { return !this.externalMutation; }
  owned(id: string): Entry {
    const original = this.source.original(id);
    const entry = this.store[original.id];
    if (!entry || entry.id !== id || entry.options.name !== original.name || entry.options.group || entry.subtree) {
      throw new ManagedProfileError("management_entry_unmanaged");
    }
    return entry;
  }
  controls(): Readonly<Record<string, ManagedPluginActivationControl>> {
    const controls: Record<string, ManagedPluginActivationControl> = {};
    for (const entry of this.entries()) {
      if (!entry?.id || !this.source.activation(entry.id)) continue;
      let canEnable = false;
      try {
        const gate = this.source.gate(entry.id, "enabled");
        canEnable = !(isJsExpr(gate) ? Boolean(entry.evaluate(gate.__jsExpr)) : Boolean(gate));
      } catch { /* Invalid or unavailable deployment facts fail closed. */ }
      controls[entry.id] = Object.freeze({ canEnable });
    }
    return Object.freeze(controls);
  }
  async apply(ids: readonly string[], preference: PluginPreference): Promise<void> {
    if (!this.healthy() || this.applying) throw new ManagedProfileError("management_configuration_changed");
    this.applying = true;
    try {
      for (const id of ids) {
        const entry = this.owned(id);
        if (preference !== "disabled" && entry.fiber) {
          if (entry.disabled || JSON.stringify(entry.options.disabled ?? null) !== JSON.stringify(this.source.gate(id, preference))) {
            throw new ManagedProfileError("management_constraint_change_requires_stop");
          }
          continue;
        }
        await entry.update({ disabled: this.source.gate(id, preference) as Exclude<EntryOptions["disabled"], undefined> }, false, true);
      }
      await this.await();
    } finally { this.applying = false; }
  }
  /** Caller owns configuration serialization and affected-owner stop admission. */
  async replace(source: ManagedProfileSource): Promise<void> {
    if (!this.healthy() || this.applying) throw new ManagedProfileError("management_configuration_changed");
    const changes = this.source.changes(source);
    this.applying = true;
    try {
      if (changes.length) {
        await this.root.update(structuredClone(source.entries) as EntryOptions[]);
        await this.await();
      }
      this.currentSource = source;
    } finally { this.applying = false; }
  }
}
function activationPolicy(value: unknown, group: boolean): UserActivationPolicy | undefined {
  if (value === undefined) return undefined;
  if (group || !value || typeof value !== "object" || Array.isArray(value)) throw new ManagedProfileError("management_profile_invalid");
  const input = value as Record<string, unknown>;
  if (input.activation !== "user" || Object.keys(input).some(key => !["activation", "constraint"].includes(key))) {
    throw new ManagedProfileError("management_profile_invalid");
  }
  const constraint = input.constraint ?? false;
  if (!(constraint === null || typeof constraint === "boolean" || isJsExpr(constraint))) throw new ManagedProfileError("management_profile_invalid");
  return Object.freeze({ activation: "user", constraint: structuredClone(constraint) });
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
