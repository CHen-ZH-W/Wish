import type { Fiber } from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";

import type { ToolAuthorizationGrant } from
  "../src/core/tools/authorization.js";
import type {
  Filesystem,
  FilesystemEntry,
  FilesystemExecutionContext,
  ResolvedFilesystemPath,
} from "../src/filesystem/index.js";
import LocalFilesystem, {
  Config,
  LocalFilesystemBackend,
} from "../src/filesystem/providers/local.js";

declare const context: FilesystemExecutionContext;
declare const grant: ToolAuthorizationGrant;

const root = new Context();
const fiber: Fiber = root.plugin(LocalFilesystem, {
  maxFileBytes: 1024,
  protectedDirectoryNames: [".git"],
});
const configured = Config({ maxFileBytes: 2048 });
const filesystem: Filesystem = new LocalFilesystemBackend(configured);
const preflight: Promise<ResolvedFilesystemPath> = filesystem.preflight({
  path: "src",
  access: "read",
  allowWorkspaceRoot: true,
  context,
});
const resolved: Promise<ResolvedFilesystemPath> = filesystem.resolve({
  path: "src",
  access: "read",
  allowWorkspaceRoot: true,
  context,
  grant,
});
const entry: Promise<FilesystemEntry> = filesystem.stat({
  path: "src/index.ts",
  access: "read",
  context,
  grant,
});

void fiber;
void preflight;
void resolved;
void entry;
