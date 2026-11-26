import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { createWebSearchTool } from "../dist/web/tools.js";
import { DeepseekSearchBackend } from "../dist/web/providers/deepseek-search.js";

const workspace = { root: process.cwd(), requestedRoot: process.cwd(), fingerprint: "search-workspace", revision: "1", instructions: [] };
const permissions = { schemaVersion: 1, subject: { agentId: "a", sessionId: "s", runId: "r", userTurnId: "u", stepId: "p" },
  profile: "approval-required", availableTools: ["web_search"], ceiling: { allowedCapabilities: ["web.search"] },
  workspace: { fingerprint: workspace.fingerprint, revision: workspace.revision }, filesystemPolicyVersion: "1", shellPolicyVersion: "1",
  sandboxPolicyVersion: "1", policyVersion: "1", authorityVersion: "1" };
async function search(backend, authorize = () => {}, input = { query: "Wish search" }) {
  const registry = new ToolRegistry(); registry.register(createWebSearchTool({ search: backend }));
  const parsed = registry.parseCall({ id: "c", name: "web_search", argumentsJson: JSON.stringify(input) });
  assert.equal(parsed.ok, true);
  return new ToolExecutor({ registry, authorization: {
    async authorize(value) { await authorize(value); return { status: "allowed", policyVersion: "1" }; },
    revalidate() { return { status: "valid", policyVersion: "1" }; },
  } }).execute({ call: parsed.call, context: { cwd: workspace.root, workspace, permissions },
    scope: { runId: "r", userTurnId: "u", stepId: "p" }, snapshot: registry.captureSnapshot({ authorityVersion: "1" }) });
}
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("DeepSeek Search performs an authorized standalone query and reads the current credential", async () => {
  let credential = "first-key", calls = 0;
  const backend = new DeepseekSearchBackend({ credential: () => credential, fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer second-key");
    assert.deepEqual(JSON.parse(init.body), { query: "Wish search", count: 1, need_content: false });
    return json({ results: [{ url: "https://example.com/a", title: "A", summary: "Source summary" },
      { url: "https://example.com/a" }, { url: "javascript:bad()" }, { url: "https://example.com/b" }] });
  } });
  const result = await search(backend, request => {
    assert.deepEqual(request.capabilities, { requirements: [{ capability: "web.search", providers: ["deepseek"] }], effects: { openWorld: true } });
    credential = "second-key";
  }, { query: "Wish search", maxResults: 1 });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.deepEqual(result.output.sources, [{ url: "https://example.com/a", title: "A", snippet: "Source summary" }]);
  assert.equal(result.output.truncated, true);
  await assert.rejects(backend.resolve({ query: "x".repeat(129) }), /1–128/);
  await backend.resolve({ query: "😀".repeat(128) });
  credential = undefined;
  await assert.rejects(backend.resolve({ query: "q" }), /key is not configured/);
  assert.equal(calls, 1);
});

