import { createHash } from "node:crypto";
import type { PluginStateSnapshot, PluginStateValue } from "./types.js";

export class PluginStateError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function fail(code: string): never { throw new PluginStateError(code); }
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 64) fail("plugin_state_invalid_value");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) fail("plugin_state_invalid_value");
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(child => visit(child, depth + 1));
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail("plugin_state_invalid_value");
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    }
    seen.delete(item); return result;
  };
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result) > 8 * 1024 * 1024) fail("plugin_state_too_large");
  return result;
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function copy<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function snapshot(value: unknown): PluginStateSnapshot {
  const item = copy(value) as PluginStateSnapshot;
  if (!item || item.formatVersion !== 1 || typeof item.key !== "string" || !item.key ||
    !item.writer || typeof item.writer.pluginId !== "string" || !item.writer.pluginId ||
    typeof item.writer.pluginVersion !== "string" || !item.writer.pluginVersion || !sha(item.writer.artifactDigest) ||
    !Number.isSafeInteger(item.writer.schemaVersion) || item.writer.schemaVersion < 1 ||
    !sha(item.configurationDigest) || !(item.previous === null || sha(item.previous)) || !sha(item.digest)) fail("plugin_state_corrupt");
  const { digest: expected, ...body } = item;
  if (digest(body) !== expected) fail("plugin_state_corrupt");
  canonical(item.value as PluginStateValue); return item;
}
export function index(value: unknown): import("./types.js").PluginStateIndex {
  const item = copy(value) as import("./types.js").PluginStateIndex;
  const heads = (input: unknown) => input && typeof input === "object" && !Array.isArray(input) && Object.entries(input).every(([key, hash]) => key.length > 0 && sha(hash));
  if (!item || !heads(item.heads) || !(item.pending === null || item.pending && typeof item.pending.requestId === "string" &&
    item.pending.requestId.length > 0 && heads(item.pending.before) && heads(item.pending.staged))) fail("plugin_state_corrupt");
  return item;
}
