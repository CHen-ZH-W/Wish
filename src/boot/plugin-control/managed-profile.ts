import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { FiberState, Service, type Context } from "@deepseek-ai/cordis";
import { EntryGroup, EntryTree, Group, isJsExpr, type Entry, type EntryOptions, type JsExpr } from "@deepseek-ai/cordis-plugin-loader";
import { readManagedProfile } from "./profile-input.js";
import type { ManagedPluginEntryDeclaration, PluginManagementClassifier } from "./classification.js";
import { readWishPluginManifest, type WishPluginManifestView } from "./manifest.js";
import type { ManagedEntryChange, ManagedPluginActivationControl, ManagedPluginPreference, ManagedPluginState } from "./managed-types.js";
import type { PluginPreference } from "./management-types.js";

export class ManagedProfileError extends Error { constructor(readonly code: string) { super(code); } }
type ManagedGate = boolean | null | JsExpr;
interface UserActivationPolicy { readonly activation: "user"; readonly constraint: ManagedGate }
interface ManagedEntryPolicy {
  readonly managementClass?: "managed";
  readonly activation?: UserActivationPolicy;
  readonly manifest?: WishPluginManifestView;
}
type ManagedEntryInput = EntryOptions & { readonly management?: unknown };

/** One validated deployment revision plus a separate preference overlay. No base-file writes. */
export class ManagedProfileSource {
  readonly entries: readonly EntryOptions[];
  private readonly originals = new Map<string, EntryOptions>();
  private readonly activations = new Map<string, UserActivationPolicy>();
  private readonly classifications = new Map<string, ManagedPluginEntryDeclaration>();
  readonly digest: string;
  private readonly fileDigests: ReadonlyMap<string, string>;
  readonly files: readonly string[];
  readonly preferences: ManagedPluginState["preferences"];
  private readonly parents = new Map<string, string>();
  private readonly children = new Map<string, readonly string[]>();
  private readonly classifier: PluginManagementClassifier | undefined;
  constructor(readonly filename: string, readonly rootId: string, readonly state: ManagedPluginState,
    previous?: ManagedProfileSource, classifier?: PluginManagementClassifier) {
    const parsed = readManagedProfile(filename);
    this.classifier = classifier ?? previous?.classifier;
    const fileDigests = new Map(parsed.files);
    const input = parsed.entries;
    if (!Array.isArray(input)) throw new ManagedProfileError("management_profile_invalid");
    const collect = (items: ManagedEntryInput[], parent = rootId): EntryOptions[] => {
      const normalized: EntryOptions[] = [];
      for (const raw of items) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(raw.id) ||
          typeof raw.name !== "string" || !raw.name || this.parents.has(`${rootId}:${raw.id}`) ||
          (raw.group !== undefined && raw.group !== null && typeof raw.group !== "boolean")) {
          throw new ManagedProfileError("management_profile_invalid");
        }
        const id = `${rootId}:${raw.id}`;
        const sourceFilename = parsed.entrySources.get(raw.id);
        if (!sourceFilename) throw new ManagedProfileError("management_profile_invalid");
        const management = managementPolicy(raw.management, !!raw.group, {
          sourceFilename,
          entryName: raw.name,
          config: raw.config,
          trustedClass: this.classifier?.moduleClass(raw.name),
        });
        const { management: _management, ...loaderOptions } = raw;
        const item = structuredClone(loaderOptions) as EntryOptions;
        this.parents.set(id, parent);
        if (management.activation) this.activations.set(id, management.activation);
        if (management.managementClass) this.classifications.set(id, Object.freeze({
          managementClass: management.managementClass,
          ...(management.manifest ? { manifest: management.manifest } : {}),
        }));
        if (management.manifest) {
          const loaded = readWishPluginManifest((raw.management as { manifest: string }).manifest,
            sourceFilename, raw.name, raw.config);
          fileDigests.set(loaded.filename, loaded.digest);
        }
        if (item.group) {
          if (!Array.isArray(raw.config)) throw new ManagedProfileError("management_profile_invalid");
          item.config = collect(raw.config as ManagedEntryInput[], id);
        }
        this.originals.set(id, structuredClone(item));
        normalized.push(item);
      }
      this.children.set(parent, normalized.map(item => `${rootId}:${item.id}`));
      return normalized;
    };
    const entries = collect(structuredClone(input) as ManagedEntryInput[]);
    if (previous) for (const [id, declaration] of this.classifications) {
      const current = declaration.manifest, prior = previous.classifications.get(id)?.manifest;
      if (!current || !prior || current.id !== prior.id) continue;
      if (current.state.mode !== prior.state.mode ||
        (current.state.mode === "versioned" && prior.state.mode === "versioned" &&
          !current.state.readableVersions.includes(prior.state.schemaVersion))) {
        throw new ManagedProfileError("plugin_manifest_state_incompatible");
      }
    }
    this.fileDigests = fileDigests;
    this.files = Object.freeze([...fileDigests.keys()]);
    this.digest = fileDigests.size === parsed.files.size ? parsed.digest : hash(JSON.stringify([...fileDigests]));
    const changes = previous?.changes(this);
    const recovery = state.pending?.configuration;
    if (recovery) {
      const exact = this.digest === recovery.beforeDigest ? "before"
        : this.digest === recovery.afterDigest ? "after" : undefined;
      for (const change of recovery.changes) {
        const actual = this.originals.get(change.entryId);
        const matches = (side: "before" | "after") => {
          const expectedName = side === "after" ? change.afterName : change.beforeName;
          if ((actual?.name ?? null) !== expectedName) return false;
          return change.kind !== "retype" || actual === undefined ||
            !!actual.group === (side === "after" ? change.afterGroup : change.beforeGroup);
        };
        // A later deployment revision may add unrelated entries while a prior
        // configuration intent awaits explicit recovery. Quarantine still
        // disables every retained target before activation, so it is safe to
        // accept that revision only when each uncertain target preserves one
        // of the two recorded identities. A third implementation/type remains
        // fail-closed.
        if (exact ? !matches(exact) : !matches("before") && !matches("after")) {
          throw new ManagedProfileError("management_profile_entry_changed");
        }
      }
    }
    const preferences: Record<string, ManagedPluginPreference> = {};
    for (const [id, preference] of Object.entries(state.preferences)) {
      const change = changes?.find(change => change.entryId === id) ?? recovery?.changes.find(change => change.entryId === id);
      if (this.originals.get(id)?.name === preference.name && change?.kind !== "retype") { preferences[id] = preference; continue; }
      if (!change || (change.beforeName !== preference.name && change.afterName !== preference.name)) {
        throw new ManagedProfileError("management_profile_entry_changed");
      }
    }
    this.preferences = Object.freeze(preferences);
    const pending = new Set(state.pending?.selection.entryIds ?? []);
    for (const id of pending) if (!this.originals.has(id) && !recovery?.changes.some(change => change.entryId === id)) {
      throw new ManagedProfileError("management_profile_entry_changed");
    }
    const overlay = (items: EntryOptions[]) => {
      for (const item of items) {
        const id = `${rootId}:${item.id}`;
        const preference = this.preferences[id]?.preference;
        // Group carriers must mount so their individually quarantined children
        // remain addressable and can later be enabled through normal controls.
        if ((!item.group && pending.has(id)) || preference === "disabled") item.disabled = true;
        else if (preference === "enabled" && this.activations.has(id)) {
          item.disabled = structuredClone(this.activations.get(id)!.constraint) as Exclude<EntryOptions["disabled"], undefined>;
        }
        if (item.group) overlay(item.config);
      }
    };
    overlay(entries); this.entries = entries;
  }
  unchanged(): boolean {
    try { return [...this.fileDigests].every(([file, digest]) => hash(readFileSync(file, "utf8")) === digest); }
    catch { return false; }
  }
  /** Include inherited scope changes; ordering alone does not stop live owners. */
  changes(next: ManagedProfileSource): readonly ManagedEntryChange[] {
    if (this.filename !== next.filename || this.rootId !== next.rootId) {
      throw new ManagedProfileError("management_profile_structure_changed");
    }
    const ids = new Set([...this.originals.keys(), ...next.originals.keys()]);
    const kinds = new Map<string, ManagedEntryChange["kind"]>();
    for (const id of ids) {
      const previous = this.originals.get(id);
      const candidate = next.originals.get(id);
      if (!previous || !candidate) {
        kinds.set(id, previous ? "remove" : "add");
        continue;
      }
      if (!!candidate.group !== !!previous.group) {
        kinds.set(id, "retype");
        continue;
      }
      const { config: oldChildren, ...oldGroup } = previous;
      const { config: newChildren, ...newGroup } = candidate;
      if (!isDeepStrictEqual(previous.group ? oldGroup : { ...oldGroup, config: oldChildren },
        candidate.group ? newGroup : { ...newGroup, config: newChildren }) ||
        this.parent(id) !== next.parent(id) || !isDeepStrictEqual(this.activations.get(id), next.activations.get(id)) ||
        !isDeepStrictEqual(this.classifications.get(id), next.classifications.get(id))) {
        kinds.set(id, previous.name === candidate.name ? "update" : "replace");
      }
    }
    const changedGroups = new Set([...kinds.keys()].filter(id => this.originals.get(id)?.group || next.originals.get(id)?.group));
    for (const id of ids) if (!kinds.has(id) && [...this.ancestors(id), ...next.ancestors(id)].some(parent => changedGroups.has(parent))) {
      kinds.set(id, "update");
    }
    for (const parent of new Set([...this.children.keys(), ...next.children.keys()])) {
      const retained = (source: ManagedProfileSource, other: ManagedProfileSource) =>
        (source.children.get(parent) ?? []).filter(id => other.parent(id) === parent);
      const before = retained(this, next), after = retained(next, this);
      if (!isDeepStrictEqual(before, after)) for (const id of after) if (!kinds.has(id)) kinds.set(id, "reorder");
    }
    return Object.freeze([...kinds].map(([id, kind]): ManagedEntryChange => {
      const identity = { entryId: id, beforeName: this.originals.get(id)?.name ?? null, afterName: next.originals.get(id)?.name ?? null };
      return Object.freeze(kind === "retype"
        ? { ...identity, kind, beforeGroup: !!this.originals.get(id)?.group, afterGroup: !!next.originals.get(id)?.group }
        : { ...identity, kind });
    }));
  }
  ids(): readonly string[] { return [...this.originals.keys()]; }
  parent(id: string): string | undefined { return this.parents.get(id); }
  ancestors(id: string): readonly string[] {
    const result: string[] = [];
    for (let parent = this.parent(id); parent && parent !== this.rootId; parent = this.parent(parent)) result.push(parent);
    return result;
  }
  has(id: string): boolean { return this.originals.has(id); }
  original(id: string): EntryOptions {
    const entry = this.originals.get(id);
    if (!entry) throw new ManagedProfileError("management_entry_unmanaged");
    return structuredClone(entry);
  }
  activation(id: string): UserActivationPolicy | undefined {
    const policy = this.activations.get(id);
    return policy ? structuredClone(policy) : undefined;
  }
  managementClasses(): ReadonlyMap<string, ManagedPluginEntryDeclaration> {
    return new Map(this.classifications);
  }
  materialize(preferences: ManagedPluginState["preferences"]): readonly EntryOptions[] {
    const entries = structuredClone(this.entries) as EntryOptions[];
    const apply = (items: EntryOptions[]) => {
      for (const item of items) {
        const id = `${this.rootId}:${item.id}`;
        if (item.group) apply(item.config);
        else item.disabled = this.gate(id, preferences[id]?.preference ?? "inherit") as Exclude<EntryOptions["disabled"], undefined>;
      }
    };
    apply(entries);
    return entries;
  }
  gate(id: string, preference: PluginPreference): ManagedGate {
    if (preference === "disabled") return true;
    const activation = this.activations.get(id);
    if (preference === "enabled" && activation) return structuredClone(activation.constraint);
    return this.original(id).disabled as ManagedGate | undefined ?? null;
  }
}

