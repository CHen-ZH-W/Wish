import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { SubagentNotRunningError } from "../dist/subagents/index.js";
import {
  createSubagentTools,
  SubagentToolDispatchService,
  SubagentResultRelay,
  SUBAGENT_TOOL_NAMES,
} from "../dist/subagents/consumers/model-tools/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const target = Object.freeze({
  providerId: "tmux",
  id: "child-1",
  target: "wish-child-1:reviewer.0",
  attachCommand: "tmux -S /tmp/wish.sock attach-session -t wish-child-1",
  captureCommand: "tmux -S /tmp/wish.sock capture-pane -p -t wish-child-1:reviewer.0",
  locator: Object.freeze({
    sessionId: "child-1",
    session: "wish-child-1",
    window: "reviewer",
    pane: "%1",
    target: "wish-child-1:reviewer.0",
    socketPath: "/tmp/wish.sock",
  }),
});

const record = Object.freeze({
  schemaVersion: 1,
  id: "child-1",
  parentAgentId: "wish",
  parentSessionId: "session-1",
  parentRunId: "run-1",
  childSessionId: "subagent-child-1",
  childRunId: "subagent-run-child-1",
  workspaceRoot: "/workspace",
  role: "reviewer",
  task: "Review the change",
  status: "running",
  target,
  createdAt: "2026-09-12T12:00:00.000Z",
  updatedAt: "2026-09-12T12:00:00.000Z",
});

const modelsConfiguration = Object.freeze({
  schemaVersion: 1,
  providers: Object.freeze([]),
  defaultModel: Object.freeze({ provider: "fixture", model: "primary" }),
  fallbackModels: Object.freeze([]),
  maxRetries: 0,
});

function harness(overrides = {}) {
  const calls = [];
  const subagents = {
    async spawn(request) { calls.push(["spawn", request]); return record; },
    async list(request) { calls.push(["list", request]); return [record]; },
    async inspect() { return record; },
    async capture(request) { calls.push(["capture", request]); return "terminal output"; },
    async send(request) { calls.push(["send", request]); },
    async stop(request) { calls.push(["stop", request]); return { ...record, status: "stopped" }; },
    async collect(request) { calls.push(["collect", request]); return { record, output: "done" }; },
    subscribe() { return () => {}; },
    async close() {},
    ...overrides,
  };
  const registry = new ToolRegistry();
  for (const definition of createSubagentTools({ subagents })) registry.register(definition);
  const authorizations = [];
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize(input) {
        authorizations.push(input);
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() { return { status: "valid", policyVersion: "policy-1" }; },
    },
    grantId: (() => {
      let id = 0;
      return () => `grant-${++id}`;
    })(),
  });
  const context = Object.freeze({
    cwd: "/workspace",
    workspace: Object.freeze({
      requestedRoot: "/workspace",
      root: "/workspace",
      fingerprint: "workspace-1",
      revision: "workspace-revision-1",
      instructions: Object.freeze([]),
    }),
    permissions: Object.freeze({
      schemaVersion: 1,
      subject: Object.freeze({
        agentId: "wish",
        sessionId: "session-1",
        runId: "run-1",
        userTurnId: "turn-1",
        stepId: "step-1",
      }),
      profile: "full-access",
      availableTools: SUBAGENT_TOOL_NAMES,
      ceiling: Object.freeze({ allowedCapabilities: ["runtime.read", "runtime.control"] }),
      workspace: Object.freeze({ fingerprint: "workspace-1", revision: "workspace-revision-1" }),
      filesystemPolicyVersion: "filesystem-1",
      shellPolicyVersion: "shell-1",
      sandboxPolicyVersion: "sandbox-1",
      policyVersion: "policy-1",
      authorityVersion: "authority-1",
    }),
    modelContext: Object.freeze({
      ref: modelsConfiguration.defaultModel,
      configuration: modelsConfiguration,
    }),
  });
  async function execute(name, input) {
    const parsed = registry.parseCall({ id: `call-${name}`, name, argumentsJson: JSON.stringify(input) });
    return executor.execute({
      call: parsed.call,
      context,
      scope: { runId: "run-1", userTurnId: "turn-1", stepId: "step-1" },
      snapshot: registry.captureSnapshot({
        authorityVersion: "authority-1",
        availableTools: SUBAGENT_TOOL_NAMES,
      }),
    });
  }
  return { registry, execute, calls, authorizations };
}

test("the model Tool Consumer is owned by Subagents and absent from Tools and Core", async () => {
  await assert.rejects(
    access(join(repositoryRoot, "src", "tools", "subagents")),
    (error) => error?.code === "ENOENT",
  );
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports["./tools/subagents"], undefined);
  assert.notEqual(manifest.exports["./subagents/model-tools"], undefined);
  for (const path of [
    join(repositoryRoot, "src", "tools", "index.ts"),
    join(repositoryRoot, "src", "core", "runtime", "runtime.ts"),
  ]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /subagent/iu);
  }
});

test("spawn_agent derives parent and workspace identity from the immutable Step context", async () => {
  const fixture = harness();
  const result = await fixture.execute("spawn_agent", {
    task: "Review the change",
    role: "reviewer",
    permissionProfile: "read-only",
    availableTools: ["read", "grep"],
  });
  assert.equal(result.ok, true);
  assert.equal(fixture.calls[0][1].parentAgentId, "wish");
  assert.equal(fixture.calls[0][1].parentSessionId, "session-1");
  assert.equal(fixture.calls[0][1].parentRunId, "run-1");
  assert.equal(fixture.calls[0][1].workspaceRoot, "/workspace");
  for (const [, request] of fixture.calls) {
    assert.equal(request.parentAgentId, "wish");
    assert.equal(request.parentSessionId, "session-1");
    assert.equal(request.parentRunId, "run-1");
    assert.equal(request.workspaceRoot, "/workspace");
  }
  assert.equal(fixture.calls[0][1].model, "fixture/primary");
  assert.equal(fixture.calls[0][1].modelsConfiguration, modelsConfiguration);
  assert.deepEqual(result.output.agent.target, target);
  assert.match(result.output.content[0].text, /Attach: tmux/u);
  assert.deepEqual(fixture.authorizations[0].capabilities.requirements, [{
    capability: "runtime.control",
    resources: ["subagents.spawn:reviewer"],
  }]);
});

