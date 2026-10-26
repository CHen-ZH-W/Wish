import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parseSkillMarkdown, skillName } from "./markdown.js";
import { resourcePath } from "./resources.js";
import type { ReadSkillRequest, SkillCatalog, SkillLookup, SkillResource, Skills, SkillSummary, SkillSource, SkillPackageSnapshot } from "./types.js";

interface SourceRegistration { readonly id: string; readonly source: SkillSource; readonly cancellation: AbortController }

export interface LocalSkillsOptions {
  readonly userRoot?: string;
  readonly maxSkills?: number;
  readonly maxFileBytes?: number;
  /** Internal isolated-Host input. Live workspace discovery is disabled when present. */
  readonly frozenPackages?: readonly SkillPackageSnapshot[];
  readonly frozenMode?: "sealed" | "overlay";
}

/** Local source adapter; no Cordis, Tools, Session state or script execution. */
export class LocalSkills implements Skills {
  private readonly userRoot: string | undefined;
  private readonly maxSkills: number;
  private readonly maxFileBytes: number;
  private readonly sources = new Map<string, SourceRegistration>();
  private readonly frozen: FrozenSkills | undefined;
  private readonly frozenPackages: readonly SkillPackageSnapshot[] | undefined;
  private readonly frozenMode: "sealed" | "overlay";

  constructor(options: LocalSkillsOptions = {}) {
    if (options.userRoot !== undefined && (!isAbsolute(options.userRoot) || options.userRoot.includes("\0"))) throw new TypeError("Skill userRoot must be absolute");
    this.userRoot = options.userRoot === undefined ? undefined : resolve(options.userRoot);
    this.maxSkills = limit(options.maxSkills ?? 100, 1000);
    this.maxFileBytes = limit(options.maxFileBytes ?? 64_000, 1_000_000);
    this.frozen = options.frozenPackages === undefined ? undefined : new FrozenSkills(options.frozenPackages);
    this.frozenPackages = options.frozenPackages?.map(validateSkillPackageSnapshot);
    this.frozenMode = options.frozenMode ?? "sealed";
  }

