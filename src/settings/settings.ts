import { randomUUID } from "node:crypto";
import type { SettingsChange, SettingsDefinition, SettingsPort, SettingsScope, SettingsStore, SettingsView, SettingsWriteRequest } from "./types.js";
import { resolveSettings, SettingsError, settingsSection, validateDefinition } from "./validation.js";

interface Owner { definition: SettingsDefinition; view: SettingsView; active: boolean; writes: number }

/** Schema/namespace owner. No imports from Tools, business modules, Loader, or WebUI. */
export class Settings implements SettingsPort {
  private owners = new Map<string, Owner>();
  private listeners = new Set<(change: SettingsChange) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly store: SettingsStore) {}

  register(input: SettingsDefinition): SettingsScope {
    this.requireOpen();
    const definition = validateDefinition(input);
    if (this.owners.has(definition.namespace)) throw new SettingsError("settings_owner_exists");
    const user = this.store.read().sections[definition.namespace] ?? {};
    const owner: Owner = { definition, view: this.project(definition, user, true), active: true, writes: 0 };
    this.owners.set(definition.namespace, owner);
    this.emit({ namespace: definition.namespace, kind: "registered" });
    const check = () => { this.requireOpen(); if (!owner.active) throw new SettingsError("settings_owner_closed"); };
    return Object.freeze({
      get: () => { check(); return owner.view.value; },
      view: () => { check(); return owner.view; },
      dispose: () => {
        if (!owner.active) return;
        owner.active = false;
        if (!owner.writes) this.owners.delete(definition.namespace);
        this.emit({ namespace: definition.namespace, kind: "removed" });
      },
    });
  }

  describe(): ReturnType<SettingsPort["describe"]> {
    this.requireOpen();
    return Object.freeze({ writable: this.store.writable, sections: Object.freeze([...this.owners.values()].filter(owner => owner.active).map(owner => owner.view)) });
  }
  subscribe(listener: (change: SettingsChange) => void): () => void {
    this.requireOpen(); this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async replace(input: SettingsWriteRequest): Promise<SettingsView> {
    this.requireOpen();
    const request = { namespace: input.namespace, revision: input.revision, user: settingsSection(input.user) };
    const owner = this.owners.get(request.namespace);
    if (!owner?.active) throw new SettingsError("settings_namespace_missing");
    if (!this.store.writable) throw new SettingsError("settings_read_only");
    owner.writes++;
    const run = this.tail.catch(() => {}).then(async () => {
      this.requireOpen();
      if (!owner.active || this.owners.get(request.namespace) !== owner) throw new SettingsError("settings_owner_closed");
      if (request.revision !== owner.view.revision) throw new SettingsError("settings_revision_conflict");
      const next = this.project(owner.definition, request.user);
      const document = this.store.read();
      await this.store.save(document.revision, { ...document.sections, [request.namespace]: request.user });
      // Storage committed even if its initiating owner was removed. A replacement
      // registration is excluded until this operation settles, and reads that commit.
      if (!owner.active || this.closed) throw new SettingsError("settings_saved_owner_closed");
      owner.view = next;
      this.emit({ namespace: request.namespace, kind: "committed" });
      return next;
    }).finally(() => {
      owner.writes--;
      if (!owner.active && !owner.writes) this.owners.delete(request.namespace);
    });
    this.tail = run;
    return run;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.listeners.clear();
    return this.closing = this.tail.catch(() => {}).then(() => this.store.close());
  }
  private requireOpen(): void { if (this.closed) throw new SettingsError("settings_closed"); }
  private project(definition: SettingsDefinition, user: SettingsView["user"], allowStaleEnums = false): SettingsView {
    return Object.freeze({ namespace: definition.namespace, title: definition.title, fields: definition.fields, applies: definition.applies,
      revision: randomUUID(), value: resolveSettings(definition, user, { allowStaleEnums }), base: resolveSettings(definition, {}), user: settingsSection(user) });
  }
  private emit(change: SettingsChange): void {
    for (const listener of [...this.listeners]) {
      try { void Promise.resolve(listener(Object.freeze(change))).catch(() => {}); } catch { /* Observers cannot undo a committed write. */ }
    }
  }
}
