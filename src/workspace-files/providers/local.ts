import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { FilesystemPolicy } from "../../filesystem/types.js";
import { WorkspaceFilesService } from "../service.js";
import type { WorkspaceBinaryFileView, WorkspaceDirectoryView, WorkspaceTextFileView } from "../types.js";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_PREVIEW_BYTES = 1024 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 32 * 1024 * 1024;

export interface Config { readonly maxEntries?: number; readonly maxPreviewBytes?: number; readonly maxBinaryBytes?: number; }
export const Config: s<Config> = s.object({
  maxEntries: s.number().step(1).min(1),
  maxPreviewBytes: s.number().step(1).min(1),
  maxBinaryBytes: s.number().step(1).min(1),
});

/** Human-facing, read-only workspace projection. It never mints model Tool authority. */
export class LocalWorkspaceFiles extends WorkspaceFilesService {
  static readonly inject = ["filesystem", "workspace"];
  static readonly Config = Config;
  private readonly maxEntries: number;
  private readonly maxPreviewBytes: number;
  private readonly maxBinaryBytes: number;
  private readonly work: PluginWorkOwner;

  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    this.maxEntries = positiveInteger(config.maxEntries ?? DEFAULT_MAX_ENTRIES, "Workspace Files maxEntries");
    this.maxPreviewBytes = positiveInteger(config.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES, "Workspace Files maxPreviewBytes");
    this.maxBinaryBytes = positiveInteger(config.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES, "Workspace Files maxBinaryBytes");
    this.work = new PluginWorkOwner(ctx, { code: "workspace_files", codeReload: true });
  }

  list(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceDirectoryView> {
    return this.work.run(async () => {
      const workspace = await this.ctx.workspace.resolve({ root, ...(signal === undefined ? {} : { signal }) });
      const target = await resolveVisiblePath(workspace.root, path, this.ctx.filesystem.policy, signal);
      const metadata = await lstat(target.absolute);
      if (!metadata.isDirectory()) throw new WorkspaceFilesError("not_directory", "The selected workspace path is not a directory");
      const raw = await readdir(target.absolute, { withFileTypes: true });
      if (!inside(workspace.root, await realpath(target.absolute))) throw new WorkspaceFilesError("path_escape", "Workspace directory changed outside the Session workspace");
      signal?.throwIfAborted();
      const visible = raw.filter(entry => !protectedName(entry.name, this.ctx.filesystem.policy) && (entry.isFile() || entry.isDirectory()));
      visible.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
      const selected = visible.slice(0, this.maxEntries);
      const entries = await Promise.all(selected.map(async entry => {
        const entryPath = target.relative === "." ? entry.name : `${target.relative}/${entry.name}`;
        const information = await lstat(join(target.absolute, entry.name));
        if (information.isSymbolicLink()) return undefined;
        return Object.freeze({
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? "directory" as const : "file" as const,
          size: information.size,
          modifiedAt: information.mtime.toISOString(),
        });
      }));
      signal?.throwIfAborted();
      return Object.freeze({ schemaVersion: 1 as const, root: workspace.root, path: target.relative, entries: Object.freeze(entries.filter(item => item !== undefined)), truncated: visible.length > selected.length });
    });
  }

  read(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceTextFileView> {
    return this.work.run(async () => {
      const workspace = await this.ctx.workspace.resolve({ root, ...(signal === undefined ? {} : { signal }) });
      const target = await resolveVisiblePath(workspace.root, path, this.ctx.filesystem.policy, signal);
      const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = process.platform === "linux" ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(target.absolute);
        if (!inside(workspace.root, opened)) throw new WorkspaceFilesError("path_escape", "Workspace file changed outside the Session workspace");
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new WorkspaceFilesError("not_file", "The selected workspace path is not a file");
        const bytes = Math.min(metadata.size, this.maxPreviewBytes);
        const buffer = Buffer.alloc(bytes);
        const result = await handle.read(buffer, 0, bytes, 0);
        signal?.throwIfAborted();
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, result.bytesRead));
        if (content.includes("\0")) throw new WorkspaceFilesError("binary_file", "Binary files are not available in the text preview");
        return Object.freeze({ schemaVersion: 1 as const, path: target.relative, size: metadata.size, modifiedAt: metadata.mtime.toISOString(), content, truncated: metadata.size > result.bytesRead });
      } catch (error) {
        if (error instanceof TypeError) throw new WorkspaceFilesError("binary_file", "Binary files are not available in the text preview");
        throw error;
      } finally {
        await handle.close();
      }
    });
  }

  readBytes(root: string, path: string, signal?: AbortSignal): Promise<WorkspaceBinaryFileView> {
    return this.work.run(async () => {
      const workspace = await this.ctx.workspace.resolve({ root, ...(signal === undefined ? {} : { signal }) });
      const target = await resolveVisiblePath(workspace.root, path, this.ctx.filesystem.policy, signal);
      const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = process.platform === "linux" ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(target.absolute);
        if (!inside(workspace.root, opened)) throw new WorkspaceFilesError("path_escape", "Workspace file changed outside the Session workspace");
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new WorkspaceFilesError("not_file", "The selected workspace path is not a file");
        if (metadata.size > this.maxBinaryBytes) throw new WorkspaceFilesError("file_too_large", `File exceeds the ${this.maxBinaryBytes} byte preview limit`);
        const buffer = Buffer.alloc(metadata.size);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
          signal?.throwIfAborted();
        }
        return Object.freeze({ schemaVersion: 1 as const, path: target.relative, size: metadata.size, modifiedAt: metadata.mtime.toISOString(), contentBase64: buffer.subarray(0, offset).toString("base64") });
      } finally { await handle.close(); }
    });
  }
}

