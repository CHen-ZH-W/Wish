import assert from "node:assert/strict";
import {
  BoundedToolScheduler,
  ToolExecutor,
  ToolRegistry,
  assertActiveToolAuthorizationGrant,
} from "../dist/core/tools/scheduler.js";
import { withActiveToolAuthorizationGrant } from "../dist/core/tools/authorization.js";

const tests = [];
const test = (name, execute) => tests.push({ name, execute });
const scope = Object.freeze({
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
});

function allowedAuthorization(overrides = {}) {
  return {
    authorize: overrides.authorize ?? (() => ({
      status: "allowed",
      policyVersion: "policy-1",
    })),
    revalidate: overrides.revalidate ?? (() => ({
      status: "valid",
      policyVersion: "policy-1",
    })),
  };
}

function executor(registry, authorization = allowedAuthorization(), options = {}) {
  let nextGrant = 0;
  return new ToolExecutor({
    registry,
    authorization,
    grantId: () => `grant-${++nextGrant}`,
    ...options,
  });
}

function ready(id, name, input) {
  return Object.freeze({ status: "ready", id, name, input });
}

function simpleDefinition(name, overrides = {}) {
  return {
    name,
    description: `Execute ${name}`,
    inputSchemaJson: '{"type":"object"}',
    executionMode: "parallel",
    parse(input) {
      return { ok: true, input };
    },
    resolveCapabilities() {
      return { requirements: [] };
    },
    execute(input) {
      return input;
    },
    ...overrides,
  };
}

test("Registry preserves registration order, uniqueness, snapshots, and disposal", () => {
  const registry = new ToolRegistry();
  const first = registry.register(simpleDefinition("first", {
    recoveryPolicy: "retry-safe",
  }));
  registry.register(simpleDefinition("second", { executionMode: "sequential" }));

  assert.deepEqual(registry.list().map((item) => item.name), ["first", "second"]);
  assert.equal(registry.list()[0].recoveryPolicy, "retry-safe");
  assert.equal(registry.list()[1].recoveryPolicy, "needs-reconciliation");
  assert.equal(Object.isFrozen(registry.list()[0]), true);
  assert.throws(
    () => registry.register(simpleDefinition("first")),
    /already registered/u,
  );

  const snapshot = registry.captureSnapshot({
    authorityVersion: "authority-1",
    availableTools: ["second"],
    metadata: { mode: "execute" },
  });
  assert.equal(snapshot.registryVersion, 2);
  assert.deepEqual(snapshot.availableTools, ["second"]);
  assert.deepEqual(registry.listForSnapshot(snapshot).map((item) => item.name), [
    "second",
  ]);
  assert.equal(Object.isFrozen(snapshot.metadata), true);
  assert.throws(
    () => registry.captureSnapshot({
      authorityVersion: "authority-1",
      availableTools: ["missing"],
    }),
    /not registered/u,
  );

  assert.equal(first.unregister(), true);
  assert.equal(first.unregister(), false);
  assert.equal(registry.version, 3);
  assert.deepEqual(registry.list().map((item) => item.name), ["second"]);
});

test("Registry turns model arguments and typed validation failures into stable calls", () => {
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", {
    parse(input) {
      return typeof input.path === "string"
        ? { ok: true, input: { path: input.path } }
        : { ok: false, message: "path is required" };
    },
  }));

  const parsed = registry.parseCall({
    id: "call-1",
    name: "read",
    argumentsJson: '{"path":"README.md"}',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.call.status, "ready");
  assert.equal(parsed.call.input.path, "README.md");
  assert.equal(Object.isFrozen(parsed.call.input), true);

  const cases = [
    registry.parseCall({ id: "bad-json", name: "read", argumentsJson: "{" }),
    registry.parseCall({ id: "array", name: "read", argumentsJson: "[]" }),
    registry.parseCall({ id: "invalid", name: "read", argumentsJson: "{}" }),
    registry.parseCall({ id: "missing", name: "missing", argumentsJson: "{}" }),
  ];
  assert.deepEqual(cases.map((item) => item.ok), [false, false, false, false]);
  assert.deepEqual(cases.map((item) => item.call.status), [
    "invalid",
    "invalid",
    "invalid",
    "invalid",
  ]);
  assert.equal(cases.at(-1).call.error.code, "not_found");
});

