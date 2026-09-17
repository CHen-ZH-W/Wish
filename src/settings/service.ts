import { Service, type Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { Settings } from "./settings.js";
import type { SettingsDefinition, SettingsPort, SettingsScope, SettingsStore } from "./types.js";

declare module "@deepseek-ai/cordis" { interface Context { settings: SettingsService } }

/** Cordis assembly seam. The registering module owns its namespace contribution. */
export class SettingsService extends Service {
  readonly port: SettingsPort;
  private readonly registry: Settings;
  private readonly realmId = randomUUID();
  constructor(ctx: Context, store: SettingsStore) {
    super(ctx, "settings");
    this.registry = new Settings(store); this.port = this.registry;
    ctx.effect(() => () => this.registry.close(), "settings persistence");
  }
  register(owner: Context, definition: SettingsDefinition): SettingsScope {
    // Cordis contextual proxies are not object-identical across consumers.
    if (owner.get("settings")?.realmId !== this.realmId) throw new Error("Settings owner must use this service realm");
    const scope = this.registry.register(definition);
    try { owner.effect(() => () => scope.dispose(), `settings:${definition.namespace}`); }
    catch (error) { scope.dispose(); throw error; }
    return scope;
  }
}
