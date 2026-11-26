import { createHash } from "node:crypto";
import type { ModelMessage, ModelRef } from "../core/model/model.js";
import type { ContextProjection } from "../core/context/projector.js";
import type { ModelAttemptRecord } from "../models/pricing/attempts.js";
import type { SessionHistorySnapshot } from "../sessions/types.js";
import type { ContextInput } from "./types.js";
import type { SessionContextOccupancyView } from "./consumers/webui-types.js";

export const CONTEXT_OCCUPANCY_METHOD = "context-character-estimate-v1";
export const MAX_OCCUPANCY_SNAPSHOTS = 20;

/** Counts and hashes only. No prompt, Tool schemas, response bodies, or image URLs. */
export interface ContextOccupancySnapshot {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly capturedAt: string;
  readonly projectionStatus: "ready" | "rejected";
  readonly model: ModelRef;
  readonly historySequence: number;
  readonly envelopeDigest: string;
  readonly opaqueDigest?: string;
  readonly priorAttemptIds: readonly string[];
  readonly anchorable: boolean;
  readonly breakdown: NonNullable<SessionContextOccupancyView["breakdown"]>;
  readonly contextWindow?: number;
  readonly reservedOutputTokens?: number;
  readonly inputLimitTokens?: number;
  readonly preflightTokens?: number;
  readonly preflightMethod?: string;
}

/** Presentation-only character sizing. Kept separate from the hard budget counter. */
export function estimateContextText(text: string): number {
  let units = 0;
  for (const character of text) units += character.codePointAt(0)! <= 0x7f ? 1 : 2;
  return Math.ceil(units / 4);
}

export function estimateContextMessage(message: ModelMessage): number {
  const parts = message.contentParts;
  const text = parts === undefined ? message.content : parts.filter(part => part.type === "text").map(part => part.text).join("");
  return 4 + estimateContextText(message.role) + estimateContextText(text) +
    estimateContextText(message.reasoningContent ?? "") +
    (message.toolCallId === undefined ? 0 : estimateContextText(message.toolCallId)) +
    (message.toolCalls ?? []).reduce((sum, call) => sum + 4 + estimateContextText(call.id) + estimateContextText(call.name) + estimateContextText(call.argumentsJson), 0);
}

export function captureContextOccupancy(
  facts: ContextInput,
  projection: ContextProjection,
  history: SessionHistorySnapshot,
  priorAttempts: readonly ModelAttemptRecord[],
  capturedAt = new Date().toISOString(),
): ContextOccupancySnapshot {
  const request = projection.status === "ready" ? projection.request : projection.candidateRequest;
  const details = projection.budget.details;
  const opaque = opaqueParts(request.messages);
  const priorAttemptIds = priorAttempts.filter(attempt => matchesScope(attempt, facts)).map(attempt => attempt.attemptId);
  return Object.freeze({
    sessionId: facts.sessionId, runId: facts.runId, userTurnId: facts.userTurnId, stepId: facts.stepId,
    capturedAt, projectionStatus: projection.status, model: Object.freeze({ ...request.model }),
    historySequence: history.records.reduce((sequence, record) => Math.max(sequence, record.sequence), 0),
    // An old calibration must not survive a model, system, tools, or request-setting change.
    envelopeDigest: digest({ model: request.model, instructions: request.instructions, tools: request.tools,
      reasoningEffort: request.reasoningEffort, temperature: request.temperature, maxOutputTokens: request.maxOutputTokens,
      contextWindow: details?.contextWindowTokens, reservedOutputTokens: details?.reservedOutputTokens }),
    ...(opaque.length === 0 ? {} : { opaqueDigest: digest(opaque) }),
    priorAttemptIds: Object.freeze(priorAttemptIds.slice(-64)), anchorable: priorAttemptIds.length <= 64,
    breakdown: Object.freeze({
      systemTokens: request.instructions.reduce((sum, instruction) => sum + estimateContextMessage(instruction), 0),
      toolsTokens: request.tools.reduce((sum, tool) => sum + 8 + estimateContextText(tool.name) + estimateContextText(tool.description) + estimateContextText(tool.inputSchemaJson), 0),
      messageTokens: request.messages.reduce((sum, message) => sum + estimateContextMessage(message), 0),
    }),
    ...numericField("contextWindow", details?.contextWindowTokens, true),
    ...numericField("reservedOutputTokens", details?.reservedOutputTokens),
    ...numericField("inputLimitTokens", projection.budget.inputLimitTokens),
    ...numericField("preflightTokens", projection.budget.estimatedInputTokens),
    ...(typeof details?.countMethod === "string" ? { preflightMethod: details.countMethod } : {}),
  });
}

