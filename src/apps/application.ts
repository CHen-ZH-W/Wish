import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Agent } from "../core/agent/agent.js";
import type { ModelRef } from "../core/model/model.js";
import type { ModelDependencies } from "../models/runtime.js";
import {
  SessionArchivedError,
  type SessionManager,
  SessionNotFoundError,
} from "../sessions/index.js";
import type {
  ArchiveSessionInput,
  RestoreSessionInput,
  DeleteSessionInput,
  GetSessionInput,
  ReadSessionHistoryInput,
  Session,
  SessionHistorySnapshot,
  UpdateSessionMetadataInput,
} from "../sessions/types.js";
import type {
  CreateWishSessionInput,
  ListWishSessionsInput,
  StartWishRunInput,
  WishAgentProtocol,
  WishApplication,
  WishOutputEvent,
  WishRunControl,
  WishRunGeneration,
  WishRunHandle,
  WishRunPayload,
  WishRuntimeRecovery,
} from "./types.js";

export type { ModelDependencies } from "../models/runtime.js";

export interface SessionDependencies {
  readonly manager: SessionManager;
}
export type ApplicationModelDependencies = Pick<
  ModelDependencies,
  "configuredModel" | "sessionReasoning"
>;

export interface WishApplicationOptions {
  readonly sessionFeatures?: import("./session-features.js").SessionFeatures;
  readonly sessions: SessionDependencies;
  readonly agent: Agent<WishAgentProtocol>;
  readonly models: ApplicationModelDependencies;
  readonly runGeneration?: WishRunGeneration;
  /** Optional only for explicit standalone embedders without durable Runtime. */
  readonly recovery?: WishRuntimeRecovery;
}

type WishRunPayloadWithSelectedModel = WishRunPayload & {
  readonly model: ModelRef;
};
type WishRunSelection = Pick<WishRunPayloadWithSelectedModel, "model" | "reasoningEffort">;

// Admission serialization, not canonical Run state. Shared facades over the same
// Session manager must not delete between start validation and Run registration.
const sessionAdmissions = new WeakMap<SessionManager, {
  tails: Map<string, Promise<void>>;
  active: Map<string, Set<Promise<unknown>>>;
}>();

interface DefaultWishApplicationOptions {
  readonly sessions: SessionManager;
  readonly agent: Agent<WishAgentProtocol>;
  readonly configuredModel: ApplicationModelDependencies["configuredModel"];
  readonly sessionReasoning?: NonNullable<ApplicationModelDependencies["sessionReasoning"]>;
  readonly runGeneration?: WishRunGeneration;
  readonly recovery?: WishRuntimeRecovery;
}

/**
 * Transport-neutral facade for explicit non-Cordis embedding.
 * Product processes obtain the same facade from the Application service.
 */
export class ApplicationFacade implements WishApplication {
  readonly sessionFeatures?: import("./session-features.js").SessionFeatures;
  readonly sessionReasoning?: NonNullable<ApplicationModelDependencies["sessionReasoning"]>;
  readonly agentId: string;
  readonly runGeneration?: WishRunGeneration;
  readonly runtimeRecovery?: WishRuntimeRecovery;
  private readonly selectionByRun = new Map<string, WishRunSelection>();
  private readonly options: DefaultWishApplicationOptions;

  constructor(options: WishApplicationOptions) {
    requireApplicationOptions(options);
    if (options.sessionFeatures) this.sessionFeatures = options.sessionFeatures;
    if (options.models.sessionReasoning) this.sessionReasoning = options.models.sessionReasoning;
    this.agentId = requireIdentifier(
      options.agent.definition.id,
      "Wish Agent id",
    );
    this.options = {
      sessions: options.sessions.manager,
      agent: options.agent,
      configuredModel: options.models.configuredModel,
      ...(options.models.sessionReasoning === undefined ? {} : { sessionReasoning: options.models.sessionReasoning }),
      ...(options.runGeneration === undefined
        ? {}
        : { runGeneration: options.runGeneration }),
      ...(options.recovery === undefined
        ? {}
        : { recovery: options.recovery }),
    };
    if (options.runGeneration !== undefined) {
      this.runGeneration = options.runGeneration;
    }
    if (options.recovery !== undefined) {
      this.runtimeRecovery = options.recovery;
    }
  }

