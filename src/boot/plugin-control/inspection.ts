import { randomUUID } from "node:crypto";

import { FiberState, type Context, type Fiber } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";

import type {
  PluginDependencyView,
  PluginDisableImpact,
  PluginEntryView,
  PluginFiberView,
  PluginGate,
  PluginInspection,
  PluginInspectionSnapshot,
  PluginPhase,
} from "./types.js";
import { previewPluginSelection } from "./selection.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Root-owned inspection; not an agent-facing Tool or a mutation authority. */
    pluginInspection: PluginInspection;
  }
}

/** Install a read-only port outside the managed application subtree. */
export function installPluginInspection(root: Context): PluginInspection {
  if (root.fiber.uid !== 0) {
    throw new Error("Plugin inspection must be installed on the process Root");
  }
  if (root.get("loader") === undefined) throw new Error("Plugin Loader is unavailable");
  if (root.get("pluginInspection") !== undefined) {
    throw new Error("Plugin inspection is already installed");
  }
  const inspection = new LoaderInspection(root);
  root.provide("pluginInspection", inspection);
  return inspection;
}

class LoaderInspection implements PluginInspection {
  private readonly instanceId = randomUUID();
  private closed = false;

  constructor(private readonly root: Context) {
    root.effect(() => () => { this.closed = true; }, "plugin inspection");
  }

  inspect(): PluginInspectionSnapshot {
    if (this.closed || this.root.fiber.state === FiberState.UNLOADING) {
      throw new Error("Plugin inspection is closed");
    }
    const loader = this.root.get("loader");
    if (loader === undefined) throw new Error("Plugin Loader is unavailable");
    const entries = [...loader.entries()];
    const entrySet = new Set(entries);
    const fibers = new Map<number, Fiber>([[0, this.root.fiber]]);
    for (const runtime of this.root.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.uid !== null) fibers.set(fiber.uid, fiber);
      }
    }
    return Object.freeze({
      instanceId: this.instanceId,
      entries: Object.freeze(entries.map(entryView)),
      fibers: Object.freeze([...fibers.values()]
        .sort((left, right) => left.uid! - right.uid!)
        .map((fiber) => fiberView(fiber, entrySet))),
    });
  }

  previewDisable(entryId: string): PluginDisableImpact {
    const snapshot = this.inspect();
    const target = snapshot.entries.find((entry) => entry.id === entryId);
    if (target === undefined) throw new Error(`Unknown plugin entry: ${entryId}`);
    const impact = previewPluginSelection(snapshot, { instanceId: snapshot.instanceId, entryIds: [target.id] });
    return Object.freeze({
      targetEntryId: target.id,
      snapshot,
      affected: impact.affected,
      coverage: "observed-fibers",
      safety: "not-assessed",
    });
  }
}

function entryView(entry: Entry): PluginEntryView {
  let enabled: boolean | null;
  try {
    enabled = !entry.disabled;
  } catch {
    // A trusted conditional gate may fail while its service is unavailable.
    // Do not leak its expression, config, or error (which can contain secrets).
    enabled = null;
  }
  return Object.freeze({
    id: entry.id,
    name: entry.options.name,
    parentId: entry.parent.ctx.fiber.entry?.id ?? null,
    kind: entry.options.group ? "group" : "plugin",
    gate: gateOf(entry.options.disabled),
    enabled,
    fiberId: entry.fiber?.uid ?? null,
    phase: entry.fiber === undefined ? "absent" : phaseOf(entry.fiber.state),
  });
}

function fiberView(fiber: Fiber, entries: ReadonlySet<Entry>): PluginFiberView {
  const entry = fiber.entry !== undefined && entries.has(fiber.entry) ? fiber.entry : undefined;
  const dependencies: PluginDependencyView[] = Object.keys(fiber.inject).sort().map((service) => {
    const impl = fiber.store?.[service];
    return Object.freeze({
      service,
      providerFiberId: impl?.fiber.uid ?? null,
      binding: impl === undefined ? "unobserved" : "captured",
    });
  });
  return Object.freeze({
    id: fiber.uid!,
    parentId: fiber.uid === 0 ? null : fiber.parent.fiber.uid,
    entryId: entry?.id ?? null,
    // Loader may retain Cordis's contextual Fiber proxy while registry enumeration
    // yields its underlying Fiber. uid is unique inside this Root; Entry identity
    // is already checked above. Object equality would misclassify the root owner.
    entryRoot: entry?.fiber?.uid === fiber.uid,
    phase: phaseOf(fiber.state),
    dependencies: Object.freeze(dependencies),
  });
}

function gateOf(value: unknown): PluginGate {
  if (value === undefined || value === null) return "default";
  if (value === false) return "enabled";
  if (value === true) return "disabled";
  return "conditional";
}

function phaseOf(state: FiberState): PluginPhase {
  switch (state) {
    case FiberState.PENDING: return "pending";
    case FiberState.LOADING: return "loading";
    case FiberState.ACTIVE: return "active";
    case FiberState.FAILED: return "failed";
    case FiberState.DISPOSED: return "disposed";
    case FiberState.UNLOADING: return "unloading";
  }
}
