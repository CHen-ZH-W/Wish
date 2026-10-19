import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { FileSubagentExchange } from "../../subagents/files.js";
import { SubagentLauncherService } from "../../subagents/launcher.js";
import { resolveConfiguredModel } from "../../models/config.js";
import { composeAgentScope, eligibleCapabilities } from "../../composition/agent-scope.js";
import type { AgentScopePreset } from "../../composition/agent-preset.js";
import { resourceDigest as digestResource } from "../../subagents/resources.js";
import { MEMORY_SNAPSHOT_RESOURCE } from "../../memory/child-resources.js";
import { TOOL_CAPABILITY_KINDS } from "../../permissions/index.js";
import { canDelegatePermissionProfile } from "../../permissions/delegation.js";
import type { SubagentResource } from "../../subagents/resources.js";
import type {
  SpawnSubagentRequest,
  SubagentLaunch,
  SubagentLauncher,
  SubagentLaunchIdentity,
  SubagentResult,
} from "../../subagents/types.js";

export interface WishCliSubagentLauncherOptions {
  readonly dataDirectory: string;
  readonly cliEntry?: string;
  readonly executable?: string;
  readonly modelsConfigurationPath?: string;
  readonly exchange?: FileSubagentExchange;
  readonly prepareResources?: (request: SpawnSubagentRequest, identity: SubagentLaunchIdentity, scopePreset?: AgentScopePreset) => Promise<readonly SubagentResource[]>;
  /** Host-only resolver; credential values are never part of a spawn request. */
  readonly resolveCredential?: (reference: string) => string | undefined;
}

/** Standalone App adapter used by the Cordis Provider and focused acceptance. */
export class WishCliSubagentLauncherBackend implements SubagentLauncher {
  readonly exchange: FileSubagentExchange;
  private readonly cliEntry: string;
  private readonly executable: string;
  private readonly modelsConfigurationPath: string | undefined;
  private readonly prepareResources: WishCliSubagentLauncherOptions["prepareResources"];
  private readonly resolveCredential: WishCliSubagentLauncherOptions["resolveCredential"];

  constructor(options: WishCliSubagentLauncherOptions) {
    this.exchange = options.exchange ?? new FileSubagentExchange(options.dataDirectory);
    this.cliEntry = options.cliEntry ?? fileURLToPath(
      new URL("./main.js", import.meta.url),
    );
    this.executable = options.executable ?? process.execPath;
    this.modelsConfigurationPath = options.modelsConfigurationPath;
    this.prepareResources = options.prepareResources;
    this.resolveCredential = options.resolveCredential;
  }

