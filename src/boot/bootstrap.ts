import { homedir } from "node:os";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Context, FiberState } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-hmr";
import Loader, {
  type Entry,
  type EntryOptions,
} from "@deepseek-ai/cordis-plugin-loader";

import type { ModelEnvironment } from "../models/types.js";
import {
  createLaunch,
  type Launch,
  type ProcessSignal,
  type Surface,
} from "./launch.js";
import { resolveWishConfiguration } from "./configuration.js";
import { createWishPluginManagementClassifier, installWishPluginCatalog } from "./plugin-catalog.js";
import { installPluginInspection } from "./plugin-control/inspection.js";
import type { PluginInspection } from "./plugin-control/types.js";
import { installPluginOwnerRegistry } from "./plugin-control/owner-registry.js";
import { installPluginChangeCoordinator } from "./plugin-control/change-coordinator.js";
import { installPluginLifecycle } from "./plugin-control/lifecycle.js";
import { installPluginStopControl } from "./plugin-control/stop.js";
import type { PluginLifecycleInspection, PluginStopControl } from "./plugin-control/management-types.js";
import { ManagedPluginStore } from "./plugin-control/managed-store.js";
import { ManagedPluginControl } from "./plugin-control/managed-control.js";
import { ManagedProfileSource, managedProfilePlugin } from "./plugin-control/managed-profile.js";
import { initializeDeploymentOverlay } from "./plugin-control/deployment-overlay.js";
import { startManagedConfigurationWatch } from "./plugin-control/config-watch.js";
import { installCodeReload, type CodeReloadInspection } from "./plugin-control/code-reload.js";
import { PluginStateRegistry } from "../plugin-state/registry.js";
import { FilePluginStatePersistence } from "../plugin-state/store.js";
import { verifyPluginContracts } from "../plugin-admission/runtime.js";
import { pluginManifestView, type WishPluginManifest } from "./plugin-control/manifest.js";
import { emptyPluginPolicy, PluginPolicyFollower, SystemPluginPolicy, SystemPluginPolicyError } from "./plugin-control/system-policy.js";

const ROOT_INCLUDE_ID = "include";

export interface BootstrapOptions {
  /** Trusted embedding metadata for isolated candidate Hosts; never a CLI permission grant. */
  readonly pluginManifests?: Readonly<Record<string, WishPluginManifest>>;
  readonly surface: Surface;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly homeDirectory?: string;
  readonly environment?: ModelEnvironment;
  /** Overrides CORDIS_CONFIG and the built-in profile. */
  readonly configurationFile?: string | URL;
  /** Read-only system policy shared with the owning Host; does not share its writer lock. */
  readonly pluginPolicyDirectory?: string;
  /** Explicit single-writer managed composition; policy followers use pluginPolicyDirectory. */
  readonly management?: {
    readonly directory: string;
    /** Root-owned control plane must be started independently of the business tree. */
    start(root: Context, control: ManagedPluginControl, lifecycle: PluginLifecycleInspection): Promise<() => Promise<void>>;
  };
}

