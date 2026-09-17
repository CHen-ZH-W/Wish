import { resolve } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { createWishWebUiHandler } from "./server.js";
import type {} from "./host/management.js";
import { localDirectoryBrowser } from "../../workspace/directory-picker/local.js";

import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  type StartedWishWebUiServer,
  WebToolApprovalBroker,
} from "./index.js";

export const name = "webui-surface";
export const inject = ["launch", "approval", "approvalRules", "application"];

/** WebUI-owned configuration supplied by its Loader row. */
export interface Config {
  readonly host?: string;
  readonly port?: number;
  readonly workspaceRoot?: string;
}

export const Config: s<Config> = s.object({
  host: s.string(),
  port: s.number().step(1).min(1).max(65_535),
  workspaceRoot: s.string(),
});

interface SurfaceGeneration {
  readonly server: StartedWishWebUiServer;
  dispose(): Promise<void>;
}

interface SurfaceOwner {
  current: SurfaceGeneration | undefined;
  queue: Promise<void>;
}

const surfaceOwners = new WeakMap<Context["fiber"], SurfaceOwner>();

/** Attach business routes to the Root host; unmanaged embeddings expose only the API. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (ctx.launch.surface !== "webui") {
    throw new Error("WebUI surface was mounted for a non-WebUI process");
  }

  const configuration = await loadWishWebUiConfiguration({
    cwd: ctx.launch.cwd,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: resolve(ctx.launch.cwd, config.workspaceRoot) }),
  });
  const approvals = new WebToolApprovalBroker();
  ctx.approval.register(approvals, {
    id: "webui-surface",
    replace: true,
  });
  const application = await ctx.application.open();

  const managementHost = ctx.get("webManagementHost");
  if (managementHost) {
    await ctx.effect(async () => {
      const handler = await createWishWebUiHandler({ application, approvals, approvalRules: ctx.approvalRules,
        workspaceRoot: configuration.workspaceRoot, directoryBrowser: localDirectoryBrowser, onRunGenerationDrainTimeout: error => ctx.launch.fail(error) });
      let registration;
      try { registration = managementHost.register(handler.handle); }
      catch (error) { await handler.close(); throw error; }
      return async () => { registration.release(); await handler.close(); };
    }, "WebUI business handler");
    return;
  }

  let started: StartedWishWebUiServer | undefined;
  await ctx.effect(async () => {
    const generation = await replaceSurface(ctx.fiber, async () => {
      let stopping = false;
      const stopSignals = ctx.launch.onSignal((signal) => {
        if (stopping) return;
        stopping = true;
        process.stderr.write(`Wish WebUI API stopping after ${signal}\n`);
        const exitCode = signal === "SIGINT"
          ? 130
          : signal === "SIGHUP"
          ? 129
          : 143;
        ctx.launch.complete(exitCode);
      });
      try {
        const server = await startWishWebUiServer({
          application,
          approvals,
          approvalRules: ctx.approvalRules,
          workspaceRoot: configuration.workspaceRoot,
          directoryBrowser: localDirectoryBrowser,
          host: configuration.host,
          port: configuration.port,
          onRunGenerationDrainTimeout: (error) => ctx.launch.fail(error),
        });
        return {
          server,
          async dispose(): Promise<void> {
            stopSignals();
            await server.close();
          },
        };
      } catch (error: unknown) {
        stopSignals();
        approvals.close();
        throw error;
      }
    });
    started = generation.server;
    return () => releaseSurface(ctx.fiber, generation);
  }, "WebUI process surface");

  if (started?.server.listening === true) {
    process.stderr.write(`Wish WebUI API listening at ${started.url}\n`);
  }
}

async function replaceSurface(
  fiber: Context["fiber"],
  start: () => Promise<SurfaceGeneration>,
): Promise<SurfaceGeneration> {
  const owner = surfaceOwner(fiber);
  return enqueue(owner, async () => {
    const previous = owner.current;
    owner.current = undefined;
    await previous?.dispose();
    const generation = await start();
    owner.current = generation;
    return generation;
  });
}

async function releaseSurface(
  fiber: Context["fiber"],
  generation: SurfaceGeneration,
): Promise<void> {
  const owner = surfaceOwner(fiber);
  await enqueue(owner, async () => {
    if (owner.current === generation) owner.current = undefined;
    await generation.dispose();
  });
}

function surfaceOwner(fiber: Context["fiber"]): SurfaceOwner {
  let owner = surfaceOwners.get(fiber);
  if (owner === undefined) {
    owner = { current: undefined, queue: Promise.resolve() };
    surfaceOwners.set(fiber, owner);
  }
  return owner;
}

function enqueue<T>(owner: SurfaceOwner, task: () => Promise<T>): Promise<T> {
  const pending = owner.queue.then(task, task);
  owner.queue = pending.then(() => undefined, () => undefined);
  return pending;
}
