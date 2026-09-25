import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { createLaunch } from "../dist/boot/launch.js";
import { installWishPluginCatalog } from "../dist/boot/plugin-catalog.js";
import { FileSubagentExchange } from "../dist/subagents/files.js";
import { MEMORY_SNAPSHOT_RESOURCE } from "../dist/memory/child-resources.js";

const configuration = new URL("../config/cordis.yml", import.meta.url);

/** Load the real default graph; replace only interactive surface execution. */
async function graph(t, { environment = {}, child = false, prepare } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wish-memory-boot-"));
  const workspace = join(directory, "workspace"), home = join(directory, "home"), data = join(directory, "data");
  await Promise.all([workspace, home, data].map(path => mkdir(path)));
  const extras = await prepare?.({ directory, workspace, home, data }) ?? {};
  const root = new Context();
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const launch = createLaunch({ surface: "cli", argv: child ? ["child"] : ["--version"], cwd: workspace,
    homeDirectory: home, environment: { WISH_DATA_DIR: data, WISH_STORAGE_FILE_ROOT: join(data, "storage"),
      WISH_SKILLS_USER_ROOT: join(home, ".wish", "skills"), ...environment, ...extras },
    configurationFile: configuration.pathname, configurationSource: "built-in" });
  root.provide("launch", launch);
  root.baseUrl = new URL("./", configuration).href;
  await root.plugin(Loader);
  installWishPluginCatalog(root);
  root.loader.builtins.cli = { inject: ["application", "launch"], apply(ctx) { ctx.launch.complete(0); } };
  await root.loader.create({ id: "include", name: "cordis:include", config: { path: configuration.href } });
  await root.loader.await();
  for (const entry of root.loader.entries()) if (!entry.disabled && entry.fiber?.state !== 2) throw new Error(`Inactive default plugin: ${entry.id}`);
  const scoped = root.loader.resolve("include:cli").ctx;
  const context = { get: name => scoped.get(name), skills: scoped.get("skills"), memory: scoped.get("memory"), memoryCuration: scoped.get("memoryCuration"), tools: scoped.get("tools") };
  return { root, context, workspace, home, data, directory,
    enabled(id) { return !root.loader.resolve(`include:${id}`).disabled; },
    tools() { return context.tools.registry.list().map(tool => tool.name); } };
}

test("default knowledge capabilities are active in an isolated home before opening an Agent", async t => {
  const f = await graph(t, { prepare: async ({ home }) => {
    const path = join(home, ".wish", "skills", "inspect");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: inspect\ndescription: Test isolated skill\n---\nInspect source.\n");
    return {};
  } });
  assert.equal(f.context.memory.libraryId, "default");
  assert.equal((await f.context.memory.state()).revision, 0);
  assert.deepEqual((await f.context.skills.list({ cwd: f.workspace })).skills.map(skill => skill.name), ["inspect"]);
  assert.ok(f.tools().includes("list_skills"));
  assert.ok(f.tools().includes("read_skill"));
  assert.ok(f.tools().includes("memory_search"));
  assert.ok(f.tools().includes("memory_read"));
  assert.ok(f.tools().includes("memory_write"));
  assert.equal(f.enabled("memory-storage"), true);
  assert.equal(f.enabled("memory-child-snapshot"), false);
  assert.equal(f.enabled("memory-curation"), false);
  assert.equal(f.enabled("memory-runtime-evidence"), false);
  assert.equal(f.root.get("skills"), undefined);
  assert.equal(f.root.get("memory"), undefined);
  assert.equal(f.root.get("memoryCuration"), undefined);
});

test("knowledge Tools can be disabled without removing Providers, Context or human surfaces", async t => {
  const f = await graph(t, { environment: { WISH_SKILLS_TOOLS_ENABLED: "0", WISH_MEMORY_TOOLS_ENABLED: "0" } });
  assert.ok(f.context.skills);
  assert.ok(f.context.memory);
  assert.equal(f.enabled("skills-context"), true);
  assert.equal(f.enabled("memory-context"), true);
  assert.equal(f.enabled("skills-session-feature"), true);
  assert.equal(f.enabled("memory-session-feature"), true);
  assert.equal(f.tools().some(name => ["list_skills", "read_skill", "memory_search", "memory_read", "memory_write"].includes(name)), false);
});

test("knowledge Context and model writes have independent switches", async t => {
  const f = await graph(t, { environment: { WISH_SKILLS_CONTEXT_ENABLED: "0", WISH_MEMORY_CONTEXT_ENABLED: "0", WISH_MEMORY_WRITE_ENABLED: "0" } });
  assert.equal(f.enabled("skills-context"), false);
  assert.equal(f.enabled("memory-context"), false);
  assert.ok(f.tools().includes("read_skill"));
  assert.ok(f.tools().includes("memory_read"));
  assert.equal(f.tools().includes("memory_write"), false);
});

