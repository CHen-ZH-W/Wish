import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { PluginPolicyFollower, SystemPluginPolicy } from "../dist/boot/plugin-control/system-policy.js";
import { WishCliSubagentLauncherBackend } from "../dist/apps/cli/subagent-launcher.js";
import { cleanEnvironment, waitFor, withTimeout } from "./support/process-fixtures.mjs";

const cli = fileURLToPath(new URL("../dist/apps/cli/main.js", import.meta.url));
const workOwner = new URL("../dist/boot/plugin-control/work-owner.js", import.meta.url).href;
const fixtureSource = `import { PluginWorkOwner } from ${JSON.stringify(workOwner)};
export const inject = ['tools'];
export function apply(ctx) {
  let started = false;
  const retirement = new AbortController();
  const work = new PluginWorkOwner(ctx, { code: 'policy_fixture', codeReload: true,
    beforeDrain: () => retirement.abort(),
    close: async () => {
      if (!started) return;
      if (process.env.WISH_TEST_HOLD_CLEANUP === '1') await new Promise(resolve => {
        const release = message => {
          if (message?.type !== 'release') return;
          process.off('message', release); resolve();
        };
        process.on('message', release); process.send?.({ event: 'cleanup-wait' });
      });
      process.send?.({ event: 'cleaned' });
    },
  });
  ctx.on('cli/command', (argv, _terminal, signal) => {
    if (!['fixture', 'child'].includes(argv[0])) return;
    started = true;
    return work.run(() => new Promise(resolve => {
      const combined = AbortSignal.any([signal, retirement.signal]);
      const timer = setInterval(() => {}, 1000);
      const stop = () => { clearInterval(timer); resolve(143); };
      if (combined.aborted) return stop();
      combined.addEventListener('abort', stop, { once: true });
      process.send?.({ event: 'ready', tools: ctx.tools.registry.list().map(tool => tool.name) });
    }));
  });
}`;

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-system-policy-"));
  const management = join(directory, "management"), configurationFile = join(directory, "cordis.yml");
  const children = [];
  let booted, request = 0;
  const boot = async () => {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory, configurationFile,
      environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "host") },
      management: managedWebUi({ directory: management, port: 0 }),
    });
  };
  const change = async (entryIds, preference) => {
    const snapshot = booted.pluginManagement.snapshot();
    return booted.pluginManagement.change({ requestId: `policy-${++request}`, revision: snapshot.revision,
      selection: { instanceId: snapshot.inspection.instanceId, entryIds }, preference });
  };
  const start = (args = [cli, "fixture"], overrides = {}) => {
    const child = spawn(process.execPath, args, { cwd: directory,
      env: { ...cleanEnvironment(), CORDIS_CONFIG: configurationFile, CORDIS_HMR: "0",
        WISH_DATA_DIR: join(directory, `process-${children.length}`), WISH_PLUGIN_POLICY_DIR: management, ...overrides },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages = [], result = { code: undefined, signal: undefined, output: "", error: "" };
    child.on("message", message => messages.push(message));
    child.stdout.on("data", value => { result.output += value; });
    child.stderr.on("data", value => { result.error += value; });
    const exit = new Promise(resolve => child.once("exit", (code, signal) => { result.code = code; result.signal = signal; resolve(result); }));
    children.push(child);
    return { child, result, messages, exit,
      async event(name) {
        await waitFor(() => messages.some(message => message.event === name) || result.code !== undefined,
          () => `Missing ${name}: ${result.error}`);
        const value = messages.find(message => message.event === name);
        assert.ok(value, `Missing ${name}: ${result.error}`); return value;
      },
    };
  };
  try {
    await writeFile(join(directory, "fixture.mjs"), fixtureSource);
    await writeFile(join(directory, "fixture.wish-plugin.json"), JSON.stringify({
      apiVersion: "wish.plugin/v1", id: "policy.fixture", entry: "./fixture.mjs", managementClass: "managed", replacement: "drain",
      configSchema: { type: "object", properties: {}, additionalProperties: false }, permissions: { capabilities: [] },
      sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" },
    }));
    const profile = await readFile(new URL("../dist/config/cordis.yml", import.meta.url), "utf8");
    await writeFile(configurationFile, profile.replace("    - id: cli\n", "    - id: policy-fixture\n      name: ./fixture.mjs\n      management:\n        manifest: ./fixture.wish-plugin.json\n\n    - id: cli\n"));
    await boot();
    await run({ directory, management, start, change, boot, get booted() { return booted; } });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test("system disable drains real CLI and child processes, persists independently of their data roots, and blocks new admissions", { timeout: 30000 }, () => fixture(async f => {
  const first = f.start(undefined, { WISH_TEST_HOLD_CLEANUP: "1" });
  assert.ok((await first.event("ready")).tools.includes("bash"));
  const admitted = process => waitFor(async () => {
    const files = await readdir(join(f.management, "policy-participants"));
    for (const name of files.filter(name => name.endsWith(".json"))) {
      const lease = JSON.parse(await readFile(join(f.management, "policy-participants", name), "utf8"));
      if (lease.pid === process.child.pid && !lease.entries.includes("include:webui")) return true;
    }
    return false;
  }, () => `CLI bootstrap did not finish: ${process.result.error}`);
  await admitted(first);
  let finished = false;
  const disabling = f.change(["include:tool-bash"], "disabled").finally(() => { finished = true; });
  void disabling.catch(() => {});
  await first.event("cleanup-wait");
  await delay(50);
  assert.equal(finished, false, "manager must await foreign process cleanup before success");
  const blocked = await withTimeout(f.start([cli, "--version"]).exit, 5000, "pending admission did not terminate");
  assert.equal(blocked.code, 1);
  assert.match(blocked.error, /system_plugin_policy_changing/u);
  first.child.send({ type: "release" });
  assert.equal((await disabling).status, "succeeded");
  assert.equal((await withTimeout(first.exit, 5000, "revoked CLI did not exit")).code, 143, first.result.error);
  assert.ok(first.messages.some(message => message.event === "cleaned"));

  const launcher = new WishCliSubagentLauncherBackend({ dataDirectory: join(f.directory, "exchange"), pluginPolicyDirectory: f.management });
  const identity = { id: "policy-child", childSessionId: "policy-child-session", childRunId: "policy-child-run" };
  const request = { parentAgentId: "wish", parentSessionId: "parent-session", parentRunId: "parent-run",
    workspaceRoot: f.directory, task: "Policy fixture", role: "worker", permissionProfile: "read-only" };
  const launch = await launcher.resolve(request, identity);
  assert.notEqual(launch.command.environment.WISH_DATA_DIR, join(f.directory, "host"));
  assert.equal(launch.command.environment.WISH_PLUGIN_POLICY_DIR, f.management);
  assert.equal(launch.command.environment.WISH_MANAGED_CLI, "0");
  const child = f.start(launch.command.args, launch.command.environment);
  const ready = await child.event("ready");
  await admitted(child);
  assert.ok(ready.tools.includes("read"));
  assert.equal(ready.tools.includes("bash"), false, "disabled tools must not register in the child Host");

  const cliEntry = f.booted.plugins.inspect().entries.find(entry => entry.id === "include:cli");
  assert.equal(cliEntry.phase, "absent", "test the switch even when CLI is not loaded in WebUI");
  assert.equal(f.booted.pluginManagement.snapshot().controls[cliEntry.id].canDisable, true);
  assert.equal((await f.change(["include:cli"], "disabled")).status, "succeeded");
  assert.equal((await withTimeout(child.exit, 5000, "revoked child did not exit")).code, 143);
  await assert.rejects(launcher.resolve(request, { ...identity, id: "denied-child" }), /system_plugin_disabled:include:cli/u);
  const denied = await withTimeout(f.start([cli, "--version"]).exit, 5000, "disabled CLI did not fail promptly");
  assert.equal(denied.code, 1);
  assert.match(denied.error, /system_plugin_disabled:include:cli/u);

  await f.booted.dispose(); await f.boot();
  assert.equal(f.booted.pluginManagement.snapshot().preferences["include:cli"].preference, "disabled");
  assert.equal((await f.change(["include:cli", "include:tool-bash"], "enabled")).status, "succeeded");
  const restored = await withTimeout(f.start([cli, "--version"]).exit, 5000, "restored CLI did not exit");
  assert.equal(restored.code, 0, restored.error);
  assert.match(restored.output, /wish/u);
  assert.equal(f.booted.plugins.inspect().entries.find(entry => entry.id === "include:tool-bash").phase, "active");
  assert.equal(f.booted.plugins.inspect().entries.find(entry => entry.id === "include:candidate-cli").phase, "absent");
  assert.equal((await f.change(["include:tool-bash", "include:candidate-cli"], "disabled")).status, "succeeded",
    "one unordered batch can disable both loaded and absent plugins");
  for (const id of ["include:tool-bash", "include:candidate-cli"]) {
    assert.equal(f.booted.pluginManagement.snapshot().preferences[id].preference, "disabled");
    assert.equal(f.booted.plugins.inspect().entries.find(entry => entry.id === id).phase, "absent");
  }
  await launch.cleanupOnFailure();
}));

test("failed participant drain retains recovery state until cleanup is verified", { timeout: 15000 }, () => fixture(async f => {
  const policy = new SystemPluginPolicy(f.management);
  let revoked = false;
  const follower = await PluginPolicyFollower.open(policy, ["include:cli"], () => { revoked = true; });
  const hostPolicy = f.booted.context.systemPluginPolicy;
  const drain = hostPolicy.drain.bind(hostPolicy);
  hostPolicy.drain = (ids, signal) => drain(ids, signal, 150);
  try {
    await assert.rejects(f.change(["include:cli"], "disabled"), /system_plugin_policy_drain_timeout/u);
    assert.equal(revoked, true);
    const state = f.booted.pluginManagement.snapshot();
    assert.equal(state.status, "recovery-required");
    assert.equal(state.pending.preference, "disabled");
    await assert.rejects(policy.assertEnabled(["include:cli"]), /system_plugin_policy_changing/u);
  } finally { await follower.close(); }
  await f.booted.dispose(); await f.boot();
  await f.booted.pluginManagement.recoverDisabled(f.booted.pluginManagement.snapshot().revision);
  assert.equal(f.booted.pluginManagement.snapshot().status, "ready");
  await assert.rejects(policy.assertEnabled(["include:cli"]), /system_plugin_disabled:include:cli/u);
}));

test("readers reject corrupt policy and keep their lease until explicit cleanup", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-policy-reader-"));
  const policy = new SystemPluginPolicy(directory);
  let follower, revoked = false;
  try {
    follower = await PluginPolicyFollower.open(policy, ["include:cli"], () => { revoked = true; });
    await writeFile(policy.filename, "not json");
    await waitFor(() => revoked, "corrupt policy must revoke the reader");
    assert.equal((await readdir(policy.participants)).filter(name => name.endsWith(".json")).length, 1);
    await assert.rejects(policy.assertEnabled(["include:cli"]));
    await follower.close();
    assert.equal((await readdir(policy.participants)).length, 0);
  } finally { await follower?.close(); await rm(directory, { recursive: true, force: true }); }
});
