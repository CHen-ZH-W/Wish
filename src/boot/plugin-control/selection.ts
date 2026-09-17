import type { PluginImpactCause, PluginInspectionSnapshot } from "./types.js";
import type { PluginSelection, PluginSelectionImpact } from "./management-types.js";

export class PluginSelectionError extends Error {
  constructor(readonly code: "invalid-selection" | "stale-instance" | "unknown-entry") {
    super(`Plugin selection rejected: ${code}`);
    this.name = "PluginSelectionError";
  }
}

/** Resolve a feature's explicit entry selection against one current observation. */
export function previewPluginSelection(
  snapshot: PluginInspectionSnapshot,
  selection: PluginSelection,
): PluginSelectionImpact {
  if (!selection || typeof selection.instanceId !== "string" ||
    !Array.isArray(selection.entryIds) || selection.entryIds.length === 0 ||
    selection.entryIds.some(id => typeof id !== "string" || !id || id.trim() !== id) ||
    new Set(selection.entryIds).size !== selection.entryIds.length) {
    throw new PluginSelectionError("invalid-selection");
  }
  if (selection.instanceId !== snapshot.instanceId) throw new PluginSelectionError("stale-instance");
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const selected = new Set(selection.entryIds);
  if ([...selected].some(id => !entries.has(id))) throw new PluginSelectionError("unknown-entry");

  const gated = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries.values()) {
      if (!gated.has(entry.id) && entry.parentId !== null && gated.has(entry.parentId)) {
        gated.add(entry.id);
        changed = true;
      }
    }
  }
  const affected = new Map<number, PluginImpactCause>();
  for (const id of gated) {
    const entry = entries.get(id)!;
    // A Group's carrier remains live; its gate applies to configured descendants.
    if (entry.kind !== "group" && entry.fiberId !== null) {
      affected.set(entry.fiberId, Object.freeze({ kind: "target" }));
    }
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const fiber of snapshot.fibers) {
      if (affected.has(fiber.id)) continue;
      if (fiber.parentId !== null && affected.has(fiber.parentId)) {
        affected.set(fiber.id, Object.freeze({ kind: "parent", fiberId: fiber.parentId }));
        changed = true;
        continue;
      }
      const dependency = fiber.dependencies.find(item =>
        item.providerFiberId !== null && affected.has(item.providerFiberId));
      if (dependency?.providerFiberId !== null && dependency?.providerFiberId !== undefined) {
        affected.set(fiber.id, Object.freeze({
          kind: "dependency", fiberId: dependency.providerFiberId, service: dependency.service,
        }));
        changed = true;
      }
    }
  }
  return Object.freeze({
    selection: Object.freeze({ instanceId: selection.instanceId, entryIds: Object.freeze([...selected].sort()) }),
    snapshot,
    gatedEntryIds: Object.freeze([...gated].sort()),
    affected: Object.freeze([...affected].sort(([a], [b]) => a - b)
      .map(([fiberId, cause]) => Object.freeze({ fiberId, cause }))),
    coverage: "observed-fibers",
    safety: "not-assessed",
  });
}
