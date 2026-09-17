import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import ApprovalHub from "../dist/approval/service.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import DefaultPermissions from "../dist/permissions/providers/default.js";
import MemoryApprovalRules from
  "../dist/permissions/rules/providers/memory.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import LinuxNativeShell from "../dist/shell/providers/linux-native.js";

const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "permission-policy-workspace",
  revision: "permission-policy-workspace-v1",
  instructions: Object.freeze([]),
});

const subject = Object.freeze({
  agentId: "wish",
  sessionId: "session-1",
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
});

function register(registry, name, capability) {
  registry.register({
    name,
    description: name,
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "retry-safe",
    parse(input) { return { ok: true, input }; },
    resolveCapabilities() {
      return {
        requirements: [{
          capability,
          ...(capability.startsWith("filesystem.")
            ? { paths: ["policy-test.txt"] }
            : { resources: [name] }),
        }],
      };
    },
    execute() { return { name }; },
  });
}

async function fixture() {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  root.approval.register({
    requestApproval() { return { status: "approved" }; },
  });
  await root.plugin(DefaultPermissions);
  return root;
}

test("permission policies monotonically narrow Step Tools and capabilities", async () => {
  const root = await fixture();
  let active = true;
  const policy = {
    id: "acceptance-mode",
    async project(input) {
      return Object.freeze({
        id: "acceptance-mode",
        revision: active ? "active-1" : "inactive-1",
        ...(active
          ? {
              availableTools: Object.freeze(
                input.availableTools.filter((name) => name !== "write"),
              ),
              allowedCapabilities: Object.freeze(
                input.allowedCapabilities.filter((kind) =>
                  kind !== "filesystem.write"
                ),
              ),
            }
          : {}),
      });
    },
    authorize(input) {
      return active && input.capabilities.requirements.some((requirement) =>
          requirement.capability === "filesystem.write"
        )
        ? { status: "denied", reason: "active mode denies writes" }
        : { status: "allowed" };
    },
  };
  const plugin = root.plugin({
    inject: ["permissions"],
    apply(ctx) { ctx.permissions.registerPolicy(policy); },
  });
  try {
    await plugin.await();
    const constrained = await root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["read", "write", "mode"],
    });
    assert.deepEqual(constrained.availableTools, ["read", "mode"]);
    assert.deepEqual(constrained.delegation.availableTools, ["read", "mode"]);
    assert.equal(
      constrained.ceiling.allowedCapabilities.includes("filesystem.write"),
      false,
    );
    assert.deepEqual(
      constrained.policies.map(({ id, revision }) => ({ id, revision })),
      [{ id: "acceptance-mode", revision: "active-1" }],
    );

    active = false;
    const unconstrained = await root.permissions.resolve({
      subject: { ...subject, stepId: "step-2" },
      workspace,
      registeredTools: ["read", "write", "mode"],
    });
    assert.deepEqual(unconstrained.availableTools, ["read", "write", "mode"]);
  } finally {
    await root.fiber.dispose();
  }
});

test("a policy tightening after Step capture denies a stale write call", async () => {
  const root = await fixture();
  let active = false;
  const plugin = root.plugin({
    inject: ["permissions"],
    apply(ctx) {
      ctx.permissions.registerPolicy({
        id: "live-mode",
        project() {
          return { id: "live-mode", revision: active ? "active" : "inactive" };
        },
        authorize(input) {
          return active && input.call.name === "write"
            ? { status: "denied", reason: "mode tightened before dispatch" }
            : { status: "allowed" };
        },
      });
    },
  });
  try {
    await plugin.await();
    const registry = new ToolRegistry();
    register(registry, "write", "filesystem.write");
    const permissions = await root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const parsed = registry.parseCall({
      id: "write-1",
      name: "write",
      argumentsJson: "{}",
    });
    assert.equal(parsed.ok, true);
    active = true;
    const result = await new ToolExecutor({
      registry,
      authorization: root.permissions,
    }).execute({
      call: parsed.call,
      context: Object.freeze({ workspace, permissions }),
      scope: Object.freeze({ runId: "run-1", userTurnId: "turn-1", stepId: "step-1" }),
      snapshot: registry.captureSnapshot({
        authorityVersion: permissions.authorityVersion,
        availableTools: permissions.availableTools,
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "permission_denied");
    assert.match(result.error.message, /tightened before dispatch/u);
  } finally {
    await root.fiber.dispose();
  }
});

test("unloading a policy invalidates snapshots captured with that policy set", async () => {
  const root = await fixture();
  const plugin = root.plugin({
    inject: ["permissions"],
    apply(ctx) {
      ctx.permissions.registerPolicy({
        id: "reloadable-mode",
        project() { return { id: "reloadable-mode", revision: "1" }; },
        authorize() { return { status: "allowed" }; },
      });
    },
  });
  try {
    await plugin.await();
    const registry = new ToolRegistry();
    register(registry, "read", "filesystem.read");
    const permissions = await root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["read"],
    });
    await plugin.dispose();
    const parsed = registry.parseCall({ id: "read-1", name: "read", argumentsJson: "{}" });
    assert.equal(parsed.ok, true);
    const result = await new ToolExecutor({
      registry,
      authorization: root.permissions,
    }).execute({
      call: parsed.call,
      context: Object.freeze({ workspace, permissions }),
      scope: Object.freeze({ runId: "run-1", userTurnId: "turn-1", stepId: "step-1" }),
      snapshot: registry.captureSnapshot({
        authorityVersion: permissions.authorityVersion,
        availableTools: permissions.availableTools,
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /contributions changed/u);
  } finally {
    await root.fiber.dispose();
  }
});