test("Executor owns prepare, authorization, recheck, Grant, dispatch, and finish order", async () => {
  const order = [];
  const events = [];
  let seenGrant;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", {
    resolveCapabilities(input) {
      order.push("capabilities");
      return {
        requirements: [{ capability: "filesystem.read", paths: [input.path] }],
      };
    },
    execute(input, _context, grant) {
      order.push("execute");
      seenGrant = grant;
      assertActiveToolAuthorizationGrant(grant, {
        callId: "call-1",
        toolName: "read",
        policyVersion: "policy-1",
        authorityVersion: "authority-1",
        registryVersion: 1,
      });
      return { content: input.path };
    },
  }));
  const tools = executor(
    registry,
    allowedAuthorization({
      authorize(input) {
        order.push("authorize");
        assert.equal(Object.isFrozen(input.capabilities), true);
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        order.push("revalidate");
        return { status: "valid", policyVersion: "policy-1" };
      },
    }),
    {
      lifecycle: {
        prepare() {
          order.push("prepare");
        },
        markDispatched() {
          order.push("markDispatched");
        },
        finish(input) {
          order.push(`finish:${input.result.ok}`);
        },
      },
      events: {
        publish(event) {
          events.push(event.type);
        },
      },
    },
  );

  const result = await tools.execute({
    call: ready("call-1", "read", { path: "README.md" }),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { content: "README.md" });
  assert.deepEqual(order, [
    "prepare",
    "capabilities",
    "authorize",
    "revalidate",
    "markDispatched",
    "execute",
    "finish:true",
  ]);
  assert.deepEqual(events, [
    "tool.prepared",
    "tool.authorization_requested",
    "tool.dispatched",
    "tool.completed",
  ]);
  assert.throws(
    () => assertActiveToolAuthorizationGrant(seenGrant),
    /not active/u,
  );
  await assert.rejects(
    withActiveToolAuthorizationGrant(seenGrant, async () => undefined),
    /cannot be reused/u,
  );
  await assert.rejects(
    withActiveToolAuthorizationGrant(
      { ...seenGrant, grantId: "fabricated" },
      async () => undefined,
    ),
    /not issued by Core/u,
  );
});

