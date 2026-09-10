import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Context, FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, {
  type Entry,
  type EntryOptions,
} from "@deepseek-ai/cordis-plugin-loader";
import Timer from "@deepseek-ai/cordis-plugin-timer";

import type { ModelEnvironment } from "../models/types.js";
import Agents from "../core/agent/service.js";
import AgentLoop from "../core/agent-loop/service.js";
import {
  createLaunch,
  type ConfigurationSource,
  type Launch,
  type ProcessSignal,
  type Surface,
} from "./launch.js";
import * as Cli from "../apps/cli/plugin.js";
import Application from "../apps/service.js";
import * as WebUi from "../apps/webui/plugin.js";
import Compaction from "../compaction/service.js";
import ContextEngine from "../context/service.js";
import * as ModelPlugins from "../models/plugins.js";
import Models from "../models/service.js";
import Runtime from "../core/runtime/service.js";
import Sessions from "../sessions/service.js";
import * as BasicToolPlugins from "../tools/plugins.js";
import Tools from "../tools/service.js";

const DEFAULT_CONFIGURATION_URL = new URL("../config/cordis.yml", import.meta.url);
const ROOT_INCLUDE_ID = "include";

export interface BootstrapOptions {
  readonly surface: Surface;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly environment?: ModelEnvironment;
  /** Overrides CORDIS_CONFIG and the built-in profile. */
  readonly configurationFile?: string | URL;
}

export interface BootstrappedProcess {
  /** Process Root Context: owns Loader, launch, signals, and final cleanup. */
  readonly context: Context;
  /** Selected surface's scoped view of the Loader-managed application graph. */
  readonly surfaceContext: Context;
  readonly completion: Promise<number>;
  dispose(): Promise<void>;
}

export class BootstrapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BootstrapError";
  }
}

/**
 * Create the process Root Context and mount the selected surface exclusively
 * through Loader -> Include -> cordis.yml.
 */
export async function bootstrap(
  options: BootstrapOptions,
): Promise<BootstrappedProcess> {
  requireSurface(options.surface);
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const configuration = resolveConfiguration(
    options.configurationFile,
    environment,
    cwd,
  );
  const root = new Context();
  const launch = createLaunch({
    surface: options.surface,
    argv: snapshotArguments(options.argv ?? []),
    cwd,
    homeDirectory: resolve(options.homeDirectory ?? homedir()),
    environment,
    configurationFile: fileURLToPath(configuration.url),
    configurationSource: configuration.source,
  });

  try {
    root.baseUrl = new URL("./", configuration.url).href;
    root.provide("launch", launch);
    installProcessSignals(root, launch);
    installConfigDiagnostics(root);
    await root.plugin(Loader);
    installBuiltins(root);

    const rootInclude: EntryOptions = {
      id: ROOT_INCLUDE_ID,
      name: "cordis:include",
      config: { path: configuration.url.href },
    };
    await root.loader.create(rootInclude);
    await root.loader.await();
    const surfaceContext = assertEntriesActivated(root, options.surface);

    let disposal: Promise<void> | undefined;
    return Object.freeze({
      context: root,
      surfaceContext,
      completion: launch.completion,
      dispose(): Promise<void> {
        launch.complete(typeof process.exitCode === "number" ? process.exitCode : 0);
        return disposal ??= root.fiber.dispose();
      },
    });
  } catch (cause: unknown) {
    await root.fiber.dispose();
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BootstrapError(
      `${options.surface} bootstrap failed: ${detail}`,
      { cause },
    );
  }
}

function installConfigDiagnostics(root: Context): void {
  root.on("hmr/config-update-failed", (filename, error) => {
    process.stderr.write(
      `Cordis config reload failed at ${filename}: ${error.message}\n`,
    );
  }, { global: true });
}

