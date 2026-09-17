import type {
  WorkspaceInstruction,
  WorkspaceRepository,
  WorkspaceSnapshot,
} from "./types.js";

/** Validate, copy, and deeply freeze one provider-owned Workspace Snapshot. */
export function snapshotWorkspace(
  value: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (value === null || typeof value !== "object") {
    throw new Error("Workspace Snapshot must be an object");
  }
  if (!Array.isArray(value.instructions)) {
    throw new Error("Workspace Snapshot instructions must be an array");
  }
  const ids = new Set<string>();
  const instructions = value.instructions.map((instruction) => {
    const copy = snapshotInstruction(instruction);
    if (ids.has(copy.id)) {
      throw new Error(`Duplicate Workspace instruction id: ${copy.id}`);
    }
    ids.add(copy.id);
    return copy;
  });
  return Object.freeze({
    requestedRoot: requireText(
      value.requestedRoot,
      "Workspace requestedRoot",
    ),
    root: requireText(value.root, "Workspace root"),
    fingerprint: requireText(
      value.fingerprint,
      "Workspace fingerprint",
    ),
    revision: requireText(value.revision, "Workspace revision"),
    instructions: Object.freeze(instructions),
    ...(value.repository === undefined
      ? {}
      : { repository: snapshotRepository(value.repository) }),
  });
}

function snapshotInstruction(
  instruction: WorkspaceInstruction,
): WorkspaceInstruction {
  if (instruction === null || typeof instruction !== "object") {
    throw new Error("Workspace instructions must contain objects");
  }
  if (instruction.authority !== "developer") {
    throw new Error("Workspace instruction authority must be developer");
  }
  const content = instruction.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Workspace instruction content must not be blank");
  }
  return Object.freeze({
    id: requireText(instruction.id, "Workspace instruction id"),
    authority: "developer" as const,
    source: requireText(instruction.source, "Workspace instruction source"),
    content,
    digest: requireText(
      instruction.digest,
      "Workspace instruction digest",
    ),
  });
}

function snapshotRepository(
  repository: WorkspaceRepository,
): WorkspaceRepository {
  if (repository === null || typeof repository !== "object") {
    throw new Error("Workspace repository must be an object");
  }
  if (repository.kind !== "git") {
    throw new Error("Workspace repository kind must be git");
  }
  return Object.freeze({
    kind: "git" as const,
    root: requireText(repository.root, "Workspace repository root"),
    identity: requireText(
      repository.identity,
      "Workspace repository identity",
    ),
  });
}

function requireText(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}