test("DeepSeek Search bounds responses, handles cancellation and never echoes error bodies", async () => {
  for (const options of [
    { fetch: async () => new Response("secret-key-from-upstream", { status: 401 }) },
    { fetch: async () => { throw new Error("secret-key-from-upstream"); } },
    { maxResponseBytes: 4, fetch: async () => json({ results: [] }) },
    { fetch: async () => json({ wrong: "schema" }) },
  ]) {
    const result = await search(new DeepseekSearchBackend({ credential: () => "test-key", ...options }));
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("secret-key-from-upstream"), false);
  }
  const backend = new DeepseekSearchBackend({ credential: () => "key", fetch: async () => { throw new Error("must not run"); } });
  await assert.rejects(backend.resolve({ query: "q", signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  const spec = await backend.resolve({ query: "q" });
  await assert.rejects(backend.search({ spec, context: { workspace, permissions }, grant: {} }), /Grant|grant/);
});

async function boot(directory) {
  return bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
    environment: { CORDIS_HMR: "0", WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
}
async function change(booted, ids, preference) {
  const before = booted.pluginManagement.snapshot();
  const receipt = await booted.pluginManagement.change({ requestId: randomUUID(), revision: before.revision, preference,
    selection: { instanceId: before.inspection.instanceId, entryIds: ids.map(id => `include:${id}`) } });
  assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
}
async function save(booted, namespace, user) {
  const settings = booted.context.get("settings").port, view = settings.describe().sections.find(item => item.namespace === namespace);
  return settings.replace({ namespace, revision: view.revision, user: { ...view.user, ...user } });
}

test("Saved enabled search without a key still boots and can be configured or stopped", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-search-startup-"));
  let booted;
  try {
    const store = await ManagedPluginStore.open(join(directory, "management", "plugins.json"));
    try {
      const state = store.snapshot();
      await store.commit(state.revision, { preferences: {
        "include:web-search": { name: "cordis:web-search", preference: "enabled" },
        "include:tool-web-search": { name: "cordis:web-search-tool", preference: "enabled" },
      }, pending: null, receipts: [] });
    } finally { await store.close(); }
    booted = await boot(directory);
    assert.equal((await fetch(booted.context.get("webManagementHost").url + "/api/health")).status, 200);
    const provider = booted.surfaceContext.get("webSearch");
    const fiberId = booted.plugins.inspect().entries.find(entry => entry.id === "include:web-search").fiberId;
    assert.ok(provider);
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_search"), true);
    const missing = await search(provider);
    assert.equal(missing.ok, false);
    assert.match(missing.error.message, /not configured/u);
    await booted.context.get("credentials").port.set("WISH_DEEPSEEK_SEARCH_API_KEY", "search-only-test-key");
    assert.equal((await provider.resolve({ query: "test" })).providerId, "deepseek");
    assert.equal(booted.plugins.inspect().entries.find(entry => entry.id === "include:web-search").fiberId, fiberId);
    // Clearing a configured credential must also leave settings reachable.
    await booted.context.get("credentials").port.delete("WISH_DEEPSEEK_SEARCH_API_KEY");
    await booted.dispose(); booted = await boot(directory);
    assert.equal((await search(booted.surfaceContext.get("webSearch"))).ok, false);
    await change(booted, ["tool-web-search", "web-search"], "disabled");
    assert.equal(booted.surfaceContext.get("webSearch"), undefined);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("Search settings survive stopped providers and restart; changed limits invalidate unexecuted approvals", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-search-settings-"));
  let booted, requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.deepseek.com/v1/tools/search") return originalFetch(url, init);
    assert.equal(init.headers.authorization, "Bearer search-only-test-key");
    requests.push(JSON.parse(init.body));
    return json({ results: [{ url: "https://example.com", summary: "result" }] });
  };
  try {
    const store = await ManagedPluginStore.open(join(directory, "management", "plugins.json"));
    try {
      await store.commit(store.snapshot().revision, { preferences: {
        "include:tool-web-search": { name: "cordis:web-search-tool", preference: "enabled" },
      }, pending: null, receipts: [] });
    } finally { await store.close(); }
    booted = await boot(directory);
    assert.equal(booted.surfaceContext.get("webSearch"), undefined);
    await save(booted, "web-search-deepseek", { "max-results": 5 });
    await booted.context.get("credentials").port.set("WISH_DEEPSEEK_SEARCH_API_KEY", "search-only-test-key");
    await change(booted, ["web-search"], "enabled");
    const provider = booted.surfaceContext.get("webSearch");
    assert.equal((await search(provider)).ok, true);
    assert.equal(requests[0].count, 5);
    const stale = await search(provider, () => save(booted, "web-search-deepseek", { "max-results": 2 }));
    assert.equal(stale.ok, false); assert.equal(requests.length, 1);
    assert.equal((await search(provider)).ok, true);
    assert.equal(requests[1].count, 2);
    await change(booted, ["web-search"], "disabled");
    await save(booted, "web-search-deepseek", { "max-results": 3 });
    await change(booted, ["web-search"], "enabled");
    assert.equal((await booted.surfaceContext.get("webSearch").resolve({ query: "test" })).providerId, "deepseek");
    assert.equal(booted.surfaceContext.get("tools").registry.has("web_search"), true);
    assert.equal(JSON.stringify(booted.context.get("settings").port.describe()).includes("search-only-test-key"), false);
    assert.equal((await readFile(join(directory, "management", "settings.json"), "utf8")).includes("search-only-test-key"), false);
    await booted.dispose(); booted = await boot(directory);
    assert.equal((await booted.surfaceContext.get("webSearch").resolve({ query: "test" })).providerId, "deepseek");
    assert.equal(booted.context.get("settings").port.describe().sections.find(view => view.namespace === "web-search-deepseek").value["max-results"], 3);
    assert.equal((await search(booted.surfaceContext.get("webSearch"))).ok, true);
    assert.equal(requests.at(-1).count, 3);
  } finally { globalThis.fetch = originalFetch; await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

