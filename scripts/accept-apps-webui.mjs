import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApplicationFacade } from "../dist/apps/application.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { PlanRuntime, MemoryPlanStateStore } from "../dist/plan/index.js";
import { createPlanSessionFeature } from "../dist/plan/consumers/session-feature.js";
import { createWishAgent } from "../dist/composition/agent-service.js";
import { createAgentLoopPipeline } from "../dist/composition/agent-loop-standalone.js";
import { createWishRuntime } from "../dist/composition/runtime-service.js";
import { RunGeneration } from "../dist/core/runtime/generation.js";
import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  WebToolApprovalBroker,
} from "../dist/apps/webui/index.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { ModelAdapterRegistry } from "../dist/models/registry.js";
import { createConfiguredModelResources } from "../dist/models/runtime.js";
import { TokenizerUsageEstimator } from "../dist/models/usage.js";
import { createFileSessionResources } from "../dist/sessions/index.js";
import { createContextResources } from "../dist/context/service.js";
import { createCompactionResources } from "../dist/compaction/service.js";
import { FileToolResultArchive } from
  "../dist/tools/results/providers/file.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import { MemoryApprovalRuleStore } from
  "../dist/permissions/rules/index.js";

function workspaceSnapshot(root) {
  return Object.freeze({
    requestedRoot: root,
    root,
    fingerprint: `workspace:fixture:${root}`,
    revision: `workspace-revision:fixture:${root}`,
    instructions: Object.freeze([]),
  });
}

function runtimeRecoverySnapshot(runId) {
  const tool = Object.freeze({
    runId,
    userTurnId: `${runId}-turn`,
    stepId: `${runId}-step`,
    callId: `${runId}-call`,
    toolName: "bash",
    phase: "dispatched",
    recoveryPolicy: "needs-reconciliation",
    disposition: "needs-reconciliation",
  });
  const interrupted = Object.freeze({
    runId,
    agentId: "wish",
    scope: "session-recovery",
    userTurnIds: Object.freeze([tool.userTurnId]),
    stepIds: Object.freeze([tool.stepId]),
    tools: Object.freeze([tool]),
    disposition: "needs-reconciliation",
  });
  const recorded = Object.freeze({
    ...interrupted,
    interruptedAt: "2099-01-01T00:00:00.000Z",
    reason: "provider_startup",
  });
  const target = Object.freeze({
    runId,
    agentId: interrupted.agentId,
    scope: interrupted.scope,
    userTurnId: tool.userTurnId,
    stepId: tool.stepId,
    callId: tool.callId,
    toolName: tool.toolName,
    recoveryPolicy: tool.recoveryPolicy,
    interruptedAt: recorded.interruptedAt,
    interruptionReason: recorded.reason,
  });
  return Object.freeze({
    schemaVersion: 1,
    status: "ready",
    recovery: Object.freeze({
      schemaVersion: 1,
      reason: "provider_startup",
      recoveredAt: recorded.interruptedAt,
      scannedThroughCursor: 5,
      runs: Object.freeze([interrupted]),
    }),
    recordedInterruptedRuns: Object.freeze([recorded]),
    pendingReconciliations: Object.freeze([target]),
    reconciliationResolutions: Object.freeze([]),
    reconciliationRequiredRuns: Object.freeze([recorded]),
  });
}

function runtimeRecoveryPort(runId) {
  const snapshot = runtimeRecoverySnapshot(runId);
  return Object.freeze({
    async snapshot() {
      return snapshot;
    },
    async resolve() {
      throw new Error("Unexpected reconciliation resolution");
    },
  });
}

function runtimeRecoveryHarness(runId) {
  let current = runtimeRecoverySnapshot(runId);
  const requests = [];
  const port = Object.freeze({
    async snapshot() {
      return current;
    },
    async resolve(request) {
      requests.push(request);
      const target = current.pendingReconciliations[0];
      assert.ok(target);
      const resolution = Object.freeze({
        schemaVersion: 1,
        ...target,
        resolutionId: request.resolutionId,
        outcome: request.outcome,
        actor: request.actor,
        reason: request.reason,
        resolvedAt: "2099-01-01T00:00:01.000Z",
      });
      current = Object.freeze({
        ...current,
        pendingReconciliations: Object.freeze([]),
        reconciliationResolutions: Object.freeze([resolution]),
        reconciliationRequiredRuns: Object.freeze([]),
      });
      return Object.freeze({ resolution, replayed: false });
    },
  });
  return { port, requests };
}

