import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { parseSkillMarkdown } from "./markdown.js";
import { resourcePath } from "./resources.js";
import type { SkillImportCapabilities, SkillImportFile, SkillImportRequest } from "./import-types.js";
import type { SkillCatalog, SkillSummary, Skills } from "./types.js";

export const DEFAULT_SKILL_IMPORT_MAX_PACKAGE_BYTES = 512_000;
export const DEFAULT_SKILL_IMPORT_MAX_FILES = 256;
const yaml = createRequire(import.meta.url)("js-yaml") as {
  readonly JSON_SCHEMA: unknown;
  load(value: string, options: { schema: unknown }): unknown;
};

export class SkillImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SkillImportError"; }
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const skillCatalogDigest = (catalog: SkillCatalog): string => hash(JSON.stringify(catalog.skills));
const fail = (code: string, message: string): never => { throw new SkillImportError(code, message); };

/** Host-only writer. All package bytes are checked before touching the configured user root. */
export class LocalSkillImporter {
  private tail: Promise<unknown> = Promise.resolve();
  readonly capabilities: SkillImportCapabilities;
  private readonly userRoot: string;
  constructor(private readonly skills: Skills, options: { readonly userRoot: string; readonly maxFileBytes?: number; readonly maxSkills?: number }) {
    if (!isAbsolute(options.userRoot) || options.userRoot.includes("\0")) throw new TypeError("Skill userRoot must be absolute");
    this.userRoot = resolve(options.userRoot);
    this.maxSkills = options.maxSkills ?? 100;
    this.capabilities = Object.freeze({ maxFileBytes: options.maxFileBytes ?? 64_000, maxPackageBytes: DEFAULT_SKILL_IMPORT_MAX_PACKAGE_BYTES, maxFiles: DEFAULT_SKILL_IMPORT_MAX_FILES });
  }
  private readonly maxSkills: number;

  importPackage(input: SkillImportRequest): Promise<SkillSummary> {
    // Snapshot caller-owned request bytes before an earlier import can delay this operation.
    let files: readonly SkillImportFile[];
    try { files = validateFiles(input.files, this.capabilities); }
    catch (error) { return Promise.reject(error); }
    const request = { ...input, files };
    const pending = this.tail.then(() => this.importChecked(request));
    this.tail = pending.catch(() => {});
    return pending;
  }

