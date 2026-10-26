import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { prepareWebUiRelease } from "./run-webui.mjs";

const launcherUrl = new URL("./run-webui.mjs", import.meta.url).href;

async function fixture(t, { failBuild = false, hmr } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-webui-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository"), releases = join(directory, "releases");
  await mkdir(join(repository, "src", "apps", "webui", "public"), { recursive: true });
  await mkdir(join(repository, "scripts"));
  await mkdir(join(repository, "native"));
  await mkdir(join(repository, "config"));
  await mkdir(join(repository, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(repository, "node_modules", "fixture"));
  await writeFile(join(repository, "node_modules", "fixture", "version"), "original-dependency");
  await symlink("../fixture/version", join(repository, "node_modules", ".bin", "fixture"));
  await writeFile(join(repository, "package.json"), JSON.stringify({ type: "module", scripts: { prebuild: "node scripts/prebuild-fixture.mjs", build: "node scripts/build-fixture.mjs" } }));
  for (const file of ["package-lock.json", "tsconfig.json", "tsconfig.type-tests.json"]) await writeFile(join(repository, file), "{}");
  await writeFile(join(repository, "config", "cordis.yml"), "old-profile");
  await writeFile(join(repository, "src", "apps", "webui", "lazy.js"), 'export default "old-module";');
  await writeFile(join(repository, "src", "apps", "webui", "public", "index.html"), "old-asset");
  await writeFile(join(repository, "src", "dependency-version"), "old-dependency");
  await writeFile(join(repository, "src", "apps", "webui", "main.js"), `
import { readFile } from "node:fs/promises";
console.log("FIXTURE_READY " + JSON.stringify({ entry: import.meta.url, cwd: process.cwd(), hmr: process.env.CORDIS_HMR, args: process.argv.slice(2), profile: process.env.CORDIS_CONFIG }));
const timer = setInterval(async () => {
  try { await readFile(process.env.TEST_PROBE); } catch { return; }
  clearInterval(timer);
  const values = await Promise.all(["./public/index.html", "../../config/cordis.yml", "../../../native/bin/wish-linux-sandbox", "../../../node_modules/fixture/version"].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  console.log("FIXTURE_VALUES " + JSON.stringify([(await import("./lazy.js")).default, ...values]));
  process.exitCode = 23;
}, 10);
`);
  await writeFile(join(repository, "scripts", "prebuild-fixture.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
await writeFile("node_modules/fixture/version", await readFile("src/dependency-version"));
`);
  await writeFile(join(repository, "scripts", "build-fixture.mjs"), failBuild ? "process.exit(17);" : `
import { cp, mkdir, writeFile } from "node:fs/promises";
await cp("src", "dist", { recursive: true });
await cp("config", "dist/config", { recursive: true });
await mkdir("native/bin", { recursive: true });
await writeFile("native/bin/wish-linux-sandbox", "old-native");
`);
  const environment = { ...process.env, WISH_WEBUI_RUNTIME_DIR: releases, TEST_PROBE: join(directory, "probe"), CORDIS_CONFIG: "custom-profile.yml" };
  if (hmr === undefined) delete environment.CORDIS_HMR; else environment.CORDIS_HMR = hmr;
  return { directory, repository, releases, environment };
}

async function start(t, fixture, { bin = false } = {}) {
  const wrapper = join(fixture.directory, "launch.mjs");
  await writeFile(wrapper, `import { launchWebUi } from ${JSON.stringify(launcherUrl)};
process.exitCode = await launchWebUi({ repositoryRoot: ${JSON.stringify(fixture.repository)}, argv: ["--fixture-argument"] });\n`);
  let command = process.execPath, args = [wrapper];
  if (bin) {
    await cp(fileURLToPath(launcherUrl), join(fixture.repository, "scripts", "run-webui.mjs"));
    command = join(fixture.directory, "wish-webui");
    await symlink("repository/scripts/run-webui.mjs", command);
    args = ["--fixture-argument"];
  }
  const child = spawn(command, args, { cwd: fixture.repository, env: fixture.environment, stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  let output = "", stderr = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exit; }
  });
  const line = async prefix => {
    for (;;) {
      const value = output.split("\n").find(value => value.startsWith(prefix + " "));
      if (value) return JSON.parse(value.slice(prefix.length + 1));
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Fixture exited before ${prefix}: ${stderr}\n${output}`);
      await Promise.race([once(child.stdout, "data"), exit]);
    }
  };
  return { child, exit, line };
}

