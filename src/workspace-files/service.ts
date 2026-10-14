import { Service, type Context } from "@deepseek-ai/cordis";
import type { WorkspaceBinaryFileView, WorkspaceDirectoryView, WorkspaceFilesPort, WorkspaceTextFileView } from "./types.js";

export abstract class WorkspaceFilesService extends Service implements WorkspaceFilesPort {
  constructor(ctx: Context) { super(ctx, "workspaceFiles"); }
  abstract list(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceDirectoryView>;
  abstract read(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceTextFileView>;
  abstract readBytes(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceBinaryFileView>;
}

declare module "@deepseek-ai/cordis" {
  interface Context { workspaceFiles: WorkspaceFilesService; }
}

export default WorkspaceFilesService;