  async resolve(
    request: SpawnSubagentRequest,
    identity: SubagentLaunchIdentity,
    scopePreset?: AgentScopePreset,
  ): Promise<SubagentLaunch> {
    const childDataDirectory = this.exchange.childDataDirectory(identity.id);
    const taskFile = await this.exchange.createTask(identity.id, request.task, request.signal);
    let modelsConfigurationPath = this.modelsConfigurationPath;
    let resourceDigest: string | undefined;
    let credentialReferences: readonly string[] = Object.freeze([]);
    let credentialsWritten = false;
    try {
      if (request.modelsConfiguration !== undefined) {
        modelsConfigurationPath = await this.exchange.writeModelsConfiguration(
          identity.id,
          request.modelsConfiguration,
          request.signal,
        );
      }
      credentialReferences = requiredCredentialReferences(request);
      if (credentialReferences.length > 0) {
        if (this.resolveCredential === undefined) {
          throw new Error("Subagent Model credentials cannot be resolved by this Host");
        }
        const values: Record<string, string> = {};
        for (const reference of credentialReferences) {
          const value = this.resolveCredential(reference);
          if (typeof value !== "string" || value.length === 0) {
            throw new Error(`Missing required Subagent Model credential ${reference}`);
          }
          values[reference] = value;
        }
        await this.exchange.writeCredentials(identity, Object.freeze(values), request.signal);
        credentialsWritten = true;
      }
      const prepared = await this.prepareResources?.(request, identity, scopePreset) ?? [];
      const resources = scopePreset?.memory === "none"
        ? prepared.filter(resource => resource.type !== MEMORY_SNAPSHOT_RESOURCE)
        : prepared;
      if (resources.length) {
        const manifest = await this.exchange.writeInputResources(identity, request, resources, request.signal);
        resourceDigest = manifest.digest;
      }
    } catch (error: unknown) {
      await Promise.all([
        this.exchange.removeTask(identity.id),
        ...(resourceDigest === undefined ? [] : [this.exchange.removeInputResources(identity.id)]),
        ...(request.modelsConfiguration === undefined
          ? []
          : [this.exchange.removeModelsConfiguration(identity.id)]),
        ...(credentialsWritten ? [this.exchange.removeCredentials(identity.id)] : []),
      ]);
      throw error;
    }
    const args = [
      this.cliEntry,
      "child",
      "--child-id",
      identity.id,
      "--child-session",
      identity.childSessionId,
      "--child-run",
      identity.childRunId,
      "--prompt-file",
      taskFile,
      "--data-dir",
      childDataDirectory,
      "--exchange-data-dir",
      this.exchange.dataDirectory,
      "--cwd",
      request.workspaceRoot,
      ...(request.model === undefined ? [] : ["--model", request.model]),
      ...(modelsConfigurationPath === undefined
        ? []
        : ["--models-config", modelsConfigurationPath]),
    ];
    const environment: Record<string, string> = {
      WISH_SUBAGENTS_ENABLED: "0",
      WISH_SUBAGENT_TOOLS_ENABLED: "0",
      WISH_WORKFLOW_ENABLED: "0",
      WISH_TASKS_ENABLED: "0",
      WISH_DATA_DIR: childDataDirectory,
      WISH_STORAGE_FILE_ROOT: join(childDataDirectory, "storage"),
      // Empty values deliberately prevent inheriting a grandparent's attachments.
      WISH_CHILD_RESOURCES_FILE: resourceDigest === undefined ? "" : this.exchange.inputResourcesPath(identity.id),
      WISH_CHILD_RESOURCES_DIGEST: resourceDigest ?? "",
      WISH_CHILD_ID: identity.id,
      WISH_CHILD_SESSION_ID: identity.childSessionId,
      WISH_CHILD_RUN_ID: identity.childRunId,
      WISH_CHILD_EXCHANGE_DATA_DIR: this.exchange.dataDirectory,
      // Empty explicitly prevents inheriting an ancestor's credential envelope.
      WISH_CHILD_CREDENTIALS_FILE: credentialsWritten
        ? this.exchange.credentialsPath(identity.id)
        : "",
      WISH_AGENT_SCOPE_PRESET: scopePreset === undefined ? "" : JSON.stringify(scopePreset),
      WISH_AGENT_PRESETS_JSON: "",
    };
    if (scopePreset?.memory === "none") environment.WISH_MEMORY_ENABLED = "0";
    // The one-use file, not the child process environment, carries these values.
    for (const reference of credentialReferences) environment[reference] = "";
    if (request.permissionProfile !== undefined) {
      environment.WISH_PERMISSION_PROFILE = request.permissionProfile;
      if (request.permissionProfile !== "full-access") {
        // A full-access parent may use the unconfined Host Shell. A narrower
        // child needs the native Shell or its profile cannot be enforced.
        environment.WISH_SHELL_PROVIDER = "linux-native";
        environment.WISH_SHELL_HOST_ENABLED = "0";
      }
    }
    if (request.availableTools !== undefined) {
      if (!request.availableTools.length) throw new Error("Cannot launch a child with an empty Tool scope");
      environment.WISH_AVAILABLE_TOOLS = request.availableTools.join(",");
    }
    if (request.allowedCapabilities !== undefined) {
      if (!request.allowedCapabilities.length) throw new Error("Cannot launch a child with an empty capability scope");
      environment.WISH_ALLOWED_CAPABILITIES = request.allowedCapabilities.join(",");
    }
    return Object.freeze({
      ...(scopePreset === undefined ? {} : { scopePresetDigest: digestResource(scopePreset) }),
      ...(resourceDigest === undefined ? {} : { resourceManifestDigest: resourceDigest }),
      windowName: request.role ?? "worker",
      command: Object.freeze({
        executable: this.executable,
        args: Object.freeze(args),
        cwd: request.workspaceRoot,
        environment: Object.freeze(environment),
      }),
      cleanupOnFailure: async () => {
        await Promise.all([
          this.exchange.removeTask(identity.id),
          ...(resourceDigest === undefined ? [] : [this.exchange.removeInputResources(identity.id)]),
          ...(request.modelsConfiguration === undefined
            ? []
            : [this.exchange.removeModelsConfiguration(identity.id)]),
          ...(credentialsWritten ? [this.exchange.removeCredentials(identity.id)] : []),
        ]);
      },
    });
  }

