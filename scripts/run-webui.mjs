#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

/** Build a complete, private release without writing to the working tree's dist. */
export async function prepareWebUiRelease({ repositoryRoot = repository, environment = process.env, onPublished = async () => {} } = {}) {
  const parent = resolve(environment.WISH_WEBUI_RUNTIME_DIR || join(environment.WISH_DATA_DIR || join(homedir(), ".wish"), "releases"));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, ".building-webui-"));
  try {
    // Keep the package layout intact: native launchers, self exports, candidate
    // workers and bundled Cordis profiles all resolve relative to the release.
    for (const name of ["src", "config", "scripts", "native", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.type-tests.json"]) {
      await cp(join(repositoryRoot, name), join(directory, name), { recursive: true, dereference: true });
    }
    // Reflinks/copies own their bytes; hardlinks or a node_modules symlink would
    // let prebuild patches and later installs mutate an already running release.
    const dependencies = await realpath(join(repositoryRoot, "node_modules"));
    await requireInternalDependencyLinks(dependencies);
    await cp(dependencies, join(directory, "node_modules"), {
      recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE,
    });
    const npm = environment.npm_execpath;
    const code = await runChild(npm ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
      npm ? [npm, "run", "build"] : ["run", "build"], { cwd: directory, env: environment, stdio: "inherit" });
    if (code !== 0) throw new Error(`Isolated WebUI build exited with code ${code}`);
    await readFile(join(directory, "dist", "apps", "webui", "main.js"));
    const digest = await digestRuntime(directory);
    await writeFile(join(directory, "release.json"), JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), entry: "dist/apps/webui/main.js",
      digest, source: resolve(repositoryRoot), dependencies: { source: dependencies, snapshot: "node_modules", copyMode: "reflink-or-copy" },
    }, null, 2) + "\n", { flag: "wx" });
    return await withReleaseLock(parent, async () => {
      const published = await publishRelease(directory, parent, digest);
      await onPublished(published);
      return published;
    });
  } catch (error) {
    // Only an unpublished release created by this invocation is removable.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Runtime paths participate in persisted Profile identity, so identical output
 * must keep its path across restarts. Never replace a running, modified release. */
async function publishRelease(staging, parent, digest) {
  const prefix = `webui-${digest}`;
  for (;;) {
    const existing = (await readdir(parent)).filter(name => name === prefix || name.startsWith(`${prefix}-`)).sort();
    for (const name of existing) {
      const directory = join(parent, name);
      try {
        if (await digestRuntime(directory) !== digest) continue;
        await rm(staging, { recursive: true, force: true });
        return directory;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    // HMR may have deliberately changed the first release with this digest.
    // Keep it untouched and create a separate copy of the original artifacts.
    const target = join(parent, existing.includes(prefix) ? `${prefix}-${randomUUID()}` : prefix);
    try { await rename(staging, target); return target; }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
  }
}

async function digestRuntime(root) {
  const hash = createHash("sha256");
  async function visit(name) {
    const filename = join(root, name), info = await lstat(filename);
    if (info.isDirectory()) {
      hash.update(JSON.stringify(["directory", name]) + "\n");
      for (const child of (await readdir(filename)).sort()) await visit(join(name, child));
    } else if (info.isSymbolicLink()) {
      hash.update(JSON.stringify(["symlink", name, await readlink(filename)]) + "\n");
    } else if (info.isFile()) {
      hash.update(JSON.stringify(["file", name, info.mode & 0o777, info.size]) + "\n");
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      hash.update("\n");
    } else throw new Error(`Unsupported release artifact: ${filename}`);
  }
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.type-tests.json", "src", "config", "scripts", "dist", "native", "node_modules"]) await visit(name);
  return hash.digest("hex");
}

async function requireInternalDependencyLinks(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) await requireInternalDependencyLinks(root, filename);
    else if (entry.isSymbolicLink()) {
      const target = await readlink(filename);
      const actual = relative(root, await realpath(filename));
      if (isAbsolute(target) || actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual)) {
        throw new Error(`Dependency symlink cannot be isolated: ${filename}`);
      }
    }
  }
}

