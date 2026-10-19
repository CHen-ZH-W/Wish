import { Service, type Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import { resolveConfiguredModel } from "../models/config.js";
import { canDelegatePermissionProfile } from "../permissions/delegation.js";
import type { WishHostConfiguration } from "../apps/config.js";
import { ProfileRecordStore } from "./store.js";
import { AgentProfileError, digest, freezeJson, identifier, record, validateDefinition, validateSnapshot } from "./validation.js";
import { captureCode, captureComposition, configJson, verifyCode } from "./composition.js";
import type { AgentProfileDefinition, AgentProfileSnapshot, ProfileRunBinding } from "./types.js";
import { createProcessOwner, ownerIsDead, validateProcessOwner } from "./process-owner.js";

export interface Config { readonly definitionsJson?: string }
export const Config: s<Config> = s.object({ definitionsJson: s.string() });

/** Canonical owner of recipes, immutable snapshots and durable Run bindings. */
export class AgentProfiles extends Service {
  static readonly inject = ["storageBackend", "launch"];
  static readonly Config = Config;
  private readonly work: PluginWorkOwner;
  private readonly definitions: ProfileRecordStore<AgentProfileDefinition>;
  private readonly snapshots: ProfileRecordStore<AgentProfileSnapshot>;
  private readonly bindings: ProfileRecordStore<ProfileRunBinding>;
  readonly ready: Promise<void>;
  private readonly instanceId: string;
  private readonly ownership = createProcessOwner();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "agentProfiles");
    this.instanceId = ctx.root.get("pluginInspection")?.inspect().instanceId ?? randomUUID();
    const lease = ctx.storageBackend.acquire(ctx.storageBackend.id, { kv: { list: true } });
    this.definitions = new ProfileRecordStore(lease, lease.id, "agent-profiles/definitions/v1", validateDefinition);
    this.snapshots = new ProfileRecordStore(lease, lease.id, "agent-profiles/snapshots/v1", validateSnapshot);
    this.bindings = new ProfileRecordStore(lease, lease.id, "agent-profiles/bindings/v1", validateBinding);
    this.work = new PluginWorkOwner(ctx, { code: "agent_profiles", codeReload: true, close: async () => { (await this.ownership).release(); lease.release(); } });
    this.ready = Promise.resolve().then(async () => {
      // A process crash never resumes a previously admitted Run implicitly.
      for (const binding of await this.bindings.list()) if (binding.status === "admitted" && await ownerIsDead(binding.owner)) {
        await this.bindings.update(binding.runId, prior => ({ ...prior, status: "interrupted", endedAt: new Date().toISOString() }));
      }
      const definitions: unknown = JSON.parse(config.definitionsJson ?? "[]");
      if (!Array.isArray(definitions)) throw new AgentProfileError("profile_invalid_definitions");
      for (const definition of definitions) { const stable = validateDefinition(definition); await this.definitions.create(`${stable.id}@${stable.version}`, stable); }
    });
    void this.ready.catch(() => {});
    ctx.effect(async () => { await this.ready; return () => {}; }, "agent profiles initialize");
  }

  async register(value: unknown): Promise<AgentProfileDefinition> {
    return this.work.run(async () => { await this.ready; const definition = validateDefinition(value); return this.definitions.create(`${definition.id}@${definition.version}`, definition); });
  }
  async list(): Promise<readonly AgentProfileDefinition[]> { return this.work.run(async () => { await this.ready; return this.definitions.list(); }); }
  async listBindings(): Promise<readonly ProfileRunBinding[]> { return this.work.run(async () => { await this.ready; return this.bindings.list(); }); }
  async get(selection: string): Promise<AgentProfileSnapshot> {
    return this.work.run(async () => {
      await this.ready;
      const snapshot = await this.snapshots.get(selection);
      if (!snapshot) throw new AgentProfileError("profile_snapshot_missing", `Unknown Profile snapshot ${selection}`);
      return snapshot;
    });
  }
  async importSnapshot(value: unknown): Promise<AgentProfileSnapshot> {
    return this.work.run(async () => { await this.ready; const snapshot = validateSnapshot(value); await verifyCode(snapshot.code); return this.snapshots.create(snapshot.digest, snapshot); });
  }

  async capture(selection: string, host: WishHostConfiguration): Promise<AgentProfileSnapshot> {
    return this.work.run(async () => {
      await this.ready;
      if (/^[a-f0-9]{64}$/u.test(selection)) return this.get(selection);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}@[1-9][0-9]*$/u.test(selection)) throw new AgentProfileError("profile_explicit_version_required", "Select id@version or an immutable snapshot digest");
      const definition = await this.definitions.get(selection);
      if (!definition) throw new AgentProfileError("profile_definition_missing");
      const tools = this.ctx.get("tools"), agents = this.ctx.get("agents"), compaction = this.ctx.get("compaction"), prompt = this.ctx.get("systemPrompt"), permissions = this.ctx.get("permissions");
      if (!tools || !agents || !compaction || !prompt || !permissions) throw new AgentProfileError("profile_composition_unavailable");
      const parent = agents.permissions;
      if (!canDelegatePermissionProfile(parent.profile ?? permissions.defaultProfile ?? "approval-required", definition.permissionProfile)) throw new AgentProfileError("profile_permission_escalation");
      const registry = tools.registryFor(agents.scope);
      for (const name of definition.tools) if (!registry.has(name) || (parent.availableTools && !parent.availableTools.includes(name))) throw new AgentProfileError("profile_tool_unavailable", `Profile Tool ${name} is unavailable or exceeds its parent`);
      if (definition.allowedCapabilities?.some(kind => parent.allowedCapabilities && !parent.allowedCapabilities.includes(kind))) throw new AgentProfileError("profile_capability_escalation");
      const model = resolveConfiguredModel(host.models, definition.model).ref;
      const spec = resolveConfiguredModel(host.models, model).spec;
      if (definition.reasoningEffort !== undefined && !spec.reasoningControl?.efforts.includes(definition.reasoningEffort)) throw new AgentProfileError("profile_invalid_reasoning");
      const resolvedModels = { ...host.models, defaultModel: model };
      const composition = captureComposition(this.ctx);
      const code = await captureCode(composition.plugins);
      const body = configJson({
        schemaVersion: 1, runtime: { node: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules }, definition, model, models: resolvedModels,
        instructions: [...host.agentInstructions, ...(definition.instructions === undefined ? [] : [{ id: "agent-profile", authority: "developer", content: definition.instructions }])],
        promptSections: prompt.capture(agents.scope).filter(section => definition.memory !== "none" || !section.id.startsWith("memory")),
        permissions: { profile: definition.permissionProfile, availableTools: definition.tools, allowedCapabilities: definition.allowedCapabilities ?? parent.allowedCapabilities },
        compaction: { strategyId: definition.compaction?.strategyId ?? compaction.strategyId, keepRecentTokens: definition.compaction?.keepRecentTokens ?? host.keepRecentTokens, summaryMaxOutputTokens: definition.compaction?.summaryMaxOutputTokens ?? host.summaryMaxOutputTokens },
        reservedOutputTokens: definition.reservedOutputTokens ?? host.reservedOutputTokens,
        maxParallelCalls: definition.maxParallelCalls ?? this.ctx.get("agentLoop")?.maxParallelCalls ?? 4,
        code, plugins: composition.plugins, deployment: composition.deployment,
      }) as Record<string, unknown>;
      const snapshot = validateSnapshot({ ...body, digest: digest(body) });
      if (spec.contextWindowTokens !== undefined && snapshot.reservedOutputTokens >= spec.contextWindowTokens) throw new AgentProfileError("profile_invalid_context_budget");
      return this.snapshots.create(snapshot.digest, snapshot);
    });
  }

  async bind(snapshotDigest: string, sessionId: string, runId: string): Promise<void> {
    await this.work.run(async () => {
      await this.ready; await this.get(snapshotDigest);
      identifier(sessionId); identifier(runId);
      const prior = await this.bindings.get(runId);
      if (prior) throw new AgentProfileError("profile_run_already_bound");
      await this.bindings.create(runId, { schemaVersion: 1, runId, sessionId, snapshotDigest, instanceId: this.instanceId, owner: (await this.ownership).owner, status: "admitted", startedAt: new Date().toISOString() }, false);
    });
  }
  async finish(runId: string, status: "completed" | "failed" | "aborted"): Promise<void> {
    await this.work.run(async () => {
      await this.bindings.update(runId, current => {
        if (current.status !== "admitted") {
          if (current.status !== status) throw new AgentProfileError("profile_binding_terminal");
          return current;
        }
        return { ...current, status, endedAt: new Date().toISOString() };
      });
    });
  }
}

function validateBinding(value: unknown): ProfileRunBinding {
  const input = record(value);
  if (input.schemaVersion !== 1 || !["admitted", "completed", "failed", "aborted", "interrupted"].includes(String(input.status)) || !/^[a-f0-9]{64}$/u.test(String(input.snapshotDigest)) || !Number.isFinite(Date.parse(String(input.startedAt)))) throw new AgentProfileError("profile_invalid_binding");
  identifier(input.runId); identifier(input.sessionId);
  identifier(input.instanceId);
  validateProcessOwner(input.owner);
  return freezeJson(input) as unknown as ProfileRunBinding;
}

declare module "@deepseek-ai/cordis" { interface Context { agentProfiles: AgentProfiles } }
export default AgentProfiles;