test("Authorization denial finishes the call without dispatching it", async () => {
  let executed = false;
  let revalidated = false;
  const events = [];
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("write", {
    execute() {
      executed = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization({
    authorize() {
      return { status: "denied", reason: "write is not allowed" };
    },
    revalidate() {
      revalidated = true;
      return { status: "valid", policyVersion: "policy-1" };
    },
  }), {
    events: { publish: (event) => events.push(event.type) },
  });

  const result = await tools.execute({
    call: ready("call-1", "write", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(executed, false);
  assert.equal(revalidated, false);
  assert.deepEqual(events, [
    "tool.prepared",
    "tool.authorization_requested",
    "tool.authorization_denied",
    "tool.failed",
  ]);
});

test("Policy changes during authorization fail closed before Grant issuance", async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("bash", {
    execute() {
      executed = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization({
    revalidate() {
      return { status: "valid", policyVersion: "policy-2" };
    },
  }));

  const result = await tools.execute({
    call: ready("call-1", "bash", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /became stale/u);
  assert.equal(executed, false);
});

test("Registry replacement while authorization waits invalidates the call", async () => {
  let authorizationStarted = false;
  let originalExecuted = false;
  let replacementExecuted = false;
  let dispatched = false;
  const approval = deferred();
  const registry = new ToolRegistry();
  const registration = registry.register(simpleDefinition("write", {
    execute() {
      originalExecuted = true;
    },
  }));
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const tools = executor(registry, allowedAuthorization({
    authorize() {
      authorizationStarted = true;
      return approval.promise;
    },
  }), {
    lifecycle: {
      prepare() {},
      markDispatched() {
        dispatched = true;
      },
      finish() {},
    },
  });
  const execution = tools.execute({
    call: ready("call-1", "write", {}),
    context: {},
    scope,
    snapshot,
  });

  await until(() => authorizationStarted);
  assert.equal(registration.unregister(), true);
  registry.register(simpleDefinition("write", {
    execute() {
      replacementExecuted = true;
    },
  }));
  approval.resolve({ status: "allowed", policyVersion: "policy-1" });

  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /registry changed/u);
  assert.equal(dispatched, false);
  assert.equal(originalExecuted, false);
  assert.equal(replacementExecuted, false);
});

test("Registry replacement after Grant issuance still cannot execute", async () => {
  let originalExecuted = false;
  let replacementExecuted = false;
  const registry = new ToolRegistry();
  const registration = registry.register(simpleDefinition("write", {
    execute() {
      originalExecuted = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization(), {
    events: {
      publish(event) {
        if (event.type !== "tool.dispatched") return;
        assert.equal(registration.unregister(), true);
        registry.register(simpleDefinition("write", {
          execute() {
            replacementExecuted = true;
          },
        }));
      },
    },
  });

  const result = await tools.execute({
    call: ready("call-1", "write", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(result.phase, "dispatched");
  assert.match(result.error.message, /registry changed/u);
  assert.equal(originalExecuted, false);
  assert.equal(replacementExecuted, false);
});

test("Tool events, Grant timestamps, and expiry checks share one clock", async () => {
  const epochMs = Date.parse("2000-01-01T00:00:00.000Z");
  const occurredAt = [];
  let seenGrant;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", {
    execute(_input, _context, grant) {
      seenGrant = grant;
      assertActiveToolAuthorizationGrant(grant);
      return "ok";
    },
  }));
  const tools = executor(registry, allowedAuthorization(), {
    clock: {
      now() {
        return new Date(epochMs);
      },
    },
    grantTtlMs: 1_000,
    events: {
      publish(event) {
        occurredAt.push(event.occurredAt);
      },
    },
  });

  const result = await tools.execute({
    call: ready("call-1", "read", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });

  assert.equal(result.ok, true);
  assert.equal(seenGrant.issuedAt, "2000-01-01T00:00:00.000Z");
  assert.equal(seenGrant.expiresAt, "2000-01-01T00:00:01.000Z");
  assert.deepEqual(
    occurredAt,
    Array.from({ length: occurredAt.length }, () => "2000-01-01T00:00:00.000Z"),
  );
});

test("Grant expiry follows the injected clock before concrete execution", async () => {
  let epochMs = Date.parse("2000-01-01T00:00:00.000Z");
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("write", {
    execute() {
      executed = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization(), {
    clock: {
      now() {
        return new Date(epochMs);
      },
    },
    grantTtlMs: 1_000,
    lifecycle: {
      prepare() {},
      markDispatched() {
        epochMs += 1_000;
      },
      finish() {},
    },
  });

  const result = await tools.execute({
    call: ready("call-1", "write", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /has expired/u);
  assert.equal(executed, false);
});

test("A Registry change invalidates an already captured Step snapshot", async () => {
  let authorized = false;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read"));
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  registry.register(simpleDefinition("grep"));
  const tools = executor(registry, allowedAuthorization({
    authorize() {
      authorized = true;
      return { status: "allowed", policyVersion: "policy-1" };
    },
  }));

  const result = await tools.execute({
    call: ready("call-1", "read", {}),
    context: {},
    scope,
    snapshot,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /registry changed/u);
  assert.equal(authorized, false);
});

test("Abort before dispatch returns a result without asking policy or executing", async () => {
  let authorized = false;
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", {
    execute() {
      executed = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization({
    authorize() {
      authorized = true;
      return { status: "allowed", policyVersion: "policy-1" };
    },
  }));
  const controller = new AbortController();
  controller.abort("user_stop");

  const result = await tools.execute({
    call: ready("call-1", "read", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "aborted");
  assert.equal(result.error.message, "user_stop");
  assert.equal(authorized, false);
  assert.equal(executed, false);
});

test("Authoritative dispatch lifecycle failure prevents concrete execution", async () => {
  let executed = false;
  let finished = false;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("write", {
    execute() {
      executed = true;
    },
  }));
  const tools = executor(registry, allowedAuthorization(), {
    lifecycle: {
      prepare() {},
      markDispatched() {
        throw new Error("journal unavailable");
      },
      finish() {
        finished = true;
      },
    },
  });

  const result = await tools.execute({
    call: ready("call-1", "write", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "execution_failed");
  assert.match(result.error.message, /journal unavailable/u);
  assert.equal(executed, false);
  assert.equal(finished, true);
});

test("Scheduler enforces its parallel bound, serial barriers, and result order", async () => {
  const starts = [];
  const finishes = [];
  const gates = new Map();
  let active = 0;
  let maxActive = 0;
  const run = async (input) => {
    starts.push(input.label);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gates.get(input.label).promise;
    active -= 1;
    finishes.push(input.label);
    return input.label;
  };
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("parallel", { execute: run }));
  registry.register(simpleDefinition("serial", {
    executionMode: "sequential",
    execute: run,
  }));
  for (const label of ["p1", "p2", "serial", "p3"]) {
    gates.set(label, deferred());
  }
  const scheduler = new BoundedToolScheduler({
    executor: executor(registry),
    maxParallelCalls: 2,
  });
  const session = scheduler.begin({
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  session.submit(ready("1", "parallel", { label: "p1" }));
  session.submit(ready("2", "parallel", { label: "p2" }));
  session.submit(ready("3", "serial", { label: "serial" }));
  session.submit(ready("4", "parallel", { label: "p3" }));
  const completion = session.close();

  await until(() => starts.length === 2);
  assert.deepEqual(starts, ["p1", "p2"]);
  gates.get("p2").resolve();
  await until(() => finishes.includes("p2"));
  assert.deepEqual(starts, ["p1", "p2"]);
  gates.get("p1").resolve();
  await until(() => starts.includes("serial"));
  assert.deepEqual(starts, ["p1", "p2", "serial"]);
  gates.get("serial").resolve();
  await until(() => starts.includes("p3"));
  gates.get("p3").resolve();

  const results = await completion;
  assert.equal(maxActive, 2);
  assert.deepEqual(finishes, ["p2", "p1", "serial", "p3"]);
  assert.deepEqual(results.map((result) => result.output), [
    "p1",
    "p2",
    "serial",
    "p3",
  ]);
});

test("Scheduler stops concrete dispatch after abort but returns every result", async () => {
  const started = [];
  const first = deferred();
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("work", {
    async execute(input) {
      started.push(input.label);
      if (input.label === "first") await first.promise;
      return input.label;
    },
  }));
  const scheduler = new BoundedToolScheduler({
    executor: executor(registry),
    maxParallelCalls: 1,
  });
  const controller = new AbortController();
  const session = scheduler.begin({
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
    signal: controller.signal,
  });
  session.submit(ready("1", "work", { label: "first" }));
  session.submit(ready("2", "work", { label: "second" }));
  const completion = session.close();
  await until(() => started.length === 1);
  controller.abort("stop");
  first.resolve();

  const results = await completion;
  assert.deepEqual(started, ["first"]);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, "aborted");
});

test("Scheduler returns invalid, duplicate, and missing calls without omission", async () => {
  let executed = 0;
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("tool", {
    execute() {
      executed += 1;
      return "ok";
    },
  }));
  const invalid = registry.parseCall({
    id: "bad",
    name: "tool",
    argumentsJson: "[]",
  }).call;
  const calls = [
    invalid,
    ready("same", "tool", {}),
    ready("same", "tool", {}),
    ready("missing", "missing", {}),
  ];
  const scheduler = new BoundedToolScheduler({ executor: executor(registry) });
  const results = await scheduler.schedule({
    calls,
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });

  assert.equal(results.length, calls.length);
  assert.deepEqual(results.map((result) => result.ok), [false, true, false, false]);
  assert.deepEqual(results.map((result) => result.callId), [
    "bad",
    "same",
    "same",
    "missing",
  ]);
  assert.equal(results[0].error.code, "invalid_input");
  assert.equal(results[2].error.code, "invalid_input");
  assert.equal(results[3].error.code, "not_found");
  assert.equal(executed, 1);
});

test("Scheduler and Executor publish one ordered Tool lifecycle", async () => {
  const events = [];
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", { execute: () => "done" }));
  const tools = executor(registry, allowedAuthorization(), {
    events: { publish: (event) => events.push(event.type) },
  });
  const scheduler = new BoundedToolScheduler({ executor: tools });
  const results = await scheduler.schedule({
    calls: [ready("call-1", "read", {})],
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  assert.equal(results[0].ok, true);
  assert.deepEqual(events, [
    "tool.queued",
    "tool.prepared",
    "tool.authorization_requested",
    "tool.dispatched",
    "tool.completed",
  ]);
});

test("Diagnostic Tool events are fail-open", async () => {
  const registry = new ToolRegistry();
  registry.register(simpleDefinition("read", { execute: () => "done" }));
  const tools = executor(registry, allowedAuthorization(), {
    events: {
      publish() {
        throw new Error("observer failed");
      },
    },
  });
  const result = await tools.execute({
    call: ready("call-1", "read", {}),
    context: {},
    scope,
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "done");
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for Tool acceptance condition");
}

let failures = 0;
for (const item of tests) {
  try {
    await item.execute();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${item.name}`);
    console.error(error);
  }
}

if (failures > 0) process.exitCode = 1;
else console.log(`Tools acceptance passed (${tests.length} tests)`);
