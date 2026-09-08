import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import {
  InteractiveToolAuthorizationService,
  createDenyAllToolAuthorizationService,
} from "../dist/tools/index.js";

const scope = Object.freeze({ runId: "run-1", userTurnId: "turn-1", stepId: "step-1" });

function createFixture(authorization) {
  const registry = new ToolRegistry();
  let grantMetadata;
  registry.register({
    name: "read",
    description: "Read one path",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse(input) {
      return { ok: true, input };
    },
    resolveCapabilities(input) {
      return {
        requirements: [{ capability: "filesystem.read", paths: [input.path] }],
      };
    },
    execute(input, _context, grant) {
      grantMetadata = grant.metadata;
      return { content: input.path };
    },
  });
  const parsed = registry.parseCall({
    id: "call-1",
    name: "read",
    argumentsJson: '{"path":"README.md"}',
  });
  assert.equal(parsed.ok, true);
  return {
    registry,
    grantMetadata: () => grantMetadata,
    execute: () => new ToolExecutor({ registry, authorization }).execute({
      call: parsed.call,
      context: { cwd: "/workspace" },
      scope,
      snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
    }),
  };
}

test("bridges one App approval to authorize, revalidate, and dispatch", async () => {
  const requests = [];
  const authorization = new InteractiveToolAuthorizationService({
    policyVersion: "policy-1",
    approval: {
      requestApproval(input, signal) {
        requests.push({ input, signal });
        return {
          status: "approved",
          metadata: { approvedBy: "cli", nested: { mode: "once" } },
        };
      },
    },
  });
  const fixture = createFixture(authorization);

  const result = await fixture.execute();
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { content: "README.md" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input.call.id, "call-1");
  assert.deepEqual(requests[0].input.capabilities, {
    requirements: [{ capability: "filesystem.read", paths: ["README.md"] }],
  });
  assert.deepEqual(fixture.grantMetadata(), {
    approvedBy: "cli",
    nested: { mode: "once" },
  });
  assert.equal(Object.isFrozen(fixture.grantMetadata()), true);
});

test("denial remains a permission failure and never dispatches", async () => {
  const authorization = new InteractiveToolAuthorizationService({
    policyVersion: "policy-1",
    approval: {
      requestApproval() {
        return { status: "denied", reason: "user declined" };
      },
    },
  });
  const result = await createFixture(authorization).execute();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(result.error.message, "user declined");
  assert.equal(result.phase, "prepared");
});

test("policy changes during approval fail closed before dispatch", async () => {
  let version = "policy-1";
  const authorization = new InteractiveToolAuthorizationService({
    policyVersion: () => version,
    approval: {
      requestApproval() {
        version = "policy-2";
        return { status: "approved" };
      },
    },
  });
  const result = await createFixture(authorization).execute();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.equal(result.error.message, "Tool authorization policy changed before dispatch");
  assert.equal(result.phase, "authorized");
});

test("approval correlation is single-use and bound to the exact input", async () => {
  const authorization = new InteractiveToolAuthorizationService({
    policyVersion: "policy-1",
    approval: { requestApproval: () => ({ status: "approved" }) },
  });
  const call = Object.freeze({
    status: "ready",
    id: "call-1",
    name: "read",
    input: Object.freeze({ path: "README.md" }),
  });
  const descriptor = Object.freeze({
    name: "read",
    description: "Read one path",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
  });
  const capabilities = Object.freeze({ requirements: Object.freeze([]) });
  const context = Object.freeze({ cwd: "/workspace" });
  const snapshot = Object.freeze({
    schemaVersion: 1,
    registryVersion: 1,
    authorityVersion: "authority-1",
    availableTools: Object.freeze(["read"]),
  });
  const input = Object.freeze({ call, descriptor, capabilities, context, scope, snapshot });
  const decision = await authorization.authorize(input);
  assert.equal(decision.status, "allowed");
  assert.deepEqual(authorization.revalidate({ ...input, decision }), {
    status: "valid",
    policyVersion: "policy-1",
  });
  assert.deepEqual(authorization.revalidate({ ...input, decision }), {
    status: "denied",
    reason: "Tool approval is missing, stale, or already consumed",
  });
});

test("deny-all service is the explicit fail-closed default", async () => {
  const result = await createFixture(
    createDenyAllToolAuthorizationService(),
  ).execute();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "permission_denied");
  assert.match(result.error.message, /no approval service is configured/u);
});

test("aborted approval never becomes an authorization decision", async () => {
  const controller = new AbortController();
  const reason = new Error("stop approval");
  const authorization = new InteractiveToolAuthorizationService({
    policyVersion: "policy-1",
    approval: { requestApproval: () => ({ status: "approved" }) },
  });
  controller.abort(reason);

  await assert.rejects(authorization.authorize({
    call: { status: "ready", id: "call", name: "read", input: {} },
    descriptor: {
      name: "read",
      description: "read",
      inputSchemaJson: '{}',
      executionMode: "parallel",
      recoveryPolicy: "retry-safe",
    },
    capabilities: { requirements: [] },
    context: {},
    scope,
    snapshot: {
      schemaVersion: 1,
      registryVersion: 1,
      authorityVersion: "authority-1",
      availableTools: ["read"],
    },
  }, controller.signal), reason);
});