function installBuiltins(root: Context): void {
  root.loader.builtins.include = Include;
  root.loader.builtins.group = Group;
  root.loader.builtins.timer = Timer;
  root.loader.builtins.hmr = Hmr;
  root.loader.builtins.sessions = Sessions;
  root.loader.builtins.models = Models;
  root.loader.builtins["model-openai-chat-completions"] =
    ModelPlugins.OpenAIChatCompletions;
  root.loader.builtins["model-openai-responses"] = ModelPlugins.OpenAIResponses;
  root.loader.builtins["model-anthropic-messages"] = ModelPlugins.AnthropicMessages;
  root.loader.builtins["context-engine"] = ContextEngine;
  root.loader.builtins.compaction = Compaction;
  root.loader.builtins.tools = Tools;
  root.loader.builtins.read = BasicToolPlugins.Read;
  root.loader.builtins.write = BasicToolPlugins.Write;
  root.loader.builtins.edit = BasicToolPlugins.Edit;
  root.loader.builtins.grep = BasicToolPlugins.Grep;
  root.loader.builtins.bash = BasicToolPlugins.Bash;
  root.loader.builtins["agent-loop"] = AgentLoop;
  root.loader.builtins.runtime = Runtime;
  root.loader.builtins.agents = Agents;
  root.loader.builtins.application = Application;
  root.loader.builtins.cli = Cli;
  root.loader.builtins.webui = WebUi;
}

function installProcessSignals(root: Context, launch: Launch): void {
  const signals: ProcessSignal[] = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  root.effect(() => {
    const handlers = new Map<ProcessSignal, () => void>();
    for (const signal of signals) {
      const handler = () => launch.dispatchSignal(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    return () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
  }, "process signals");
}

function assertEntriesActivated(
  root: Context,
  surface: Surface,
): Context {
  const failures = new Map<string, string>();
  for (const entry of root.loader.entries()) {
    if (entry.disabled) continue;
    const state = entry.fiber?.state;
    if (state === FiberState.ACTIVE) continue;
    failures.set(entry.id, describeInactiveEntry(entry));
  }

  const selectedId = `${ROOT_INCLUDE_ID}:${surface}`;
  let selected: Entry | undefined;
  try {
    selected = root.loader.resolve(selectedId);
  } catch {
    failures.set(selectedId, `${selectedId}: missing selected surface entry`);
  }
  if (selected?.disabled === true) {
    failures.set(selectedId, `${selectedId}: selected surface entry is disabled`);
  } else if (selected !== undefined && selected.fiber?.state !== FiberState.ACTIVE) {
    failures.set(selectedId, describeInactiveEntry(selected));
  }

  if (failures.size > 0) {
    throw new Error(
      `${failures.size} Loader ${failures.size === 1 ? "entry" : "entries"} did not activate\n` +
        [...failures.values()].join("\n"),
    );
  }
  return selected!.ctx;
}

function describeInactiveEntry(entry: Entry): string {
  const fiber = entry.fiber;
  if (fiber === undefined) return `${entry.id}: missing fiber`;
  if (fiber.state !== FiberState.PENDING) {
    return `${entry.id}: fiber state ${fiber.state}`;
  }
  const missing = Object.keys(fiber.inject).filter(
    (service) => fiber.ctx.get(service) === undefined,
  );
  return `${entry.id}: pending (waiting for ${missing.join(", ") || "unknown service"})`;
}

interface ResolvedConfiguration {
  readonly url: URL;
  readonly source: ConfigurationSource;
}

function resolveConfiguration(
  input: string | URL | undefined,
  environment: ModelEnvironment,
  cwd: string,
): ResolvedConfiguration {
  let source: ConfigurationSource = "option";
  if (input === undefined) {
    const configured = environment.CORDIS_CONFIG;
    if (configured === undefined) {
      return Object.freeze({
        url: new URL(DEFAULT_CONFIGURATION_URL.href),
        source: "built-in",
      });
    }
    input = requireConfigurationPath(configured, "CORDIS_CONFIG");
    source = "environment";
  }

  const url = input instanceof URL
    ? new URL(input.href)
    : pathToFileURL(isAbsolute(input)
      ? requireConfigurationPath(input, "Cordis configuration")
      : resolve(cwd, requireConfigurationPath(input, "Cordis configuration")));
  if (url.protocol !== "file:") {
    throw new TypeError("Cordis configuration must be a local file");
  }
  return Object.freeze({ url, source });
}

function requireConfigurationPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty trimmed path`);
  }
  return value;
}

function snapshotArguments(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new TypeError("Process arguments must be an array of strings");
  }
  return Object.freeze([...input]);
}

function requireSurface(surface: Surface): void {
  if (surface !== "cli" && surface !== "webui") {
    throw new TypeError(`Unsupported process surface: ${String(surface)}`);
  }
}