test("WebUI releases keep code, assets, profiles and native binaries independent of later builds", { timeout: 15000 }, async t => {
  const f = await fixture(t), running = await start(t, f);
  const ready = await running.line("FIXTURE_READY");
  assert.equal(ready.cwd, f.repository);
  assert.equal(ready.hmr, undefined);
  assert.equal(ready.profile, "custom-profile.yml");
  assert.deepEqual(ready.args, ["--fixture-argument"]);
  const release = dirname(dirname(dirname(dirname(fileURLToPath(ready.entry)))));
  assert.equal(dirname(release), f.releases);
  // Rebuild/change every resource in the worktree after startup. Lazy imports
  // and reads in the running process must still resolve to its own release.
  await cp(join(release, "dist"), join(f.repository, "dist"), { recursive: true });
  await writeFile(join(f.repository, "src", "apps", "webui", "lazy.js"), 'export default "new-module";');
  await writeFile(join(f.repository, "dist", "apps", "webui", "lazy.js"), 'export default "new-module";');
  await writeFile(join(f.repository, "dist", "apps", "webui", "public", "index.html"), "new-asset");
  await writeFile(join(f.repository, "config", "cordis.yml"), "new-profile");
  await writeFile(join(f.repository, "dist", "config", "cordis.yml"), "new-profile");
  await mkdir(join(f.repository, "native", "bin"), { recursive: true });
  await writeFile(join(f.repository, "native", "bin", "wish-linux-sandbox"), "new-native");
  await writeFile(f.environment.TEST_PROBE, "read now");
  assert.deepEqual(await running.line("FIXTURE_VALUES"), ["old-module", "old-asset", "old-profile", "old-native", "old-dependency"]);
  assert.equal((await running.exit)[0], 23);
  assert.equal(JSON.parse(await readFile(join(release, "release.json"), "utf8")).entry, "dist/apps/webui/main.js");
  assert.ok((await readdir(f.releases)).includes(release.split("/").at(-1)), "successful release survives process exit");
});

test("prebuild dependency patches in a new release cannot change the repository or an older release", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment });
  assert.equal(await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment }), first, "identical runtime output retains its Profile identity path");
  await writeFile(join(f.repository, "src", "dependency-version"), "new-dependency");
  const second = await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment });
  assert.notEqual(second, first, "changed runtime output receives its own path");
  assert.equal(await readFile(join(f.repository, "node_modules", "fixture", "version"), "utf8"), "original-dependency");
  assert.equal(await readFile(join(first, "node_modules", "fixture", "version"), "utf8"), "old-dependency");
  assert.equal(await readFile(join(second, "node_modules", "fixture", "version"), "utf8"), "new-dependency");
  assert.equal(await readlink(join(first, "node_modules", ".bin", "fixture")), "../fixture/version");
});

test("a release changed by HMR is kept intact and is never reused as the original artifact", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const modified = await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment });
  await writeFile(join(modified, "dist", "apps", "webui", "lazy.js"), 'export default "HMR-changed";');
  const original = await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment });
  assert.notEqual(original, modified);
  assert.equal(await readFile(join(modified, "dist", "apps", "webui", "lazy.js"), "utf8"), 'export default "HMR-changed";');
  assert.equal(await readFile(join(original, "dist", "apps", "webui", "lazy.js"), "utf8"), 'export default "old-module";');
  assert.equal(await prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment }), original);
});

test("dependency links outside the snapshot fail before any build runs", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await symlink("../src", join(f.repository, "node_modules", "outside"));
  await assert.rejects(prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment }), /Dependency symlink cannot be isolated/);
  assert.deepEqual(await readdir(f.releases), []);
  assert.equal(await readFile(join(f.repository, "node_modules", "fixture", "version"), "utf8"), "original-dependency");
});

test("explicit HMR opt in survives release startup and termination reaches the runtime", { timeout: 15000 }, async t => {
  const f = await fixture(t, { hmr: "1" }), running = await start(t, f);
  assert.equal((await running.line("FIXTURE_READY")).hmr, "1");
  running.child.kill("SIGTERM");
  assert.equal((await running.exit)[0], 143);
  assert.equal((await readdir(f.releases)).length, 1);
});

test("the wish-webui bin symlink executes the protected launcher through its shebang", { timeout: 15000 }, async t => {
  const f = await fixture(t), running = await start(t, f, { bin: true });
  const ready = await running.line("FIXTURE_READY");
  assert.equal(ready.hmr, undefined);
  assert.deepEqual(ready.args, ["--fixture-argument"]);
  running.child.kill("SIGTERM");
  assert.equal((await running.exit)[0], 143);
});

test("a failed isolated build neither launches nor retains an incomplete release", { timeout: 15000 }, async t => {
  const f = await fixture(t, { failBuild: true });
  await assert.rejects(prepareWebUiRelease({ repositoryRoot: f.repository, environment: f.environment }), /build exited with code 17/);
  assert.deepEqual(await readdir(f.releases), []);
  await assert.rejects(readFile(join(f.repository, "dist", "apps", "webui", "main.js")), { code: "ENOENT" });
});

test("interrupting a build stops its descendants and removes its unpublished release", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.environment.TEST_BUILD_EFFECTS = join(f.directory, "build-effects");
  await writeFile(join(f.repository, "scripts", "build-fixture.mjs"), `
import { appendFile, writeFile } from "node:fs/promises";
await writeFile(process.env.TEST_BUILD_EFFECTS, "started");
console.log("FIXTURE_BUILD_STARTED {}");
setInterval(() => appendFile(process.env.TEST_BUILD_EFFECTS, "."), 20);
`);
  const running = await start(t, f);
  await running.line("FIXTURE_BUILD_STARTED");
  running.child.kill("SIGTERM");
  assert.notEqual((await running.exit)[0], 0);
  assert.deepEqual(await readdir(f.releases), []);
  const effects = await readFile(f.environment.TEST_BUILD_EFFECTS, "utf8");
  await setTimeout(100);
  assert.equal(await readFile(f.environment.TEST_BUILD_EFFECTS, "utf8"), effects);
});
