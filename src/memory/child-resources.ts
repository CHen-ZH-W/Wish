import { snapshotResourceManifest, type SubagentResourceManifest } from "../subagents/resources.js";
import type { MemoryCandidate, MemorySnapshot, MemoryState } from "./types.js";
import { document, identity, snapshotState, version } from "./validation.js";

export const MEMORY_SNAPSHOT_RESOURCE = "wish.memory.snapshot";
export const MEMORY_CANDIDATES_RESOURCE = "wish.memory.candidates";
export const MAX_CHILD_MEMORY_CANDIDATES = 32;

export interface ChildMemoryInput {
  readonly snapshot: MemorySnapshot;
  readonly allowProposals: boolean;
}

export function childMemoryInput(manifest: SubagentResourceManifest): ChildMemoryInput {
  const resource = snapshotResourceManifest(manifest).resources.find(item => item.type === MEMORY_SNAPSHOT_RESOURCE);
  const value = resource?.payload as ChildMemoryInput;
  if (resource?.schemaVersion !== 1 || !value || typeof value.allowProposals !== "boolean" || value.snapshot?.schemaVersion !== 1 || !Array.isArray(value.snapshot.documents) || value.snapshot.documents.length > 100) throw new Error("Invalid child Memory snapshot resource");
  const documents = value.snapshot.documents.map(document);
  if (documents.some(item => item.status !== "accepted") || new Set(documents.map(item => item.id)).size !== documents.length) throw new Error("Child Memory snapshot must contain unique accepted documents");
  return Object.freeze({ allowProposals: value.allowProposals, snapshot: Object.freeze({ schemaVersion: 1, libraryId: identity(value.snapshot.libraryId), revision: version(value.snapshot.revision), documents: Object.freeze(documents) }) });
}

/** Child queue state is local; imported documents are immutable baseline data. */
export function childMemoryState(value: unknown, input: ChildMemoryInput, manifest: SubagentResourceManifest): MemoryState {
  const state = snapshotState(value);
  if (state.libraryId !== input.snapshot.libraryId || JSON.stringify(state.documents) !== JSON.stringify(input.snapshot.documents) || state.candidates.length > MAX_CHILD_MEMORY_CANDIDATES || state.candidates.length !== state.audit.length) throw new Error("Child Memory output exceeds its snapshot scope");
  if (state.candidates.length && !input.allowProposals) throw new Error("Child Memory proposals were not authorized by its Host");
  for (const item of state.candidates) assertChildCandidate(item, manifest, input.snapshot);
  for (const audit of state.audit) {
    if (audit.action !== "propose" || !state.candidates.some(item => item.id === audit.targetId) || audit.actor.kind !== "child" || audit.actor.id !== manifest.identity.id || audit.actor.sessionId !== manifest.identity.childSessionId || audit.actor.runId !== manifest.identity.childRunId) throw new Error("Invalid child Memory proposal audit");
  }
  if (new Set(state.audit.map(item => item.targetId)).size !== state.candidates.length) throw new Error("Child Memory audit does not cover every candidate exactly once");
  return state;
}

export function assertChildCandidate(item: MemoryCandidate, manifest: SubagentResourceManifest, snapshot: MemorySnapshot): void {
  if (item.status !== "pending" || item.version !== 1 || item.actor.kind !== "child" || item.actor.id !== manifest.identity.id || item.actor.sessionId !== manifest.identity.childSessionId || item.actor.runId !== manifest.identity.childRunId) throw new Error("Invalid child Memory candidate identity or status");
  const existing = snapshot.documents.find(doc => doc.id === item.targetId);
  if ((existing?.version ?? 0) !== item.expectedDocumentVersion) throw new Error("Child Memory target is outside its snapshot scope");
  if (item.evidence.some(evidence => evidence.kind !== "session" || evidence.id !== `${manifest.identity.childSessionId}:${manifest.identity.childRunId}`)) throw new Error("Child Memory evidence must belong to its own Session and Run");
}
