export {
  WorkspaceError,
  WorkspaceInstructionTooLargeError,
  WorkspaceInstructionUnavailableError,
  WorkspaceInvalidRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotFoundError,
  WorkspaceRootUnavailableError,
} from "./errors.js";
export type { WorkspaceErrorCode } from "./errors.js";
export { WorkspaceService } from "./service.js";
export { snapshotWorkspace } from "./snapshot.js";
export type {
  ResolveWorkspaceRequest,
  WorkspaceFingerprint,
  WorkspaceInstruction,
  WorkspaceRepository,
  WorkspaceResolver,
  WorkspaceRevision,
  WorkspaceSnapshot,
} from "./types.js";
