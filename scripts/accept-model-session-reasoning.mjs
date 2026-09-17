import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApplicationFacade } from "../dist/apps/application.js";
import { startWishWebUiServer, WebToolApprovalBroker } from "../dist/apps/webui/index.js";
import { ContextProjector } from "../dist/core/context/projector.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { createDefaultModelAdapterRegistry } from "../dist/models/registry.js";
import { ConfiguredModel } from "../dist/models/runtime.js";
import { DomainSessionReasoningStore, ModelReasoningSelectionError, SessionReasoningSelections } from "../dist/models/session-reasoning.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

test("Context projection preserves a Run's selected reasoning effort for the Provider", async () => {
  const projection = await new ContextProjector().project({
    request: { model: { provider: "deepseek", model: "deepseek-flash" },
      messages: [{ role: "user", content: "hello" }], tools: [], reasoningEffort: "low" },
    groups: [], currentUserMessageIndex: 0,
  });
  assert.equal(projection.status, "ready");
  assert.equal(projection.request.reasoningEffort, "low");
});

test("Session reasoning selection survives store replacement and uses CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-reasoning-"));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  const storage = { backend(id) { assert.equal(id, "file"); return backend; } };
  const model = new ConfiguredModel({ configuration: loadModelsConfiguration({ environment: {} }), registry: createDefaultModelAdapterRegistry() });
  const reference = { provider: "deepseek", model: "deepseek-flash" };
  try {
    const first = new DomainSessionReasoningStore(storage, "file");
    const selections = new SessionReasoningSelections(model, first);
    assert.deepEqual(selections.inspectDefault().model, reference);
    assert.equal(selections.inspectDefault().control.defaultEffort, "high");
    assert.equal(selections.inspectDefault().selected, undefined);
    assert.equal((await selections.inspect("session-a", reference)).selected, undefined);
    await selections.select("session-a", reference, "low");
    assert.equal(await selections.forRun("session-a", reference), "low");
    const second = new DomainSessionReasoningStore(storage, "file");
    assert.equal((await second.get("session-a")).value.effort, "low");
    const stale = await first.get("session-a");
    await selections.select("session-a", reference, "max");
    await assert.rejects(second.put({ schemaVersion: 1, sessionId: "session-a", model: reference, effort: "high" }, stale.revision), /conflict|revision|precondition/iu);
    await selections.select("session-a", reference, null);
    assert.equal(await selections.forRun("session-a", reference), undefined);
    await selections.select("session with spaces", reference, "high");
    assert.equal(await selections.forRun("session with spaces", reference), "high");
    await assert.rejects(selections.select("session-a", reference, "ultra"), /not support/u);
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("new Run snapshots effort; a later selection does not change its follow-up", async () => {
  let selected = "low";
  let nextRun = 0;
  const starts = [], controls = [], completions = [];
  const reference = { provider: "deepseek", model: "deepseek-flash" };
  const configuredModel = new ConfiguredModel({ configuration: loadModelsConfiguration({ environment: {} }), registry: createDefaultModelAdapterRegistry() });
  const session = { sessionId: "session-a", agentId: "wish", status: "active" };
  const application = new ApplicationFacade({
    sessions: { manager: { async get() { return session; } } },
    models: { configuredModel, sessionReasoning: {
      defaultModel() { return reference; }, async forRun() { return selected; }, async inspect() {}, async select() {},
    } },
    agent: { definition: { id: "wish" }, startRun(input) {
      starts.push(input);
      let settle; const completion = new Promise(resolve => { settle = resolve; });
      completions.push(settle);
      return { runId: `run-${++nextRun}`, scope: input.scope, completion };
    }, control(runId, control) { controls.push({ runId, control }); return { accepted: true }; }, async *observe() {} },
  });
  const first = await application.startRun({ sessionId: "session-a", payload: { text: "first" } });
  assert.equal(starts[0].payload.reasoningEffort, "low");
  selected = "max";
  application.controlRun(first.runId, { type: "follow_up", id: "follow-1", payload: { text: "queued" } });
  assert.equal(controls[0].control.payload.reasoningEffort, "low");
  assert.throws(() => application.controlRun(first.runId, { type: "follow_up", id: "follow-2", payload: { text: "queued", reasoningEffort: "max" } }), /cannot change the reasoning effort/u);
  completions[0]({ status: "completed" });
  await first.completion;
  const second = await application.startRun({ sessionId: "session-a", payload: { text: "second" } });
  assert.equal(starts[1].payload.reasoningEffort, "max");
  completions[1]({ status: "completed" });
  await second.completion;
});

test("WebUI selection endpoint validates Session, model, and effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-reasoning-api-"));
  const reference = { provider: "deepseek", model: "deepseek-flash" };
  const control = { format: "deepseek-chat", efforts: ["none", "low", "high", "max"], defaultEffort: "high" };
  let selected, status = "active";
  const port = {
    defaultModel() { return reference; },
    inspectDefault() { return { model: reference, control }; },
    async inspect() { return { model: reference, control, ...(selected === undefined ? {} : { selected }) }; },
    async select(_sessionId, _model, effort) {
      if (effort === "max") throw new ModelReasoningSelectionError();
      selected = effort ?? undefined; return this.inspect();
    },
  };
  const server = await startWishWebUiServer({
    application: { agentId: "wish", sessionReasoning: port, async getSession() { return { sessionId: "session-a", status }; } },
    approvals: new WebToolApprovalBroker(), workspaceRoot: directory, port: 0,
  });
  const endpoint = `${server.url}/api/sessions/session-a/model-reasoning`;
  const post = (body) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let response = await fetch(`${server.url}/api/model-reasoning/default`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).selection, { model: reference, control });
    response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).selection.control.efforts, control.efforts);
    response = await post({ model: reference, effort: "low" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selection.selected, "low");
    response = await post({ model: reference, effort: "ultra" });
    assert.equal(response.status, 400);
    response = await post({ model: { provider: "deepseek", model: "stale" }, effort: "max" });
    assert.equal(response.status, 409);
    response = await post({ model: reference, effort: "max" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "model_reasoning_unsupported");
    status = "archived";
    response = await post({ model: reference, effort: "max" });
    assert.equal(response.status, 409);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
