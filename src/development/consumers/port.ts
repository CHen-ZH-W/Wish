import { ToolExecutionError } from "../../core/tools/executor.js";
import type { WishToolExecutionContext } from "../../composition/tool-context.js";
import type { Development, DevelopmentChange, DevelopmentProject } from "../types.js";

export const DEVELOPMENT_POLICY_ID = "wish-development";

/** Business operations stay with the product owner; consumers never approve work. */
export interface DevelopmentConsumerPort {
  readonly state: Development;
  begin(input: { readonly sessionId: string; readonly workspaceRoot: string; readonly rawWish: string; readonly requestId: string; readonly runId?: string; readonly title?: string }): Promise<DevelopmentProject>;
  readonly propose: Development["propose"];
  readonly report: Development["report"];
  readonly recordVerification: Development["recordVerification"];
  conversationInput?(sessionId: string, runId: string): Promise<{ readonly rawWish: string; readonly requestId: string } | undefined>;
}

export interface CurrentDevelopment { readonly project: DevelopmentProject; readonly change: DevelopmentChange }
export interface DevelopmentBindingInput { readonly executionEpoch: number; readonly confirmationDigest: string }
export interface DevelopmentPermissionFacts {
  readonly managed: boolean;
  readonly projectId: string;
  readonly changeId: string;
  readonly executionEpoch: number;
  readonly confirmationDigest: string;
  readonly specDigest: string;
  readonly executionAllowed: boolean;
}

export async function developmentProject(state: Pick<Development, "forSession" | "list">, sessionId: string, workspaceRoot?: string): Promise<DevelopmentProject | undefined> {
  const attached = await state.forSession(sessionId);
  // A second Session in the same workspace cannot bypass the active increment's fence.
  if (attached && (workspaceRoot === undefined || attached.workspaceRoot === workspaceRoot)) return attached;
  return workspaceRoot === undefined ? undefined : (await state.list()).find(item => item.workspaceRoot === workspaceRoot);
}

export async function currentDevelopment(state: Pick<Development, "forSession" | "list">, sessionId: string, workspaceRoot?: string): Promise<CurrentDevelopment | undefined> {
  const project = await developmentProject(state, sessionId, workspaceRoot);
  const change = project?.changes.find(item => item.id === project.activeChangeId);
  return project && change && change.phase !== "accepted" ? { project, change } : undefined;
}

/** Production history contains the rendered human input before the model can call a Tool. */
export async function directHumanRequest(port: DevelopmentConsumerPort, context: WishToolExecutionContext, fallback: string, signal?: AbortSignal): Promise<{ readonly rawWish: string; readonly requestId: string; readonly conversationInput: boolean }> {
  const turn = context.userTurn;
  const humanSource = turn?.provenance.source === "wish-cli" || turn?.provenance.source === "wish-webui";
  const direct = turn?.provenance.origin === "run_input"
    ? turn.inputSource === "user" && turn.provenance.source === "user"
    : turn?.provenance.origin === "follow_up" && humanSource;
  if (!turn || turn.parentRunId !== undefined || turn.runId !== context.permissions.subject.runId || turn.userTurnId !== context.permissions.subject.userTurnId) {
    throw new ToolExecutionError("permission_denied", "wish_begin requires a direct top-level human UserTurn");
  }
  const pending = await port.conversationInput?.(context.permissions.subject.sessionId, turn.runId);
  if (pending) {
    const history = await context.sessionHistory?.read(signal);
    const accepted = history?.records.filter(item => item.kind === "message" && item.runId === turn.runId && item.userTurnId === turn.userTurnId && item.message.role === "user" &&
      (item.origin === "steering" && item.inputSource === "steering" || item.origin === "user_input" && item.inputSource === "follow_up")).at(-1);
    if (history?.sessionId !== context.permissions.subject.sessionId || accepted?.kind !== "message" || accepted.message.content !== pending.rawWish || !pending.rawWish.trim() || !pending.requestId) {
      throw new ToolExecutionError("permission_denied", "The new human message has not been accepted into this Run; do not replace it with the old UserTurn request");
    }
    return { ...pending, conversationInput: true };
  }
  if (!direct) throw new ToolExecutionError("permission_denied", "wish_begin requires a direct top-level human UserTurn");
  // Narrow embedders may omit transcript access; their caller still must supply direct human provenance.
  if (!context.sessionHistory) return { rawWish: fallback, requestId: turn.userTurnId, conversationInput: false };
  const history = await context.sessionHistory.read(signal);
  const record = history.records.find(item => item.kind === "message" && item.runId === turn.runId && item.userTurnId === turn.userTurnId && item.origin === "user_input" && item.message.role === "user" &&
    (turn.provenance.origin === "run_input" ? item.inputSource === "user" : item.inputSource === "follow_up" || item.inputSource === "user"));
  if (history.sessionId !== context.permissions.subject.sessionId || record?.kind !== "message" || !record.message.content.trim()) {
    throw new ToolExecutionError("permission_denied", "The original human request is unavailable; Wish cannot invent its source");
  }
  return { rawWish: record.message.content, requestId: turn.userTurnId, conversationInput: false };
}

