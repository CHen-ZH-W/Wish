import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import { FileSubagentExchange } from "../../subagents/files.js";
import { SubagentLauncherService } from "../../subagents/launcher.js";
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
  readonly prepareResources?: (request: SpawnSubagentRequest, identity: SubagentLaunchIdentity) => Promise<readonly SubagentResource[]>;
}

/** Standalone App adapter used by the Cordis Provider and focused acceptance. */
export class WishCliSubagentLauncherBackend implements SubagentLauncher {
  readonly exchange: FileSubagentExchange;
  private readonly cliEntry: string;
  private readonly executable: string;
  private readonly modelsConfigurationPath: string | undefined;
  private readonly prepareResources: WishCliSubagentLauncherOptions["prepareResources"];

  constructor(options: WishCliSubagentLauncherOptions) {
    this.exchange = options.exchange ?? new FileSubagentExchange(options.dataDirectory);
    this.cliEntry = options.cliEntry ?? fileURLToPath(
      new URL("./main.js", import.meta.url),
    );
    this.executable = options.executable ?? process.execPath;
    this.modelsConfigurationPath = options.modelsConfigurationPath;
    this.prepareResources = options.prepareResources;
  }

  async resolve(
    request: SpawnSubagentRequest,
    identity: SubagentLaunchIdentity,
  ): Promise<SubagentLaunch> {
    const childDataDirectory = this.exchange.childDataDirectory(identity.id);
    const taskFile = await this.exchange.createTask(identity.id, request.task, request.signal);
    let modelsConfigurationPath = this.modelsConfigurationPath;
    let resourceDigest: string | undefined;
    try {
      if (request.modelsConfiguration !== undefined) {
        modelsConfigurationPath = await this.exchange.writeModelsConfiguration(
          identity.id,
          request.modelsConfiguration,
          request.signal,
        );
      }
      const resources = await this.prepareResources?.(request, identity) ?? [];
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
    };
    if (request.permissionProfile !== undefined) {
      environment.WISH_PERMISSION_PROFILE = request.permissionProfile;
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
        ]);
      },
    });
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
  static readonly inject = ["launch", "sessions"];
  static readonly Config = Config;
  private readonly backend: WishCliSubagentLauncherBackend;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.work = new PluginWorkOwner(ctx, { code: "subagent_launcher", codeReload: true });
    this.backend = new WishCliSubagentLauncherBackend({
      dataDirectory: ctx.sessions.dataDirectory,
      prepareResources: (request, identity) => this.prepareResources(request, identity),
      ...(config.childExecutable === undefined
        ? {}
        : { executable: config.childExecutable }),
      ...(config.childCliEntry === undefined ? {} : { cliEntry: config.childCliEntry }),
      ...(ctx.launch.environment.WISH_MODELS_CONFIG === undefined
        ? {}
        : { modelsConfigurationPath: ctx.launch.environment.WISH_MODELS_CONFIG }),
    });
  }

  resolve(request: SpawnSubagentRequest, identity: SubagentLaunchIdentity) {
    return this.work.run(() => this.backend.resolve(request, identity));
  }

  override readResult(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    return this.work.runDuringActivation(this.ctx, () => this.backend.exchange.read(id, signal));
  }
}

export default WishCliSubagentLauncher;
