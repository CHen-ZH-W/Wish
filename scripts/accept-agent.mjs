import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "../dist/core/agent/agent.js";

function createRuntime(overrides = {}) {
  const calls = {
    startRun: [],
    control: [],
    observe: [],
  };
  const runtime = {
    startRun(definition, input) {
      calls.startRun.push({ definition, input });
      return {
        agentId: definition.id,
        runId: input.runId ?? "run-generated",
        initialUserTurnId: "turn-initial",
        scope: input.scope,
        completion: Promise.resolve({ status: "completed" }),
      };
    },
    control(agentId, runId, control) {
      calls.control.push({ agentId, runId, control });
      return { accepted: true };
    },
    observe(agentId, runId, options) {
      calls.observe.push({ agentId, runId, options });
      return (async function* output() {
        yield { type: "run.started", runId };
      })();
    },
    ...overrides,
  };
  return { calls, runtime };
}

test("startRun snapshots public DTOs without interpreting their meaning", async () => {
  const { calls, runtime } = createRuntime();
  const configuration = {
    model: "logical-model",
    routing: { candidates: ["primary", "fallback"] },
  };
  const definitionMetadata = { owner: { team: "core" } };
  const payload = { content: { text: "hello" }, attachments: ["a"] };
  const inputMetadata = { transport: { channel: "test" } };
  const agent = new Agent(
    { id: "coding-agent", configuration, metadata: definitionMetadata },
    runtime,
  );

  const handle = agent.startRun({
    scope: "  conversation:1  ",
    payload,
    runId: "run-requested",
    metadata: inputMetadata,
  });

  assert.equal(handle.runId, "run-requested");
  assert.equal(handle.scope, "conversation:1");
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(calls.startRun.length, 1);
  assert.equal(calls.startRun[0].definition, agent.definition);
  assert.notEqual(calls.startRun[0].input.payload, payload);
  assert.deepEqual(calls.startRun[0].input.payload, payload);
  assert.equal(calls.startRun[0].input.scope, "conversation:1");
  assert.notEqual(agent.definition.configuration, configuration);
  assert.deepEqual(agent.definition.configuration, configuration);
  assert.equal(Object.isFrozen(agent.definition), true);
  assert.equal(Object.isFrozen(agent.definition.configuration), true);
  assert.equal(Object.isFrozen(agent.definition.configuration.routing), true);
  assert.equal(
    Object.isFrozen(agent.definition.configuration.routing.candidates),
    true,
  );
  assert.equal(Object.isFrozen(agent.definition.metadata.owner), true);
  assert.equal(Object.isFrozen(calls.startRun[0].input), true);
  assert.equal(Object.isFrozen(calls.startRun[0].input.payload.content), true);
  assert.equal(Object.isFrozen(calls.startRun[0].input.payload.attachments), true);
  assert.equal(Object.isFrozen(calls.startRun[0].input.metadata.transport), true);

  configuration.routing.candidates.push("later");
  definitionMetadata.owner.team = "changed";
  payload.content.text = "changed";
  payload.attachments.push("b");
  inputMetadata.transport.channel = "changed";

  assert.deepEqual(agent.definition.configuration, {
    model: "logical-model",
    routing: { candidates: ["primary", "fallback"] },
  });
  assert.deepEqual(agent.definition.metadata, { owner: { team: "core" } });
  assert.deepEqual(calls.startRun[0].input.payload, {
    content: { text: "hello" },
    attachments: ["a"],
  });
  assert.deepEqual(calls.startRun[0].input.metadata, {
    transport: { channel: "test" },
  });
  assert.deepEqual(await handle.completion, { status: "completed" });
});

test("public DTO snapshots leave caller-owned inputs mutable", () => {
  const { runtime } = createRuntime();
  const configuration = { nested: { enabled: true } };
  const payload = { values: [1, 2] };
  const agent = new Agent({ id: "coding-agent", configuration }, runtime);

  agent.startRun({ scope: "scope", payload });

  assert.equal(Object.isFrozen(configuration), false);
  assert.equal(Object.isFrozen(configuration.nested), false);
  assert.equal(Object.isFrozen(payload), false);
  assert.equal(Object.isFrozen(payload.values), false);
});

test("control delegates the Agent identity, Run identity, and exact command", () => {
  const { calls, runtime } = createRuntime();
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const command = { type: "steer", text: "new constraint" };

  const receipt = agent.control("run-1", command);

  assert.deepEqual(receipt, { accepted: true });
  assert.deepEqual(calls.control, [
    { agentId: "coding-agent", runId: "run-1", control: command },
  ]);
});

test("observe delegates attachment and does not turn observation into control", async () => {
  const { calls, runtime } = createRuntime();
  const agent = new Agent({ id: "coding-agent" }, runtime);
  const options = { afterSequence: 3 };

  const events = [];
  for await (const event of agent.observe("run-1", options)) {
    events.push(event);
  }

  assert.deepEqual(events, [{ type: "run.started", runId: "run-1" }]);
  assert.deepEqual(calls.observe, [
    { agentId: "coding-agent", runId: "run-1", options },
  ]);
  assert.equal(calls.control.length, 0);
});

test("public boundary rejects ambiguous identities, scopes, and cursors", () => {
  const { runtime } = createRuntime();

  assert.throws(
    () => new Agent({ id: "  " }, runtime),
    /Agent definition id must not be empty/u,
  );

  const agent = new Agent({ id: "coding-agent" }, runtime);
  assert.throws(
    () => agent.startRun({ scope: "  ", payload: null }),
    /Run scope must not be empty/u,
  );
  assert.throws(
    () => agent.startRun({ scope: "scope", payload: null, runId: " run-1" }),
    /Run id must not have leading or trailing whitespace/u,
  );
  assert.throws(
    () => agent.control(" ", { type: "abort" }),
    /Run id must not be empty/u,
  );
  assert.throws(
    () => agent.observe("run-1", { afterSequence: -1 }),
    /afterSequence must be a non-negative safe integer/u,
  );
});

test("Runtime errors and receipts are not swallowed or rewritten", () => {
  const expected = new Error("scope already active");
  const { runtime } = createRuntime({
    startRun() {
      throw expected;
    },
  });
  const agent = new Agent({ id: "coding-agent" }, runtime);

  assert.throws(
    () => agent.startRun({ scope: "conversation:1", payload: "hello" }),
    (error) => error === expected,
  );
});