export function developmentFacts(current: CurrentDevelopment | undefined, sessionId: string, runId: string, workspaceRoot?: string): DevelopmentPermissionFacts {
  const project = current?.project, change = current?.change;
  const spec = change?.specs.at(-1), confirmation = change?.confirmations.at(-1);
  const start = change?.starts.find(item => item.runId === runId && ["dispatching", "running"].includes(item.status));
  return Object.freeze({
    managed: current !== undefined, projectId: project?.id ?? "", changeId: change?.id ?? "",
    executionEpoch: change?.executionEpoch ?? 0, confirmationDigest: confirmation?.digest ?? "", specDigest: spec?.digest ?? "",
    executionAllowed: (workspaceRoot === undefined || project?.workspaceRoot === workspaceRoot) && change?.sessionId === sessionId && ["running", "verifying"].includes(change.phase) && ["none", "verification"].includes(change.gate) &&
      confirmation !== undefined && spec !== undefined && confirmation.specVersion === spec.version && confirmation.specDigest === spec.digest &&
      confirmation.executionEpoch === change.executionEpoch && start !== undefined && start.confirmationDigest === confirmation.digest &&
      start.executionEpoch === change.executionEpoch && start.specVersion === spec.version,
  });
}

export function sameExecutionBinding(left: DevelopmentPermissionFacts, right: DevelopmentPermissionFacts): boolean {
  return left.managed && right.managed && left.executionAllowed && right.executionAllowed &&
    left.projectId === right.projectId && left.changeId === right.changeId && left.executionEpoch === right.executionEpoch &&
    left.confirmationDigest === right.confirmationDigest && left.specDigest === right.specDigest;
}

export function snapshotDevelopmentFacts(context: WishToolExecutionContext): DevelopmentPermissionFacts | undefined {
  const metadata = context.permissions.policies?.find(item => item.id === DEVELOPMENT_POLICY_ID)?.metadata;
  if (!metadata || typeof metadata.managed !== "boolean" || typeof metadata.executionAllowed !== "boolean" ||
      typeof metadata.projectId !== "string" || typeof metadata.changeId !== "string" ||
      !Number.isSafeInteger(metadata.executionEpoch) || typeof metadata.confirmationDigest !== "string" || typeof metadata.specDigest !== "string") return undefined;
  return metadata as unknown as DevelopmentPermissionFacts;
}

export async function requireExecution(port: DevelopmentConsumerPort, context: WishToolExecutionContext, binding: DevelopmentBindingInput): Promise<CurrentDevelopment> {
  const subject = context.permissions.subject;
  const current = await currentDevelopment(port.state, subject.sessionId, context.workspace.root);
  const facts = developmentFacts(current, subject.sessionId, subject.runId, context.workspace.root);
  const projected = snapshotDevelopmentFacts(context);
  if (!current || current.project.workspaceRoot !== context.workspace.root || context.cwd !== context.workspace.root || !projected || !sameExecutionBinding(projected, facts) || binding.executionEpoch !== facts.executionEpoch || binding.confirmationDigest !== facts.confirmationDigest) {
    throw new ToolExecutionError("permission_denied", "This Run no longer owns the confirmed Wish development execution. Read wish_read and await the current human decision.");
  }
  return current;
}

/** Preserve exact identities without injecting complete file inventories every Step. */
export function developmentModelView(project: DevelopmentProject) {
  const active = project.changes.find(item => item.id === project.activeChangeId && item.phase !== "accepted");
  const change = active ?? project.changes.at(-1);
  if (!change) return { projectId: project.id, projectRevision: project.revision, workspaceRoot: project.workspaceRoot };
  const confirmation = change.confirmations.at(-1), report = change.reports.at(-1);
  const snapshot = (code: import("../types.js").WorkspaceSnapshot) => ({ digest: code.digest, fileCount: code.files.length, totalBytes: code.totalBytes, excluded: code.excluded });
  const spec = change.specs.at(-1);
  const modelSpec = spec && { ...spec, ...("code" in spec ? { code: snapshot(spec.code as import("../types.js").WorkspaceSnapshot) } : {}) };
  const planApproval = confirmation?.planApproval;
  const approvalRef = planApproval && { sessionId: planApproval.sessionId, reviewId: planApproval.reviewId, stateVersion: planApproval.stateVersion, documentVersion: planApproval.documentVersion, digest: planApproval.digest, artifacts: planApproval.artifacts };
  return { projectId: project.id, projectRevision: project.revision, workspaceRoot: project.workspaceRoot, changeId: change.id,
    historyOnly: active === undefined, rawWish: change.rawWish, wishUpdates: change.wishUpdates, phase: change.phase, gate: change.gate, executionEpoch: change.executionEpoch, spec: modelSpec,
    confirmation: confirmation && { ...confirmation, code: snapshot(confirmation.code), ...(approvalRef ? { planApproval: approvalRef } : {}) }, starts: change.starts.slice(-3),
    verifications: change.verifications.slice(-8).map(receipt => ({ ...receipt, code: snapshot(receipt.code), output: receipt.output.slice(-2000) })),
    report: report && { ...report, code: snapshot(report.code) },
  };
}

export function developmentToolError(error: unknown): ToolExecutionError {
  if (error instanceof ToolExecutionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolExecutionError(/conflict|revision|stale|snapshot|changed/iu.test(message) ? "conflict" : "execution_failed", message);
}