  async createSession(input: CreateWishSessionInput): Promise<Session> {
    throwIfAborted(input.signal);
    return this.options.sessions.create({
      sessionId: input.sessionId ?? randomUUID(),
      agentId: this.agentId,
      scope: normalizeDirectory(input.workspaceRoot, "Wish workspaceRoot"),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  getSession(input: GetSessionInput): Promise<Session> {
    return requireOwnedSession(
      this.options.sessions,
      this.agentId,
      input.sessionId,
      input.signal,
    );
  }

  listSessions(
    input: ListWishSessionsInput = {},
  ): Promise<readonly Session[]> {
    return this.options.sessions.list({ ...input, agentId: this.agentId });
  }

  async updateSessionMetadata(
    input: UpdateSessionMetadataInput,
  ): Promise<Session> {
    await this.getSession(input);
    return this.options.sessions.updateMetadata(input);
  }

  async archiveSession(input: ArchiveSessionInput): Promise<Session> {
    return this.serialSession(input.sessionId, async () => {
      await this.requireRemovable(input);
      return this.options.sessions.archive(input);
    });
  }

  async restoreSession(input: RestoreSessionInput): Promise<Session> {
    return this.serialSession(input.sessionId, async () => {
      await this.getSession(input);
      return this.options.sessions.restore(input);
    });
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    return this.serialSession(input.sessionId, async () => {
      await this.requireRemovable(input);
      await this.options.sessions.delete(input);
    });
  }

  private admissions() {
    let value = sessionAdmissions.get(this.options.sessions);
    if (!value) { value = { tails: new Map(), active: new Map() }; sessionAdmissions.set(this.options.sessions, value); }
    return value;
  }

  private serialSession<T>(id: string, action: () => Promise<T>): Promise<T> {
    const { tails } = this.admissions();
    const result = (tails.get(id) ?? Promise.resolve()).then(action);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(id, tail);
    return result.finally(() => { if (tails.get(id) === tail) tails.delete(id); });
  }

  private async requireRemovable(input: GetSessionInput): Promise<void> {
    await this.getSession(input);
    if (this.admissions().active.get(input.sessionId)?.size || this.runGeneration?.snapshot().activeRuns.some(run => run.scope === input.sessionId)) {
      throw Object.assign(new Error("会话仍有运行，请停止并等待运行结束后再操作。"), { code: "session_busy" });
    }
    const recovery = await this.runtimeRecovery?.snapshot(input.signal);
    if (recovery?.pendingReconciliations.some(item => item.scope === input.sessionId)) {
      throw Object.assign(new Error("会话有待核对的执行结果，请先完成恢复核对。"), { code: "session_busy" });
    }
    await this.sessionFeatures?.beforeRemoval?.(input.sessionId);
    throwIfAborted(input.signal);
  }

  async readSessionHistory(
    input: ReadSessionHistoryInput,
  ): Promise<SessionHistorySnapshot> {
    await this.getSession(input);
    return this.options.sessions.readHistory(input);
  }

  async startRun(input: StartWishRunInput): Promise<WishRunHandle> {
    return this.serialSession(input.sessionId, () => this.startSessionRun(input));
  }

  private async startSessionRun(input: StartWishRunInput): Promise<WishRunHandle> {
    const session = await requireActiveOwnedSession(
      this.options.sessions,
      this.agentId,
      input.sessionId,
      input.signal,
    );
    throwIfAborted(input.signal);
    const basePayload = normalizeRunPayload(
      input.payload,
      this.options.configuredModel,
    );
    const selectedEffort = input.payload.reasoningEffort ?? await this.options.sessionReasoning?.forRun(input.sessionId, basePayload.model, input.signal);
    if (selectedEffort !== undefined && !this.options.configuredModel.getModelSpec(basePayload.model).reasoningControl?.efforts.includes(selectedEffort)) {
      throw new Error("Selected model does not support this reasoning effort");
    }
    const payload = Object.freeze({ ...basePayload, ...(selectedEffort === undefined ? {} : { reasoningEffort: selectedEffort }) });
    await this.sessionFeatures?.beforeInput(input.sessionId, payload.text);
    const handle = this.options.agent.startRun({
      scope: session.sessionId,
      payload,
      ...(input.inputSource === undefined ? {} : { inputSource: input.inputSource }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    this.selectionByRun.set(handle.runId, Object.freeze({ model: payload.model, ...(payload.reasoningEffort === undefined ? {} : { reasoningEffort: payload.reasoningEffort }) }));
    const active = this.admissions().active;
    const pending = active.get(input.sessionId) ?? new Set<Promise<unknown>>();
    active.set(input.sessionId, pending); pending.add(handle.completion);
    const settled = () => {
      this.selectionByRun.delete(handle.runId);
      pending.delete(handle.completion);
      if (!pending.size && active.get(input.sessionId) === pending) active.delete(input.sessionId);
    };
    void handle.completion.then(settled, settled);
    return handle;
  }

  controlRun(
    runId: string,
    control: WishRunControl,
  ): ReturnType<WishApplication["controlRun"]> {
    if (control.type !== "follow_up") {
      return this.options.agent.control(runId, control);
    }
    const selected = this.selectionByRun.get(runId);
    if (selected === undefined) {
      return this.options.agent.control(runId, control);
    }
    if (
      control.payload.model !== undefined &&
      !sameModel(control.payload.model, selected.model)
    ) {
      throw new Error("Wish follow-up cannot change the model selected for its Run");
    }
    if (control.payload.reasoningEffort !== undefined && control.payload.reasoningEffort !== selected.reasoningEffort) {
      throw new Error("Wish follow-up cannot change the reasoning effort selected for its Run");
    }
    const normalized: WishRunControl = Object.freeze({
      ...control,
      payload: Object.freeze({
        text: requireUserText(control.payload.text, "Wish follow-up input"),
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }),
    });
    return this.options.agent.control(runId, normalized);
  }

  observeRun(
    runId: string,
    options?: Parameters<WishApplication["observeRun"]>[1],
  ): AsyncIterable<WishOutputEvent> {
    return this.options.agent.observe(runId, options);
  }
}

async function requireActiveOwnedSession(
  sessions: SessionManager,
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const session = await requireOwnedSession(
    sessions,
    agentId,
    sessionId,
    signal,
  );
  if (session.status === "archived") {
    throw new SessionArchivedError(session.sessionId);
  }
  return session;
}

async function requireOwnedSession(
  sessions: SessionManager,
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const session = await sessions.get({
    sessionId,
    ...(signal === undefined ? {} : { signal }),
  });
  if (session.agentId !== agentId) {
    throw new SessionNotFoundError(sessionId);
  }
  return session;
}

function normalizeRunPayload(
  payload: StartWishRunInput["payload"],
  models: DefaultWishApplicationOptions["configuredModel"],
): WishRunPayloadWithSelectedModel {
  if (payload === null || typeof payload !== "object") {
    throw new Error("Wish Run payload must be an object");
  }
  const model = models.resolve(payload.model ?? models.getDefaultModel()).ref;
  return Object.freeze({
    text: requireUserText(payload.text, "Wish Run input"),
    model,
  });
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function requireApplicationOptions(
  options: WishApplicationOptions,
): void {
  if (options === null || typeof options !== "object") {
    throw new Error("WishApplication requires options");
  }
  if (
    options.agent === null || typeof options.agent !== "object" ||
    options.agent.definition === null ||
    typeof options.agent.definition !== "object" ||
    typeof options.agent.startRun !== "function" ||
    typeof options.agent.control !== "function" ||
    typeof options.agent.observe !== "function"
  ) {
    throw new Error("WishApplication requires Agent dependencies");
  }
  if (
    options.sessions === null || typeof options.sessions !== "object" ||
    options.sessions.manager === null ||
    typeof options.sessions.manager !== "object"
  ) {
    throw new Error("WishApplication requires Sessions dependencies");
  }
  if (
    options.models === null || typeof options.models !== "object" ||
    typeof options.models.configuredModel?.resolve !== "function"
  ) {
    throw new Error("WishApplication requires Models dependencies");
  }
}

function normalizeDirectory(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed path`);
  }
  return resolve(value);
}

function requireUserText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Wish Application operation was aborted", {
    cause: signal.reason,
  });
}
