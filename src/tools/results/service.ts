import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ToolResultArchivePort,
  ToolResultArchiveReference,
} from "./types.js";
import type { ToolResult } from "../../core/tools/scheduler.js";

export interface OpenToolResultArchiveRequest {
  /** Root used only to read pre-Blob relative locators. */
  readonly legacyLocatorRoot?: string;
}

export interface ToolResultArchiveRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly userTurnId: string;
  readonly stepId: string;
  readonly result: ToolResult;
  readonly resultSha256: string;
  readonly createdAt?: string;
}

export interface ToolResultArchive extends ToolResultArchivePort {
  read(
    reference: ToolResultArchiveReference,
    signal?: AbortSignal,
  ): Promise<ToolResultArchiveRecord>;
}

/** Explicit ownership of one Archive and its pinned Storage generation. */
export interface ToolResultArchiveHandle extends ToolResultArchive {
  readonly released: boolean;
  release(): boolean;
}

/** Tool-owned replaceable archive definition consumed by ContextEngine. */
export abstract class ToolResultArchiveService extends Service {
  constructor(ctx: Context) {
    super(ctx, "toolResultArchive");
  }

  abstract open(request?: OpenToolResultArchiveRequest): ToolResultArchiveHandle;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    toolResultArchive: ToolResultArchiveService;
  }
}

export default ToolResultArchiveService;
