import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

test("WebUI management writes and native config reload share the real Skills lifecycle and preserve preferences", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-config-webui-"));
  let booted;
  try {
    const skillRoot = join(directory, "replacement-skills");
    await mkdir(join(skillRoot, "sample"), { recursive: true });
    await writeFile(join(skillRoot, "sample", "SKILL.md"), "---\nname: sample\ndescription: Reloaded skill root\n---\nRead the sample.\n");
    const filename = join(directory, "cordis.yml");
    // This relocated profile is at the fixture root, not dist/config. Keep its
    // now-default code watcher inside the fixture, never the shared /tmp tree.
    const original = (await readFile(new URL("../config/cordis.yml", import.meta.url), "utf8")).replace("base: '..'", "base: '.'");
    await writeFile(filename, original);
    booted = await bootstrap({ surface: "webui", configurationFile: filename, cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const base = booted.context.webManagementHost.url;
    const authorization = await (await fetch(base + "/api/management/bootstrap")).json();
    const snapshot = async () => (await fetch(base + "/api/management/plugins")).json();
    const change = async preference => {
      const before = await snapshot();
      const response = await fetch(base + "/api/management/plugins/change", { method: "POST",
        headers: { "Content-Type": "application/json", "X-Wish-Management-Token": authorization.token },
        body: JSON.stringify({ requestId: randomUUID(), revision: before.revision, preference,
          selection: { instanceId: authorization.instanceId, entryIds: ["include:skills-local"] } }),
      });
      assert.equal(response.status, 200);
      const receipt = await response.json(); assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    };
    const initial = await snapshot();
    assert.equal(initial.configuration.watching, true);
    const unrelated = new Map(["include:application", "include:runtime", "include:sessions", "include:timer", "include:webui"]
      .map(id => [id, booted.context.loader.resolve(id).fiber]));
    await change("disabled");
    let revised = original.replace("userRoot: !!js launch.environment.WISH_SKILLS_USER_ROOT || undefined", `userRoot: ${JSON.stringify(skillRoot)}`);
    assert.notEqual(revised, original);
    await writeFile(filename, revised);
    await waitFor(async () => {
      const current = await snapshot();
      return current.configuration.digest !== initial.configuration.digest && current.configuration.phase === "idle";
    });
    const disabled = await snapshot();
    assert.equal(disabled.preferences["include:skills-local"].preference, "disabled");
    assert.equal(booted.surfaceContext.get("skills"), undefined);
    assert.equal(disabled.inspection.instanceId, authorization.instanceId);
    for (const [id, fiber] of unrelated) assert.ok(booted.context.loader.resolve(id).fiber === fiber, `${id} was replaced`);
    await change("enabled");
    const list = await booted.surfaceContext.get("skills").list({ cwd: directory });
    assert.equal(list.skills.length, 1);
    assert.equal(list.skills[0].name, "sample");

    // Also replace an active production owner, not only a dormant entry's options.
    const oldSkills = booted.surfaceContext.get("skills");
    const oldSkillsFiber = booted.context.loader.resolve("include:skills-local").fiber;
    const previousDigest = (await snapshot()).configuration.digest;
    const emptyRoot = join(directory, "empty-skills");
    await mkdir(emptyRoot);
    revised = revised.replace(`userRoot: ${JSON.stringify(skillRoot)}`, `userRoot: ${JSON.stringify(emptyRoot)}`);
    await writeFile(filename, revised);
    await waitFor(async () => {
      const current = await snapshot();
      return current.configuration.digest !== previousDigest && current.configuration.phase === "idle";
    });
    assert.notEqual(booted.context.loader.resolve("include:skills-local").fiber, oldSkillsFiber);
    await assert.rejects(() => oldSkills.list({ cwd: directory }));
    assert.equal((await booted.surfaceContext.get("skills").list({ cwd: directory })).skills.length, 0);
    for (const [id, fiber] of unrelated) assert.ok(booted.context.loader.resolve(id).fiber === fiber, `${id} was replaced`);

    const valid = await snapshot();
    await writeFile(filename, "[PRIVATE_SENTINEL: [");
    await waitFor(async () => (await snapshot()).configuration.phase === "rejected");
    const rejected = await snapshot();
    assert.equal(rejected.configuration.digest, valid.configuration.digest);
    assert.equal(rejected.configuration.code, "management_configuration_invalid");
    assert.equal(JSON.stringify(rejected).includes("PRIVATE_SENTINEL"), false);
    assert.equal((await fetch(base + "/api/health")).status, 200);
    // Recovery controls can still safely disable against the last accepted base.
    await change("disabled");
    await writeFile(filename, revised);
    await waitFor(async () => (await snapshot()).configuration.phase === "idle");
    assert.equal((await snapshot()).preferences["include:skills-local"].preference, "disabled");
    assert.equal(await readFile(filename, "utf8"), revised);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("WebUI activates and stops default-off Memory Curation and Web Fetch without environment opt-in", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-user-activation-webui-"));
  let booted;
  try {
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const control = booted.pluginManagement, ctx = booted.surfaceContext;
    const change = async (id, preference) => {
      const before = control.snapshot();
      const receipt = await control.change({ requestId: randomUUID(), revision: before.revision, preference,
        selection: { instanceId: before.inspection.instanceId, entryIds: [`include:${id}`] } });
      assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
      return control.snapshot();
    };
    const initial = control.snapshot();
    for (const id of ["memory-curation", "memory-runtime-evidence", "memory-workflow-evidence", "web-fetch-http", "tool-web-fetch"]) {
      assert.deepEqual(initial.controls[`include:${id}`], { canEnable: true }, id);
      assert.equal(initial.inspection.entries.find(entry => entry.id === `include:${id}`).enabled, false, id);
    }
    assert.equal(initial.controls["include:web-search-searxng"], undefined);
    assert.equal(ctx.get("memoryCuration"), undefined);
    assert.equal(ctx.get("webFetch"), undefined);

    await change("memory-curation", "enabled");
    assert.ok(ctx.get("memoryCuration"));
    await change("memory-runtime-evidence", "enabled");
    await change("memory-workflow-evidence", "enabled");
    assert.equal(control.snapshot().inspection.entries.find(entry => entry.id === "include:memory-runtime-evidence").phase, "active");
    await change("memory-curation", "disabled");
    assert.equal(ctx.get("memoryCuration"), undefined);
    assert.equal(control.snapshot().inspection.entries.find(entry => entry.id === "include:memory-runtime-evidence").phase, "pending");
    await change("memory-curation", "enabled");
    assert.ok(ctx.get("memoryCuration"));

    await change("web-fetch-http", "enabled");
    assert.ok(ctx.get("webFetch"));
    await change("tool-web-fetch", "enabled");
    assert.equal(ctx.get("tools").registry.has("web_fetch"), true);
    await change("web-fetch-http", "disabled");
    assert.equal(ctx.get("webFetch"), undefined);
    assert.equal(ctx.get("tools").registry.has("web_fetch"), false);
    assert.equal(control.snapshot().inspection.entries.find(entry => entry.id === "include:tool-web-fetch").phase, "pending");
    await change("web-fetch-http", "enabled");
    assert.ok(ctx.get("webFetch"));
    assert.equal(ctx.get("tools").registry.has("web_fetch"), true);
    await change("tool-web-fetch", "disabled");
    assert.ok(ctx.get("webFetch"));
    assert.equal(ctx.get("tools").registry.has("web_fetch"), false);
  } finally { await booted?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("management model selection is sampled by the next WebUI Run", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-settings-webui-"));
  let booted; const selected = [], authorizations = [];
  const provider = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      selected.push(JSON.parse(body).model);
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "selected" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  try {
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const configuration = { schemaVersion: 1, defaultModel: "fixture/primary", fallbackModels: [], maxRetries: 0,
      providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, auth: { type: "bearer", apiKeyEnv: "FIXTURE_API_KEY" }, developerRoleMode: "native", models: ["primary", "secondary"].map(id => ({ id, status: "active", contextWindowTokens: 128000, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true })) }] };
    booted = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, WISH_MODELS_JSON: JSON.stringify(configuration) },
      management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const base = booted.context.webManagementHost.url;
    const authorization = await (await fetch(base + "/api/management/bootstrap")).json();
    const writeHeaders = { "Content-Type": "application/json", "X-Wish-Management-Token": authorization.token };
    const sections = (await (await fetch(base + "/api/management/settings")).json()).sections;
    const models = sections.find(section => section.namespace === "models"); assert.ok(models);
    const modelField = models.fields.find(field => field.key === "default-model");
    const secondary = modelField.options.find(option => typeof option === "object" && option.value === "fixture/secondary");
    assert.deepEqual(secondary.attributes, { provider: "fixture", model: "secondary", contextWindowTokens: 128000, apiKeyEnv: "FIXTURE_API_KEY" });
    const described = await (await fetch(base + "/api/management/credentials/describe", { method: "POST", headers: writeHeaders,
      body: JSON.stringify({ references: ["FIXTURE_API_KEY"] }) })).json();
    assert.deepEqual(described.credentials, [{ reference: "FIXTURE_API_KEY", configured: false, source: "missing", writable: true }]);
    const secret = "fixture-secret-value";
    const credentialResponse = await fetch(base + "/api/management/credentials/set", { method: "POST", headers: writeHeaders,
      body: JSON.stringify({ reference: "FIXTURE_API_KEY", value: secret }) });
    assert.equal(credentialResponse.status, 200);
    assert.equal(JSON.stringify(await credentialResponse.json()).includes(secret), false);
    const saved = await fetch(base + "/api/management/settings/replace", { method: "POST", headers: writeHeaders, body: JSON.stringify({ namespace: "models", revision: models.revision, user: { "default-model": "fixture/secondary", "context-window-overrides": JSON.stringify({ "fixture/secondary": 256000 }) } }) });
    assert.equal(saved.status, 200);
    const modelService = booted.surfaceContext.get("models");
    const resolvedConfiguration = await modelService.load({ dataDirectory: join(directory, "data") });
    assert.equal(modelService.open(resolvedConfiguration).configuredModel.getContextWindowTokens("fixture/secondary"), 256000);
    const createdResponse = await fetch(base + "/api/sessions", { method: "POST", headers: writeHeaders, body: JSON.stringify({ title: "Model selection" }) });
    const created = await createdResponse.json(); assert.equal(createdResponse.status, 201, JSON.stringify(created));
    const started = await fetch(`${base}/api/sessions/${created.session.sessionId}/runs`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ text: "use selected model" }) });
    assert.equal(started.status, 202);
    await waitFor(() => selected.length === 1);
    assert.deepEqual(selected, ["secondary"]);
    assert.deepEqual(authorizations, [`Bearer ${secret}`]);
    assert.equal(JSON.stringify(await (await fetch(base + "/api/management/settings")).json()).includes(secret), false);
  } finally {
    await booted?.dispose(); await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error("managed WebUI config update did not settle");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
