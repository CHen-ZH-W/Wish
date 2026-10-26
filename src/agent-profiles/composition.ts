import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import { AgentProfileError, canonical, digest, freezeJson } from "./validation.js";
import type { ProfileCodeFile, ProfilePlugin } from "./types.js";
import { validateProfileResources, type ProfileResources } from "./resources.js";

/** Resolve Loader expressions once; omit absent optional settings and refuse executable values. */
export function configJson(value: unknown, parent = ""): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => configJson(item));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if ((/^(?:apiKey|api_key|password|secret|authorization)$/iu.test(key) || (parent === "headers" && /authorization|cookie|token|api[-_]?key/iu.test(key))) && typeof child === "string" && child !== "") throw new AgentProfileError("profile_literal_secret", "Use credential environment references before freezing a Profile");
      if (parent === "headers" && child && typeof child === "object" && "fromEnv" in child && !/authorization|cookie|token|api[-_]?key/iu.test(key)) throw new AgentProfileError("profile_unresolved_header", "Non-credential headers must be literal in reproducible Profiles");
      result[key] = configJson(child, key);
    }
    return result;
  }
  canonical(value); return value;
}

function moduleUrl(entry: Entry): string {
  const name = entry.options.name;
  if (/^(?:\.{1,2}\/|\/|file:)/u.test(name)) return new URL(name, entry.ctx.baseUrl).href;
  return import.meta.resolve(name);
}

/** A resolved deployment can boot without re-evaluating the original YAML or its environment. */
export function captureComposition(ctx: Context): { plugins: readonly ProfilePlugin[]; deployment: readonly Readonly<Record<string, unknown>>[]; identity: string } {
  const loader = ctx.root.get("loader");
  if (!loader) throw new AgentProfileError("profile_loader_unavailable");
  const entries = [...loader.entries()].filter(entry => entry.id !== "include");
  const rows = new Map<string, Record<string, unknown>>();
  const plugins: ProfilePlugin[] = [];
  const identities: unknown[] = [];
  for (const entry of entries) {
    const grouped = entry.options.group === true;
    const enabled = !entry.disabled;
    const config = grouped || !enabled ? null : configJson(entry.fiber?.config);
    const module = moduleUrl(entry);
    plugins.push({ id: entry.id, module, config, enabled });
    identities.push([entry.id, entry.fiber?.uid ?? null, enabled, grouped ? null : config]);
    const metadata = Object.fromEntries(Object.entries(entry.options).filter(([key]) => !["name", "config", "disabled", "management"].includes(key)));
    rows.set(entry.id, { ...metadata, name: module, disabled: !enabled, ...(grouped ? { config: [] } : config === null ? {} : { config }) });
  }
  const deployment: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const row = rows.get(entry.id)!;
    const parent = rows.get(entry.parent.ctx.fiber.entry?.id ?? "");
    if (parent && Array.isArray(parent.config)) parent.config.push(row);
    else deployment.push(row);
  }
  return freezeJson({ plugins, deployment, identity: digest(identities) });
}

/** Archive identities, not executable artifacts. An unavailable release is explicitly refused. */
export async function captureCode(plugins: readonly ProfilePlugin[]): Promise<readonly ProfileCodeFile[]> {
  const runtimeDirectory = fileURLToPath(new URL("../", import.meta.url));
  const roots = new Set([runtimeDirectory]);
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.module.startsWith("file:")) continue;
    const filename = fileURLToPath(plugin.module);
    if (!filename.startsWith(runtimeDirectory)) roots.add(dirname(filename));
  }
  const files = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.(?:[cm]?js|json|node)$/u.test(entry.name)) files.add(filename);
      else if (entry.isSymbolicLink()) throw new AgentProfileError("profile_code_symlink");
      if (files.size > 20_000) throw new AgentProfileError("profile_code_limit");
    }
  };
  for (const root of roots) await visit(root);
  for (const root of roots) {
    let directory = root;
    while (directory !== dirname(directory)) {
      const manifest = join(directory, "package.json");
      try { await stat(manifest); files.add(manifest); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      directory = dirname(directory);
    }
  }
  for (const name of ["package.json", "package-lock.json", "native/bin/wish-linux-sandbox"]) {
    const filename = resolve(runtimeDirectory, "..", name);
    try { await stat(filename); files.add(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const paths = [...files].sort(), result: ProfileCodeFile[] = [];
  // Constrained Hosts must not open the entire release at once (RLIMIT_NOFILE).
  for (let offset = 0; offset < paths.length; offset += 32) result.push(...await Promise.all(paths.slice(offset, offset + 32).map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }))));
  return result;
}