function agentLoopResources(options) {
  const context = createContextResources({
    dataDirectory: options.dataDirectory,
    sessions: options.sessions,
    archive: new FileToolResultArchive({
      directory: join(options.dataDirectory, "tool-results"),
      locatorRoot: options.dataDirectory,
    }),
    agentInstructions: options.agentInstructions,
    models: options.models,
    configuration: {
      reservedOutputTokens: options.reservedOutputTokens,
    },
  });
  const compaction = createCompactionResources({
    dataDirectory: options.dataDirectory,
    sessions: options.sessions,
    models: options.models,
    keepRecentTokens: options.keepRecentTokens,
    summaryMaxOutputTokens: options.summaryMaxOutputTokens,
  });
  return {
    stepPipeline: createAgentLoopPipeline({
      sessions: options.sessions,
      agentId: options.agentId,
      models: options.models,
      workspace: options.workspace,
      filesystem: options.filesystem ?? new LocalFilesystemBackend(),
      context,
      compaction,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
  };
}

function runtimeResources(options, runtime = {}) {
  return {
    runtime: createWishRuntime(agentLoopResources(options), runtime),
  };
}

function approvalInput(workspace, runId = "run-1") {
  return {
    call: {
      status: "ready",
      id: "call-1",
      name: "read",
      input: { path: "note.txt" },
    },
    descriptor: {
      name: "read",
      description: "Read a file",
      inputSchemaJson: "{}",
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
    },
    capabilities: {
      requirements: [{ capability: "filesystem.read", paths: ["note.txt"] }],
    },
    context: { cwd: workspace, modelSupportsImages: false },
    scope: {
      runId,
      userTurnId: "turn-1",
      stepId: "step-1",
    },
    snapshot: {
      schemaVersion: 1,
      registryVersion: 1,
      authorityVersion: "authority-v1",
      availableTools: ["read"],
    },
  };
}

function session(sessionId, scope, title, status = "active") {
  return {
    schemaVersion: 1,
    sessionId,
    agentId: "wish",
    scope,
    status,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    historyRevision: "0",
    ...(title === undefined ? {} : { title }),
  };
}

function outputEvent(runId, sequence, type, payload) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    type,
    occurredAt: "2099-01-01T00:00:00.000Z",
    runId,
    payload,
  };
}

function fixtureConfiguration() {
  return loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: "fixture/primary",
      fallbackModels: [],
      maxRetries: 0,
      providers: [{
        id: "fixture",
        protocol: "fixture-protocol",
        baseUrl: "https://fixture.example.test/v1",
        auth: { type: "none" },
        developerRoleMode: "native",
        models: [{
          id: "primary",
          status: "active",
          contextWindowTokens: 4_096,
          maxOutputTokens: 1_024,
          input: { text: true, image: true },
          reasoning: false,
          toolCalling: true,
          developerRole: true,
        }],
      }],
    },
    availableProtocols: ["fixture-protocol"],
  });
}

function deterministicRuntime() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () =>
      `2099-01-01T00:00:${String(++counters.time).padStart(2, "0")}Z`,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined
      ? options.headers
      : { "content-type": "application/json", ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const value = await response.json();
  return { response, value };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function collectSse(response, onEvent = async () => {}) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const result = await reader.read();
    buffer += decoder.decode(result.value, { stream: !result.done });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.length === 0 || block.startsWith(":")) continue;
      const parsed = {};
      for (const line of block.split("\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).replace(/^ /u, "");
        if (key === "id" || key === "event") parsed[key] = value;
        if (key === "data") parsed.data = JSON.parse(value);
      }
      events.push(parsed);
      await onEvent(parsed);
    }
    if (result.done) break;
  }
  return events;
}