  registerSource(source: SkillSource): () => void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(source.id) || this.sources.has(source.id) || this.sources.size >= 128 || Object.is(source, this) ||
      typeof source.list !== "function" || typeof source.read !== "function" || typeof source.snapshot !== "function") throw new TypeError("Invalid or duplicate Skill source");
    const registration = { id: source.id, source, cancellation: new AbortController() };
    this.sources.set(registration.id, registration);
    return () => {
      if (this.sources.get(registration.id) !== registration) return;
      this.sources.delete(registration.id);
      registration.cancellation.abort(new Error("Skill source retired"));
    };
  }

  async list(input: SkillLookup): Promise<SkillCatalog> {
    const local = await this.listLocal(input);
    const skills = [...local.skills], issues = [...local.issues], names = new Set(skills.map(skill => skill.name));
    for (const registration of this.sources.values()) {
      const lookup = sourceLookup(input, registration);
      try {
        const catalog = await registration.source.list(lookup);
        lookup.signal!.throwIfAborted();
        if (!Array.isArray(catalog.skills) || catalog.skills.length > this.maxSkills || !Array.isArray(catalog.issues) || catalog.issues.length > 1000) throw new Error("Skill source catalog limit exceeded");
        for (const item of catalog.skills) {
          const skill = registeredSummary(registration.id, item);
          const fixed = this.frozenPackages?.find(pkg => pkg.skill.packageId === skill.packageId);
          if (fixed) {
            if (this.frozenMode === "overlay") skills[skills.findIndex(item => item.packageId === skill.packageId)] = skill;
            else if (!Object.entries(fixed.skill).every(([key, value]) => skill[key as keyof SkillSummary] === value)) throw new Error("Frozen Skill contribution changed");
            continue;
          }
          if (this.frozen && this.frozenMode === "sealed") throw new Error("Unfrozen Skill contribution is unavailable");
          if (names.has(skill.name)) { issues.push({ location: skill.location, message: "Duplicate Skill name; earlier source wins" }); continue; }
          if (skills.length >= this.maxSkills) throw new Error("Skill catalog limit reached");
          names.add(skill.name); skills.push(skill);
        }
        for (const issue of catalog.issues) {
          if (typeof issue.location !== "string" || typeof issue.message !== "string" || issue.location.length > 4096 || issue.message.length > 4096) throw new Error("Invalid Skill source diagnostic");
          issues.push(Object.freeze({ location: issue.location, message: issue.message }));
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        if (!registration.cancellation.signal.aborted) issues.push({ location: `source:${registration.id}`, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return Object.freeze({ skills: Object.freeze(skills), issues: Object.freeze(issues.map(issue => Object.freeze(issue))) });
  }

  private async listLocal(input: SkillLookup): Promise<SkillCatalog> {
    if (this.frozen) return this.frozen.list(input);
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
    if (this.frozenMode === "sealed" && this.frozenPackages?.some(pkg => pkg.skill.packageId === skill.packageId)) return this.frozen!.read(input);
    const localIdentity = digest(JSON.stringify([skill.source, skill.location])) === skill.packageId;
    // Source identity is re-resolved, so removal/replacement cannot reuse a stale catalog.
    if (!localIdentity) for (const registration of this.sources.values()) {
      const lookup = sourceLookup(input, registration), catalog = await registration.source.list(lookup);
      lookup.signal!.throwIfAborted();
      const original = catalog.skills.find(item => registeredSummary(registration.id, item).packageId === skill.packageId);
      if (!original) continue;
      const { offset: _offset, limit: _limit, ...request } = input;
      const loaded = await registration.source.read({ ...request, ...lookup, expectedPackageId: original.packageId, path, offset: 0 });
      lookup.signal!.throwIfAborted();
      if (registeredSummary(registration.id, loaded.skill).packageId !== skill.packageId || loaded.skill.digest !== skill.digest ||
        loaded.skill.modelInvocable !== skill.modelInvocable || loaded.path !== path || !loaded.complete || loaded.offset !== 0 ||
        loaded.totalCharacters !== Array.from(loaded.content).length || Buffer.byteLength(loaded.content) > this.maxFileBytes || digest(loaded.content) !== loaded.digest ||
        (path === "SKILL.md" && loaded.digest !== skill.digest)) throw new Error("Skill source returned incomplete or changed resource bytes");
      const manifest = path === "SKILL.md" ? loaded : await registration.source.read({ ...lookup, name: skill.name, expectedDigest: skill.digest, expectedPackageId: original.packageId, path: "SKILL.md", invocation: "host" });
      lookup.signal!.throwIfAborted();
      if (!manifest.complete || manifest.offset !== 0 || digest(manifest.content) !== skill.digest) throw new Error("Skill source manifest changed");
      const metadata = parseSkillMarkdown(manifest.content, skill.name);
      if (metadata.modelInvocable !== skill.modelInvocable || metadata.description !== skill.description) throw new Error("Skill source cannot change invocation authority");
      return page(skill, path, loaded.content, input);
    }
    if (!localIdentity) throw new Error("Skill source retired or changed; refresh its catalog before loading");
    const directory = resolve(skill.location, "..");
    const target = join(directory, ...path.split("/"));
    if (relative(directory, target).startsWith(`..${sep}`)) throw new Error("Skill path escapes its package");
    const content = await readText(target, this.maxFileBytes, input.signal);
    // The manifest may have changed between discovery and IO. Never silently load it.
    if (path === "SKILL.md" && digest(content) !== skill.digest) throw new Error("Skill changed during loading");
    if (path !== "SKILL.md" && digest(await readText(skill.location, this.maxFileBytes, input.signal)) !== skill.digest) throw new Error("Skill changed during resource loading");
    input.signal?.throwIfAborted();
    return page(skill, path, content, input);
  }

  async snapshot(input: SkillLookup): Promise<readonly SkillPackageSnapshot[]> {
    const before = await this.list(input);
    if (before.issues.length) throw new Error("Complete Skill capture requires a catalog without diagnostics");
    const packages: SkillPackageSnapshot[] = [], captured = new Set<string>();
    const local = await this.listLocal(input);
    const contributed = new Set<string>();
    if (this.frozen) for (const registration of this.sources.values()) {
      const lookup = sourceLookup(input, registration);
      for (const skill of (await registration.source.list(lookup)).skills) contributed.add(registeredSummary(registration.id, skill).packageId);
      lookup.signal!.throwIfAborted();
    }
    for (const skill of before.skills) {
      if (!local.skills.some(item => item.packageId === skill.packageId)) continue;
      if (this.frozen && contributed.has(skill.packageId)) continue;
      if (this.frozenPackages) {
        packages.push(this.frozenPackages.find(pkg => pkg.skill.packageId === skill.packageId)!); captured.add(skill.packageId); continue;
      }
      const first = await captureLocalPackage(skill, this.maxFileBytes, input.signal);
      const second = await captureLocalPackage(skill, this.maxFileBytes, input.signal);
      if (first.digest !== second.digest) throw new Error("Skill resource tree changed during capture");
      packages.push(first); captured.add(skill.packageId);
    }
    for (const registration of this.sources.values()) {
      const lookup = sourceLookup(input, registration), snapshots = await registration.source.snapshot(lookup);
      lookup.signal!.throwIfAborted();
      if (!Array.isArray(snapshots) || snapshots.length > this.maxSkills) throw new Error("Skill source snapshot limit exceeded");
      for (const raw of snapshots) {
        const pkg = validateSkillPackageSnapshot(raw), skill = registeredSummary(registration.id, pkg.skill);
        const visible = before.skills.find(item => item.packageId === skill.packageId);
        if (!visible) continue;
        if (!Object.entries(visible).every(([key, value]) => skill[key as keyof SkillSummary] === value)) throw new Error("Skill source changed during capture");
        if (captured.has(skill.packageId)) throw new Error("Duplicate Skill package capture");
        const normalized = createSkillPackageSnapshot(skill, Object.fromEntries(pkg.resources.map(resource => [resource.path, resource.content])));
        if (this.frozenMode === "sealed" && this.frozenPackages) {
          const fixed = this.frozenPackages.find(item => item.skill.packageId === skill.packageId);
          if (!fixed || fixed.digest !== normalized.digest) throw new Error("Frozen Skill resources changed");
        }
        packages.push(normalized); captured.add(skill.packageId);
      }
    }
    if (captured.size !== before.skills.length || JSON.stringify(before) !== JSON.stringify(await this.list(input))) throw new Error("Skill catalog changed during capture");
    const ordered = before.skills.map(skill => packages.find(pkg => pkg.skill.packageId === skill.packageId)!);
    boundedPackages(ordered);
    return Object.freeze(ordered);
  }
}

function sourceLookup(input: SkillLookup, registration: SourceRegistration): SkillLookup {
  return { cwd: input.cwd, signal: AbortSignal.any([registration.cancellation.signal, ...(input.signal ? [input.signal] : [])]) };
}
function registeredSummary(sourceId: string, value: SkillSummary): SkillSummary {
  validateSummary(value);
  return Object.freeze({ ...value, packageId: digest(JSON.stringify([sourceId, value.packageId])) });
}
function validateSummary(value: SkillSummary): void {
  skillName(value?.name);
  if (Object.keys(value).some(key => !["packageId", "name", "description", "source", "location", "digest", "modelInvocable"].includes(key)) || !/^[a-f0-9]{64}$/u.test(value.packageId) || !/^[a-f0-9]{64}$/u.test(value.digest) || !["user", "workspace"].includes(value.source) ||
    typeof value.modelInvocable !== "boolean" || typeof value.description !== "string" || !value.description.trim() || value.description.length > 1024 ||
    typeof value.location !== "string" || !value.location || value.location.length > 4096 || value.location.includes("\0")) throw new TypeError("Invalid Skill summary");
}
function page(skill: SkillSummary, path: string, content: string, input: ReadSkillRequest): SkillResource {
  const resourceDigest = digest(content), offset = input.offset ?? 0;
  if (input.expectedResourceDigest !== undefined && input.expectedResourceDigest !== resourceDigest) throw new Error("Skill resource changed; restart loading from the first page");
  const characters = Array.from(content);
  if (offset > characters.length) throw new RangeError("Skill offset exceeds resource length");
  const end = Math.min(characters.length, offset + (input.limit ?? characters.length));
  return Object.freeze({ skill, path, content: characters.slice(offset, end).join(""), digest: resourceDigest, offset, totalCharacters: characters.length,
    ...(end < characters.length ? { nextOffset: end } : {}), complete: offset === 0 && end === characters.length });
}

/** Build a frozen package from explicit data; no filesystem writes or script execution. */
export function createSkillPackageSnapshot(skill: SkillSummary, files: Readonly<Record<string, string>>): SkillPackageSnapshot {
  validateSummary(skill);
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 256) throw new TypeError("Skill package file limit exceeded");
  const resources = Object.keys(files).sort().map(path => {
    resourcePath(path);
    const content = files[path];
    if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > 1_000_000 || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(content)) !== content) throw new TypeError("Skill package resources must be bounded UTF-8 text");
    return Object.freeze({ path, content, digest: digest(content), bytes: Buffer.byteLength(content) });
  });
  const manifest = resources.find(item => item.path === "SKILL.md");
  if (!manifest || manifest.digest !== skill.digest) throw new Error("Skill package manifest digest mismatch");
  const metadata = parseSkillMarkdown(manifest.content, skill.name);
  if (metadata.description !== skill.description || metadata.modelInvocable !== skill.modelInvocable) throw new Error("Skill package metadata mismatch");
  const paths = resources.map(item => item.path);
  if (paths.some(path => paths.some(other => other.startsWith(`${path}/`))) || resources.reduce((sum, item) => sum + item.bytes, 0) > 4 * 1024 * 1024) throw new Error("Skill package tree exceeds limits or has a path collision");
  const body = { schemaVersion: 1 as const, skill: Object.freeze({ ...skill }), resources: Object.freeze(resources) };
  return Object.freeze({ ...body, digest: digest(stableJson(body)) });
}
export function validateSkillPackageSnapshot(value: unknown): SkillPackageSnapshot {
  const pkg = value as SkillPackageSnapshot;
  if (!pkg || pkg.schemaVersion !== 1 || !Array.isArray(pkg.resources) || pkg.resources.length > 256 || Object.keys(pkg).some(key => !["schemaVersion", "skill", "resources", "digest"].includes(key))) throw new TypeError("Invalid Skill package snapshot");
  const files: Record<string, string> = {};
  for (const resource of pkg.resources) {
    if (!resource || Object.keys(resource).some(key => !["path", "content", "digest", "bytes"].includes(key)) || Object.hasOwn(files, resource.path)) throw new TypeError("Invalid Skill package resource");
    if (typeof resource.content !== "string" || digest(resource.content) !== resource.digest || Buffer.byteLength(resource.content) !== resource.bytes) throw new Error("Skill resource digest/size mismatch");
    Object.defineProperty(files, resource.path, { value: resource.content, enumerable: true });
  }
  const expected = createSkillPackageSnapshot(pkg.skill, files);
  if (expected.digest !== pkg.digest || stableJson(expected.resources) !== stableJson(pkg.resources)) throw new Error("Skill package digest mismatch");
  return expected;
}
function boundedPackages(packages: readonly SkillPackageSnapshot[]): void {
  if (packages.length > 1000 || packages.reduce((sum, pkg) => sum + pkg.resources.reduce((size, item) => size + item.bytes, 0), 0) > 16 * 1024 * 1024) throw new Error("Skill snapshot total limit exceeded");
}

/** Immutable source adapter. Callers opt in; normal LocalSkills reads stay live. */
export class FrozenSkills implements Skills {
  private readonly packages: readonly SkillPackageSnapshot[];
  constructor(packages: readonly SkillPackageSnapshot[]) {
    boundedPackages(packages);
    this.packages = Object.freeze(packages.map(validateSkillPackageSnapshot));
    if (new Set(this.packages.map(pkg => pkg.skill.name)).size !== packages.length || new Set(this.packages.map(pkg => pkg.skill.packageId)).size !== packages.length) throw new Error("Duplicate frozen Skill identity");
  }
  async list(input: SkillLookup): Promise<SkillCatalog> { input.signal?.throwIfAborted(); if (!isAbsolute(input.cwd)) throw new TypeError("Skill cwd must be absolute"); return Object.freeze({ skills: Object.freeze(this.packages.map(pkg => pkg.skill)), issues: Object.freeze([]) }); }
  async snapshot(input: SkillLookup): Promise<readonly SkillPackageSnapshot[]> { await this.list(input); return this.packages; }
  async read(input: ReadSkillRequest): Promise<SkillResource> {
    await this.list(input);
    const skill = this.packages.find(pkg => pkg.skill.name === input.name)?.skill;
    if (!skill || input.expectedDigest !== skill.digest || (input.expectedPackageId !== undefined && input.expectedPackageId !== skill.packageId)) throw new Error("Frozen Skill identity changed or is unavailable");
    if (input.invocation === "model" && (!input.expectedPackageId || !skill.modelInvocable)) throw new Error("Frozen Skill does not allow this model invocation");
    if (!Number.isSafeInteger(input.offset ?? 0) || (input.offset ?? 0) < 0 || ((input.offset ?? 0) > 0 && input.expectedResourceDigest === undefined)) throw new TypeError("Invalid frozen Skill continuation");
    if (input.limit !== undefined) limit(input.limit, 32_000);
    const path = resourcePath(input.path ?? "SKILL.md"), resource = this.packages.find(pkg => pkg.skill.packageId === skill.packageId)!.resources.find(item => item.path === path);
    if (!resource) throw new Error("Frozen Skill resource unavailable");
    return page(skill, path, resource.content, input);
  }
}

async function captureLocalPackage(skill: SkillSummary, maxBytes: number, signal?: AbortSignal): Promise<SkillPackageSnapshot> {
  const directory = resolve(skill.location, ".."), files: Record<string, string> = {};
  let entriesSeen = 0;
  const visit = async (path: string, prefix: string): Promise<void> => {
    const entries = await readDirectory(path, signal);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > 1024) throw new Error("Skill package directory limit exceeded");
      const name = `${prefix}/${entry.name}`; resourcePath(name);
      if (entry.isSymbolicLink()) throw new Error("Skill snapshot rejects symbolic links");
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) {
        if (Object.keys(files).length >= 256) throw new Error("Skill package file limit exceeded");
        files[name] = await readText(join(path, entry.name), maxBytes, signal);
        if (Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0) > 4 * 1024 * 1024) throw new Error("Skill package size limit exceeded");
      } else throw new Error("Skill snapshot requires regular resources");
    }
  };
  files["SKILL.md"] = await readText(skill.location, maxBytes, signal);
  for (const name of ["references", "scripts", "assets"]) {
    const path = join(directory, name);
    try { await regularPath(path, "directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await visit(path, name);
  }
  return createSkillPackageSnapshot(skill, files);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
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
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
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
