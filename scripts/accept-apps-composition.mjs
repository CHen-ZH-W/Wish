import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";

import { ApplicationFacade } from "../dist/apps/application.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { registerManagedSessionFeature } from "../dist/apps/session-feature-owner.js";
import { createWishAgent } from "../dist/composition/agent-service.js";
import { createAgentLoopPipeline } from "../dist/composition/agent-loop-standalone.js";
import { createWishRuntime } from "../dist/composition/runtime-service.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import {
  createDefaultModelAdapterRegistry,
  ModelAdapterRegistry,
} from "../dist/models/registry.js";
import { createConfiguredModelResources } from "../dist/models/runtime.js";
import { TokenizerUsageEstimator } from "../dist/models/usage.js";
import { MemoryModelAttemptLedger } from
  "../dist/models/pricing/ledger.js";
import { createContextResources } from "../dist/context/service.js";
import { createCompactionResources } from "../dist/compaction/service.js";
import { FileToolResultArchive } from
  "../dist/tools/results/providers/file.js";
import { ToolRegistry } from "../dist/core/tools/scheduler.js";
import {
  createFileSessionResources,
  SessionArchivedError,
  SessionNotFoundError,
} from "../dist/sessions/index.js";
import {
  registerBasicTools,
} from "../dist/composition/coding-tools.js";
import { createBashTool } from "../dist/shell/consumers/model-tool.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import { LocalFilesystemSearchBackend } from
  "../dist/filesystem/search/providers/local.js";

function fixtureConfiguration(options = {}) {
  const models = [{
    id: "primary",
    status: "active",
    contextWindowTokens: options.contextWindowTokens ?? 4_096,
    maxOutputTokens: 1_024,
    input: { text: true, image: true },
    reasoning: false,
    toolCalling: true,
    developerRole: true,
  }];
  if (options.secondary === true) {
    models.push({ ...models[0], id: "secondary" });
  }
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
        models,
      }],
    },
    availableProtocols: ["fixture-protocol"],
  });
}