test("Web approval broker transports explicit scope, remains observable, and fails closed", async () => {
  const events = [];
  const ids = ["approval-1", "approval-2"];
  const broker = new WebToolApprovalBroker({
    timeoutMs: 10_000,
    approvalId: () => ids.shift(),
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  broker.subscribe("run-1", (event) => events.push(event));
  const input = approvalInput("/workspace");
  const decision = Promise.resolve(broker.requestApproval(input));

  assert.equal(broker.listPending("run-1").length, 1);
  assert.equal(broker.listPending("run-1")[0].approvalId, "approval-1");
  assert.equal(broker.listPending("run-1")[0].workspace.cwd, "/workspace");
  assert.equal(Object.isFrozen(broker.listPending("run-1")[0].call.input), true);
  assert.equal(input.call.input === broker.listPending("run-1")[0].call.input, false);
  const resolved = broker.decide("approval-1", true, "session");
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.retentionScope, "session");
  assert.equal(broker.decide("approval-1", true), undefined);
  assert.deepEqual(await decision, {
    status: "approved",
    scope: "session",
    metadata: {
      source: "wish-webui",
      persistence: "session",
      approvalId: "approval-1",
    },
  });
  assert.deepEqual(events.map((event) => event.type), [
    "approval.requested",
    "approval.resolved",
  ]);

  const controller = new AbortController();
  const cancelled = Promise.resolve(
    broker.requestApproval(approvalInput("/workspace"), controller.signal),
  );
  controller.abort("stop");
  assert.deepEqual(await cancelled, {
    status: "denied",
    reason: "Tool approval was cancelled because the Run was aborted",
  });
  assert.equal(broker.listPending().length, 0);
  broker.close();
  assert.deepEqual(broker.requestApproval(input), {
    status: "denied",
    reason: "WebUI approval service is closed",
  });
});

test("WebUI static assets build a CSP-compatible responsive application shell", async () => {
  const assetRoot = new URL("../dist/apps/webui/public/", import.meta.url);
  const [html, css, entry] = await Promise.all([
    readFile(new URL("index.html", assetRoot), "utf8"),
    readFile(new URL("app.css", assetRoot), "utf8"),
    readFile(new URL("client.js", assetRoot), "utf8"),
  ]);
  const manifest = JSON.parse(await readFile(new URL("ui-modules.json", assetRoot), "utf8"));
  assert.deepEqual(manifest.modules.find(module => module.id === "ModelsClientUi").entryIds, ["include:models"]);
  assert.equal(entry.trim(), `import ${JSON.stringify(manifest.core)};`);
  const script = await readFile(new URL(manifest.core.slice("/assets/".length), assetRoot), "utf8");

  assert.match(html, /id="wish-root"/u);
  assert.match(html, /type="module" src="\/assets\/client\.js"/u);
  assert.match(html, /href="\/assets\/app\.css"/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u);
  assert.doesNotMatch(html, /\sstyle=/u);
  assert.match(css, /\.wish-shell/u);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(script, /EventSource/u);
  assert.match(script, /\/api\/management\/bootstrap/u);
  assert.doesNotMatch(script, /legacy-link|\/legacy/u);
  for (const removed of ["app.js", "next.html", "next.css"]) {
    await assert.rejects(readFile(new URL(removed, assetRoot)), { code: "ENOENT" });
  }
});

test("WebUI configuration owns only listener and workspace settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-config-"));
  try {
    const configuration = await loadWishWebUiConfiguration({
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 9123,
    });
    assert.equal(configuration.host, "127.0.0.1");
    assert.equal(configuration.port, 9123);
    assert.equal(configuration.workspaceRoot, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP API maps Sessions, Runs, controls, and Runtime cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-api-"));
  const approvals = new WebToolApprovalBroker();
  const approvalRules = new MemoryApprovalRuleStore({
    id: () => "rule-web-1",
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
  const retainedRule = await approvalRules.remember({
    profile: "approval-required",
    policyVersion: "policy-web-1",
    toolName: "bash",
    capabilityDigest: "sha256:web-capability",
    identity: {
      agentId: "wish",
      sessionId: "session-1",
      runId: "run-1",
      workspaceFingerprint: "workspace-web-1",
    },
    scope: "workspace",
  });
  let stored = session("session-1", root, "Initial");
  const controls = [];
  const observedAfter = [];
  let observerStopped = false;
  let runCount = 0;
  let resolveSecondRun;
  const recoveryHarness = runtimeRecoveryHarness("run-needs-review");
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  const sessionFeatures = new SessionFeatureRegistry();
  sessionFeatures.register("plan", createPlanSessionFeature(plan));
  const application = {
    agentId: "wish",
    sessionFeatures,
    runtimeRecovery: recoveryHarness.port,
    async createSession(input) {
      stored = session(input.sessionId ?? "session-1", input.workspaceRoot, input.title);
      return stored;
    },
    async getSession() {
      return stored;
    },
    async listSessions(input = {}) {
      return input.status === undefined || input.status === stored.status
        ? [stored]
        : [];
    },
    async updateSessionMetadata(input) {
      stored = { ...stored, ...(input.title === null ? {} : { title: input.title }) };
      if (input.title === null) delete stored.title;
      return stored;
    },
    async archiveSession() {
      stored = { ...stored, status: "archived" };
      return stored;
    },
    async readSessionHistory() {
      return { sessionId: stored.sessionId, historyRevision: "0", records: [] };
    },
    async startRun(input) {
      runCount += 1;
      const runId = `run-${runCount}`;
      return {
        agentId: "wish",
        runId,
        initialUserTurnId: `turn-${runCount}`,
        scope: input.sessionId,
        completion: runCount === 1
          ? Promise.resolve({ status: "completed" })
          : new Promise((resolve) => {
            resolveSecondRun = resolve;
          }),
      };
    },
    controlRun(runId, control) {
      controls.push({ runId, control });
      return {
        accepted: true,
        kind: control.type,
        runId,
        controlId: control.id ?? `control-${controls.length}`,
        ...(control.type === "abort" ? {} : { position: 1 }),
      };
    },
    observeRun(runId, options = {}) {
      observedAfter.push(options.afterSequence ?? 0);
      if (runId === "run-2") {
        return {
          async *[Symbol.asyncIterator]() {
            yield outputEvent(runId, 1, "runtime.transition", {
              type: "run.started",
              at: "2099-01-01T00:00:00.000Z",
            });
            await new Promise((resolve) => {
              const stop = () => {
                observerStopped = true;
                resolve();
              };
              options.signal?.addEventListener("abort", stop, { once: true });
            });
          },
        };
      }
      const events = [
        outputEvent(runId, 1, "runtime.transition", {
          type: "run.started",
          at: "2099-01-01T00:00:00.000Z",
        }),
        outputEvent(runId, 2, "model.stream", {
          type: "text_delta",
          text: "answer",
        }),
        outputEvent(runId, 3, "runtime.transition", {
          type: "run.completed",
          result: {},
          at: "2099-01-01T00:00:01.000Z",
        }),
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            if (event.sequence > (options.afterSequence ?? 0)) yield event;
          }
        },
      };
    },
  };
  let started;
  try {
    started = await startWishWebUiServer({
      application,
      approvals,
      approvalRules,
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      heartbeatIntervalMs: 50,
    });
    const health = await requestJson(started.url, "/api/health");
    await plan.enter({ sessionId: "session-1" });
    await plan.update({ sessionId: "session-1", markdown: "first plan" });
    await plan.review({ sessionId: "session-1", markdown: "first plan", expectedPlanVersion: 1 });
    const review = await requestJson(started.url, "/api/sessions/session-1/features");
    assert.equal(review.response.status, 200);
    const oldToken = review.value.features[0].token;
    const feedback = await requestJson(started.url, "/api/sessions/session-1/features/plan", {
      method: "POST", body: { action: "keep-planning", token: oldToken, feedback: "Add tests first" },
    });
    assert.equal(feedback.response.status, 200);
    assert.equal((await plan.get({ sessionId: "session-1" })).active, true);
    const stale = await requestJson(started.url, "/api/sessions/session-1/features/plan", {
      method: "POST", body: { action: "approve", token: oldToken },
    });
    assert.equal(stale.response.status, 409);
    await plan.update({ sessionId: "session-1", markdown: "revised plan with tests" });
    await plan.review({ sessionId: "session-1", markdown: "revised plan with tests", expectedPlanVersion: 2 });
    const revised = await requestJson(started.url, "/api/sessions/session-1/features");
    const decision = await requestJson(started.url, "/api/sessions/session-1/features/plan", {
      method: "POST", body: { action: "approve", token: revised.value.features[0].token },
    });
    assert.equal(decision.response.status, 200);
    assert.equal((await plan.get({ sessionId: "session-1" })).active, false);
    assert.equal(runCount, 0, "human approval must not start execution implicitly");
    assert.equal(health.response.status, 200);
    assert.equal(health.value.agentId, "wish");
    assert.deepEqual(
      health.value.runtimeRecovery.reconciliationRequiredRuns.map((run) =>
        run.runId
      ),
      ["run-needs-review"],
    );
    const recovery = await requestJson(started.url, "/api/runtime-recovery");
    const target = recovery.value.recovery.pendingReconciliations[0];
    assert.equal(target.callId, "run-needs-review-call");
    const invalidResolution = await requestJson(
      started.url,
      "/api/runtime-recovery/reconciliations",
      {
        method: "POST",
        body: {
          resolutionId: "resolution-web-invalid",
          runId: target.runId,
          userTurnId: target.userTurnId,
          stepId: target.stepId,
          callId: target.callId,
          outcome: "maybe",
          actor: "wish-webui-operator",
          reason: "checked",
        },
      },
    );
    assert.equal(invalidResolution.response.status, 400);
    const resolved = await requestJson(
      started.url,
      "/api/runtime-recovery/reconciliations",
      {
        method: "POST",
        body: {
          resolutionId: "resolution-web-1",
          runId: target.runId,
          userTurnId: target.userTurnId,
          stepId: target.stepId,
          callId: target.callId,
          outcome: "accepted-unknown",
          actor: "wish-webui-operator",
          reason: "operator accepts the residual uncertainty",
          evidence: "ticket-web-1",
        },
      },
    );
    assert.equal(resolved.response.status, 200);
    assert.equal(resolved.value.commit.resolution.outcome, "accepted-unknown");
    assert.deepEqual(resolved.value.recovery.pendingReconciliations, []);
    assert.equal(recoveryHarness.requests[0].evidence, "ticket-web-1");
    const postResolutionHealth = await requestJson(started.url, "/api/health");
    assert.deepEqual(
      postResolutionHealth.value.runtimeRecovery.reconciliationRequiredRuns,
      [],
    );

    const approvalDecision = Promise.resolve(
      approvals.requestApproval(approvalInput(root)),
    );
    const pendingApproval = approvals.listPending()[0];
    const invalidApproval = await requestJson(
      started.url,
      `/api/approvals/${pendingApproval.approvalId}`,
      { method: "POST", body: { approved: true, scope: "forever" } },
    );
    assert.equal(invalidApproval.response.status, 400);
    const approved = await requestJson(
      started.url,
      `/api/approvals/${pendingApproval.approvalId}`,
      { method: "POST", body: { approved: true, scope: "workspace" } },
    );
    assert.equal(approved.value.approval.retentionScope, "workspace");
    assert.equal((await approvalDecision).scope, "workspace");

    const listedRules = await requestJson(started.url, "/api/approval-rules");
    assert.deepEqual(listedRules.value.rules.map((rule) => rule.id), [
      retainedRule.id,
    ]);
    const revoked = await requestJson(
      started.url,
      `/api/approval-rules/${retainedRule.id}`,
      { method: "DELETE" },
    );
    assert.equal(revoked.value.revoked, true);
    assert.deepEqual(
      (await requestJson(started.url, "/api/approval-rules")).value.rules,
      [],
    );

    // Standalone embedding exposes business APIs only. Root owns the UI and management.
    for (const path of ["/", "/legacy", "/assets/app.js", "/assets/client.js"]) {
      assert.equal((await fetch(`${started.url}${path}`)).status, 404);
    }

    const created = await requestJson(started.url, "/api/sessions", {
      method: "POST",
      body: { title: "Initial" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.session.scope, root);
    const listed = await requestJson(started.url, "/api/sessions?status=active");
    assert.equal(listed.value.sessions.length, 1);
    assert.equal(listed.value.workspaceRoot, root);
    const renamed = await requestJson(started.url, "/api/sessions/session-1", {
      method: "PATCH",
      body: { title: "Renamed" },
    });
    assert.equal(renamed.value.session.title, "Renamed");
    const history = await requestJson(
      started.url,
      "/api/sessions/session-1/history",
    );
    assert.deepEqual(history.value.history.records, []);

    const accepted = await requestJson(
      started.url,
      "/api/sessions/session-1/runs",
      { method: "POST", body: { text: "hello" } },
    );
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.value.run.runId, "run-1");
    assert.equal(accepted.value.eventsUrl, "/api/runs/run-1/events");
    const runState = await requestJson(started.url, "/api/runs/run-1");
    assert.equal(runState.value.run.status, "completed");
    const sessionRuns = await requestJson(
      started.url,
      "/api/sessions/session-1/runs",
    );
    assert.deepEqual(
      sessionRuns.value.runs.map((run) => run.runId),
      ["run-1"],
    );
    const controlled = await requestJson(
      started.url,
      accepted.value.controlsUrl,
      { method: "POST", body: { type: "follow_up", id: "web-1", text: "next" } },
    );
    assert.equal(controlled.value.receipt.accepted, true);
    assert.deepEqual(controls[0], {
      runId: "run-1",
      control: {
        type: "follow_up",
        id: "web-1",
        text: "next",
        payload: { text: "next" },
        source: "wish-webui",
      },
    });

    const stream = await fetch(`${started.url}${accepted.value.eventsUrl}`, {
      headers: { "last-event-id": "1" },
    });
    const streamed = await collectSse(stream);
    assert.deepEqual(
      streamed.filter((event) => event.id !== undefined).map((event) => event.id),
      ["2", "3"],
    );
    assert.equal(observedAfter[0], 1);

    const second = await requestJson(
      started.url,
      "/api/sessions/session-1/runs",
      { method: "POST", body: { text: "long" } },
    );
    const disconnected = await fetch(`${started.url}${second.value.eventsUrl}`);
    assert.ok(disconnected.body);
    const reader = disconnected.body.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => observerStopped, "SSE observer did not stop after disconnect");
    assert.equal(
      controls.some((item) => item.control.type === "abort"),
      false,
      "disconnect must not abort the Run",
    );

    const wrongType = await fetch(`${started.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
    const archived = await requestJson(
      started.url,
      "/api/sessions/session-1/archive",
      { method: "POST", body: {} },
    );
    assert.equal(archived.value.session.status, "archived");

    let closed = false;
    const closing = started.close().then(() => {
      closed = true;
    });
    await waitFor(
      () => controls.some((item) =>
        item.runId === "run-2" &&
        item.control.type === "abort" &&
        item.control.source === "wish-webui-shutdown"
      ),
      "WebUI shutdown did not abort its active Run",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "WebUI close must wait for Run completion");
    assert.equal(runCount, 2, "shutdown must not replay an active Run");
    resolveSecondRun({
      status: "aborted",
      cancellation: { reason: "Wish WebUI server is closing" },
    });
    await closing;
    assert.equal(closed, true);
    assert.equal(
      controls.filter((item) =>
        item.runId === "run-2" && item.control.type === "abort"
      ).length,
      1,
      "one server generation must abort each active Run once",
    );
    started = undefined;
  } finally {
    await started?.close();
    await approvalRules.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Session actions enforce ownership, active completion and module vetoes through the API", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-session-api-"));
  const sessions = createFileSessionResources(root);
  const features = new SessionFeatureRegistry();
  const completion = deferred();
  let unsettled = false;
  let pendingReconciliations = [];
  const options = { sessions, sessionFeatures: features,
    recovery: { async snapshot() { return { pendingReconciliations }; } },
    agent: { definition: { id: "wish" }, startRun({ scope }) { unsettled = true; return { runId: "run", scope, completion: completion.promise }; }, control() {}, async *observe() {} },
    models: { configuredModel: { getDefaultModel: () => ({ provider: "test", model: "test" }), resolve: ref => ({ ref }) } },
  };
  const application = new ApplicationFacade(options), otherFacade = new ApplicationFacade(options);
  let server;
  try {
    server = await startWishWebUiServer({ application, approvals: new WebToolApprovalBroker(), workspaceRoot: root, host: "127.0.0.1", port: 0 });
    await application.createSession({ sessionId: "one", workspaceRoot: root });
    await sessions.manager.create({ sessionId: "foreign", agentId: "other", scope: root });
    const post = (id, action) => requestJson(server.url, `/api/sessions/${id}/${action}`, { method: "POST", body: {} });
    const remove = id => requestJson(server.url, `/api/sessions/${id}`, { method: "DELETE", body: {} });
    assert.equal((await remove("foreign")).response.status, 404);
    assert.equal((await post("foreign", "restore")).response.status, 404);
    assert.equal((await post("one", "archive")).value.session.status, "archived");
    assert.equal((await post("one", "restore")).value.session.status, "active");
    const renamed = await requestJson(server.url, "/api/sessions/one", { method: "PATCH", body: { title: "  新名字  " } });
    assert.equal(renamed.value.session.title, "新名字");
    assert.equal((await requestJson(server.url, "/api/sessions/one", { method: "PATCH", body: { title: " " } })).response.status, 400);
    const starting = application.startRun({ sessionId: "one", payload: { text: "test" } });
    await assert.rejects(otherFacade.deleteSession({ sessionId: "one" }), { code: "session_busy" });
    await starting; assert.ok(unsettled);
    assert.equal((await post("one", "archive")).response.status, 409);
    assert.equal((await remove("one")).response.status, 409);
    completion.resolve({}); await completion.promise;
    pendingReconciliations = [{ scope: "one" }];
    assert.equal((await remove("one")).response.status, 409);
    pendingReconciliations = [];
    const unregister = features.register("fixture", { async inspect() {}, async act() {}, async beforeRemoval() { throw new Error("正在运行的子任务"); } });
    assert.equal((await remove("one")).response.status, 409);
    unregister();
    assert.equal((await remove("one")).response.status, 409, "missing owner cannot be treated as idle");
    features.register("fixture", { async inspect() {}, async act() {}, async beforeRemoval() {} });
    assert.equal((await remove("one")).response.status, 200);
    assert.equal((await requestJson(server.url, "/api/sessions/one")).response.status, 404);
    assert.ok(await sessions.manager.get({ sessionId: "foreign" }));
  } finally { completion.resolve({}); await server?.close(); await sessions.manager.store.close(); await rm(root, { recursive: true, force: true }); }
});

test("managed WebUI shutdown delegates one abort to its Run generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-generation-"));
  const approvals = new WebToolApprovalBroker();
  const completion = deferred();
  const controls = [];
  let starts = 0;
  const runtime = {
    startRun(definition, input) {
      starts += 1;
      return Object.freeze({
        agentId: definition.id,
        runId: "managed-run",
        initialUserTurnId: "managed-turn",
        scope: input.scope,
        completion: completion.promise,
      });
    },
    control(agentId, runId, control) {
      controls.push({ agentId, runId, control });
      return Object.freeze({ accepted: true, kind: control.type, runId });
    },
    async *observe() {},
  };
  const runGeneration = new RunGeneration(runtime, {
    id: "webui-generation",
    drainTimeoutMs: 1_000,
    abortControl: ({ reason }) => Object.freeze({
      type: "abort",
      source: "managed-generation",
      reason,
    }),
  });
  const application = {
    agentId: "wish",
    runGeneration,
    startRun(input) {
      return runGeneration.startRun(
        { id: "wish" },
        { scope: input.sessionId, payload: input.payload },
      );
    },
    controlRun(runId, control) {
      return runGeneration.control("wish", runId, control);
    },
    observeRun(runId, options) {
      return runGeneration.observe("wish", runId, options);
    },
  };
  let started;
  try {
    started = await startWishWebUiServer({
      application,
      approvals,
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
    });
    const accepted = await requestJson(
      started.url,
      "/api/sessions/session-managed/runs",
      { method: "POST", body: { text: "wait" } },
    );
    assert.equal(accepted.response.status, 202);

    let closed = false;
    const closing = started.close().then(() => {
      closed = true;
    });
    await waitFor(() => controls.length === 1, "generation abort was not sent");
    assert.equal(closed, false);
    assert.equal(runGeneration.state, "retiring");
    assert.deepEqual(controls[0], {
      agentId: "wish",
      runId: "managed-run",
      control: {
        type: "abort",
        source: "managed-generation",
        reason: "Wish WebUI server is closing",
      },
    });

    completion.resolve({
      status: "aborted",
      cancellation: { reason: "Wish WebUI server is closing" },
    });
    await closing;
    assert.equal(runGeneration.state, "retired");
    assert.equal(controls.length, 1);
    assert.equal(starts, 1, "WebUI shutdown must not replay the Run");
    started = undefined;
  } finally {
    completion.resolve({ status: "aborted" });
    await started?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Application streams Tool approval and commits one Session transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-real-"));
  const approvals = new WebToolApprovalBroker({
    timeoutMs: 10_000,
    approvalId: () => "approval-real",
  });
  let started;
  try {
    await writeFile(join(root, "note.txt"), "web approval value", "utf8");
    let requestCount = 0;
    const adapters = new ModelAdapterRegistry();
    adapters.register("fixture-protocol", () => ({
      async *stream(request) {
        requestCount += 1;
        yield { type: "start", model: request.model };
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "read-call",
              name: "read",
              argumentsJson: '{"path":"note.txt"}',
            },
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        assert.match(
          request.messages.findLast((message) => message.role === "tool").content,
          /web approval value/u,
        );
        yield { type: "text_delta", text: "read through web approval" };
        yield { type: "done", finishReason: "stop" };
      },
    }));
    const dataDirectory = join(root, "data");
    const sessions = createFileSessionResources(dataDirectory);
    const models = createConfiguredModelResources({
      configuration: fixtureConfiguration(),
      registry: adapters,
      usageEstimator: new TokenizerUsageEstimator(),
      fetch: async () => new Response(),
    });
    const workspace = {
      resolve({ root }) {
        return workspaceSnapshot(root);
      },
    };
    const runtime = runtimeResources({
      dataDirectory,
      sessions,
      agentId: "wish",
      models,
      workspace,
      agentInstructions: [],
      reservedOutputTokens: 512,
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 256,
      tools: { approval: approvals },
    }, { ...deterministicRuntime(), maxSteps: 4 });
    const application = new ApplicationFacade({
      sessions,
      agent: createWishAgent(
        { id: "wish", configuration: { agentInstructions: [] } },
        runtime,
      ),
      models,
    });
    started = await startWishWebUiServer({
      application,
      approvals,
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
    });
    const created = await requestJson(started.url, "/api/sessions", {
      method: "POST",
      body: { sessionId: "session-real", title: "Real" },
    });
    assert.equal(created.response.status, 201);
    const accepted = await requestJson(
      started.url,
      "/api/sessions/session-real/runs",
      { method: "POST", body: { text: "read the note" } },
    );
    let approvalSubmitted = false;
    const stream = await fetch(`${started.url}${accepted.value.eventsUrl}`);
    const events = await collectSse(stream, async (event) => {
      const candidate = event.event === "approval.snapshot"
        ? event.data.approvals[0]
        : event.event === "approval.requested"
        ? event.data.approval
        : undefined;
      if (candidate === undefined || approvalSubmitted) return;
      approvalSubmitted = true;
      const decision = await requestJson(
        started.url,
        `/api/approvals/${candidate.approvalId}`,
        { method: "POST", body: { approved: true } },
      );
      assert.equal(decision.value.approval.status, "approved");
    });

    assert.equal(approvalSubmitted, true);
    assert.equal(
      events.some((event) => event.event === "approval.resolved"),
      true,
    );
    assert.equal(
      events.some((event) =>
        event.event === "tool.lifecycle" &&
        event.data.payload.type === "tool.completed"
      ),
      true,
    );
    assert.equal(
      events.some((event) =>
        event.event === "runtime.transition" &&
        event.data.payload.type === "run.completed"
      ),
      true,
      `terminal events: ${events.map((event) =>
        `${event.event}:${event.data?.payload?.type ?? "-"}`
      ).join(", ")}`,
    );
    const runState = await requestJson(
      started.url,
      `/api/runs/${accepted.value.run.runId}`,
    );
    assert.equal(runState.value.run.status, "completed");
    const history = await requestJson(
      started.url,
      "/api/sessions/session-real/history",
    );
    assert.deepEqual(
      history.value.history.records.map((record) => record.message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    const pending = await requestJson(started.url, "/api/approvals");
    assert.deepEqual(pending.value.approvals, []);
    const repeated = await requestJson(
      started.url,
      "/api/approvals/approval-real",
      { method: "POST", body: { approved: true } },
    );
    assert.equal(repeated.response.status, 404);
  } finally {
    await started?.close();
    await rm(root, { recursive: true, force: true });
  }
});