  cleanupLaunchSecrets(identity: SubagentLaunchIdentity): Promise<void> {
    return this.exchange.removeCredentials(identity.id);
  }
  purgeChild(identity: SubagentLaunchIdentity): Promise<void> {
    return this.exchange.purgeChild(identity.id);
  }
}

export interface Config {
  readonly childExecutable?: string;
  readonly childCliEntry?: string;
}

export const Config: s<Config> = s.object({
  childExecutable: s.string(),
  childCliEntry: s.string(),
});

/** Cordis adapter for launching Wish's CLI child surface. */
export class WishCliSubagentLauncher extends SubagentLauncherService {
  static readonly inject = ["launch", "sessions", "models"];
  static readonly Config = Config;
  private readonly backend: WishCliSubagentLauncherBackend;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.work = new PluginWorkOwner(ctx, { code: "subagent_launcher", codeReload: true });
    this.backend = new WishCliSubagentLauncherBackend({
      dataDirectory: ctx.sessions.dataDirectory,
      prepareResources: (request, identity, preset) => this.prepareResources(
        request, identity, preset?.memory === "none" ? ["memory"] : [],
      ),
      ...(config.childExecutable === undefined
        ? {}
        : { executable: config.childExecutable }),
      ...(config.childCliEntry === undefined ? {} : { cliEntry: config.childCliEntry }),
      ...(ctx.launch.environment.WISH_MODELS_CONFIG === undefined
        ? {}
        : { modelsConfigurationPath: ctx.launch.environment.WISH_MODELS_CONFIG }),
      resolveCredential: (reference) => {
        const resolved = ctx.get("credentials")?.resolve(reference);
        if (resolved !== undefined) return resolved;
        const inherited = ctx.launch.environment[reference];
        return typeof inherited === "string" && inherited.length > 0
          ? inherited
          : undefined;
      },
    });
  }

  resolve(request: SpawnSubagentRequest, identity: SubagentLaunchIdentity) {
    return this.work.run(async () => {
      const preset = this.ctx.get("agents")?.presetForRole(request.role);
      const modelsConfiguration = request.modelsConfiguration ?? await this.ctx.models.load({
        dataDirectory: this.ctx.sessions.dataDirectory,
      });
      return this.backend.resolve({ ...request, modelsConfiguration }, identity, preset);
    });
  }

  compose(request: SpawnSubagentRequest): SpawnSubagentRequest {
    this.work.assertAttached();
    const preset = this.ctx.get("agents")?.presetForRole(request.role);
    if (preset?.permissionProfile !== undefined && request.permissionProfile !== undefined &&
        !canDelegatePermissionProfile(request.permissionProfile, preset.permissionProfile)) {
      throw new Error(`Agent Scope role ${preset.role} permission profile exceeds the parent ceiling`);
    }
    const permissionProfile = preset?.permissionProfile ?? request.permissionProfile;
    const delegatedCapabilities = preset?.allowedCapabilities === undefined
      ? request.allowedCapabilities
      : preset.allowedCapabilities.filter(kind => request.allowedCapabilities === undefined || request.allowedCapabilities.includes(kind));
    if (delegatedCapabilities?.length === 0) throw new Error("Agent Scope has no delegated capabilities");
    const tools = this.ctx.get("tools");
    const applicationTools = tools?.registry.list().map(tool => tool.name) ?? [];
    const localTools = preset?.localTools ?? [];
    const registeredTools = [...applicationTools, ...localTools.map(tool => tool.name)];
    const ceiling = [...(request.availableTools ?? applicationTools), ...localTools.map(tool => tool.name)];
    const desired = preset?.availableTools === undefined
      ? (preset === undefined ? request.availableTools : undefined)
      : preset.availableTools.filter(name => ceiling.includes(name));
    if (preset?.availableTools !== undefined && desired?.length === 0) {
      throw new Error(`Agent Scope role ${preset.role} has no Tools within the parent ceiling`);
    }
    const runtimeFeatures = preset?.memory === "none"
      ? this.runtimeFeatures.filter(feature => feature !== "memory.snapshot")
      : this.runtimeFeatures;
    const eligible = eligibleCapabilities(new Set(delegatedCapabilities ?? TOOL_CAPABILITY_KINDS),
      permissionProfile, runtimeFeatures.includes("human.review"));
    const allowedCapabilities = preset === undefined ? delegatedCapabilities :
      (delegatedCapabilities ?? TOOL_CAPABILITY_KINDS).filter(kind => eligible.has(kind));
    if (allowedCapabilities?.length === 0) throw new Error("Agent Scope has no executable capabilities");
    const composition = composeAgentScope({
      availableTools: ceiling,
      ...(desired === undefined ? {} : { requestedTools: desired }),
      registeredTools,
      toolContracts: new Map([
        ...(tools?.getCompositionContracts().entries() ?? []),
        ...localTools.map(tool => [tool.name, tool] as const),
      ]),
      runtimeFeatures,
      allowedCapabilities: allowedCapabilities ?? TOOL_CAPABILITY_KINDS,
      ...(permissionProfile === undefined ? {} : { permissionProfile }),
    });
    const { scopePresetDigest: _previousDigest, ...base } = request;
    return Object.freeze({ ...base, availableTools: composition.availableTools,
      ...(preset === undefined ? {} : { scopePresetDigest: digestResource(preset) }),
      ...(permissionProfile === undefined ? {} : { permissionProfile }),
      ...(allowedCapabilities === undefined ? {} : { allowedCapabilities: Object.freeze([...allowedCapabilities]) }),
    });
  }

  override cleanupLaunchSecrets(identity: SubagentLaunchIdentity): Promise<void> {
    return this.work.runDuringActivation(this.ctx, () => this.backend.cleanupLaunchSecrets(identity));
  }

  override purgeChild(identity: SubagentLaunchIdentity): Promise<void> {
    return this.work.runDuringActivation(this.ctx, () => this.backend.purgeChild(identity));
  }

  override readResult(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    return this.work.runDuringActivation(this.ctx, () => this.backend.exchange.read(id, signal));
  }
}

export default WishCliSubagentLauncher;

function requiredCredentialReferences(
  request: SpawnSubagentRequest,
): readonly string[] {
  const configuration = request.modelsConfiguration;
  if (configuration === undefined) return Object.freeze([]);
  const models = [
    request.model ?? configuration.defaultModel,
    ...configuration.fallbackModels,
  ];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const auth = resolveConfiguredModel(configuration, model).auth;
    if (auth.type === "none" || seen.has(auth.apiKeyEnv)) continue;
    seen.add(auth.apiKeyEnv);
    result.push(auth.apiKeyEnv);
  }
  return Object.freeze(result);
}
