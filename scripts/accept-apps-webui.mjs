import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWishApplication } from "../dist/apps/application.js";
import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  WebToolApprovalBroker,
} from "../dist/apps/webui/index.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { ModelAdapterRegistry } from "../dist/models/registry.js";

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

test("Web approval broker is one-shot, observable, and fail-closed", async () => {
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
  const resolved = broker.decide("approval-1", true);
  assert.equal(resolved.status, "approved");
  assert.equal(broker.decide("approval-1", true), undefined);
  assert.deepEqual(await decision, {
    status: "approved",
    metadata: {
      source: "wish-webui",
      persistence: "once",
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
  const [html, css, script] = await Promise.all([
    readFile(new URL("index.html", assetRoot), "utf8"),
    readFile(new URL("app.css", assetRoot), "utf8"),
    readFile(new URL("app.js", assetRoot), "utf8"),
  ]);

  assert.match(html, /id="session-list"/u);
  assert.match(html, /id="message-list"/u);
  assert.match(html, /id="approval-list"/u);
  assert.match(html, /id="send-steer"/u);
  assert.match(html, /id="send-follow-up"/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u);
  assert.doesNotMatch(html, /\sstyle=/u);
  assert.match(css, /--canvas:/u);
  assert.match(css, /prefers-color-scheme: dark/u);
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /prefers-reduced-motion: reduce/u);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /new EventSource/u);
  assert.match(script, /runIsActive\(\)/u);
  assert.match(script, /renderMarkdown/u);
  assert.match(script, /shouldStickToBottom/u);
  assert.match(script, /compositionstart/u);
  assert.match(script, /event\.isComposing/u);
});

test("WebUI configuration reuses host Models settings and owns listener defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-config-"));
  try {
    const configuration = await loadWishWebUiConfiguration({
      workspaceRoot: root,
      homeDirectory: root,
      environment: {
        WISH_WEBUI_HOST: "127.0.0.1",
        WISH_WEBUI_PORT: "9123",
        WISH_MODELS_JSON: JSON.stringify({
          schemaVersion: 1,
          defaultModel: "fixture/primary",
          providers: [{
            id: "fixture",
            protocol: "openai-chat-completions",
            baseUrl: "https://fixture.example.test/v1",
            auth: { type: "none" },
            developerRoleMode: "native",
            models: [{
              id: "primary",
              status: "active",
              contextWindowTokens: 4_096,
              maxOutputTokens: 1_024,
              input: { text: true, image: false },
              reasoning: false,
              toolCalling: true,
              developerRole: true,
            }],
          }],
        }),
      },
    });
    assert.equal(configuration.host, "127.0.0.1");
    assert.equal(configuration.port, 9123);
    assert.equal(configuration.workspaceRoot, root);
    assert.equal(configuration.application.models.defaultModel.model, "primary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP API maps Sessions, Runs, controls, and Runtime cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-webui-api-"));
  const approvals = new WebToolApprovalBroker();
  let stored = session("session-1", root, "Initial");
  const controls = [];
  const observedAfter = [];
  let observerStopped = false;
  let runCount = 0;
  const application = {
    agentId: "wish",
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
          : new Promise(() => {}),
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
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      heartbeatIntervalMs: 50,
    });
    const health = await requestJson(started.url, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.value.agentId, "wish");

    const page = await fetch(`${started.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/u);
    assert.match(
      page.headers.get("content-security-policy"),
      /default-src 'self'/u,
    );
    assert.match(await page.text(), /<title>Wish<\/title>/u);
    const browserScript = await fetch(`${started.url}/assets/app.js`);
    assert.match(
      browserScript.headers.get("content-type"),
      /text\/javascript/u,
    );
    assert.match(await browserScript.text(), /new EventSource/u);
    const head = await fetch(`${started.url}/assets/app.css`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type"), /text\/css/u);

    const created = await requestJson(started.url, "/api/sessions", {
      method: "POST",
      body: { title: "Initial" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.session.scope, root);
    const listed = await requestJson(started.url, "/api/sessions?status=active");
    assert.equal(listed.value.sessions.length, 1);
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
  } finally {
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
    const application = createWishApplication({
      dataDirectory: join(root, "data"),
      agent: { id: "wish", configuration: { agentInstructions: [] } },
      models: {
        configuration: fixtureConfiguration(),
        registry: adapters,
        fetch: async () => new Response(),
      },
      workspace: {
        resolve({ session }) {
          return { cwd: session.scope, instructions: [] };
        },
      },
      context: { reservedOutputTokens: 512 },
      compaction: { keepRecentTokens: 512, summaryMaxOutputTokens: 256 },
      tools: { approval: approvals },
      runtime: { ...deterministicRuntime(), maxSteps: 4 },
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