test("read and control tools use narrow capabilities and the current parent filter", async () => {
  const fixture = harness();
  const listed = await fixture.execute("list_agents", { status: "running" });
  const captured = await fixture.execute("capture_agent", { id: "child-1", lines: 10 });
  const sent = await fixture.execute("send_agent", { id: "child-1", text: "continue" });
  const stopped = await fixture.execute("stop_agent", { id: "child-1" });
  const collected = await fixture.execute("collect_agent", { id: "child-1" });

  for (const result of [listed, captured, sent, stopped, collected]) assert.equal(result.ok, true);
  assert.equal(fixture.calls[0][1].parentRunId, "run-1");
  assert.equal(fixture.calls[0][1].workspaceRoot, "/workspace");
  assert.equal(captured.output.content[0].text, "terminal output");
  assert.equal(collected.output.agent.id, "child-1");
  assert.deepEqual(
    fixture.authorizations.map((input) => input.capabilities.requirements[0].capability),
    ["runtime.read", "runtime.read", "runtime.control", "runtime.control", "runtime.read"],
  );
});

test("Subagent Tool parsing and service failures remain stable Tool failures", async () => {
  const fixture = harness({
    async send() { throw new SubagentNotRunningError("child-1"); },
  });
  const invalid = await fixture.execute("spawn_agent", { task: "ok", permissionProfile: "root" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_input");

  const failed = await fixture.execute("send_agent", { id: "child-1", text: "late" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "conflict");
  assert.match(failed.error.message, /not running/u);
});

test("the stable dispatch port switches committed scheduler strategies without replacing Tools", async () => {
  const root = new Context();
  const calls = [];
  const direct = { async spawn() { calls.push("direct"); return record; } };
  try {
    const dispatch = new SubagentToolDispatchService(root, direct);
    const request = { task: "review" }, context = {}, grant = {};
    assert.equal(dispatch.activeStrategy, "direct");
    assert.equal(await dispatch.dispatch(request, context, grant), record);

    let oldActive = true, successorActive = false;
    const removeOld = dispatch.register({ id: "workflow", active: () => oldActive,
      async dispatch() { calls.push("workflow-old"); return { content: [] }; } });
    const removeSuccessor = dispatch.register({ id: "workflow", active: () => successorActive,
      async dispatch() { calls.push("workflow-new"); return { content: [] }; } });
    assert.equal(dispatch.activeStrategy, "workflow");
    await dispatch.dispatch(request, context, grant);
    successorActive = true;
    await dispatch.dispatch(request, context, grant);
    removeSuccessor();
    await dispatch.dispatch(request, context, grant);
    oldActive = false;
    await dispatch.dispatch(request, context, grant);
    removeOld();
    assert.deepEqual(calls, ["direct", "workflow-old", "workflow-new", "workflow-old", "direct"]);
  } finally { await root.fiber.dispose(); }
});

test("Subagent result relay holds the parent and injects one structured follow-up", async () => {
  let released = 0;
  const followUps = [];
  let listener;
  const relay = new SubagentResultRelay({
    subagents: {
      subscribe(next) {
        listener = next;
        return () => { listener = undefined; };
      },
    },
    maxWaitMs: 1_000,
  });
  relay.watch({
    record,
    continuation: {
      deferCompletion(reason) {
        assert.match(reason, /reviewer result/u);
        return { reason, release() { released += 1; } };
      },
      followUp(input) {
        followUps.push(input);
        return { accepted: true };
      },
    },
  });
  listener({
    type: "subagent.updated",
    occurredAt: "2026-09-12T12:00:01.000Z",
    record: {
      ...record,
      status: "exited",
      result: {
        schemaVersion: 1,
        id: record.id,
        childSessionId: record.childSessionId,
        childRunId: record.childRunId,
        status: "completed",
        text: "review found no issues",
        completedAt: "2026-09-12T12:00:01.000Z",
      },
    },
  });
  const deadline = Date.now() + 1_000;
  while (released === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(released, 1);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].source, "wish-subagent-result");
  assert.equal(followUps[0].reserveCapacity, true);
  assert.match(followUps[0].text, /review found no issues/u);
  assert.match(followUps[0].text, /wish-child-1:reviewer\.0/u);
  await relay.close();
});

test("Subagent result relay reports subscription failure before releasing its hold", async () => {
  let released = 0;
  const followUps = [];
  const relay = new SubagentResultRelay({
    subagents: {
      subscribe() { throw new Error("event source unavailable"); },
    },
    maxWaitMs: 1_000,
  });
  relay.watch({
    record,
    continuation: {
      deferCompletion(reason) {
        return { reason, release() { released += 1; } };
      },
      followUp(input) {
        followUps.push(input);
        return { accepted: true };
      },
    },
  });
  const deadline = Date.now() + 1_000;
  while (released === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(released, 1);
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].source, "wish-subagent-result");
  assert.match(followUps[0].text, /event source unavailable/u);
  assert.match(followUps[0].text, /wish-child-1:reviewer\.0/u);
  await relay.close();
});
