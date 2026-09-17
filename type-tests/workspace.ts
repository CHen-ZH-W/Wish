import type { Context } from "@deepseek-ai/cordis";

import {
  WorkspaceService,
  type ResolveWorkspaceRequest,
  type WorkspaceResolver,
  type WorkspaceSnapshot,
} from "../src/workspace/index.js";

declare const ctx: Context;
declare const resolver: WorkspaceResolver;
declare const request: ResolveWorkspaceRequest;

const service: WorkspaceService = ctx.workspace;
const result: Promise<WorkspaceSnapshot> = resolver.resolve(request);

void service;
void result;
