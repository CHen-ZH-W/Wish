import type { InteractionAnswer, InteractionInput, InteractionState } from "./types.js";

export class InteractionError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InteractionError("interaction_invalid_input", "A non-empty text value is required");
  return value.trim();
}
export function input(value: unknown): InteractionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InteractionError("interaction_invalid_input");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["title", "description", "questions"].includes(k)) || !Array.isArray(v.questions) || !v.questions.length) throw new InteractionError("interaction_invalid_input");
  const ids = new Set<string>();
  const questions = v.questions.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InteractionError("interaction_invalid_question");
    const q = raw as Record<string, unknown>, id = text(q.id);
    if (ids.has(id) || Object.keys(q).some(k => !["id", "question", "why", "multiple", "options"].includes(k)) || q.multiple !== undefined && typeof q.multiple !== "boolean") throw new InteractionError("interaction_invalid_question");
    ids.add(id);
    const optionIds = new Set<string>();
    if (q.options !== undefined && !Array.isArray(q.options)) throw new InteractionError("interaction_invalid_options");
    const options = (q.options as unknown[] | undefined)?.map(rawOption => {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) throw new InteractionError("interaction_invalid_options");
      const o = rawOption as Record<string, unknown>, optionId = text(o.id);
      if (optionIds.has(optionId) || Object.keys(o).some(k => !["id", "label", "description", "recommended"].includes(k)) || o.recommended !== undefined && typeof o.recommended !== "boolean") throw new InteractionError("interaction_invalid_options");
      optionIds.add(optionId);
      return Object.freeze({ id: optionId, label: text(o.label), ...(o.description === undefined ? {} : { description: text(o.description) }), ...(o.recommended === undefined ? {} : { recommended: o.recommended as boolean }) });
    });
    return Object.freeze({ id, question: text(q.question), ...(q.why === undefined ? {} : { why: text(q.why) }), ...(q.multiple === undefined ? {} : { multiple: q.multiple as boolean }), ...(options === undefined ? {} : { options: Object.freeze(options) }) });
  });
  return Object.freeze({ title: text(v.title), ...(v.description === undefined ? {} : { description: text(v.description) }), questions: Object.freeze(questions) });
}
export function answers(spec: InteractionInput, raw: unknown): readonly InteractionAnswer[] {
  if (!Array.isArray(raw) || raw.length !== spec.questions.length) throw new InteractionError("interaction_incomplete_answer", "Answer every question using a choice or your own text");
  const found = new Set<string>();
  const result = raw.map((v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new InteractionError("interaction_invalid_answer");
    const a = v as Record<string, unknown>, questionId = text(a.questionId), question = spec.questions.find(q => q.id === questionId);
    if (!question || found.has(questionId) || Object.keys(a).some(k => !["questionId", "optionIds", "text"].includes(k)) || !Array.isArray(a.optionIds) || typeof a.text !== "string") throw new InteractionError("interaction_invalid_answer");
    found.add(questionId);
    const optionIds = a.optionIds.map(text), note = a.text.trim();
    if (new Set(optionIds).size !== optionIds.length || optionIds.some(id => !question.options?.some(o => o.id === id)) || !question.multiple && optionIds.length > 1 || !optionIds.length && !note) throw new InteractionError("interaction_incomplete_answer", "Choose an option or write your answer");
    return Object.freeze({ questionId, optionIds: Object.freeze(optionIds), text: note });
  });
  return Object.freeze(result);
}
export function state(value: unknown): InteractionState {
  if (!value || typeof value !== "object") throw new InteractionError("interaction_invalid_state");
  const v = value as InteractionState;
  if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 1 || !Array.isArray(v.requests)) throw new InteractionError("interaction_invalid_state");
  text(v.sessionId);
  const ids = new Set<string>();
  const requests = v.requests.map(r => {
    const spec = input({ title: r.title, questions: r.questions, ...(r.description === undefined ? {} : { description: r.description }) });
    for (const s of [r.id, r.runId, r.userTurnId, r.stepId, r.toolCallId, r.createdAt]) text(s);
    if (r.sessionId !== v.sessionId || ids.has(r.id) || !["pending", "answered", "dismissed", "interrupted"].includes(r.status) || !Number.isSafeInteger(r.revision) || r.revision < 1) throw new InteractionError("interaction_invalid_state");
    ids.add(r.id);
    return Object.freeze({ ...r, ...spec, ...(r.status === "answered" ? { answers: answers(spec, r.answers) } : {}) });
  });
  return Object.freeze({ schemaVersion: 1, sessionId: v.sessionId, revision: v.revision, requests: Object.freeze(requests) });
}