function sessionFeatureBridgeFixture(features) {
  const runs = [], controls = [];
  const model = { provider: "fixture", model: "primary" };
  const agent = {
    definition: { id: "bridge-agent" },
    startRun(input) {
      let resolveCompletion;
      const completion = new Promise(resolve => { resolveCompletion = resolve; });
      const handle = { runId: input.runId ?? `bridge-run-${runs.length + 1}`, agentId: "bridge-agent", initialUserTurnId: "bridge-turn", scope: input.scope, completion };
      const run = { handle, active: true, complete(status = "completed") { if (this.active) { this.active = false; resolveCompletion({ runId: handle.runId, status }); } } };
      runs.push(run); return handle;
    },
    control(runId, control) { controls.push({ runId, control }); if (control.type === "abort") runs.find(run => run.handle.runId === runId)?.complete("aborted"); return { runId, type: control.type, accepted: true }; },
    async *observe() {},
  };
  const application = new ApplicationFacade({ sessions: { manager: { async get({ sessionId }) { return { schemaVersion: 1, agentId: "bridge-agent", sessionId, scope: "/bridge", status: "active", createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", historyRevision: "1" }; } } }, agent,
    models: { configuredModel: { resolve: () => ({ ref: model }), getDefaultModel: () => model } }, sessionFeatures: features });
  return { application, runs, controls };
}

test("Session Feature Run observation receives the registered facade handle including cleanup completion", async () => {
  const features = new SessionFeatureRegistry(), cleanupEntered = Promise.withResolvers(), releaseCleanup = Promise.withResolvers();
  const inputs = [], observed = []; let legacyInputs = 0;
  features.register("observer", { async inspect() {}, async act() {},
    async beforeInput(sessionId, text, context) { inputs.push({ sessionId, text, context }); },
    async runStarted(application, handle) { observed.push({ application, handle }); },
    async purgeRun() { cleanupEntered.resolve(); await releaseCleanup.promise; },
  });
  features.register("legacy", { async inspect() {}, async act() {}, async beforeInput(_sessionId, _text) { legacyInputs++; } });
  const { application, runs } = sessionFeatureBridgeFixture(features);
  const handle = await application.startRun({ sessionId: "bridge-session", runId: "reserved-run", inputSource: "user", payload: { text: "A natural request" } });
  assert.equal(observed.length, 1); assert.equal(observed[0].application, application); assert.equal(observed[0].handle, handle);
  assert.notEqual(handle.completion, runs[0].handle.completion, "Observers must receive cleanup completion rather than only Core completion");
  assert.deepEqual(inputs, [{ sessionId: "bridge-session", text: "A natural request", context: { kind: "start", runId: "reserved-run", inputSource: "user" } }]);
  let finished = false; const completion = handle.completion.then(() => { finished = true; });
  runs[0].complete(); await cleanupEntered.promise; await Promise.resolve(); assert.equal(finished, false);
  releaseCleanup.resolve(); await completion; assert.equal(finished, true);
  await features.beforeInput("bridge-session", "Updated scope", { kind: "steer", runId: handle.runId, inputSource: "user" });
  await features.beforeInput("bridge-session", "Another turn", { kind: "follow_up", runId: handle.runId, inputSource: "user" });
  assert.equal(inputs[1].context.kind, "steer"); assert.equal(inputs[2].context.kind, "follow_up"); assert.equal(legacyInputs, 3);
});

test("A failed Run-start observer aborts the new Run and drains feature cleanup before rejecting admission", async () => {
  const features = new SessionFeatureRegistry(), cleanupEntered = Promise.withResolvers(), releaseCleanup = Promise.withResolvers();
  const failure = new Error("observer failed"), events = [];
  features.register("observer", { async inspect() {}, async act() {}, async runStarted() { throw failure; },
    async purgeRun() { events.push("cleanup-entered"); cleanupEntered.resolve(); await releaseCleanup.promise; events.push("cleanup-finished"); },
  });
  const { application, runs, controls } = sessionFeatureBridgeFixture(features);
  let rejected = false;
  const starting = application.startRun({ sessionId: "bridge-session", inputSource: "user", payload: { text: "Start an observed Run" } });
  const rejection = assert.rejects(starting, error => { rejected = true; assert.equal(error, failure); events.push("start-rejected"); return true; });
  try {
    await cleanupEntered.promise; assert.equal(runs.length, 1); assert.equal(runs[0].active, false); assert.equal(controls.length, 1); assert.equal(controls[0].control.type, "abort");
    assert.equal(rejected, false, "Admission must not reject while its hidden Run is still cleaning up");
  } finally { releaseCleanup.resolve(); }
  await rejection; assert.deepEqual(events, ["cleanup-entered", "cleanup-finished", "start-rejected"]);
});

test("Managed Session Feature wrappers preserve input and Run-handle context and reject retained observers after unload", async () => {
  const root = new Context(), observed = []; let registered, released = false;
  root.provide("application", { registerSessionFeature(key, feature) { assert.equal(key, "bridge"); registered = feature; return () => { released = true; }; } });
  try {
    const fiber = await root.plugin({ inject: ["application"], apply(ctx) { registerManagedSessionFeature(ctx, "bridge", { async inspect() {}, async act() {},
      async beforeInput(sessionId, text, context) { observed.push({ sessionId, text, context }); }, async runStarted(application, handle) { observed.push({ application, handle }); },
    }); } });
    const facade = {}, handle = { runId: "bridge-run" }, context = { kind: "follow_up", runId: "bridge-run", inputSource: "user" };
    await registered.beforeInput("bridge-session", "follow up", context); await registered.runStarted(facade, handle);
    assert.equal(observed[0].context, context); assert.equal(observed[1].application, facade); assert.equal(observed[1].handle, handle);
    await fiber.dispose(); assert.equal(released, true);
    await assert.rejects(registered.beforeInput("bridge-session", "stale", context), /closed/u);
    await assert.rejects(registered.runStarted(facade, handle), /closed/u);
  } finally { await root.fiber.dispose(); }
});

function modelResources(configuration, options = {}) {
  return createConfiguredModelResources({
    configuration,
    registry: options.registry ?? createDefaultModelAdapterRegistry(),
    usageEstimator: new TokenizerUsageEstimator(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.attemptLedger === undefined
      ? {}
      : { attemptLedger: options.attemptLedger }),
  });
}

function agentLoopResources(options) {
  const context = createContextResources({
    dataDirectory: options.dataDirectory,
    sessions: options.sessions,
    archive: new FileToolResultArchive({
      directory: join(options.dataDirectory, "tool-results"),
      locatorRoot: options.dataDirectory,
    }),
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
      ...(options.permissions === undefined
        ? {}
        : { permissions: options.permissions }),
      context,
      compaction,
      resolveInstructions: () => options.agentInstructions.map((instruction) => ({
        role: instruction.authority,
        content: instruction.content,
      })),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
  };
}

function runtimeResources(options, runtime = {}) {
  return {
    runtime: createWishRuntime(agentLoopResources(options), runtime),
  };
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

function workspaceSnapshot(root, instructions = []) {
  return Object.freeze({
    requestedRoot: root,
    root,
    fingerprint: `workspace:fixture:${root}`,
    revision: `workspace-revision:fixture:${root}`,
    instructions: Object.freeze(instructions),
  });
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("composes one shared App through durable Session, Context, Tool and Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-app-composition-"));
  try {
    await writeFile(join(root, "workspace-note.txt"), "workspace value", "utf8");

    const requests = [];
    const attemptLedger = new MemoryModelAttemptLedger();
    const adapters = new ModelAdapterRegistry();
    adapters.register("fixture-protocol", () => ({
      async *stream(request) {
        requests.push(request);
        yield { type: "start", model: request.model };
        if (requests.length === 1) {
          yield { type: "text_delta", text: "first answer" };
          yield { type: "done", finishReason: "stop", usage: fixtureUsage() };
          return;
        }
        if (requests.length === 2) {
          yield {
            type: "tool_call",
            call: {
              id: "read-call",
              name: "read",
              argumentsJson: '{"path":"workspace-note.txt"}',
            },
          };
          yield { type: "done", finishReason: "tool_calls", usage: fixtureUsage() };
          return;
        }
        yield { type: "text_delta", text: "read complete" };
        yield { type: "done", finishReason: "stop", usage: fixtureUsage() };
      },
    }));
    const approvals = [];
    const resolvedWorkspaces = [];
    const toolRegistry = new ToolRegistry();
    const filesystem = new LocalFilesystemBackend();
    const filesystemSearch = new LocalFilesystemSearchBackend(filesystem);
    const registrations = registerBasicTools(toolRegistry, {
      read: { filesystem },
      write: { filesystem },
      edit: { filesystem },
      grep: { search: filesystemSearch },
    });
    const dataDirectory = join(root, "data");
    const sessions = createFileSessionResources(dataDirectory);
    const models = modelResources(fixtureConfiguration(), {
      registry: adapters,
      fetch: async () => new Response(),
      attemptLedger: { ledger: attemptLedger, currency: "USD" },
    });
    const agentInstructions = [{
      id: "agent-base",
      authority: "system",
      content: "Be exact.",
    }];
    const workspace = {
      resolve({ root }) {
        const snapshot = workspaceSnapshot(root, [
          Object.freeze({
            id: "workspace",
            authority: "developer",
            source: `${root}/AGENTS.md`,
            content: "Stay in the workspace.",
            digest: "sha256:fixture",
          }),
        ]);
        resolvedWorkspaces.push(snapshot);
        return snapshot;
      },
    };
    const runtime = runtimeResources({
      dataDirectory,
      sessions,
      agentId: "wish-agent",
      models,
      workspace,
      filesystem,
      filesystemSearch,
      agentInstructions,
      reservedOutputTokens: 512,
      keepRecentTokens: 512,
      summaryMaxOutputTokens: 256,
      tools: {
        registry: toolRegistry,
        approval: {
          requestApproval(input) {
            approvals.push(input);
            return { status: "approved", metadata: { source: "acceptance" } };
          },
        },
        policyVersion: "acceptance-policy-v1",
        authorityVersion: "acceptance-authority-v1",
      },
    }, deterministicRuntime());
    const application = new ApplicationFacade({
      sessions,
      agent: createWishAgent({
        id: "wish-agent",
        configuration: {
          agentInstructions,
        },
      }, runtime),
      models,
    });
    assert.equal(registrations.at(-1).descriptor.name, "bash");
    assert.equal(registrations.at(-1).unregister(), true);

    const session = await application.createSession({
      sessionId: "session-1",
      workspaceRoot: root,
      title: "Composition",
    });
    assert.equal(session.agentId, "wish-agent");
    assert.equal(session.scope, root);

    const first = await application.startRun({
      sessionId: session.sessionId,
      payload: { text: "first question" },
    });
    assert.equal((await first.completion).status, "completed");
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.name),
      ["read", "write", "edit", "grep"],
    );
    assert.deepEqual(requests[0].instructions, [
      { role: "system", content: "Be exact." },
    ]);

    toolRegistry.register(createBashTool());

    const second = await application.startRun({
      sessionId: session.sessionId,
      payload: { text: "read the note" },
    });
    const eventsPromise = collect(application.observeRun(second.runId));
    const secondCompletion = await second.completion;
    const events = await eventsPromise;
    assert.equal(secondCompletion.status, "completed");
    assert.equal(secondCompletion.result.output.text, "read complete");
    assert.deepEqual(
      requests[1].tools.map((tool) => tool.name),
      ["read", "write", "edit", "grep", "bash"],
    );

    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].call.name, "read");
    assert.deepEqual(
      resolvedWorkspaces.map((snapshot) => snapshot.root),
      [root, root, root],
    );
    assert.deepEqual(approvals[0].context.workspace, resolvedWorkspaces[1]);
    assert.equal(Object.isFrozen(approvals[0].context.workspace), true);
    assert.equal(
      events.some((event) =>
        event.type === "tool.lifecycle" &&
        event.payload.type === "tool.dispatched"
      ),
      true,
    );

    const secondInput = requests[1].messages;
    assert.equal(
      secondInput.filter((message) => message.content === "first answer").length,
      1,
    );
    assert.equal(
      secondInput.filter((message) => message.content === "read the note").length,
      1,
    );
    const visibleToolResult = requests[2].messages.findLast((message) =>
      message.role === "tool"
    );
    assert.ok(visibleToolResult);
    assert.match(visibleToolResult.content, /workspace value/u);

    const history = await application.readSessionHistory({
      sessionId: session.sessionId,
    });
    assert.deepEqual(
      history.records.map((record) => record.message.role),
      ["user", "assistant", "user", "assistant", "tool", "assistant"],
    );
    const toolRecord = history.records.find((record) =>
      record.kind === "message" && record.message.role === "tool"
    );
    assert.ok(toolRecord?.toolResultArchive);
    assert.equal(toolRecord.toolResultArchive.toolCallId, "read-call");
    const archived = JSON.parse(await readFile(
      join(root, "data", toolRecord.toolResultArchive.locator),
      "utf8",
    ));
    assert.equal(archived.result.callId, "read-call");
    assert.equal(archived.result.ok, true);

    assert.deepEqual(
      (await application.listSessions()).map((item) => item.sessionId),
      ["session-1"],
    );
    await assert.rejects(
      application.startRun({
        sessionId: "missing",
        payload: { text: "must not start" },
      }),
      SessionNotFoundError,
    );
    await application.archiveSession({ sessionId: session.sessionId });
    await assert.rejects(
      application.startRun({
        sessionId: session.sessionId,
        payload: { text: "must not restart" },
      }),
      SessionArchivedError,
    );
    assert.equal(requests.length, 3);
    const attempts = await attemptLedger.list({ sessionId: session.sessionId });
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((attempt) => attempt.runId), [
      "run-1",
      "run-2",
      "run-2",
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.stepId), [
      "turn-1:1",
      "turn-2:1",
      "turn-2:2",
    ]);
    assert.equal(attempts.every((attempt) => attempt.status === "completed"), true);
    assert.equal(attempts.every((attempt) => attempt.cost?.status === "unavailable"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureUsage() {
  return {
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    totalTokens: 12,
    source: "provider",
  };
}

function sse(records) {
  return new Response(records.map(({ event, data }) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  ).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicText(text) {
  return sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          model: "claude-test",
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function anthropicConfiguration() {
  return loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: "anthropic/claude-test",
      fallbackModels: [],
      maxRetries: 0,
      providers: [{
        id: "anthropic",
        protocol: "anthropic-messages",
        baseUrl: "https://anthropic.example.test/v1",
        auth: { type: "none" },
        developerRoleMode: "system-fallback",
        models: [{
          id: "claude-test",
          status: "active",
          contextWindowTokens: 50,
          maxOutputTokens: 20,
          input: { text: true, image: false },
          reasoning: false,
          toolCalling: true,
          developerRole: false,
        }],
      }],
    },
  });
}

test("recovers one Context overflow by appending a Session checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-app-compaction-"));
  try {
    let fullRequestCounts = 0;
    const modelRequests = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/messages/count_tokens")) {
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        if (hasTools) {
          fullRequestCounts += 1;
          return new Response(JSON.stringify({
            input_tokens: fullRequestCounts === 2 ? 100 : 2,
          }), { status: 200 });
        }
        const includesPriorAnswer = JSON.stringify(body.messages)
          .includes("prior answer");
        return new Response(JSON.stringify({
          input_tokens: includesPriorAnswer ? 20 : 1,
        }), { status: 200 });
      }

      modelRequests.push(body);
      const isSummary = JSON.stringify(body).includes(
        "Summarize the historical agent transcript",
      );
      if (isSummary) return anthropicText("durable checkpoint");
      return anthropicText(
        modelRequests.filter((request) =>
          !JSON.stringify(request).includes(
            "Summarize the historical agent transcript",
          )
        ).length === 1
          ? "prior answer"
          : "answer after compaction",
      );
    };
    const dataDirectory = join(root, "data");
    const sessions = createFileSessionResources(dataDirectory);
    const models = modelResources(anthropicConfiguration(), { fetch });
    let workspaceResolutions = 0;
    const resolvedWorkspaces = [];
    const workspace = {
      resolve({ root }) {
        workspaceResolutions += 1;
        const resolved = workspaceSnapshot(root);
        resolvedWorkspaces.push(resolved);
        return resolved;
      },
    };
    const permissionRequests = [];
    const permissions = {
      resolve(request) {
        permissionRequests.push(request);
        return Object.freeze({
          schemaVersion: 1,
          subject: Object.freeze({ ...request.subject }),
          profile: request.agent?.profile ?? "approval-required",
          availableTools: Object.freeze([...request.registeredTools]),
          ceiling: Object.freeze({
            allowedCapabilities: Object.freeze(["filesystem.read"]),
          }),
          workspace: Object.freeze({
            fingerprint: request.workspace.fingerprint,
            revision: request.workspace.revision,
          }),
          policyVersion: "acceptance-permissions-v1",
          authorityVersion:
            `acceptance:${request.subject.runId}:${request.subject.stepId}:${request.workspace.revision}`,
        });
      },
      authorize() {
        throw new Error("No Tool authorization expected");
      },
      revalidate() {
        throw new Error("No Tool revalidation expected");
      },
    };
    const runtime = runtimeResources({
      dataDirectory,
      sessions,
      agentId: "wish-agent",
      models,
      workspace,
      permissions,
      agentInstructions: [],
      reservedOutputTokens: 10,
      keepRecentTokens: 10,
      summaryMaxOutputTokens: 8,
    }, deterministicRuntime());
    const application = new ApplicationFacade({
      sessions,
      agent: createWishAgent({
        id: "wish-agent",
        configuration: {
          agentInstructions: [],
          permissions: { profile: "read-only" },
        },
      }, runtime),
      models,
    });
    await application.createSession({
      sessionId: "session-compact",
      workspaceRoot: root,
    });

    const first = await application.startRun({
      sessionId: "session-compact",
      payload: { text: "old question", permissionProfile: "workspace-write" },
    });
    assert.equal((await first.completion).status, "completed");
    const second = await application.startRun({
      sessionId: "session-compact",
      payload: { text: "new question" },
    });
    const completion = await second.completion;
    assert.equal(completion.status, "completed");
    assert.equal(completion.result.output.text, "answer after compaction");
    assert.equal(fullRequestCounts, 3);
    assert.equal(workspaceResolutions, 2);
    assert.equal(permissionRequests.length, 2);
    assert.deepEqual(
      permissionRequests.map((request) => request.agent?.profile),
      ["workspace-write", "read-only"],
    );
    assert.deepEqual(permissionRequests[0].workspace, resolvedWorkspaces[0]);
    assert.deepEqual(permissionRequests[1].workspace, resolvedWorkspaces[1]);
    assert.notEqual(
      permissionRequests[0].subject.runId,
      permissionRequests[1].subject.runId,
    );

    const history = await application.readSessionHistory({
      sessionId: "session-compact",
    });
    const checkpoints = history.records.filter((record) =>
      record.kind === "checkpoint"
    );
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].reason, "context_over_budget");
    assert.equal(checkpoints[0].message.content, "durable checkpoint");
    assert.equal(checkpoints[0].coveredThroughSequence, 1);
    assert.deepEqual(checkpoints[0].sourceSequences, [1]);
    assert.equal(
      history.records.filter((record) => record.message.content === "new question")
        .length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