test("disabling a knowledge capability disables all of its optional Consumers", async t => {
  const f = await graph(t, { environment: { WISH_SKILLS_ENABLED: "0", WISH_MEMORY_ENABLED: "0", WISH_MEMORY_CURATION_ENABLED: "1", WISH_MEMORY_AUTO_CURATION: "1" } });
  assert.equal(f.context.get("skills"), undefined);
  assert.equal(f.context.get("memory"), undefined);
  assert.equal(f.context.get("memoryCuration"), undefined);
  for (const entry of f.root.loader.entries()) if (/^include:(skills-|memory-)/u.test(entry.id)) assert.equal(entry.disabled, true, entry.id);
});

test("curation requires its opt-in and evidence adapters follow available providers", async t => {
  const f = await graph(t, { environment: { WISH_MEMORY_CURATION_ENABLED: "1", WISH_WORKFLOW_ENABLED: "0", WISH_SUBAGENTS_ENABLED: "0" } });
  assert.ok(f.context.memoryCuration);
  assert.equal(f.enabled("memory-runtime-evidence"), true);
  assert.equal(f.enabled("memory-workflow-evidence"), false);
  assert.equal(f.enabled("memory-subagent-resources"), false);
  assert.equal(f.enabled("memory-coordinator-controls"), true);
  assert.deepEqual((await f.context.memoryCuration.scheduler.state()).jobs, []);
});

test("automatic flag alone does not start or instantiate curation", async t => {
  const f = await graph(t, { environment: { WISH_MEMORY_AUTO_CURATION: "1" } });
  assert.equal(f.context.get("memoryCuration"), undefined);
  assert.equal(f.enabled("memory-runtime-evidence"), false);
});

test("a child without Host attachments never creates an independent Memory authority", async t => {
  const f = await graph(t, { child: true, environment: { WISH_MEMORY_CURATION_ENABLED: "1", WISH_MEMORY_AUTO_CURATION: "1", WISH_CHILD_RESOURCES_FILE: "", WISH_CHILD_RESOURCES_DIGEST: "" } });
  assert.equal(f.context.get("memory"), undefined);
  for (const entry of f.root.loader.entries()) if (/^include:memory-/u.test(entry.id)) assert.equal(entry.disabled, true, entry.id);
});

test("Host-pinned child attachments exclusively select the scoped snapshot Provider", async t => {
  const f = await graph(t, { child: true, environment: { WISH_MEMORY_CURATION_ENABLED: "1", WISH_MEMORY_AUTO_CURATION: "1", WISH_SUBAGENTS_ENABLED: "0" },
    prepare: async ({ workspace, data }) => {
      const exchange = new FileSubagentExchange(data);
      const identity = { id: "boot-child", childSessionId: "boot-child-session", childRunId: "boot-child-run" };
      const manifest = await exchange.writeInputResources(identity,
        { parentAgentId: "parent", parentSessionId: "parent-session", parentRunId: "parent-run", workspaceRoot: workspace },
        [{ type: MEMORY_SNAPSHOT_RESOURCE, schemaVersion: 1, payload: { snapshot: { schemaVersion: 1, libraryId: "delegated", revision: 0, documents: [] }, allowProposals: false } }]);
      return { WISH_CHILD_ID: identity.id, WISH_CHILD_SESSION_ID: identity.childSessionId, WISH_CHILD_RUN_ID: identity.childRunId,
        WISH_CHILD_EXCHANGE_DATA_DIR: data, WISH_DATA_DIR: exchange.childDataDirectory(identity.id),
        WISH_STORAGE_FILE_ROOT: join(exchange.childDataDirectory(identity.id), "storage"),
        WISH_CHILD_RESOURCES_FILE: exchange.inputResourcesPath(identity.id), WISH_CHILD_RESOURCES_DIGEST: manifest.digest };
    } });
  assert.equal(f.context.memory.libraryId, "delegated");
  assert.equal(f.enabled("memory-storage"), false);
  assert.equal(f.enabled("memory-child-snapshot"), true);
  assert.equal(f.enabled("memory-session-feature"), false);
  assert.equal(f.enabled("memory-curation"), false);
  assert.equal(f.enabled("memory-subagent-resources"), false);
  await assert.rejects(f.context.memory.decide({}), /cannot accept/u);
});

test("partial or malformed child attachment markers fail closed instead of using root storage", async t => {
  for (const environment of [{ WISH_CHILD_RESOURCES_FILE: "/invalid/file" }, { WISH_CHILD_RESOURCES_DIGEST: "broken" }]) {
    await assert.rejects(graph(t, { environment }), /memory-child-snapshot|Child Memory/u);
  }
});