/** Reconstructs one Session meter from its durable projection facts and Provider attempts. */
export function projectContextOccupancy(
  sessionId: string,
  snapshots: readonly ContextOccupancySnapshot[],
  attempts: readonly ModelAttemptRecord[],
  history: SessionHistorySnapshot,
): SessionContextOccupancyView {
  const owned = snapshots.filter(snapshot => snapshot.sessionId === sessionId);
  const latest = owned.at(-1);
  const unknown = (reason: string, base: Partial<SessionContextOccupancyView> = {}): SessionContextOccupancyView =>
    Object.freeze({ schemaVersion: 1, sessionId, status: "unknown", source: "unknown", ...base, reason });
  if (latest === undefined) return unknown("projection_unavailable");
  const base = { model: latest.model, capturedAt: latest.capturedAt,
    ...(latest.contextWindow === undefined ? {} : { contextWindow: latest.contextWindow }),
    ...(latest.reservedOutputTokens === undefined ? {} : { reservedOutputTokens: latest.reservedOutputTokens }),
    ...(latest.inputLimitTokens === undefined ? {} : { inputLimitTokens: latest.inputLimitTokens }) };
  if (latest.projectionStatus === "rejected") return unknown("context_request_rejected", base);
  if (history.records.reduce((sequence, record) => Math.max(sequence, record.sequence), 0) < latest.historySequence) return unknown("context_changed_after_projection", base);
  const tail = history.records.filter(record => record.sequence > latest.historySequence);
  if (tail.some(record => record.kind === "checkpoint")) return unknown("context_changed_after_projection", base);
  if (tail.some(record => record.kind === "message" && (record.runId !== latest.runId || record.userTurnId !== latest.userTurnId ||
    record.stepId !== latest.stepId || record.origin === "steering"))) return unknown("context_changed_after_projection", base);
  // Only newly committed output of this exact Step is absent from its input request.
  // A current user input may be committed after projection; it is already counted there.
  const additions = tail.filter(record => record.kind === "message" && record.runId === latest.runId &&
    record.userTurnId === latest.userTurnId && record.stepId === latest.stepId &&
    (record.origin === "assistant" || record.origin === "tool"));
  const messages = additions.flatMap(record => record.kind === "message" ? [record.message] : []);
  if (opaqueParts(messages).length > 0) return unknown("multimodal_count_unavailable", base);
  const addedTokens = messages.reduce((sum, message) => sum + estimateContextMessage(message), 0);
  const breakdown = Object.freeze({ ...latest.breakdown, messageTokens: latest.breakdown.messageTokens + addedTokens });
  let source: SessionContextOccupancyView["source"] = "estimated";
  let countMethod = CONTEXT_OCCUPANCY_METHOD;
  let usedTokens: number | undefined;

  if (latest.preflightTokens !== undefined) {
    usedTokens = latest.preflightTokens + addedTokens;
    source = "preflight";
    countMethod = (latest.preflightMethod ?? "request-token-counter") + (addedTokens > 0 ? `+${CONTEXT_OCCUPANCY_METHOD}` : "");
  } else {
    const eligible = attempts.filter(attempt => attempt.sessionId === sessionId && attempt.status === "completed" &&
      attempt.usage?.source === "provider" && safeTokens(attempt.usage.inputTokens) && sameModel(attempt.requestedModel, latest.model) &&
      (attempt.billedModel === undefined || sameModel(attempt.billedModel, latest.model)))
      .sort((left, right) => (right.endedAt ?? right.requestedAt).localeCompare(left.endedAt ?? left.requestedAt));
    for (const attempt of eligible) {
      const anchor = [...owned].reverse().find(snapshot => snapshot.projectionStatus === "ready" && matchesScope(attempt, snapshot) &&
        snapshot.anchorable && !snapshot.priorAttemptIds.includes(attempt.attemptId) &&
        snapshot.envelopeDigest === latest.envelopeDigest && snapshot.opaqueDigest === latest.opaqueDigest &&
        sameModel(snapshot.model, attempt.requestedModel) && attempt.requestedAt >= snapshot.capturedAt);
      if (anchor === undefined) continue;
      // inputTokens already includes cached tokens in Wish's normalized ModelUsage.
      const calibrated = attempt.usage!.inputTokens + total(latest.breakdown) - total(anchor.breakdown) + addedTokens;
      if (!safeTokens(calibrated)) continue;
      usedTokens = calibrated;
      source = "provider-anchored";
      countMethod = `provider-input+${CONTEXT_OCCUPANCY_METHOD}`;
      break;
    }
    if (usedTokens === undefined && latest.opaqueDigest === undefined) usedTokens = total(breakdown);
  }
  if (usedTokens === undefined || !safeTokens(usedTokens)) return unknown("multimodal_count_unavailable", base);
  return Object.freeze({ schemaVersion: 1, sessionId, status: "estimated", source, ...base, usedTokens, breakdown, countMethod,
    ...(latest.contextWindow === undefined ? { reason: "context_window_unavailable" } : {
      remainingTokens: latest.contextWindow - usedTokens, ratio: usedTokens / latest.contextWindow,
    }),
  });
}

function matchesScope(attempt: ModelAttemptRecord, facts: Pick<ContextOccupancySnapshot, "sessionId" | "runId" | "userTurnId" | "stepId">): boolean {
  return attempt.sessionId === facts.sessionId && attempt.runId === facts.runId && attempt.userTurnId === facts.userTurnId && attempt.stepId === facts.stepId;
}
function sameModel(left: ModelRef, right: ModelRef): boolean { return left.provider === right.provider && left.model === right.model; }
function safeTokens(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function numericField<Key extends string>(key: Key, value: unknown, positive = false): Partial<Record<Key, number>> {
  return safeTokens(value) && (!positive || value > 0) ? { [key]: value } as Record<Key, number> : {};
}
function total(breakdown: NonNullable<SessionContextOccupancyView["breakdown"]>): number {
  return breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
}
function opaqueParts(messages: readonly ModelMessage[]): readonly unknown[] {
  return messages.flatMap(message => (message.contentParts ?? []).filter(part => part.type !== "text"));
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
