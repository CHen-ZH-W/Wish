import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/service.js";
import { StorageBackendService } from "../dist/storage/binding.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import StorageMemory from "../dist/memory/providers/storage.js";
import MemorySubagentResources, { SubagentMemoryResources } from "../dist/memory/consumers/subagent-resources.js";
import { childMemoryLibrary, MEMORY_LIBRARY_RESOURCE } from "../dist/memory/child-resources.js";
import { FileSubagentExchange } from "../dist/subagents/files.js";
import { SubagentLauncherService } from "../dist/subagents/launcher.js";
import { MemoryContextProvider } from "../dist/memory/consumers/context.js";

async function host(directory, launch = {}) {
  const root = new Context();
  root.provide("launch", { cwd: directory, surface: "cli", argv: [], environment: {}, ...launch });
  root.provide("sessions", { dataDirectory: directory });
  await root.plugin(StorageHub);
  const backend = new FileStorageBackend({ id: "file", rootDirectory: join(directory, "storage") });
  root.storage.register(backend);
  class Selected extends StorageBackendService { static inject = ["storage"]; id = "file"; }
  await root.plugin(Selected);
  root.effect(() => () => backend.close());
  return root;
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-shared-child-"));
  const parent = await host(directory);
  const children = [], providers = [];
  try {
    await parent.plugin(StorageMemory);
    const exchange = new FileSubagentExchange(directory);
    const owner = { parentAgentId: "parent", parentSessionId: "parent-session", parentRunId: "parent-run", workspaceRoot: directory };
    const identity = { id: "child", childSessionId: "child-session", childRunId: "child-run" };
    const resourceProvider = new SubagentMemoryResources({ memory: parent.memory }); providers.push(resourceProvider);
    const request = { ...owner, task: "Inspect current memory", allowedCapabilities: ["runtime.read"] };
    const prepare = async () => {
      const inputs = await resourceProvider.prepare(request);
      const manifest = await exchange.writeInputResources(identity, owner, inputs);
      const environment = { WISH_CHILD_ID: identity.id, WISH_CHILD_SESSION_ID: identity.childSessionId, WISH_CHILD_RUN_ID: identity.childRunId,
        WISH_DATA_DIR: exchange.childDataDirectory(identity.id), WISH_CHILD_EXCHANGE_DATA_DIR: directory,
        WISH_CHILD_RESOURCES_FILE: exchange.inputResourcesPath(identity.id), WISH_CHILD_RESOURCES_DIGEST: manifest.digest };
      return { inputs, manifest, environment };
    };
    const startChild = async environment => {
      const child = await host(exchange.childDataDirectory(identity.id), { cwd: directory, argv: ["child"], environment });
      children.push(child);
      await child.plugin(StorageMemory);
      return child;
    };
    await run({ directory, parent, exchange, identity, owner, request, resourceProvider, prepare, startChild });
  } finally {
    await Promise.allSettled(providers.map(provider => provider.close()));
    await Promise.allSettled(children.map(child => child.fiber.dispose()));
    await parent.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
const evidence = [{ kind: "operator", id: "fixture", revision: "1", digest: "a".repeat(64) }];

test("child reads the parent's current files and summary after updates, without a content snapshot", () => fixture(async f => {
  const initial = { "memory_summary.md": "v1\nInitial shared summary", "MEMORY.md": "Before update", "large.md": "x".repeat(2_100_000) };
  await f.parent.memory.workspace.publish(initial, new AbortController().signal);
  const { inputs, manifest, environment } = await f.prepare();
  assert.equal(inputs[0].type, MEMORY_LIBRARY_RESOURCE);
  assert.ok(JSON.stringify(inputs).length < 1000);
  assert.equal(childMemoryLibrary(manifest).directory, f.parent.memory.workspace.directory);
  const child = await f.startChild(environment);
  assert.equal((await child.memory.files()).find(file => file.path === "MEMORY.md").content, "Before update");
  await f.parent.memory.workspace.publish({ "memory_summary.md": "v1\nUpdated shared summary", "MEMORY.md": "After update", "new.md": "New knowledge" }, new AbortController().signal);
  assert.deepEqual(await child.memory.files(), await f.parent.memory.files());
  assert.equal((await child.memory.query({ text: "After update" }))[0].content, "After update");
  assert.ok(!(await child.memory.files()).some(file => file.path === "large.md"));
  const context = await new MemoryContextProvider(child.memory).provide({ request: { availableTools: ["memory_read"] } });
  assert.ok(context[0].message.content.includes("Updated shared summary"));
  assert.ok(!(await readdir(f.exchange.childDataDirectory(f.identity.id))).some(name => name.startsWith("memory-snapshot-")));
}));

test("child reads new Journal revisions but every Memory write API remains read-only", () => fixture(async f => {
  const consolidate = (revision, text) => f.parent.memory.consolidate({ operationId: `write-${revision}`, actor: { kind: "curation", id: "fixture" },
    reason: "fixture update", expectedRevision: revision, retirements: [], upserts: [{ id: "knowledge", expectedVersion: revision,
      title: "Knowledge", content: text, appliesTo: "fixture", keywords: [], evidence }] });
  await consolidate(0, "old");
  const { environment } = await f.prepare();
  const child = await f.startChild(environment);
  assert.equal((await child.memory.read("knowledge")).content, "old");
  await consolidate(1, "new");
  assert.equal((await child.memory.read("knowledge")).content, "new");
  assert.equal((await child.memory.snapshot()).revision, 2);
  const before = await f.parent.memory.state();
  for (const method of ["propose", "decide", "changeStatus", "consolidate"]) await assert.rejects(child.memory[method]({}), /read-only/u);
  assert.deepEqual(await f.parent.memory.state(), before);
  assert.equal(child.memory.sharedLibrary, undefined);
}));

test("child only exposes delegated Memory Skills while allowed file contents remain live", () => fixture(async f => {
  const files = { "skills/allowed/SKILL.md": "allowed old", "skills/disabled/SKILL.md": "private" };
  await f.parent.memory.workspace.publish(files, new AbortController().signal);
  const release = f.parent.memory.registerModelFileFilter(files => Promise.resolve(files.filter(file => !file.path?.startsWith("skills/disabled/"))));
  try {
    const { manifest, environment } = await f.prepare();
    assert.deepEqual(childMemoryLibrary(manifest).allowedSkills, ["allowed"]);
    const child = await f.startChild(environment);
    await f.parent.memory.workspace.publish({ ...files, "skills/allowed/SKILL.md": "allowed new", "skills/new/SKILL.md": "not delegated" }, new AbortController().signal);
    assert.deepEqual((await child.memory.files()).map(file => [file.path, file.content]), [["skills/allowed/SKILL.md", "allowed new"]]);
  } finally { release(); }
}));

test("child rejects a changed manifest, foreign identity and mismatched resource path", async () => {
  for (const kind of ["manifest", "identity", "path"]) await fixture(async f => {
    const { environment } = await f.prepare();
    if (kind === "manifest") {
      const file = f.exchange.inputResourcesPath(f.identity.id), manifest = JSON.parse(await readFile(file, "utf8"));
      manifest.resources[0].payload.directory = join(f.directory, "ungranted");
      await writeFile(file, JSON.stringify(manifest));
    } else if (kind === "identity") environment.WISH_CHILD_RUN_ID = "foreign";
    else environment.WISH_CHILD_RESOURCES_FILE = join(f.directory, "wrong.json");
    await assert.rejects(f.startChild(environment), /manifest|identity|resource path|Host grant/u);
  });
});

test("parent resource adapter follows plugin lifecycle and does not import child proposals", () => fixture(async f => {
  await f.parent.plugin(SubagentLauncherService);
  const plugin = await f.parent.plugin(MemorySubagentResources);
  assert.deepEqual(f.parent.subagentLauncher.runtimeFeatures, ["memory.read"]);
  assert.deepEqual(await f.resourceProvider.prepare({ ...f.request, allowedCapabilities: [] }), []);
  await plugin.dispose();
  assert.deepEqual(f.parent.subagentLauncher.runtimeFeatures, []);
  await f.resourceProvider.close();
  await assert.rejects(f.resourceProvider.prepare(f.request), /closed/u);
}));

test("closing the resource adapter aborts and drains an in-flight library grant", async () => {
  const entered = Promise.withResolvers();
  const resources = new SubagentMemoryResources({ memory: {
    sharedLibrary: { libraryId: "fixture", directory: "/fixture", journalRoot: "/fixture/storage" },
    modelFiles(signal) { entered.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
  } });
  const work = resources.prepare({ allowedCapabilities: ["runtime.read"] });
  const rejected = assert.rejects(work);
  await entered.promise; await resources.close(); await rejected;
});