export async function launchWebUi({ repositoryRoot = repository, environment = process.env, argv = process.argv.slice(2) } = {}) {
  const keep = releaseKeep(environment.WISH_WEBUI_RELEASE_KEEP);
  let lease;
  const directory = await prepareWebUiRelease({ repositoryRoot, environment, onPublished: async directory => {
    lease = join(directory, `.runtime-user-${process.pid}-${randomUUID()}.json`);
    await writeFile(lease, JSON.stringify({ pid: process.pid, start: await processStart(process.pid) }), { flag: "wx", mode: 0o600 });
  } });
  process.stderr.write(`Wish WebUI release: ${directory}\n`);
  // The managed profile watcher can still apply deliberate deployment writes.
  // Ordinary working-tree builds cannot touch this release's code or profile.
  const cleanup = () => pruneWebUiReleases({ parent: dirname(directory), keep, environment, protectedDirectories: [directory] })
    .catch(error => process.stderr.write(`Wish release cleanup deferred: ${error.message}\n`));
  try {
    await cleanup();
    return await runChild(process.execPath, [join(directory, "dist", "apps", "webui", "main.js"), ...argv], {
      cwd: process.cwd(), env: environment, stdio: "inherit",
    });
  } finally { await rm(lease, { force: true }); await cleanup(); }
}

function releaseKeep(value) {
  if (value === undefined) return 2;
  const keep = Number(value);
  if (!Number.isSafeInteger(keep) || keep < 2) throw new Error("WISH_WEBUI_RELEASE_KEEP must be an integer >= 2");
  return keep;
}

/** Published releases are reclaimed only after checking live users and durable
 * executable Profile references. Unrecognized directories are never candidates. */
export async function pruneWebUiReleases({ parent, keep = 2, environment = process.env, protectedDirectories = [] }) {
  releaseKeep(String(keep));
  // Older launchers have no lease. Linux process inspection also protects those
  // releases and children left alive after a launcher crash.
  if (process.platform !== "linux") return [];
  parent = await realpath(parent);
  return withReleaseLock(parent, async () => {
    const candidates = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^webui-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/u.test(entry.name)) continue;
      const directory = join(parent, entry.name);
      let metadata;
      try { metadata = JSON.parse(await readFile(join(directory, "release.json"), "utf8")); }
      catch { continue; }
      if (metadata.schemaVersion !== 1 || metadata.entry !== "dist/apps/webui/main.js" ||
          entry.name.slice(6, 70) !== metadata.digest || !Number.isFinite(Date.parse(metadata.createdAt))) continue;
      candidates.push({ directory, createdAt: metadata.createdAt });
    }
    const protectedSet = new Set(protectedDirectories.map(path => resolve(path)));
    const protectReferences = text => {
      for (const { directory } of candidates) if (text.includes(directory + "/") || text.includes(pathToFileURL(directory).href + "/") || text === directory) protectedSet.add(directory);
    };
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        const info = await lstat(`/proc/${name}`);
        if (info.uid !== process.getuid()) continue;
        const command = await readFile(`/proc/${name}/cmdline`, "utf8");
        protectReferences(command);
        // Wish runs on Node. Unrelated setuid helpers may expose cmdline but
        // deny cwd access; they cannot own a relative Node module entrypoint.
        if (/(?:^|\/)(?:node|nodejs)$/u.test(command.split("\0")[0] ?? "")) {
          protectReferences(await readlink(`/proc/${name}/cwd`).catch(error => {
            if (["ENOENT", "ESRCH"].includes(error.code)) return "";
            throw error;
          }));
        }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    for (const { directory } of candidates) {
      for (const name of await readdir(directory)) {
        if (!/^\.runtime-user-\d+-[a-f0-9-]+\.json$/u.test(name)) continue;
        const path = join(directory, name);
        try {
          const owner = JSON.parse(await readFile(path, "utf8"));
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.start !== "string") { protectedSet.add(directory); continue; }
          const start = await processStart(owner.pid);
          if (start && start === owner.start) protectedSet.add(directory);
          else await rm(path, { force: true });
        } catch (error) { if (error.code !== "ENOENT") protectedSet.add(directory); }
      }
    }
    const dataRoot = resolve(environment.WISH_DATA_DIR || join(homedir(), ".wish"));
    const storageRoot = resolve(environment.WISH_STORAGE_FILE_ROOT || join(dataRoot, "storage"));
    const namespace = createHash("sha256").update("agent-profiles/snapshots/v1").digest("hex");
    await scanReferences(join(storageRoot, "kv", `namespace-${namespace}`), text => {
      const record = JSON.parse(text);
      if (typeof record.valueBase64 !== "string") throw new Error("Cannot verify persisted Profile references");
      protectReferences(Buffer.from(record.valueBase64, "base64").toString("utf8"));
    });
    await scanReferences(join(dataRoot, "management"), protectReferences);
    if (environment.CORDIS_CONFIG) {
      try { protectReferences(await readFile(resolve(environment.CORDIS_CONFIG), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.directory.localeCompare(b.directory));
    for (const { directory } of candidates.slice(0, keep)) protectedSet.add(directory);
    const inspected = new Set();
    for (;;) {
      const next = candidates.find(({ directory }) => protectedSet.has(directory) && !inspected.has(directory));
      if (!next) break;
      inspected.add(next.directory);
      await scanReferences(join(next.directory, "config"), protectReferences);
    }
    const removed = [];
    for (const { directory } of candidates) {
      if (protectedSet.has(directory)) continue;
      await rm(directory, { recursive: true });
      removed.push(directory);
    }
    return removed;
  });
}

