import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { FileSubagentExchange } from "../dist/subagents/files.js";
import { createResourceManifest, snapshotResources } from "../dist/subagents/resources.js";
import { WishCliSubagentLauncherBackend } from "../dist/apps/cli/subagent-launcher.js";
import { SubagentLauncherService } from "../dist/subagents/launcher.js";
import { SubagentRuntime } from "../dist/subagents/runtime.js";
import { MemorySubagentRecordStore, snapshotRecord } from "../dist/subagents/store.js";

const identity = { id: "child-1", childSessionId: "session-child", childRunId: "run-child" };
const owner = { parentAgentId: "parent", parentSessionId: "session-parent", parentRunId: "run-parent", workspaceRoot: "/tmp/workspace" };
const resource = { type: "fixture.knowledge", schemaVersion: 1, payload: { title: "Read only", list: [1, "two"] } };

test("resource manifests are bounded immutable data and bind all execution identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-resources-"));
  try {
    const exchange = new FileSubagentExchange(directory);
    const manifest = await exchange.writeInputResources(identity, owner, [resource]);
    assert.ok(Object.isFrozen(manifest.resources[0].payload.list));
    assert.deepEqual(await exchange.readInputResources(identity), manifest);
    await assert.rejects(exchange.readInputResources({ ...identity, childRunId: "foreign" }), /identity mismatch/u);
    await assert.rejects(exchange.writeInputResources(identity, owner, [resource]), /EEXIST/u);
    const output = { type: "fixture.proposals", schemaVersion: 1, payload: [{ text: "Untrusted candidate" }] };
    await exchange.writeOutputResource(manifest, output);
    assert.deepEqual(await exchange.readOutputResource(manifest, output.type), output);
    const stale = createResourceManifest(identity, owner, [{ ...resource, payload: "different" }]);
    await assert.rejects(exchange.readOutputResource(stale, output.type), /another input snapshot/u);
    assert.throws(() => snapshotResources([resource, resource]), /Duplicate/u);
    assert.throws(() => snapshotResources([{ ...resource, type: "../escape" }]), /resource type/u);
    assert.throws(() => snapshotResources([{ ...resource, payload: "x".repeat(2_000_001) }]), /JSON/u);
    assert.throws(() => snapshotResources([{ ...resource, payload: { execute() {} } }]), /JSON/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resource IO rejects tampering, symlink files, and output path escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-resources-security-"));
  try {
    const exchange = new FileSubagentExchange(directory);
    const manifest = await exchange.writeInputResources(identity, owner, [resource]);
    const path = exchange.inputResourcesPath(identity.id);
    const bytes = JSON.parse(await readFile(path, "utf8"));
    bytes.resources[0].payload.title = "tampered";
    await writeFile(path, JSON.stringify(bytes));
    await assert.rejects(exchange.readInputResources(identity), /digest mismatch/u);
    await rm(path);
    const outside = join(directory, "outside.json");
    await writeFile(outside, JSON.stringify(manifest));
    await symlink(outside, path);
    await assert.rejects(exchange.readInputResources(identity), /ELOOP/u);
    await assert.rejects(exchange.writeOutputResource(manifest, { ...resource, type: "../../escape" }), /resource type/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI launcher obtains resources only from the Host and preserves child data isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-resources-launch-"));
  try {
    const exchange = new FileSubagentExchange(directory);
    let seen;
    const launcher = new WishCliSubagentLauncherBackend({ dataDirectory: directory, exchange, prepareResources: async (request, child) => {
      seen = { request, child }; return [resource];
    } });
    const request = { ...owner, task: "Inspect files", permissionProfile: "read-only" };
    const launch = await launcher.resolve(request, identity);
    assert.deepEqual(seen, { request, child: identity });
    assert.equal(launch.command.environment.WISH_DATA_DIR, exchange.childDataDirectory(identity.id));
    assert.equal(launch.command.environment.WISH_STORAGE_FILE_ROOT, join(exchange.childDataDirectory(identity.id), "storage"));
    assert.equal(launch.command.environment.WISH_CHILD_RESOURCES_FILE, exchange.inputResourcesPath(identity.id));
    assert.equal(launch.command.environment.WISH_CHILD_RESOURCES_DIGEST, (await exchange.readInputResources(identity)).digest);
    await launch.cleanupOnFailure();
    assert.equal(await exchange.readInputResources(identity), undefined);
    const plain = new WishCliSubagentLauncherBackend({ dataDirectory: directory });
    const noResource = await plain.resolve(request, { ...identity, id: "plain" });
    assert.equal(noResource.command.environment.WISH_CHILD_RESOURCES_FILE, "");
    assert.equal(noResource.command.environment.WISH_CHILD_RESOURCES_DIGEST, "");
    await noResource.cleanupOnFailure();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Host resource registrations follow Consumer lifecycle rather than the launcher's", async () => {
  class Launcher extends SubagentLauncherService {
    async resolve(request, identity) { return this.prepareResources(request, identity); }
  }
  const root = new Context();
  try {
    await root.plugin(Launcher);
    const plugin = await root.plugin({ inject: ["subagentLauncher"], apply(ctx) {
      ctx.subagentLauncher.registerResourceProvider({ id: "fixture", prepare() { return [resource]; } });
    } });
    assert.deepEqual(await root.subagentLauncher.resolve({ ...owner, task: "inspect" }, identity), [resource]);
    await plugin.dispose();
    assert.deepEqual(await root.subagentLauncher.resolve({ ...owner, task: "inspect" }, identity), []);
  } finally { await root.fiber.dispose(); }
});

test("Runtime durably binds resource digest before admitting child execution", async () => {
  const store = new MemorySubagentRecordStore();
  const digest = "a".repeat(64);
  const target = { providerId: "fixture", id: "child-1", target: "fixture:child-1", attachCommand: "attach", captureCommand: "capture", locator: {} };
  let starts = 0;
  const runtime = new SubagentRuntime({ store, id: () => "child-1", launcher: { resolve() { return { resourceManifestDigest: digest, command: { executable: "fixture", cwd: owner.workspaceRoot } }; } },
    execution: { async start() {
      assert.equal((await store.get("child-1")).resourceManifestDigest, digest);
      starts++;
      return { target, active: false, exitCode: 0 };
    } },
  });
  try {
    const record = await runtime.spawn({ ...owner, task: "Inspect" });
    assert.equal(starts, 1);
    assert.equal(snapshotRecord(record).resourceManifestDigest, digest);
    assert.throws(() => snapshotRecord({ ...record, resourceManifestDigest: "invalid" }), /manifest digest/u);
  } finally { await runtime.close(); }
});

test("failed Host resource binding prevents process dispatch and cleans prepared attachments", async () => {
  class RejectBindingStore extends MemorySubagentRecordStore {
    async replace(record, signal) {
      if (record.status === "starting" && record.resourceManifestDigest) throw new Error("binding commit failed");
      return super.replace(record, signal);
    }
  }
  let started = false, cleaned = false;
  const runtime = new SubagentRuntime({ store: new RejectBindingStore(), id: () => "binding-failed", launcher: { resolve() {
    return { resourceManifestDigest: "a".repeat(64), command: { executable: "fixture", cwd: owner.workspaceRoot }, cleanupOnFailure() { cleaned = true; } };
  } }, execution: { async start() { started = true; throw new Error("must not dispatch"); } } });
  try {
    await assert.rejects(runtime.spawn({ ...owner, task: "Inspect" }), /binding commit failed/u);
    assert.equal(started, false);
    assert.equal(cleaned, true);
  } finally { await runtime.close(); }
});
