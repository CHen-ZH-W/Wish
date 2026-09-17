import type { Session, SessionStatus } from "../../../../sessions/types.js";

export interface WorkspaceSessionGroup {
  readonly scope: string;
  readonly label: string;
  readonly sessions: readonly Session[];
}

export interface WorkspaceChoice {
  readonly root: string;
  readonly label: string;
  readonly sessionCount: number;
}

/** A read projection of Host Session.scope, not a second Workspace registry. */
export function groupSessionsByWorkspace(sessions: readonly Session[], status: SessionStatus): readonly WorkspaceSessionGroup[] {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.status !== status) continue;
    const group = groups.get(session.scope);
    if (group) group.push(session);
    else groups.set(session.scope, [session]);
  }
  const labels = new Map<string, number>();
  for (const scope of groups.keys()) {
    const label = workspaceLabel(scope);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return Object.freeze([...groups].map(([scope, items]) => {
    const name = workspaceLabel(scope);
    return Object.freeze({ scope, label: labels.get(name)! > 1 ? scope : name, sessions: Object.freeze(items) });
  }));
}

/** Previously used Host workspace identities; never seed a directory choice for the user. */
export function projectWorkspaceChoices(sessions: readonly Session[]): readonly WorkspaceChoice[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (typeof session.scope !== "string" || !session.scope) continue;
    counts.set(session.scope, (counts.get(session.scope) ?? 0) + 1);
  }
  const labels = new Map<string, number>();
  for (const root of counts.keys()) {
    const label = workspaceLabel(root);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return Object.freeze([...counts].map(([root, sessionCount]) => {
    const name = workspaceLabel(root);
    return Object.freeze({ root, label: labels.get(name)! > 1 ? root : name, sessionCount });
  }));
}

function workspaceLabel(scope: string): string { return scope.split(/[\\/]/u).filter(Boolean).at(-1) || scope; }
