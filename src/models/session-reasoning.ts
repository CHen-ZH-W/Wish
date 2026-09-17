import type { ModelRef } from "../core/model/model.js";
import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import { KV_ABSENT, type KvPrecondition } from "../storage/kv.js";
import type { ConfiguredModel } from "./runtime.js";
import type { ModelReasoningControl, ModelReasoningEffort } from "./types.js";

export interface SessionReasoningSelection {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly model: ModelRef;
  readonly effort: ModelReasoningEffort;
}

export interface SessionReasoningView {
  readonly model: ModelRef;
  readonly control?: ModelReasoningControl;
  /** Absent means the model's configured request default is used. */
  readonly selected?: ModelReasoningEffort;
}

export interface SessionReasoningPort {
  defaultModel(): ModelRef;
  /** Model capability before a Session exists; never reads Session-scoped state. */
  inspectDefault(): SessionReasoningView;
  inspect(sessionId: string, model: ModelRef, signal?: AbortSignal): Promise<SessionReasoningView>;
  select(sessionId: string, model: ModelRef, effort: ModelReasoningEffort | null, signal?: AbortSignal): Promise<SessionReasoningView>;
  forRun(sessionId: string, model: ModelRef, signal?: AbortSignal): Promise<ModelReasoningEffort | undefined>;
}

export interface SessionReasoningStore {
  get(sessionId: string, signal?: AbortSignal): Promise<{ readonly value: SessionReasoningSelection; readonly revision: string } | undefined>;
  put(selection: SessionReasoningSelection, revision: string | undefined, signal?: AbortSignal): Promise<void>;
  delete(sessionId: string, revision: string, signal?: AbortSignal): Promise<void>;
}

export class ModelReasoningSelectionError extends Error {
  constructor() { super("Selected model does not support this reasoning effort"); }
}

const domainSpec: DomainSpec<string, SessionReasoningSelection> = Object.freeze({
  id: "models/session-reasoning",
  schemaVersion: 1,
  shape: "keyed" as const,
  requirements: Object.freeze({ kv: Object.freeze({ list: false }) }),
  resolve(sessionId: string) { return Object.freeze({ key: validSessionId(sessionId), default: DOMAIN_ABSENT }); },
  encode(value: SessionReasoningSelection) { return new TextEncoder().encode(JSON.stringify(value)); },
  decode(payload: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown; },
  validate(value: unknown): SessionReasoningSelection { return validSelection(value); },
});

/** Models-owned, Session-keyed durable selection; Storage remains the generic KV owner. */
export class DomainSessionReasoningStore implements SessionReasoningStore {
  private readonly domain: StorageDomain<string, SessionReasoningSelection>;
  constructor(storage: StorageBackendResolver, backendId: string) {
    this.domain = new StorageDomain({ storage, backendId, spec: domainSpec });
  }
  async get(sessionId: string, signal?: AbortSignal) {
    const entry = await this.domain.resolve(sessionId).load(signal);
    if (entry === undefined) return undefined;
    if (entry.value.sessionId !== sessionId || entry.revision === undefined) throw new Error("Session reasoning selection is corrupt");
    return Object.freeze({ value: entry.value, revision: entry.revision });
  }
  async put(selection: SessionReasoningSelection, revision: string | undefined, signal?: AbortSignal): Promise<void> {
    const precondition: KvPrecondition = revision === undefined ? KV_ABSENT : { kind: "revision", revision };
    await this.domain.resolve(selection.sessionId).save(selection, precondition, signal);
  }
  async delete(sessionId: string, revision: string, signal?: AbortSignal): Promise<void> {
    await this.domain.resolve(sessionId).delete({ kind: "revision", revision }, signal);
  }
}

/** Validation belongs to Models; callers never supply arbitrary Provider JSON. */
export class SessionReasoningSelections implements SessionReasoningPort {
  constructor(private readonly configuredModel: ConfiguredModel, private readonly store: SessionReasoningStore) {}

