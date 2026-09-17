import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  SubagentCommand,
  SubagentExecutionSnapshot,
  SubagentExecutionTarget,
} from "./types.js";

export interface StartSubagentExecutionRequest {
  readonly id: string;
  readonly role: string;
  readonly workspaceRoot: string;
  readonly command: SubagentCommand;
  readonly signal?: AbortSignal;
}

export interface CaptureSubagentExecutionRequest {
  readonly target: SubagentExecutionTarget;
  readonly lines?: number;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export interface SendSubagentExecutionRequest {
  readonly target: SubagentExecutionTarget;
  readonly text: string;
  readonly enter?: boolean;
  readonly signal?: AbortSignal;
}

export interface SubagentExecutionProvider {
  readonly id: string;
  start(request: StartSubagentExecutionRequest): Promise<SubagentExecutionSnapshot>;
  inspect(
    target: SubagentExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SubagentExecutionSnapshot | undefined>;
  capture(request: CaptureSubagentExecutionRequest): Promise<string>;
  send(request: SendSubagentExecutionRequest): Promise<void>;
  stop(target: SubagentExecutionTarget, signal?: AbortSignal): Promise<void>;
}

/** Replaceable execution Provider; semantic child lifecycle stays in Subagents. */
export abstract class SubagentExecutionService extends Service implements
  SubagentExecutionProvider {
  abstract readonly id: string;

  constructor(ctx: Context) {
    super(ctx, "subagentExecution");
  }

  abstract start(
    request: StartSubagentExecutionRequest,
  ): Promise<SubagentExecutionSnapshot>;
  abstract inspect(
    target: SubagentExecutionTarget,
    signal?: AbortSignal,
  ): Promise<SubagentExecutionSnapshot | undefined>;
  abstract capture(request: CaptureSubagentExecutionRequest): Promise<string>;
  abstract send(request: SendSubagentExecutionRequest): Promise<void>;
  abstract stop(
    target: SubagentExecutionTarget,
    signal?: AbortSignal,
  ): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagentExecution: SubagentExecutionService;
  }
}

export default SubagentExecutionService;