  private async importChecked(input: SkillImportRequest): Promise<SkillSummary> {
    input.signal?.throwIfAborted();
    if (!/^[a-f0-9]{64}$/u.test(input.expectedCatalogDigest) || (input.overwrite !== undefined && typeof input.overwrite !== "boolean")) fail("skill_import_invalid_request", "导入请求无效，请刷新 Skill 目录后重试。");
    const manifest = input.files.find(file => file.path === "SKILL.md")!;
    // Parse once to obtain the declared package name, then apply the normal exact-name parser.
    let metadata: ReturnType<typeof parseSkillMarkdown>;
    try {
      // The standard parser checks the name before checking its directory match.
      const names = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(manifest.content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n"));
      if (!names) throw new Error("SKILL.md 缺少 YAML 元信息");
      // Discover the name using the same data-only YAML parser, including quoted YAML names.
      const value = yaml.load(names[1]!, { schema: yaml.JSON_SCHEMA }) as { name?: unknown } | null;
      metadata = parseSkillMarkdown(manifest.content, typeof value?.name === "string" ? value.name : "");
    } catch (error) { return fail("skill_import_invalid_manifest", `SKILL.md 格式无效：${error instanceof Error ? error.message : String(error)}`); }
    const location = join(this.userRoot, metadata.name, "SKILL.md");
    const identity = hash(JSON.stringify(["user", location]));
    const expected = { ...metadata, packageId: identity, source: "user" as const, location, digest: hash(manifest.content) };
    const catalog = await this.skills.list(input);
    this.checkCatalog(input, catalog, expected);
    let root: FileHandle | undefined;
    let temporary: string | undefined, backup: string | undefined;
    try {
      root = await openDirectory(this.userRoot, true, input.signal);
      const rootPath = `/proc/self/fd/${root.fd}`;
      const target = `${rootPath}/${metadata.name}`;
      const existing = await optionalStat(target);
      const previous = catalog.skills.find(skill => skill.name === metadata.name);
      if (existing && (!previous || !input.overwrite)) fail("skill_import_conflict", "同名 Skill 目录已存在，请选择其他名称或明确覆盖已有用户 Skill。");
      if (existing) await checkTree(target, input.signal);
      else if (previous) fail("skill_import_catalog_changed", "Skill 目录已变化，请刷新后重试。");
      temporary = `${rootPath}/.wish-skill-import-${randomUUID()}`;
      await mkdir(temporary, { mode: 0o700 });
      const staged = await open(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        for (const file of input.files) {
          input.signal?.throwIfAborted();
          const parts = file.path.split("/"), name = parts.pop()!;
          const parent = await openRelativeDirectory(staged, parts, true, input.signal);
          try {
            const handle = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await handle.writeFile(file.content, "utf8"); await handle.sync(); }
            finally { await handle.close(); }
          } finally { await parent.close(); }
        }
      } finally { await staged.close(); }
      input.signal?.throwIfAborted();
      // Workspaces and contributed sources may change while the bytes are staged.
      this.checkCatalog(input, await this.skills.list(input), expected);
      await assertRootIdentity(this.userRoot, root, input.signal);
      if (existing) {
        await checkTree(target, input.signal);
        const live = await lstat(target);
        if (live.dev !== existing.dev || live.ino !== existing.ino) fail("skill_import_catalog_changed", "Skill 目录已变化，请刷新后重试。");
        backup = `${rootPath}/.wish-skill-backup-${randomUUID()}`;
        await rename(target, backup);
      } else if (await optionalStat(target)) fail("skill_import_conflict", "同名 Skill 目录已存在，请刷新后重试。");
      try { await rename(temporary, target); temporary = undefined; }
      catch (error) { if (backup) { await rename(backup, target); backup = undefined; } throw error; }
      // A complete directory replacement removes resources left over from the old package.
      if (backup) {
        try { await rm(backup, { recursive: true, force: true }); backup = undefined; }
        catch { fail("skill_import_cleanup_required", "Skill 已导入，但旧包清理失败。用户 Skill 目录中的 .wish-skill-backup 备份需要人工检查，请勿重复覆盖。"); }
      }
      return Object.freeze(expected);
    } catch (error) {
      if (error instanceof SkillImportError || input.signal?.aborted) throw error;
      throw new SkillImportError("skill_import_failed", `Skill 导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        // A retained backup is recovery evidence if restoration or post-commit cleanup failed.
      } finally { await root?.close(); }
    }
  }

  private checkCatalog(input: SkillImportRequest, catalog: SkillCatalog, expected: SkillSummary): void {
    if (skillCatalogDigest(catalog) !== input.expectedCatalogDigest) fail("skill_import_catalog_changed", "Skill 目录已变化，请刷新后重试。");
    const previous = catalog.skills.find(skill => skill.name === expected.name);
    if (previous && !input.overwrite) fail("skill_import_conflict", "已存在同名 Skill；如需替换，请明确选择覆盖。");
    if (previous && (previous.source !== "user" || previous.location !== expected.location || previous.packageId !== expected.packageId)) fail("skill_import_source_conflict", "只能覆盖当前用户目录中的 Skill，不能替换工作区或插件提供的 Skill。");
    if (!previous && catalog.skills.length >= this.maxSkills) fail("skill_import_limit", "Skill 数量已达到上限，无法导入新的 Skill。");
  }
}

function validateFiles(value: readonly SkillImportFile[], limits: SkillImportCapabilities): readonly SkillImportFile[] {
  if (!Array.isArray(value) || !value.length || value.length > limits.maxFiles) fail("skill_import_limit", `请选择一个 Skill 包，最多支持 ${limits.maxFiles} 个文件。`);
  let bytes = 0;
  const paths = new Set<string>();
  const files = value.map(file => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") fail("skill_import_invalid_request", "导入文件必须包含相对路径和文本内容。");
    const parts = file.path.split("/");
    if (file.path.length > 1024 || file.path.includes("\\") || file.path.includes("\0") || parts.some(part => !part || part === "." || part === "..")) fail("skill_import_invalid_path", "Skill 文件路径必须是包内的相对路径，不能包含越界路径。");
    if (paths.has(file.path)) fail("skill_import_invalid_path", `Skill 包包含重复路径：${file.path}`);
    paths.add(file.path);
    const size = Buffer.byteLength(file.content, "utf8");
    if (file.content.includes("\0") || Buffer.from(file.content, "utf8").toString("utf8") !== file.content) fail("skill_import_invalid_text", `仅支持有效 UTF-8 文本资源：${file.path}`);
    if (size > limits.maxFileBytes) fail("skill_import_limit", `Skill 文件超过 ${limits.maxFileBytes} 字节：${file.path}`);
    bytes += size;
    return Object.freeze({ path: file.path, content: file.content });
  });
  if (bytes > limits.maxPackageBytes) fail("skill_import_limit", `Skill 包超过 ${limits.maxPackageBytes} 字节。`);
  const manifests = files.filter(file => file.path.split("/").at(-1) === "SKILL.md");
  if (manifests.length !== 1) fail("skill_import_invalid_manifest", "每次只能导入一个 Skill 包，且必须包含唯一的 SKILL.md。");
  const prefix = manifests[0]!.path.slice(0, -"SKILL.md".length);
  const normalized = files.map(file => {
    if (!file.path.startsWith(prefix)) fail("skill_import_invalid_path", "所有文件必须位于同一个 Skill 文件夹中。");
    const path = file.path.slice(prefix.length);
    try { resourcePath(path); }
    catch { return fail("skill_import_unsupported_resource", `不支持的 Skill 资源：${path}。仅支持 SKILL.md 和 references、scripts、assets 下的文本文件；agents 调用策略文件暂不支持。`); }
    return Object.freeze({ path, content: file.content });
  });
  // Reject file/directory collisions before creating the temporary package.
  const resources = new Set(normalized.map(file => file.path));
  for (const file of normalized) {
    const parts = file.path.split("/");
    while (parts.length > 1) { parts.pop(); if (resources.has(parts.join("/"))) fail("skill_import_invalid_path", `Skill 包的文件和目录路径冲突：${file.path}`); }
  }
  return Object.freeze(normalized);
}

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Walk and create each directory relative to a held descriptor; never traverse a symlink. */
async function openDirectory(path: string, create: boolean, signal?: AbortSignal): Promise<FileHandle> {
  if (process.platform !== "linux") fail("skill_import_unsupported_host", "本地 Skill 导入需要 Linux 安全文件访问支持。");
  const absolute = resolve(path), root = parse(absolute).root;
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of relative(root, absolute).split("/").filter(Boolean)) {
      signal?.throwIfAborted();
      const nextPath = `/proc/self/fd/${directory.fd}/${component}`;
      if (create) { try { await mkdir(nextPath, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const next = await open(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

async function assertRootIdentity(path: string, root: FileHandle, signal?: AbortSignal): Promise<void> {
  const current = await openDirectory(path, false, signal);
  try { const [before, after] = await Promise.all([root.stat(), current.stat()]); if (before.dev !== after.dev || before.ino !== after.ino) fail("skill_import_catalog_changed", "Skill 用户目录已变化，请刷新后重试。"); }
  finally { await current.close(); }
}

async function checkTree(path: string, signal?: AbortSignal, count = { value: 0 }): Promise<void> {
  signal?.throwIfAborted();
  if (++count.value > 1024) fail("skill_import_unsafe_target", "已有 Skill 包文件过多，无法安全覆盖。");
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail("skill_import_unsafe_target", "已有 Skill 包包含符号链接、硬链接或非普通文件，不能覆盖。");
  if (stat.isDirectory()) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = await directory.stat();
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) fail("skill_import_unsafe_target", "已有 Skill 目录在检查期间变化，请刷新后重试。");
      for (const name of await readdir(`/proc/self/fd/${directory.fd}`)) await checkTree(`/proc/self/fd/${directory.fd}/${name}`, signal, count);
    } finally { await directory.close(); }
  }
}

async function openRelativeDirectory(root: FileHandle, parts: readonly string[], create: boolean, signal?: AbortSignal): Promise<FileHandle> {
  let directory = await open(`/proc/self/fd/${root.fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      signal?.throwIfAborted();
      const path = `/proc/self/fd/${directory.fd}/${part}`;
      if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}
