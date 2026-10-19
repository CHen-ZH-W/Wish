import type { PermissionProfile } from "./types.js";

/** A child may use the parent's profile or a profile with no broader automatic authority. */
export function canDelegatePermissionProfile(
  parent: PermissionProfile,
  child: PermissionProfile,
): boolean {
  const order: readonly PermissionProfile[] = [
    "read-only", "approval-required", "workspace-write", "full-access",
  ];
  const parentIndex = order.indexOf(parent);
  const childIndex = order.indexOf(child);
  return parentIndex >= 0 && childIndex >= 0 && childIndex <= parentIndex;
}
