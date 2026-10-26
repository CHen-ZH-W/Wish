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
export async function prepareWebUiRelease({ repositoryRoot = repository, environment = process.env } = {}) {
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
    return await publishRelease(directory, parent, digest);
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
  const directory = await prepareWebUiRelease({ repositoryRoot, environment });
  process.stderr.write(`Wish WebUI release: ${directory}\n`);
  // The managed profile watcher can still apply deliberate deployment writes.
  // Ordinary working-tree builds cannot touch this release's code or profile.
  return runChild(process.execPath, [join(directory, "dist", "apps", "webui", "main.js"), ...argv], {
    cwd: process.cwd(), env: environment, stdio: "inherit",
  });
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
