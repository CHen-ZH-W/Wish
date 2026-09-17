import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parseSkillMarkdown, skillName } from "./markdown.js";
import { resourcePath } from "./resources.js";
import type { ReadSkillRequest, SkillCatalog, SkillLookup, SkillResource, Skills, SkillSummary } from "./types.js";

export interface LocalSkillsOptions {
  readonly userRoot?: string;
  readonly maxSkills?: number;
  readonly maxFileBytes?: number;
}

/** Local source adapter; no Cordis, Tools, Session state or script execution. */
export class LocalSkills implements Skills {
  private readonly userRoot: string | undefined;
  private readonly maxSkills: number;
  private readonly maxFileBytes: number;

  constructor(options: LocalSkillsOptions = {}) {
    if (options.userRoot !== undefined && (!isAbsolute(options.userRoot) || options.userRoot.includes("\0"))) throw new TypeError("Skill userRoot must be absolute");
    this.userRoot = options.userRoot === undefined ? undefined : resolve(options.userRoot);
    this.maxSkills = limit(options.maxSkills ?? 100, 1000);
    this.maxFileBytes = limit(options.maxFileBytes ?? 64_000, 1_000_000);
  }

  async list(input: SkillLookup): Promise<SkillCatalog> {
    input.signal?.throwIfAborted();
    if (!isAbsolute(input.cwd)) throw new TypeError("Skill cwd must be absolute");
    const skills: SkillSummary[] = [], issues: { location: string; message: string }[] = [];
    const roots: { path: string; source: SkillSummary["source"] }[] = [
      ...(this.userRoot === undefined ? [] : [{ path: this.userRoot, source: "user" as const }]),
      { path: join(input.cwd, ".agents", "skills"), source: "workspace" },
    ];
    const names = new Set<string>();
    for (const root of roots) {
      input.signal?.throwIfAborted();
      try {
        await regularPath(root.path, "directory");
        const entries = await readDirectory(root.path, input.signal);
        for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          input.signal?.throwIfAborted();
          const location = join(root.path, entry.name, "SKILL.md");
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          try {
            skillName(entry.name);
            const content = await readText(location, this.maxFileBytes, input.signal);
            const metadata = parseSkillMarkdown(content, entry.name);
            if (names.has(metadata.name)) throw new Error("Duplicate Skill name; earlier root wins");
            if (skills.length >= this.maxSkills) throw new Error("Skill catalog limit reached");
            names.add(metadata.name);
            skills.push(Object.freeze({ ...metadata, packageId: digest(JSON.stringify([root.source, location])), source: root.source, location, digest: digest(content) }));
          } catch (error) {
            input.signal?.throwIfAborted();
            issues.push({ location, message: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ location: root.path, message: String(error) });
      }
    }
    return Object.freeze({ skills: Object.freeze(skills), issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
  }

  async read(input: ReadSkillRequest): Promise<SkillResource> {
    input.signal?.throwIfAborted();
    skillName(input.name);
    if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest)) throw new TypeError("expectedDigest must be a SHA-256 digest");
    if ((input.invocation === "model" && input.expectedPackageId === undefined) ||
        (input.expectedPackageId !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedPackageId))) throw new TypeError("Model reads require expectedPackageId");
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Skill offset must be a non-negative integer");
    if (input.limit !== undefined) limit(input.limit, 32_000);
    if ((offset > 0 && input.expectedResourceDigest === undefined) ||
        (input.expectedResourceDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedResourceDigest))) throw new TypeError("Continuation pages require expectedResourceDigest");
    const catalog = await this.list(input);
    const skill = catalog.skills.find(item => item.name === input.name);
    if (!skill) throw new Error("Skill is unknown or no longer available");
    if (input.expectedPackageId !== undefined && input.expectedPackageId !== skill.packageId) throw new Error("Skill package origin changed; refresh its catalog before loading");
    if (input.invocation === "model" && !skill.modelInvocable) throw new Error("Skill does not allow model invocation; explicit Host loading is required");
    if (skill.digest !== input.expectedDigest) throw new Error("Skill changed; refresh its catalog before loading");
    const path = resourcePath(input.path ?? "SKILL.md");
    const directory = resolve(skill.location, "..");
    const target = join(directory, ...path.split("/"));
    if (relative(directory, target).startsWith(`..${sep}`)) throw new Error("Skill path escapes its package");
    const content = await readText(target, this.maxFileBytes, input.signal);
    // The manifest may have changed between discovery and IO. Never silently load it.
    if (path === "SKILL.md" && digest(content) !== skill.digest) throw new Error("Skill changed during loading");
    if (path !== "SKILL.md" && digest(await readText(skill.location, this.maxFileBytes, input.signal)) !== skill.digest) throw new Error("Skill changed during resource loading");
    input.signal?.throwIfAborted();
    const resourceDigest = digest(content);
    if (input.expectedResourceDigest !== undefined && input.expectedResourceDigest !== resourceDigest) throw new Error("Skill resource changed; restart loading from the first page");
    const characters = Array.from(content);
    if (offset > characters.length) throw new RangeError("Skill offset exceeds resource length");
    const end = Math.min(characters.length, offset + (input.limit ?? characters.length));
    return Object.freeze({ skill, path, content: characters.slice(offset, end).join(""), digest: resourceDigest,
      offset, totalCharacters: characters.length,
      ...(end < characters.length ? { nextOffset: end } : {}), complete: offset === 0 && end === characters.length });
  }
}

async function regularPath(path: string, kind: "file" | "directory"): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stat = await lstat(current);
    const directory = index < components.length - 1 || kind === "directory";
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Skill path must use regular ${directory ? "directories" : "files"}: ${current}`);
  }
}

async function readText(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await regularPath(path, "file");
  const file = await openPinnedPath(path, "file", signal);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes || before.nlink !== 1) throw new Error("Skill file must be bounded, regular, and not hard-linked");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Skill file exceeds size limit");
    await regularPath(path, "file");
    const after = await lstat(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== length || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Skill resource changed during loading");
    signal?.throwIfAborted();
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    if (content.includes("\0")) throw new Error("Skill resources must be UTF-8 text");
    return content;
  } finally { await file.close(); }
}

/** Every path component is opened relative to a held directory descriptor.
 * Unlike checking lstat then opening an absolute path, this cannot follow an
 * ancestor symlink swapped into place between those operations. */
async function openPinnedPath(path: string, kind: "file" | "directory", signal?: AbortSignal): Promise<FileHandle> {
  if (process.platform !== "linux") throw new Error("Local Skills requires Linux /proc descriptor-relative safe file access");
  const absolute = resolve(path), root = parse(absolute).root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components.slice(0, -1)) {
      signal?.throwIfAborted();
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    signal?.throwIfAborted();
    return await open(`/proc/self/fd/${directory.fd}/${components.at(-1) ?? "."}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (kind === "directory" ? constants.O_DIRECTORY : 0));
  } finally { await directory.close(); }
}

async function readDirectory(path: string, signal?: AbortSignal) {
  const directory = await openPinnedPath(path, "directory", signal);
  try {
    signal?.throwIfAborted();
    const stream = await opendir(`/proc/self/fd/${directory.fd}`, { bufferSize: 32 });
    const entries = [];
    for await (const entry of stream) {
      signal?.throwIfAborted();
      if (entries.length >= 1000) throw new Error("Skill root exceeds 1000 entries");
      entries.push(entry);
    }
    return entries;
  } finally { await directory.close(); }
}

function digest(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function limit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Skill limit must be between 1 and ${max}`);
  return value;
}