export class WorkspaceFilesError extends Error {
  constructor(readonly code: "invalid_path" | "path_escape" | "protected_path" | "symbolic_link" | "not_directory" | "not_file" | "binary_file" | "file_too_large", message: string) {
    super(message); this.name = "WorkspaceFilesError";
  }
}

async function resolveVisiblePath(root: string, input: string, policy: FilesystemPolicy, signal?: AbortSignal): Promise<{ readonly absolute: string; readonly relative: string }> {
  const normalized = input === "" ? "." : input;
  if (typeof normalized !== "string" || normalized.includes("\0") || normalized.startsWith("/") || normalized.split(/[\\/]/u).includes("..")) {
    throw new WorkspaceFilesError("invalid_path", "Workspace file paths must be relative");
  }
  const absolute = resolve(root, normalized);
  if (!inside(root, absolute)) throw new WorkspaceFilesError("path_escape", "Workspace file path escapes the Session workspace");
  const relativePath = relative(root, absolute) || ".";
  const parts = relativePath === "." ? [] : relativePath.split(sep);
  let current = root;
  for (const part of parts) {
    if (protectedName(part, policy)) throw new WorkspaceFilesError("protected_path", "Protected workspace paths are not exposed in Files");
    current = join(current, part);
    const metadata = await lstat(current);
    signal?.throwIfAborted();
    if (metadata.isSymbolicLink()) throw new WorkspaceFilesError("symbolic_link", "Symbolic links are not followed by Files");
  }
  const canonical = await realpath(absolute);
  if (!inside(root, canonical)) throw new WorkspaceFilesError("path_escape", "Workspace file target escapes the Session workspace");
  return Object.freeze({ absolute: canonical, relative: relativePath.split(sep).join("/") });
}

function protectedName(name: string, policy: FilesystemPolicy): boolean {
  if (policy.protectedNameExceptions.includes(name)) return false;
  return policy.protectedDirectoryNames.includes(name) || policy.protectedFileNames.includes(name) || policy.protectedFilePrefixes.some(prefix => name.startsWith(prefix));
}
function inside(root: string, target: string): boolean { return target === root || target.startsWith(`${root}${sep}`); }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }

export default LocalWorkspaceFiles;