async function scanReferences(directory, consume) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (entry.name === "credentials.json" || entry.name.endsWith(".lock")) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Cannot inspect linked release references");
    if (entry.isDirectory()) await scanReferences(path, consume);
    else if (/\.(?:json|ya?ml)$/u.test(entry.name)) consume(await readFile(path, "utf8"));
  }
}

async function processStart(pid) {
  if (process.platform !== "linux") return "live";
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return ""; throw error; }
}

async function withReleaseLock(parent, operation) {
  if (process.platform !== "linux") return operation();
  const path = join(parent, ".releases.lock");
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Release lock cannot be a symlink"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const child = spawn("flock", ["--exclusive", "--wait", "30", "--no-fork", path, "/bin/sh", "-c",
    'printf "locked\\n"; cat >/dev/null'], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let detail = "";
  child.stderr.on("data", chunk => { detail += chunk; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  void closed.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", chunk => String(chunk) === "locked\n" ? resolve() : reject(new Error("Invalid release lock response")));
      child.once("close", () => reject(new Error(`Release lock unavailable: ${detail}`)));
    });
    return await operation();
  } finally { child.stdin.end(); await closed; }
}

function runChild(command, args, options) {
  return new Promise((resolveResult, reject) => {
    // npm builds have shell/compiler descendants. Forward signals to the whole
    // owned process group so a cancelled build cannot continue writing output.
    const ownGroup = process.platform !== "win32";
    const child = spawn(command, args, { ...options, detached: ownGroup });
    const handlers = new Map(["SIGINT", "SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])].map(signal => {
      const handler = () => {
        if (!child.pid) return;
        try { if (ownGroup) process.kill(-child.pid, signal); else child.kill(signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      process.on(signal, handler);
      return [signal, handler];
    }));
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveResult(code ?? 128 + (osConstants.signals[signal] ?? 1));
    });
  });
}

// npm's bin entry is a symlink; compare its canonical path to this module.
if (process.argv[1] && pathToFileURL(await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).href === import.meta.url) {
  try { process.exitCode = await launchWebUi(); }
  catch (error) {
    process.stderr.write(`wish-webui: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
