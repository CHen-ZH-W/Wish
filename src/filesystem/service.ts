import { Service, type Context } from "@deepseek-ai/cordis";

import type {
  Filesystem,
  FilesystemEntry,
  FilesystemPolicy,
  PreflightFilesystemPathRequest,
  ReadFilesystemFileRequest,
  ResolvedFilesystemPath,
  ResolveFilesystemPathRequest,
  StatFilesystemPathRequest,
  WriteFilesystemFileRequest,
} from "./types.js";

/** Service Definition implemented by replaceable filesystem enforcers. */
export abstract class FilesystemService extends Service implements Filesystem {
  abstract readonly policy: FilesystemPolicy;

  constructor(ctx: Context) {
    super(ctx, "filesystem");
  }

  abstract preflight(
    request: PreflightFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath>;

  abstract resolve(
    request: ResolveFilesystemPathRequest,
  ): Promise<ResolvedFilesystemPath>;

  abstract readFile(request: ReadFilesystemFileRequest): Promise<Uint8Array>;

  abstract writeFile(request: WriteFilesystemFileRequest): Promise<void>;

  abstract stat(request: StatFilesystemPathRequest): Promise<FilesystemEntry>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    filesystem: FilesystemService;
  }
}

export default FilesystemService;
