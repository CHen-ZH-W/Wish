import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutor, ToolRegistry } from "wish/core/tools";
import {
  BASIC_TOOL_NAMES,
  createBasicToolResultRenderer,
  registerBasicTools,
} from "wish/tools";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });

test("registers exactly the five Basic Tools in their stable order", () => {
  const registry = new ToolRegistry();
  const registrations = registerBasicTools(registry);

  assert.deepEqual(BASIC_TOOL_NAMES, ["read", "write", "edit", "grep", "bash"]);
  assert.deepEqual(
    registry.list().map((descriptor) => descriptor.name),
    BASIC_TOOL_NAMES,
  );
  assert.deepEqual(
    registrations.map((registration) => registration.descriptor.name),
    BASIC_TOOL_NAMES,
  );
  assert.equal(registry.version, 5);
  assert.equal(Object.isFrozen(BASIC_TOOL_NAMES), true);
  assert.equal(Object.isFrozen(registrations), true);

  assert.deepEqual(
    registry.list().map(({ name, executionMode, recoveryPolicy }) => ({
      name,
      executionMode,
      recoveryPolicy,
    })),
    [
      { name: "read", executionMode: "parallel", recoveryPolicy: "retry-safe" },
      {
        name: "write",
        executionMode: "sequential",
        recoveryPolicy: "needs-reconciliation",
      },
      {
        name: "edit",
        executionMode: "sequential",
        recoveryPolicy: "needs-reconciliation",
      },
      { name: "grep", executionMode: "parallel", recoveryPolicy: "retry-safe" },
      {
        name: "bash",
        executionMode: "sequential",
        recoveryPolicy: "needs-reconciliation",
      },
    ],
  );
});

test("forwards per-Tool options without owning authorization or execution", async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registerBasicTools(registry, {
    read: {
      operations: {
        async access(path, signal) {
          calls.push({ operation: "access", path, signal });
        },
        async detectImageMimeType(path, signal) {
          calls.push({ operation: "detect", path, signal });
          return null;
        },
        async readFile(path, signal) {
          calls.push({ operation: "read", path, signal });
          return Buffer.from("injected content", "utf8");
        },
      },
    },
  });

  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: "read-1",
    name: "read",
    argumentsJson: '{"path":"notes.txt"}',
  });
  assert.equal(parsed.ok, true);

  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize() {
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
  });
  const result = await executor.execute({
    call: parsed.call,
    context: { cwd: "/workspace" },
    scope,
    snapshot,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output.content, [{ type: "text", text: "injected content" }]);
  assert.deepEqual(
    calls.map(({ operation, path }) => ({ operation, path })),
    [
      { operation: "access", path: "/workspace/notes.txt" },
      { operation: "detect", path: "/workspace/notes.txt" },
      { operation: "read", path: "/workspace/notes.txt" },
    ],
  );
});

test("rejects an existing Basic Tool without partially changing the Registry", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "grep",
    description: "existing",
    inputSchemaJson: '{"type":"object"}',
    executionMode: "parallel",
    recoveryPolicy: "retry-safe",
    parse(input) { return { ok: true, input }; },
    resolveCapabilities() { return { requirements: [] }; },
    execute() { return "existing"; },
  });
  const version = registry.version;

  assert.throws(
    () => registerBasicTools(registry),
    /Tool "grep" is already registered/u,
  );
  assert.equal(registry.version, version);
  assert.deepEqual(registry.list().map((descriptor) => descriptor.name), ["grep"]);
});

test("returns the Registry-owned handles and exposes the renderer composition entry", () => {
  const registry = new ToolRegistry();
  const registrations = registerBasicTools(registry);

  for (const registration of [...registrations].reverse()) {
    assert.equal(registration.unregister(), true);
    assert.equal(registration.unregister(), false);
  }
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.version, 10);

  const renderer = createBasicToolResultRenderer();
  assert.equal(typeof renderer.render, "function");
});