/** A separate Loader tree; Include's writer and HMR never own this deployment file. */
export function managedProfilePlugin(source: ManagedProfileSource, ready: (profile: ManagedProfile) => void,
  classifications: PluginManagementClassifier): typeof ManagedProfile {
  return class Profile extends ManagedProfile {
    constructor(ctx: Context) { super(ctx, source, classifications); ready(this); }
  };
}
export class ManagedProfile extends EntryTree {
  static inject = ["loader"];
  static readonly [EntryGroup.key] = true;
  private externalMutation = false;
  private applying = false;
  private readonly classificationOwner = {};
  constructor(ctx: Context, private currentSource: ManagedProfileSource, private readonly classifications: PluginManagementClassifier) {
    super(ctx);
    this.ctx.baseUrl = new URL(".", pathToFileURL(currentSource.filename)).href;
    classifications.replaceEntries(this.classificationOwner, currentSource.managementClasses());
    ctx.effect(() => () => classifications.removeEntries(this.classificationOwner), "managed plugin classifications");
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
    if (!entry || entry.id !== id || entry.options.name !== original.name || entry.options.group || entry.subtree || entry.subgroup) {
      throw new ManagedProfileError("management_entry_unmanaged");
    }
    return entry;
  }
  ownedGroup(id: string): Entry {
    const original = this.source.original(id), entry = this.store[original.id];
    if (!original.group || (original.inject && Object.keys(original.inject).length) || !entry || entry.id !== id ||
      entry.options.name !== original.name || !entry.options.group || entry.subtree ||
      !(entry.subgroup instanceof Group) || entry.fiber?.runtime?.callback !== Group) {
      throw new ManagedProfileError("management_group_unmanaged");
    }
    if (entry._initTask || entry._disposing || entry.fiber.inertia || entry.fiber.state !== FiberState.ACTIVE) {
      throw new ManagedProfileError("management_target_unsettled");
    }
    // The native carrier only owns configuration children. Programmatic mounts
    // must not silently bypass their own stop admission when the carrier moves.
    for (const runtime of this.ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (fiber.uid === null || fiber.parent.fiber.uid !== entry.fiber.uid) continue;
      const child = fiber.entry;
      if (!child || child.fiber?.uid !== fiber.uid || child.parent !== entry.subgroup || !this.source.has(child.id)) {
        throw new ManagedProfileError("management_group_unmanaged");
      }
    }
    return entry;
  }
  /** Validate carriers before the durable intent or any owner cleanup. */
  async prepareStructure(source: ManagedProfileSource): Promise<() => void> {
    const replacements = new Set(this.source.changes(source).filter(change =>
      change.kind === "add" || change.kind === "replace" || change.kind === "retype").map(change => change.entryId));
    for (const id of source.ids()) {
      const options = source.original(id);
      if (!options.group && !replacements.has(id)) continue;
      const plugin = this.ctx.loader.unwrapExports(await this.import(options.name));
      if (options.group && ((options.inject && Object.keys(options.inject).length) || plugin !== Group)) {
        throw new ManagedProfileError("management_group_unmanaged");
      }
      if (!options.group && (plugin?.[EntryGroup.key] || Reflect.get(this.ctx.registry.resolve(plugin) ?? {}, EntryGroup.key))) {
        throw new ManagedProfileError("management_entry_unmanaged");
      }
    }
    const groups = this.source.ids().filter(id => this.source.original(id).group).map(id => {
      const entry = this.ownedGroup(id);
      return { id, entry, fiber: entry.fiber };
    });
    return () => {
      for (const { id, entry, fiber } of groups) if (this.ownedGroup(id) !== entry || entry.fiber !== fiber) {
        throw new ManagedProfileError("management_configuration_changed");
      }
    };
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
  /** Recreate entries from the last committed source after their old owners were closed. */
  async restoreEntries(entries: readonly { readonly id: string; readonly preference: PluginPreference }[]): Promise<void> {
    if (!this.healthy() || this.applying) throw new ManagedProfileError("management_configuration_changed");
    for (const { id } of entries) this.owned(id);
    this.applying = true;
    try {
      // Force disposal of every possibly-partial generation before rebuilding.
      for (const { id } of entries) await this.owned(id).update({ disabled: true }, false, true);
      await this.settleLifecycle();
      for (const { id, preference } of entries) {
        await this.owned(id).update({ disabled: this.source.gate(id, preference) as Exclude<EntryOptions["disabled"], undefined> }, false, true);
      }
      await this.settleLifecycle();
    } finally { this.applying = false; }
  }
  /** Restore a retained configuration object after a partial or committed candidate switch. */
  async restore(source: ManagedProfileSource, preferences: ManagedPluginState["preferences"] = source.preferences): Promise<void> {
    if (!this.healthy() || this.applying || source.filename !== this.source.filename || source.rootId !== this.source.rootId) {
      throw new ManagedProfileError("management_configuration_changed");
    }
    this.applying = true;
    try {
      this.classifications.replaceEntries(this.classificationOwner, source.managementClasses());
      const changes = this.source.changes(source);
      const detached = new Set(changes.filter(change => change.beforeName !== null && change.kind !== "reorder" &&
        (change.afterName === null || change.kind === "retype" || this.source.parent(change.entryId) !== source.parent(change.entryId) ||
          this.source.original(change.entryId).group)).map(change => change.entryId));
      for (const id of detached) {
        if (this.source.ancestors(id).some(parent => detached.has(parent))) continue;
        const entry = this.store[this.source.original(id).id];
        if (entry) await entry.parent.remove(entry.options.id);
      }
      await this.root.update(structuredClone(source.materialize(preferences)) as EntryOptions[]);
      // A candidate Fiber can retain its activation error after a required
      // service disappears and it returns to PENDING. Recovery cares that the
      // old graph has settled and is verified below; replaying that stale error
      // would turn a successful rollback into recovery-required.
      await this.settleLifecycle();
      this.verifySource(source);
      this.currentSource = source;
    } finally { this.applying = false; }
  }
  /** Caller owns configuration serialization and affected-owner stop admission. */
  async replace(source: ManagedProfileSource): Promise<void> {
    if (!this.healthy() || this.applying) throw new ManagedProfileError("management_configuration_changed");
    const changes = this.source.changes(source);
    this.applying = true;
    const previousClasses = this.source.managementClasses();
    try {
      if (changes.length) {
        this.classifications.replaceEntries(this.classificationOwner, source.managementClasses());
        // EntryGroup.update starts siblings before removing old children, and
        // all groups share this.store. Detach old ownership first so an old
        // parent cannot delete a child just adopted by its destination.
        const detached = new Set(changes.filter(change => change.beforeName !== null && change.kind !== "reorder" &&
          (change.afterName === null || change.kind === "retype" || this.source.parent(change.entryId) !== source.parent(change.entryId) ||
            this.source.original(change.entryId).group)).map(change => change.entryId));
        for (const id of detached) {
          if (this.source.ancestors(id).some(parent => detached.has(parent))) continue;
          const entry = this.store[this.source.original(id).id];
          if (!entry) throw new ManagedProfileError("management_configuration_changed");
          await entry.parent.remove(entry.options.id);
        }
        await this.root.update(structuredClone(source.entries) as EntryOptions[]);
        await this.await();
        this.verifySource(source);
      }
      this.currentSource = source;
    } catch (error) {
      this.classifications.replaceEntries(this.classificationOwner, previousClasses);
      throw error;
    } finally { this.applying = false; }
  }
  private verifySource(source: ManagedProfileSource): void {
    const actual = [...this.entries()];
    if (actual.length !== source.ids().length) throw new ManagedProfileError("management_configuration_verification_failed");
    for (const id of source.ids()) {
      const expected = source.original(id), entry = this.store[expected.id];
      const expectedParent = source.parent(id) === source.rootId ? this.root :
        this.store[source.original(source.parent(id)!).id]?.subgroup;
      if (!entry || entry.id !== id || entry.options.name !== expected.name || entry.subtree || entry.parent !== expectedParent ||
        !!entry.options.group !== !!expected.group || (entry.options.group ? !(entry.subgroup instanceof Group) : !!entry.subgroup)) {
        throw new ManagedProfileError("management_configuration_verification_failed");
      }
    }
  }
  /** Wait for imports and dependency propagation without replaying a stale
   * activation error from a Fiber that has already returned to PENDING.
   */
  private async settleLifecycle(): Promise<void> {
    while (true) {
      const tasks = [...this.entries()]
        .map(entry => entry._initTask ?? entry.fiber?.inertia)
        .filter((task): task is Promise<void> => task !== undefined);
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  }
}
function managementPolicy(value: unknown, group: boolean, entry: {
  readonly sourceFilename: string;
  readonly entryName: string;
  readonly config: unknown;
  readonly trustedClass: ReturnType<PluginManagementClassifier["moduleClass"]>;
}): ManagedEntryPolicy {
  if (value === undefined) return {};
  if (group || !value || typeof value !== "object" || Array.isArray(value)) throw new ManagedProfileError("management_profile_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["class", "activation", "constraint", "manifest"].includes(key)) ||
    (input.class !== undefined && input.class !== "managed") ||
    (input.manifest !== undefined && (typeof input.manifest !== "string" || !input.manifest || input.manifest !== input.manifest.trim())) ||
    (input.activation !== undefined && input.activation !== "user") ||
    (input.activation === undefined && input.constraint !== undefined) ||
    (input.class === undefined && input.activation === undefined && input.manifest === undefined)) {
    throw new ManagedProfileError("management_profile_invalid");
  }
  let activation: UserActivationPolicy | undefined;
  if (input.activation === "user") {
    const constraint = input.constraint ?? false;
    if (!(constraint === null || typeof constraint === "boolean" || isJsExpr(constraint))) throw new ManagedProfileError("management_profile_invalid");
    activation = Object.freeze({ activation: "user", constraint: structuredClone(constraint) });
  }
  let manifest: WishPluginManifestView | undefined;
  if (typeof input.manifest === "string") {
    const loaded = readWishPluginManifest(input.manifest, entry.sourceFilename, entry.entryName, entry.config);
    manifest = loaded.view;
  }
  // Catalog modules are trusted by Host metadata. Unknown modules become
  // managed only after their external manifest validates; class alone is not proof.
  const managementClass = entry.trustedClass === "managed" || manifest ? "managed" as const : undefined;
  return Object.freeze({ ...(managementClass ? { managementClass } : {}), ...(manifest ? { manifest } : {}), ...(activation ? { activation } : {}) });
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