export interface BootstrappedProcess {
  /** Process Root Context: owns Loader, launch, signals, and final cleanup. */
  readonly context: Context;
  /** Selected surface's scoped view of the Loader-managed application graph. */
  readonly surfaceContext: Context;
  readonly completion: Promise<number>;
  /** Root-owned observations, available even when an application dependency unloads. */
  readonly plugins: PluginInspection;
  readonly pluginLifecycle: PluginLifecycleInspection;
  /** Fails closed until a managed configuration/recovery adapter is installed at composition. */
  readonly pluginStops: PluginStopControl;
  readonly codeReload: CodeReloadInspection;
  readonly pluginManagement?: ManagedPluginControl;
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
  const configuration = resolveWishConfiguration(
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
  let follower: PluginPolicyFollower | undefined;
  let initialized = false;
  let disposal: Promise<void> | undefined;
  const disposeRoot = () => disposal ??= (async () => {
    await root.fiber.dispose();
    await follower?.close();
  })();

  try {
    root.baseUrl = new URL("./", configuration.url).href;
    root.provide("launch", launch);
    installProcessSignals(root, launch);
    installConfigDiagnostics(root);
    await root.plugin(Loader);
    installWishPluginCatalog(root);
    const pluginClassifications = createWishPluginManagementClassifier();
    if (options.pluginManifests) {
      if (options.management) throw new Error("plugin_manifests_managed_source_required");
      const declarations = new Map(Object.entries(options.pluginManifests).map(([id, value]) => {
        if (!/^include:[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("plugin_manifest_entry_invalid");
        return [id, { managementClass: "managed" as const, manifest: pluginManifestView(value) }] as const;
      }));
      pluginClassifications.replaceEntries(options.pluginManifests, declarations);
      root.effect(() => () => pluginClassifications.removeEntries(options.pluginManifests!), "isolated plugin manifest declarations");
    }
    const plugins = installPluginInspection(root, pluginClassifications);
    installPluginOwnerRegistry(root);
    installPluginChangeCoordinator(root);
    const codeReload = installCodeReload(root, plugins);
    const pluginLifecycle = installPluginLifecycle(root, plugins);
    let management: ManagedPluginControl | undefined;
    const stateDirectory = resolve(environment.WISH_DATA_DIR || resolve(launch.homeDirectory, ".wish"), "plugin-state");
    let stateCommitted = (_requestId: string): boolean => false;
    const pluginState = new PluginStateRegistry(() => FilePluginStatePersistence.open(stateDirectory), requestId => stateCommitted(requestId));
    root.provide("pluginState", pluginState);
    root.effect(() => () => pluginState.close(), "plugin private-state persistence");
    let pluginStops: PluginStopControl;
    if (options.management) {
      const store = await ManagedPluginStore.open(resolve(options.management.directory, "plugins.json"));
      root.provide("systemPluginPolicy", new SystemPluginPolicy(options.management.directory, () => store.snapshot()));
      stateCommitted = requestId => store.snapshot().receipts.some(receipt => receipt.requestId === requestId && receipt.status === "succeeded");
      management = new ManagedPluginControl(root, plugins, store); pluginStops = management.stops;
      root.provide("managedPlugins", management);
      management.attachCodeReload(codeReload);
      root.codeReload.attachTransaction({ run: (signal, batch) => management!.runCodeReload(signal, batch) });
      root.effect(() => () => management!.close(), "managed plugin persistence");
      const stop = await options.management.start(root, management, pluginLifecycle);
      root.effect(() => stop, "independent management surface");
      // Keep watched deployment inputs separate from the manager's frequently
      // renamed journal files; directory watchers must not follow that churn.
      const overlayFilename = resolve(options.management.directory, "deployment", "overlay.json");
      await initializeDeploymentOverlay(overlayFilename);
      const source = new ManagedProfileSource(fileURLToPath(configuration.url), ROOT_INCLUDE_ID, store.snapshot(), undefined, pluginClassifications, overlayFilename);
      root.loader.builtins["wish-managed-profile"] = managedProfilePlugin(source, profile => management!.attach(profile), pluginClassifications);
    } else {
      pluginStops = installPluginStopControl(root, plugins);
      if (options.pluginPolicyDirectory !== undefined) {
        const policy = new SystemPluginPolicy(options.pluginPolicyDirectory);
        root.provide("systemPluginPolicy", policy);
        let overlayFilename: string | undefined = resolve(policy.directory, "deployment", "overlay.json");
        try { await access(overlayFilename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; overlayFilename = undefined; }
        const base = new ManagedProfileSource(fileURLToPath(configuration.url), ROOT_INCLUDE_ID, emptyPluginPolicy,
          undefined, pluginClassifications, overlayFilename);
        follower = await PluginPolicyFollower.open(policy, base.ids(), () => {
          launch.dispatchSignal("SIGTERM");
          if (initialized) void disposeRoot().then(() => launch.complete(143), error => launch.fail(error));
        });
        const preferences = Object.fromEntries(Object.entries(follower.state.preferences).filter(([id]) => base.has(id)));
        const source = new ManagedProfileSource(fileURLToPath(configuration.url), ROOT_INCLUDE_ID,
          { ...follower.state, preferences }, undefined, pluginClassifications, overlayFilename);
        if (preferences[`${ROOT_INCLUDE_ID}:${options.surface}`]?.preference === "disabled") {
          throw new SystemPluginPolicyError(`system_plugin_disabled:${ROOT_INCLUDE_ID}:${options.surface}`);
        }
        root.loader.builtins["wish-managed-profile"] = managedProfilePlugin(source, () => {}, pluginClassifications);
      }
    }

    const rootInclude: EntryOptions = {
      id: ROOT_INCLUDE_ID,
      name: management || follower ? "cordis:wish-managed-profile" : "cordis:include",
      config: { path: configuration.url.href },
    };
    await pluginState.begin(`startup:${Date.now()}`, ["*"]);
    await root.loader.create(rootInclude);
    await root.loader.await();
    for (const entry of plugins.inspect().entries) if (entry.enabled === true && entry.manifest?.contracts) {
      const fiber = entry.fiberId === null ? undefined : root.get("pluginOwners")?.record(entry.fiberId)?.fiber;
      if (!fiber || entry.phase !== "active") throw new Error("plugin_contract_activation_incomplete");
      verifyPluginContracts(root, fiber, entry.manifest);
    }
    await pluginState.finish(true);
    if (follower) {
      await follower.ready(plugins.inspect().entries.filter(entry => entry.enabled === true && entry.id.startsWith(`${ROOT_INCLUDE_ID}:`)).map(entry => entry.id));
      if (root.loader.resolve(`${ROOT_INCLUDE_ID}:${options.surface}`).fiber?.state !== FiberState.ACTIVE) {
        throw new SystemPluginPolicyError(`system_plugin_required_entry_unavailable:${ROOT_INCLUDE_ID}:${options.surface}`);
      }
    }
    const surfaceContext = management || follower
      ? [...root.loader.entries()].find(entry => entry.id === `${ROOT_INCLUDE_ID}:${options.surface}`)?.ctx ?? root
      : assertEntriesActivated(root, options.surface);
    if (management) await startManagedConfigurationWatch(root, management, fileURLToPath(configuration.url));

    initialized = true;
    if (follower?.revoked) throw new SystemPluginPolicyError("system_plugin_policy_revoked");
    return Object.freeze({
      context: root,
      surfaceContext,
      completion: launch.completion,
      plugins,
      pluginLifecycle,
      pluginStops,
      codeReload,
      ...(management ? { pluginManagement: management } : {}),
      dispose(): Promise<void> {
        launch.complete(typeof process.exitCode === "number" ? process.exitCode : 0);
        return disposeRoot();
      },
    });
  } catch (cause: unknown) {
    let failure = cause;
    try { await root.get("pluginState")?.rollback(); await root.get("pluginState")?.finish(false); }
    catch (error) { failure = new AggregateError([failure, error], "plugin_state_startup_recovery_failed"); }
    try { await disposeRoot(); }
    catch (error) { failure = new AggregateError([failure, error], "bootstrap_cleanup_failed"); }
    const detail = failure instanceof Error ? failure.message : String(failure);
    throw new BootstrapError(
      `${options.surface} bootstrap failed: ${detail}`,
      { cause: failure },
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
