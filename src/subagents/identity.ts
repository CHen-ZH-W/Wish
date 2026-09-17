import { createHash } from "node:crypto";
import { TOOL_CAPABILITY_KINDS } from "../permissions/types.js";
import type { CapabilityKind } from "../permissions/authorization.js";
/** Shared address derivation, not permission to launch or adopt a child. */
export function subagentIdForKey(key: string): string {
  if (!key.trim() || key.length > 4096) throw new Error("Invalid Subagent dispatch key");
  return `dispatch-${createHash("sha256").update(key).digest("hex")}`;
}
export function snapshotChildCapabilities(value: readonly CapabilityKind[]): readonly CapabilityKind[] {
  if (!Array.isArray(value) || value.some(kind => !(TOOL_CAPABILITY_KINDS as readonly string[]).includes(kind)) || new Set(value).size !== value.length) throw new Error("Invalid child capability ceiling");
  return Object.freeze([...value]);
}
