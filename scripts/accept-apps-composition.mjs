import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApplicationFacade } from "../dist/apps/application.js";
import { createWishAgent } from "../dist/core/agent/service.js";
import { createAgentLoopPipeline } from "../dist/core/agent-loop/service.js";
import { createWishRuntime } from "../dist/core/runtime/service.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import {
  createDefaultModelAdapterRegistry,
  ModelAdapterRegistry,
} from "../dist/models/registry.js";
import { createConfiguredModelResources } from "../dist/models/runtime.js";
import { TokenizerUsageEstimator } from "../dist/models/usage.js";
import { createContextResources } from "../dist/context/service.js";
import { createCompactionResources } from "../dist/compaction/service.js";
import { ToolRegistry } from "../dist/core/tools/scheduler.js";
import {
  createFileSessionResources,
  SessionArchivedError,
  SessionNotFoundError,
} from "../dist/sessions/index.js";
import {
  registerBasicTools,
} from "../dist/tools/index.js";
import { createBashTool } from "../dist/tools/basic/bash.js";

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

function modelResources(configuration, options = {}) {
  return createConfiguredModelResources({
    configuration,
    registry: options.registry ?? createDefaultModelAdapterRegistry(),
    usageEstimator: new TokenizerUsageEstimator(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function agentLoopResources(options) {
  const context = createContextResources({
    dataDirectory: options.dataDirectory,
    sessions: options.sessions,
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
    const adapters = new ModelAdapterRegistry();
    adapters.register("fixture-protocol", () => ({
      async *stream(request) {
        requests.push(request);
        yield { type: "start", model: request.model };
        if (requests.length === 1) {
          yield { type: "text_delta", text: "first answer" };
          yield { type: "done", finishReason: "stop" };
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
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "read complete" };
        yield { type: "done", finishReason: "stop" };
      },
    }));
    const approvals = [];
    const resolvedSessions = [];
    const toolRegistry = new ToolRegistry();
    const registrations = registerBasicTools(toolRegistry);
    const dataDirectory = join(root, "data");
    const sessions = createFileSessionResources(dataDirectory);
    const models = modelResources(fixtureConfiguration(), {
      registry: adapters,
      fetch: async () => new Response(),
    });
    const agentInstructions = [{
      id: "agent-base",
      authority: "system",
      content: "Be exact.",
    }];
    const workspace = {
      resolve({ session }) {
        resolvedSessions.push(session.sessionId);
        return {
          cwd: session.scope,
          instructions: [{
            id: "workspace",
            authority: "developer",
            content: "Stay in the workspace.",
          }],
        };
      },
    };
    const runtime = runtimeResources({
      dataDirectory,
      sessions,
      agentId: "wish-agent",
      models,
      workspace,
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
    }, { ...deterministicRuntime(), maxSteps: 4 });
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
    assert.deepEqual(resolvedSessions, ["session-1", "session-1", "session-1"]);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const workspace = {
      resolve({ session }) {
        return { cwd: session.scope, instructions: [] };
      },
    };
    const runtime = runtimeResources({
      dataDirectory,
      sessions,
      agentId: "wish-agent",
      models,
      workspace,
      agentInstructions: [],
      reservedOutputTokens: 10,
      keepRecentTokens: 10,
      summaryMaxOutputTokens: 8,
    }, { ...deterministicRuntime(), maxSteps: 2 });
    const application = new ApplicationFacade({
      sessions,
      agent: createWishAgent({
        id: "wish-agent",
        configuration: { agentInstructions: [] },
      }, runtime),
      models,
    });
    await application.createSession({
      sessionId: "session-compact",
      workspaceRoot: root,
    });

    const first = await application.startRun({
      sessionId: "session-compact",
      payload: { text: "old question" },
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
