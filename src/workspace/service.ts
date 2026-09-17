import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  ResolveWorkspaceRequest,
  WorkspaceResolver,
  WorkspaceSnapshot,
} from "./types.js";

/** Service Definition implemented by replaceable Workspace providers. */
export abstract class WorkspaceService extends Service
  implements WorkspaceResolver {
  constructor(ctx: Context) {
    super(ctx, "workspace");
  }

  abstract resolve(
    request: ResolveWorkspaceRequest,
  ): Promise<WorkspaceSnapshot>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    workspace: WorkspaceService;
  }
}

export default WorkspaceService;