  defaultModel(): ModelRef { return this.configuredModel.getDefaultModel(); }

  inspectDefault(): SessionReasoningView {
    const resolved = this.configuredModel.resolve(this.defaultModel());
    const control = effectiveControl(resolved.spec.reasoningControl, resolved.request.extraBody);
    return Object.freeze({ model: resolved.ref, ...(control === undefined ? {} : { control }) });
  }

  async inspect(sessionId: string, model: ModelRef, signal?: AbortSignal): Promise<SessionReasoningView> {
    validSessionId(sessionId);
    const resolved = this.configuredModel.resolve(model);
    const control = effectiveControl(resolved.spec.reasoningControl, resolved.request.extraBody);
    const stored = await this.store.get(sessionId, signal);
    const selected = stored?.value.model.provider === resolved.ref.provider && stored.value.model.model === resolved.ref.model &&
      control?.efforts.includes(stored.value.effort) ? stored.value.effort : undefined;
    return Object.freeze({ model: resolved.ref, ...(control === undefined ? {} : { control }), ...(selected === undefined ? {} : { selected }) });
  }

  async select(sessionId: string, model: ModelRef, effort: ModelReasoningEffort | null, signal?: AbortSignal): Promise<SessionReasoningView> {
    validSessionId(sessionId);
    const resolved = this.configuredModel.resolve(model);
    const control = resolved.spec.reasoningControl;
    if (control === undefined || effort !== null && !control.efforts.includes(effort)) {
      throw new ModelReasoningSelectionError();
    }
    const current = await this.store.get(sessionId, signal);
    if (current?.value.model.provider === resolved.ref.provider && current.value.model.model === resolved.ref.model && current.value.effort === effort) {
      return this.inspect(sessionId, resolved.ref, signal);
    }
    if (effort === null) {
      if (current !== undefined) await this.store.delete(sessionId, current.revision, signal);
    } else {
      await this.store.put(Object.freeze({ schemaVersion: 1, sessionId, model: resolved.ref, effort }), current?.revision, signal);
    }
    return this.inspect(sessionId, resolved.ref, signal);
  }

  async forRun(sessionId: string, model: ModelRef, signal?: AbortSignal): Promise<ModelReasoningEffort | undefined> {
    return (await this.inspect(sessionId, model, signal)).selected;
  }
}

function effectiveControl(control: ModelReasoningControl | undefined, extraBody: Readonly<Record<string, unknown>>): ModelReasoningControl | undefined {
  if (control === undefined) return undefined;
  let selected: unknown;
  if (control.format === "deepseek-chat") {
    const thinking = extraBody.thinking;
    selected = thinking !== null && typeof thinking === "object" && !Array.isArray(thinking) &&
      (thinking as Record<string, unknown>).type === "disabled" ? "none" : extraBody.reasoning_effort;
  } else {
    const reasoning = extraBody.reasoning;
    selected = reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
      ? (reasoning as Record<string, unknown>).effort : undefined;
  }
  return selected !== undefined && control.efforts.some(effort => effort === selected)
    ? Object.freeze({ ...control, defaultEffort: selected as ModelReasoningEffort })
    : control;
}

function validSessionId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new Error("Invalid Session id for model selection");
  return value;
}

function validSelection(value: unknown): SessionReasoningSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Session reasoning selection");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || typeof item.sessionId !== "string" || item.model === null || typeof item.model !== "object" || Array.isArray(item.model) ||
    (item.effort !== "none" && item.effort !== "low" && item.effort !== "high" && item.effort !== "max")) {
    throw new Error("Invalid Session reasoning selection");
  }
  const model = item.model as Record<string, unknown>;
  if (typeof model.provider !== "string" || !model.provider || typeof model.model !== "string" || !model.model) throw new Error("Invalid Session reasoning model");
  return Object.freeze({ schemaVersion: 1, sessionId: validSessionId(item.sessionId), model: Object.freeze({ provider: model.provider, model: model.model }), effort: item.effort });
}