export async function verifyCode(files: readonly ProfileCodeFile[]): Promise<void> {
  for (const file of files) {
    let bytes: Uint8Array;
    try { bytes = await readFile(file.path); }
    catch (cause) { throw new AgentProfileError("profile_code_unavailable", `Required implementation is unavailable: ${file.path}`); }
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new AgentProfileError("profile_code_changed", `Required implementation changed: ${file.path}`);
  }
}

/** Only Host-owned storage/process locations are relocated; semantic plugin settings stay frozen. */
export function experimentDeployment(deployment: readonly Readonly<Record<string, unknown>>[], directory: string, resources?: ProfileResources, resourceMode: "sealed" | "overlay" = "sealed", boundedModelAdapters = false): string {
  if (resources) validateProfileResources(resources);
  const rows = structuredClone(deployment) as Record<string, unknown>[];
  const candidateControls = new Set(["service.js", "providers/linux.js", "consumers/cli.js", "consumers/management.js", "consumers/model-tools.js"].map(path => new URL(`../candidates/${path}`, import.meta.url).href));
  const visit = (items: Record<string, unknown>[]): void => {
    for (const row of items) {
      if (row.group === true && Array.isArray(row.config)) { visit(row.config as Record<string, unknown>[]); continue; }
      const name = String(row.name);
      if (boundedModelAdapters && /\/models\/model-[a-z-]+-entry\.js$/u.test(name)) row.disabled = true;
      if (resources && (/\/skills\/providers\/local\.js$/u.test(name) || name === new URL("./resource-skills.js", import.meta.url).href)) {
        row.name = new URL("./resource-skills.js", import.meta.url).href;
        row.config = { resourcesJson: canonical(resources), mode: resourceMode };
      }
      if (resources && (/\/memory\/providers\/(?:storage|child-snapshot)\.js$/u.test(name) || name === new URL("./resource-memory.js", import.meta.url).href)) {
        row.name = new URL("./resource-memory.js", import.meta.url).href;
        row.config = { resourcesJson: canonical(resources) };
      }
      // Host control owners can opt out without adding domain dependencies to the Worker.
      if (candidateControls.has(name) || row.experiment === "exclude") row.disabled = true;
      const config = row.config && typeof row.config === "object" ? row.config as Record<string, unknown> : {};
      row.config = config;
      if (name.endsWith("/storage/providers/file/plugin.js")) config.rootDirectory = join(directory, "storage");
      if (name.endsWith("/sessions/service.js")) config.dataDirectory = join(directory, "data");
      if (name.endsWith("/experiments/service.js")) config.directory = join(directory, "jobs");
      if (name.endsWith("/sessions/providers/file/plugin.js")) config.dataDirectory = join(directory, "data");
      if (name.endsWith("/tmux/providers/local.js")) { config.socketPath = join(directory, "tmux.sock"); config.sessionPrefix = "wish-experiment"; }
      if (/\/(?:apps\/webui\/plugin|.*\/consumers\/webui-control|.*\/consumers\/webui)\.js$/u.test(name)) row.disabled = true;
      // A frozen WebUI deployment still boots the isolated Worker through its CLI surface.
      if (name.endsWith("/apps/cli/plugin.js") && row.experiment !== "exclude") row.disabled = false;
      if (name.endsWith("/boot/plugin-control/config-watch.js") || name.includes("cordis-plugin-hmr/")) row.disabled = true;
    }
  };
  visit(rows);
  return canonical(rows);
}
