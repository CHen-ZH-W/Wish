import { Service, type Context } from "@deepseek-ai/cordis";

import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { SettingsScope } from "../settings/types.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import { StorageConflictError } from "../storage/errors.js";
import { KV_ABSENT, type KvPrecondition } from "../storage/kv.js";
import type { ShellPolicy } from "../shell/types.js";
import { DEFAULT_PERMISSION_PROFILE } from "./providers/default.js";
import { PERMISSION_PROFILES, type PermissionProfile } from "./types.js";
import type {} from "../settings/service.js";
import type {} from "../storage/binding.js";
import type {} from "../composition/agent-service.js";
import type {} from "../shell/service.js";

export interface SessionPermissionProfileSelection {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly profile: PermissionProfile;
}

export interface SessionPermissionProfileView {
  readonly availableProfiles: readonly PermissionProfile[];
  readonly selected: PermissionProfile;
  readonly source: "default" | "session" | "deployment";
  readonly shellBackend: ShellPolicy["backend"];
  readonly workspaceIsolation: boolean;
}

export interface SessionPermissionProfilesPort {
  inspectDefault(): SessionPermissionProfileView;
  inspect(sessionId: string, signal?: AbortSignal): Promise<SessionPermissionProfileView>;
  initialize(sessionId: string, profile?: PermissionProfile, signal?: AbortSignal): Promise<SessionPermissionProfileView>;
  select(sessionId: string, profile: PermissionProfile, signal?: AbortSignal): Promise<SessionPermissionProfileView>;
  forRun(sessionId: string, signal?: AbortSignal): Promise<PermissionProfile>;
  clear(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export interface SessionPermissionProfileStore {
  get(sessionId: string, signal?: AbortSignal): Promise<{ readonly value: SessionPermissionProfileSelection; readonly revision: string } | undefined>;
  put(selection: SessionPermissionProfileSelection, revision: string | undefined, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, revision: string, signal?: AbortSignal): Promise<void>;
}

export class SessionPermissionProfileUnavailableError extends Error {
  constructor(readonly profile: PermissionProfile) {
    super(`Permission profile ${JSON.stringify(profile)} is unavailable with the active Shell`);
    this.name = "SessionPermissionProfileUnavailableError";
  }
}

const domainSpec: DomainSpec<string, SessionPermissionProfileSelection> = Object.freeze({
  id: "permissions/session-profile",
  schemaVersion: 1,
  shape: "keyed" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve(sessionId: string) {
    return Object.freeze({ key: validSessionId(sessionId), default: DOMAIN_ABSENT });
  },
  encode(value: SessionPermissionProfileSelection) {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(payload: Uint8Array): unknown {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  },
  validate(value: unknown): SessionPermissionProfileSelection {
    return validSelection(value);
  },
});

export class DomainSessionPermissionProfileStore implements SessionPermissionProfileStore {
  private readonly domain: StorageDomain<string, SessionPermissionProfileSelection>;

  constructor(storage: StorageBackendResolver, backendId: string) {
    this.domain = new StorageDomain({ storage, backendId, spec: domainSpec });
  }

  async get(sessionId: string, signal?: AbortSignal) {
    const entry = await this.domain.resolve(sessionId).load(signal);
    if (entry === undefined) return undefined;
    if (entry.value.sessionId !== sessionId || entry.revision === undefined) {
      throw new Error("Session permission profile selection is corrupt");
    }
    return Object.freeze({ value: entry.value, revision: entry.revision });
  }

  async put(
    selection: SessionPermissionProfileSelection,
    revision: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const precondition: KvPrecondition = revision === undefined
      ? KV_ABSENT
      : { kind: "revision", revision };
    await this.domain.resolve(selection.sessionId).save(selection, precondition, signal);
  }
  async delete(sessionId: string, revision: string, signal?: AbortSignal): Promise<void> {
    await this.domain.resolve(sessionId).delete({ kind: "revision", revision }, signal);
  }
}

export class LeasedSessionPermissionProfileStore implements SessionPermissionProfileStore {
  constructor(private readonly current: () => { readonly storage: StorageBackendResolver; readonly backendId: string }) {}

  get(sessionId: string, signal?: AbortSignal) {
    return this.withStore((store) => store.get(sessionId, signal));
  }

  put(selection: SessionPermissionProfileSelection, revision: string | undefined, signal?: AbortSignal): Promise<void> {
    return this.withStore((store) => store.put(selection, revision, signal));
  }
  delete(sessionId: string, revision: string, signal?: AbortSignal): Promise<void> {
    return this.withStore((store) => store.delete(sessionId, revision, signal));
  }

  private async withStore<T>(action: (store: DomainSessionPermissionProfileStore) => Promise<T>): Promise<T> {
    const current = this.current();
    const lease = current.storage.acquire(current.backendId, domainSpec.requirements);
    try {
      return await action(new DomainSessionPermissionProfileStore(lease, current.backendId));
    } finally {
      lease.release();
    }
  }
}

/** Permissions-owned durable Session choice. The general default is consulted
 * only while a new Session is initialized; legacy Sessions keep deployment behavior.
 */
export class SessionPermissionProfiles implements SessionPermissionProfilesPort {
  private readonly available: readonly PermissionProfile[];

  constructor(
    private readonly store: SessionPermissionProfileStore,
    private readonly deploymentDefault: PermissionProfile,
    private readonly defaultProfile: () => PermissionProfile,
    private readonly shellPolicy: ShellPolicy,
  ) {
    this.available = availablePermissionProfiles(shellPolicy);
    requireAvailableProfile(deploymentDefault, this.available);
  }

  inspectDefault(): SessionPermissionProfileView {
    return this.view(requireAvailableProfile(this.defaultProfile(), this.available), "default");
  }

  async inspect(sessionId: string, signal?: AbortSignal): Promise<SessionPermissionProfileView> {
    const stored = await this.store.get(validSessionId(sessionId), signal);
    if (stored === undefined) return this.view(this.deploymentDefault, "deployment");
    return this.view(requireAvailableProfile(stored.value.profile, this.available), "session");
  }

  async initialize(sessionId: string, profile?: PermissionProfile, signal?: AbortSignal): Promise<SessionPermissionProfileView> {
    const id = validSessionId(sessionId);
    const existing = await this.store.get(id, signal);
    if (existing !== undefined) return this.view(requireAvailableProfile(existing.value.profile, this.available), "session");
    const selected = requireAvailableProfile(profile ?? this.defaultProfile(), this.available);
    try {
      await this.store.put(Object.freeze({ schemaVersion: 1, sessionId: id, profile: selected }), undefined, signal);
    } catch (error) {
      if (!(error instanceof StorageConflictError)) throw error;
    }
    return this.inspect(id, signal);
  }

  async select(sessionId: string, profile: PermissionProfile, signal?: AbortSignal): Promise<SessionPermissionProfileView> {
    const id = validSessionId(sessionId);
    const selected = requireAvailableProfile(profile, this.available);
    const current = await this.store.get(id, signal);
    if (current?.value.profile === selected) return this.view(selected, "session");
    await this.store.put(Object.freeze({ schemaVersion: 1, sessionId: id, profile: selected }), current?.revision, signal);
    return this.view(selected, "session");
  }

  async forRun(sessionId: string, signal?: AbortSignal): Promise<PermissionProfile> {
    return (await this.inspect(sessionId, signal)).selected;
  }
  async clear(sessionId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.store.get(validSessionId(sessionId), signal);
    if (current) await this.store.delete(sessionId, current.revision, signal);
  }

  private view(selected: PermissionProfile, source: SessionPermissionProfileView["source"]): SessionPermissionProfileView {
    return Object.freeze({
      availableProfiles: this.available,
      selected,
      source,
      shellBackend: this.shellPolicy.backend,
      workspaceIsolation: this.shellPolicy.filesystem === "path-scoped" && selected === "workspace-write",
    });
  }
}

/** Product service that binds the active Shell catalog, Settings default and durable Storage. */
export class SessionPermissions extends Service {
  static readonly inject = ["launch", "storageBackend", "permissions", "shell", "agents"];

  readonly port: SessionPermissionProfilesPort;
  private readonly work: PluginWorkOwner;
  private readonly settingsScope: SettingsScope | undefined;

  constructor(ctx: Context) {
    super(ctx, "sessionPermissions");
    this.work = new PluginWorkOwner(ctx, { code: "session_permissions", codeReload: true });
    const available = availablePermissionProfiles(ctx.shell.policy);
    const deploymentDefault = requireAvailableProfile(
      ctx.agents.permissions.profile ?? ctx.permissions.defaultProfile ?? DEFAULT_PERMISSION_PROFILE,
      available,
    );
    const settings = ctx.launch.surface === "webui" ? ctx.get("settings") : undefined;
    this.settingsScope = settings?.register(ctx, {
      namespace: "permissions",
      title: "权限",
      applies: "new-session",
      fields: [{
        key: "default-profile",
        label: "新会话默认权限",
        description: "只影响之后创建的会话；完全访问会关闭工作区隔离，并暴露宿主文件、网络和环境变量。",
        type: "enum",
        options: available.map((profile) => Object.freeze({ value: profile, label: permissionProfileLabel(profile) })),
        default: deploymentDefault,
      }],
    });
    const store = new LeasedSessionPermissionProfileStore(() => {
      this.work.assertAttached();
      const current = ctx.get("storageBackend");
      if (current === undefined) throw new Error("Session permission profile storage is unavailable");
      return { storage: current, backendId: current.id };
    });
    this.port = new SessionPermissionProfiles(
      store,
      deploymentDefault,
      () => {
        const value = this.settingsScope?.get()["default-profile"];
        return typeof value === "string" && isPermissionProfile(value)
          ? value
          : deploymentDefault;
      },
      ctx.shell.policy,
    );
  }
}

export function availablePermissionProfiles(policy: ShellPolicy): readonly PermissionProfile[] {
  if (policy.backend === "host") {
    return Object.freeze(policy.automaticPermissionProfiles.includes("full-access") ? ["full-access"] : []);
  }
  const profiles: PermissionProfile[] = ["read-only", "approval-required"];
  if (policy.automaticPermissionProfiles.includes("workspace-write") && policy.filesystem === "path-scoped") {
    profiles.push("workspace-write");
  }
  if (policy.automaticPermissionProfiles.includes("full-access")) {
    profiles.push("full-access");
  }
  return Object.freeze(profiles);
}

function permissionProfileLabel(profile: PermissionProfile): string {
  switch (profile) {
    case "read-only": return "只读";
    case "approval-required": return "需要审批";
    case "workspace-write": return "工作区可写";
    case "full-access": return "完全访问（无隔离）";
  }
}

function requireAvailableProfile(profile: PermissionProfile, available: readonly PermissionProfile[]): PermissionProfile {
  if (!available.includes(profile)) throw new SessionPermissionProfileUnavailableError(profile);
  return profile;
}

function isPermissionProfile(value: string): value is PermissionProfile {
  return (PERMISSION_PROFILES as readonly string[]).includes(value);
}

function validSessionId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("Invalid Session id for permission profile selection");
  }
  return value;
}

function validSelection(value: unknown): SessionPermissionProfileSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Session permission profile selection");
  }
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.sessionId !== "string" || typeof item.profile !== "string" || !isPermissionProfile(item.profile)) {
    throw new Error("Invalid Session permission profile selection");
  }
  return Object.freeze({
    schemaVersion: 1,
    sessionId: validSessionId(item.sessionId),
    profile: item.profile,
  });
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionPermissions: SessionPermissions;
  }
}

export default SessionPermissions;
