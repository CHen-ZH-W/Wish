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
} from "./types.js";

export type { ModelDependencies } from "../models/runtime.js";

export interface SessionDependencies {
  readonly manager: SessionManager;
}
export type ApplicationModelDependencies = Pick<
  ModelDependencies,
  "configuredModel"
>;

export interface WishApplicationOptions {
  readonly sessions: SessionDependencies;
  readonly agent: Agent<WishAgentProtocol>;
  readonly models: ApplicationModelDependencies;
  readonly runGeneration?: WishRunGeneration;
}

type WishRunPayloadWithSelectedModel = WishRunPayload & {
  readonly model: ModelRef;
};

interface DefaultWishApplicationOptions {
  readonly sessions: SessionManager;
  readonly agent: Agent<WishAgentProtocol>;
  readonly configuredModel: ApplicationModelDependencies["configuredModel"];
  readonly runGeneration?: WishRunGeneration;
}

/**
 * Transport-neutral facade for explicit non-Cordis embedding.
 * Product processes obtain the same facade from the Application service.
 */
export class ApplicationFacade implements WishApplication {
  readonly agentId: string;
  readonly runGeneration?: WishRunGeneration;
  private readonly modelByRun = new Map<string, ModelRef>();
  private readonly options: DefaultWishApplicationOptions;

  constructor(options: WishApplicationOptions) {
    requireApplicationOptions(options);
    this.agentId = requireIdentifier(
      options.agent.definition.id,
      "Wish Agent id",
    );
    this.options = {
      sessions: options.sessions.manager,
      agent: options.agent,
      configuredModel: options.models.configuredModel,
      ...(options.runGeneration === undefined
        ? {}
        : { runGeneration: options.runGeneration }),
    };
    if (options.runGeneration !== undefined) {
      this.runGeneration = options.runGeneration;
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
    await this.getSession(input);
    return this.options.sessions.archive(input);
  }

  async readSessionHistory(
    input: ReadSessionHistoryInput,
  ): Promise<SessionHistorySnapshot> {
    await this.getSession(input);
    return this.options.sessions.readHistory(input);
  }

  async startRun(input: StartWishRunInput): Promise<WishRunHandle> {
    const session = await requireActiveOwnedSession(
      this.options.sessions,
      this.agentId,
      input.sessionId,
      input.signal,
    );
    throwIfAborted(input.signal);
    const payload = normalizeRunPayload(
      input.payload,
      this.options.configuredModel,
    );
    const handle = this.options.agent.startRun({
      scope: session.sessionId,
      payload,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    this.modelByRun.set(handle.runId, payload.model);
    void handle.completion.finally(() => {
      this.modelByRun.delete(handle.runId);
    });
    return handle;
  }

  controlRun(
    runId: string,
    control: WishRunControl,
  ): ReturnType<WishApplication["controlRun"]> {
    if (control.type !== "follow_up") {
      return this.options.agent.control(runId, control);
    }
    const selected = this.modelByRun.get(runId);
    if (selected === undefined) {
      return this.options.agent.control(runId, control);
    }
    if (
      control.payload.model !== undefined &&
      !sameModel(control.payload.model, selected)
    ) {
      throw new Error("Wish follow-up cannot change the model selected for its Run");
    }
    const normalized: WishRunControl = Object.freeze({
      ...control,
      payload: Object.freeze({
        text: requireUserText(control.payload.text, "Wish follow-up input"),
        model: selected,
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
