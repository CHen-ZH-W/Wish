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

function harness(overrides = {}, toolOptions = {}) {
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
  for (const definition of createSubagentTools({ subagents, ...toolOptions })) registry.register(definition);
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
    userTurn: Object.freeze({ runId: "run-1", userTurnId: "turn-1", ordinal: 1, inputSource: "user", provenance: Object.freeze({ origin: "run_input", source: "user", receivedAt: "2026-09-12T12:00:00.000Z" }) }),
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

test("spawn_agent links an explicit Todo item after admission without another todo_write", async () => {
  const progress = [];
  const todoProgress = {
    async validate(link) { progress.push(["validate", link]); },
    async beginDispatch(link, id) { progress.push(["begin", link, id]); },
    async bind(link, child) { progress.push(["bind", link, child.id]); },
    async finishDispatch(link, id, status) { progress.push(["finish", link, id, status]); },
  };
  const h = harness({}, { todoProgress });
  const result = await h.execute("spawn_agent", { task: "Review core", role: "reviewer", todoId: "core" });
  assert.equal(result.ok, true);
  assert.deepEqual(progress.map(item => item[0]), ["validate", "begin", "bind", "finish"]);
  assert.equal(progress[0][1].itemId, "core");
  assert.equal(progress[2][2], "child-1");
  assert.equal(progress[3][3], "completed");
  assert.equal(h.calls.filter(item => item[0] === "spawn").length, 1);
});

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
    const scopeTools = {
      registry: { list: () => [{ name: "read" }] },
      getCompositionContracts: () => new Map(),
    };
    const dispatch = new SubagentToolDispatchService(root, direct, scopeTools);
    const request = {
      task: "review", parentAgentId: "wish", parentSessionId: "session-1",
      parentRunId: "run-1", workspaceRoot: "/workspace",
    };
    const context = {
      workspace: { root: "/workspace" },
      permissions: {
        subject: { agentId: "wish", sessionId: "session-1", runId: "run-1" },
        profile: "full-access",
        availableTools: ["read"],
        ceiling: { allowedCapabilities: ["filesystem.read"] },
      },
    };
    const grant = {};
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

test("child Agent Scope is assembled before direct or Workflow dispatch", async () => {
  const root = new Context();
  const submitted = [];
  const tools = {
    registry: { list: () => ["read", "bash", "enter_plan_mode", "spawn_agent"].map(name => ({ name })) },
    getCompositionContracts: () => new Map([
      ["enter_plan_mode", { requires: ["plan.state", "human.review", "session.resume"] }],
      ["spawn_agent", { requires: ["subagents.service"] }],
    ]),
  };
  const request = {
    task: "edit", parentAgentId: "wish", parentSessionId: "session-1",
    parentRunId: "run-1", workspaceRoot: "/workspace",
  };
  const context = {
    workspace: { root: "/workspace" },
    permissions: {
      subject: { agentId: "wish", sessionId: "session-1", runId: "run-1" },
      profile: "full-access",
      availableTools: ["read", "bash", "enter_plan_mode", "spawn_agent"],
      ceiling: { allowedCapabilities: ["filesystem.read", "process.exec", "runtime.control"] },
    },
  };
  try {
    const dispatch = new SubagentToolDispatchService(root, {
      async spawn(input) { submitted.push(input); return record; },
    }, tools);
    await dispatch.dispatch(request, context, {});
    assert.deepEqual(submitted[0].availableTools, ["read", "bash"]);
    assert.deepEqual(submitted[0].allowedCapabilities,
      ["filesystem.read", "process.exec", "runtime.control"]);

    dispatch.register({ id: "workflow", active: () => true,
      async dispatch(input) { submitted.push(input); return record; } });
    await dispatch.dispatch({ ...request, permissionProfile: "workspace-write" }, context, {});
    assert.deepEqual(submitted[1].availableTools, ["read", "bash"]);
    assert.equal(submitted[1].permissionProfile, "workspace-write");

    await assert.rejects(dispatch.dispatch({ ...request,
      availableTools: ["read", "enter_plan_mode"],
    }, context, {}), /requires runtime feature\(s\): plan.state, human.review, session.resume/u);
    await assert.rejects(dispatch.dispatch({ ...request,
      availableTools: ["read", "unknown"],
    }, context, {}), /exceeds the Host delegation ceiling/u);
    await assert.rejects(dispatch.dispatch({ ...request,
      allowedCapabilities: ["network.connect"],
    }, context, {}), /exceed the Host delegation ceiling/u);
    assert.equal(submitted.length, 2);

    const reviewedRoot = new Context();
    try {
      const reviewed = new SubagentToolDispatchService(reviewedRoot, {
        async spawn(input) { submitted.push(input); return record; },
      }, tools, ["plan.state", "human.review", "session.resume"]);
      await reviewed.dispatch({ ...request, availableTools: ["read", "enter_plan_mode"] }, context, {});
      assert.deepEqual(submitted[2].availableTools, ["read", "enter_plan_mode"]);
    } finally {
      await reviewedRoot.fiber.dispose();
    }
    const localRoot = new Context();
    try {
      const local = new SubagentToolDispatchService(localRoot, {
        async spawn(input) { submitted.push(input); return record; },
      }, tools, [], role => role === "specialist" ? {
        role, localTools: [{ name: "inspect_patch", requires: [] }],
      } : undefined);
      await local.dispatch({ ...request, role: "specialist", availableTools: ["read", "inspect_patch"] }, context, {});
      assert.deepEqual(submitted[3].availableTools, ["read", "inspect_patch"]);
    } finally { await localRoot.fiber.dispose(); }
  } finally {
    await root.fiber.dispose();
  }
});

test("Subagent result relay holds the parent and resumes it with one internal result", async () => {
  let released = 0;
  const resumptions = [];
  let listener;
  const relay = new SubagentResultRelay({
    subagents: {
      subscribe(next) {
        listener = next;
        return () => { listener = undefined; };
      },
      inspect: async () => record,
    },
    maxWaitMs: 1_000,
  });
  relay.watch({
    record,
    continuation: {
      deferUserTurnCompletion(reason) {
        assert.match(reason, /reviewer result/u);
        return { reason, release() { released += 1; } };
      },
      resume(input) {
        resumptions.push(input);
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
  assert.equal(resumptions.length, 1);
  assert.equal(resumptions[0].source, "wish-subagent-result");
  assert.equal(resumptions[0].reserveCapacity, true);
  assert.equal(resumptions[0].withinUserTurn, true);
  assert.match(resumptions[0].text, /review found no issues/u);
  assert.match(resumptions[0].text, /wish-child-1:reviewer\.0/u);
  await relay.close();
});
test("Subagent result relay reports subscription failure before releasing its hold", async () => {
  let released = 0;
  const resumptions = [];
  const relay = new SubagentResultRelay({
    subagents: {
      subscribe() { throw new Error("event source unavailable"); },
    },
    maxWaitMs: 1_000,
  });
  relay.watch({
    record,
    continuation: {
      deferUserTurnCompletion(reason) {
        return { reason, release() { released += 1; } };
      },
      resume(input) {
        resumptions.push(input);
        return { accepted: true };
      },
    },
  });
  const deadline = Date.now() + 1_000;
  while (released === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(released, 1);
  assert.equal(resumptions.length, 1);
  assert.equal(resumptions[0].source, "wish-subagent-result");
  assert.match(resumptions[0].text, /event source unavailable/u);
  assert.match(resumptions[0].text, /wish-child-1:reviewer\.0/u);
  await relay.close();
});

test("Subagent result relay observes a child that settled before subscription", async () => {
  let released = 0;
  const resumptions = [];
  const completed = { ...record, status: "exited", result: {
    schemaVersion: 1, id: record.id, childSessionId: record.childSessionId,
    childRunId: record.childRunId, status: "completed", text: "already done",
    completedAt: "2026-09-12T12:00:01.000Z",
  } };
  const relay = new SubagentResultRelay({ subagents: {
    subscribe() { return () => {}; },
    inspect: async () => completed,
  }, maxWaitMs: 1_000 });
  relay.watch({ record, continuation: {
    deferUserTurnCompletion(reason) { return { reason, release() { released++; } }; },
    resume(input) { resumptions.push(input); return { accepted: true }; },
  } });
  const deadline = Date.now() + 1_000;
  while (released === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(released, 1);
  assert.equal(resumptions.length, 1);
  assert.match(resumptions[0].text, /already done/u);
  await relay.close();
});
