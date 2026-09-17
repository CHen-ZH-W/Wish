import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import ApprovalHub from "../dist/approval/service.js";
import MemoryApprovalRules from
  "../dist/permissions/rules/providers/memory.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import LinuxNativeShell from "../dist/shell/providers/linux-native.js";
import HostShell from "../dist/shell/providers/host.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import {
  DefaultPermissions,
  PermissionProfileUnavailableError,
} from "../dist/permissions/index.js";

const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "workspace-1",
  revision: "workspace-revision-1",
  instructions: Object.freeze([]),
});

const subject = Object.freeze({
  agentId: "agent-1",
  sessionId: "session-1",
  runId: "run-1",
  userTurnId: "turn-1",
  stepId: "step-1",
});

function registerTool(registry, name, capability, resourcePath) {
  registry.register({
    name,
    description: name,
    inputSchemaJson: '{"type":"object"}',
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
    parse(input) {
      return { ok: true, input };
    },
    resolveCapabilities() {
      if (capability === "network.connect") {
        return {
          requirements: [
            { capability: "process.exec", commands: ["probe"] },
            { capability: "network.connect", hosts: ["*"] },
          ],
          effects: { openWorld: true },
        };
      }
      if (capability === "web.search") {
        return {
          requirements: [{ capability, providers: ["deepseek"] }],
          effects: { openWorld: true },
        };
      }
      if (capability === "web.fetch") {
        return {
          requirements: [{
            capability,
            providers: ["http-public"],
            origins: ["https://example.com"],
          }],
          effects: { openWorld: true },
        };
      }
      return {
        requirements: [{
          capability,
          ...(capability.startsWith("filesystem.")
            ? {
                paths: [capability === "filesystem.read"
                  ? "package.json"
                  : resourcePath ?? "permission-output.txt"],
              }
            : capability === "network.connect"
              ? { hosts: ["*"] }
              : capability === "process.exec"
                ? { commands: ["probe"] }
                : { resources: ["probe"] }),
        }],
      };
    },
    execute(_input, _context, grant) {
      return { grant };
    },
  });
}

async function execute(
  permissions,
  permissionSnapshot,
  name,
  capability,
  resourcePath,
) {
  const registry = new ToolRegistry();
  registerTool(registry, name, capability, resourcePath);
  const parsed = registry.parseCall({
    id: `call-${name}`,
    name,
    argumentsJson: "{}",
  });
  assert.equal(parsed.ok, true);
  return new ToolExecutor({ registry, authorization: permissions }).execute({
    call: parsed.call,
    context: Object.freeze({ workspace, permissions: permissionSnapshot }),
    scope: Object.freeze({
      runId: permissionSnapshot.subject.runId,
      userTurnId: permissionSnapshot.subject.userTurnId,
      stepId: permissionSnapshot.subject.stepId,
    }),
    snapshot: registry.captureSnapshot({
      authorityVersion: permissionSnapshot.authorityVersion,
      availableTools: permissionSnapshot.availableTools.filter((tool) =>
        tool === name
      ),
    }),
  });
}

test("Permission Snapshot is deterministic, deep-frozen, and Step-scoped", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  await root.plugin(DefaultPermissions);
  try {
    const request = {
      agent: {
        availableTools: ["write", "read", "missing", "read"],
        allowedCapabilities: ["filesystem.read", "filesystem.write"],
      },
      subject,
      workspace,
      registeredTools: ["read", "write", "grep"],
    };
    const first = root.permissions.resolve(request);
    const second = root.permissions.resolve(request);
    assert.equal(first.profile, "approval-required");
    assert.deepEqual(first.availableTools, ["read", "write"]);
    assert.deepEqual(first.ceiling.allowedCapabilities, [
      "filesystem.read",
      "filesystem.write",
    ]);
    assert.equal(first.authorityVersion, second.authorityVersion);
    assert.equal(
      first.filesystemPolicyVersion,
      root.filesystem.policy.version,
    );
    assert.equal(first.shellPolicyVersion, root.shell.policy.version);
    assert.equal(
      first.sandboxPolicyVersion,
      root.sandboxPolicy.policy.version,
    );
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.subject), true);
    assert.equal(Object.isFrozen(first.ceiling.allowedCapabilities), true);

    const nextStep = root.permissions.resolve({
      ...request,
      subject: { ...subject, stepId: "step-2" },
    });
    assert.notEqual(first.authorityVersion, nextStep.authorityVersion);
  } finally {
    await root.fiber.dispose();
  }
});

test("default policy allows reads, asks once for writes, and respects ceilings", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  const approvalRequests = [];
  root.approval.register({
    requestApproval(input) {
      approvalRequests.push(input);
      return {
        status: "approved",
        metadata: { approvedBy: "test" },
      };
    },
  });
  await root.plugin(DefaultPermissions);
  try {
    const permissions = root.permissions;
    const snapshot = permissions.resolve({
      subject,
      workspace,
      registeredTools: ["read", "write"],
    });
    const read = await execute(
      permissions,
      snapshot,
      "read",
      "filesystem.read",
    );
    assert.equal(read.ok, true);
    assert.equal(approvalRequests.length, 0);
    assert.equal(read.output.grant.metadata.authorizationSource, "profile");

    const write = await execute(
      permissions,
      snapshot,
      "write",
      "filesystem.write",
    );
    assert.equal(write.ok, true);
    assert.equal(approvalRequests.length, 1);
    assert.equal(write.output.grant.metadata.authorizationSource, "approval");
    assert.deepEqual(write.output.grant.metadata.approval, {
      approvedBy: "test",
    });

    const ceiling = permissions.resolve({
      agent: { allowedCapabilities: ["filesystem.read"] },
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const denied = await execute(
      permissions,
      ceiling,
      "write",
      "filesystem.write",
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "permission_denied");
    assert.equal(approvalRequests.length, 1);
  } finally {
    await root.fiber.dispose();
  }
});

test("Web access is denied by read-only and approved for open-world profiles", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  const approvalRequests = [];
  root.approval.register({
    requestApproval(input) {
      approvalRequests.push(input);
      return { status: "approved" };
    },
  });
  await root.plugin(DefaultPermissions);
  try {
    const readOnly = root.permissions.resolve({
      agent: { profile: "read-only" },
      subject,
      workspace,
      registeredTools: ["web_search"],
    });
    const denied = await execute(
      root.permissions,
      readOnly,
      "web_search",
      "web.search",
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "permission_denied");
    assert.equal(approvalRequests.length, 0);

    const approvalRequired = root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["web_search", "web_fetch"],
    });
    const searched = await execute(
      root.permissions,
      approvalRequired,
      "web_search",
      "web.search",
    );
    const fetched = await execute(
      root.permissions,
      approvalRequired,
      "web_fetch",
      "web.fetch",
    );
    assert.equal(searched.ok, true);
    assert.equal(fetched.ok, true);
    assert.equal(approvalRequests.length, 2);
  } finally {
    await root.fiber.dispose();
  }
});

test("read-only denies mutation and native workspace-write allows local writes", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  const approvalRequests = [];
  root.approval.register({
    requestApproval(input) {
      approvalRequests.push(input);
      return { status: "approved" };
    },
  });
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  await root.plugin(DefaultPermissions);
  try {
    const readOnly = root.permissions.resolve({
      agent: { profile: "read-only" },
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const denied = await execute(
      root.permissions,
      readOnly,
      "write",
      "filesystem.write",
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "permission_denied");
    assert.equal(approvalRequests.length, 0);

    const readOnlyExecSnapshot = root.permissions.resolve({
      agent: { profile: "read-only" },
      subject,
      workspace,
      registeredTools: ["exec"],
    });
    const approvedExec = await execute(
      root.permissions,
      readOnlyExecSnapshot,
      "exec",
      "process.exec",
    );
    assert.equal(approvedExec.ok, true);
    assert.equal(approvalRequests.length, 1);

    const workspaceWrite = root.permissions.resolve({
      agent: { profile: "workspace-write" },
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const allowed = await execute(
      root.permissions,
      workspaceWrite,
      "write",
      "filesystem.write",
    );
    assert.equal(allowed.ok, true);

    const elevatedSnapshot = root.permissions.resolve({
      agent: { profile: "workspace-write" },
      subject,
      workspace,
      registeredTools: ["network"],
    });
    const elevated = await execute(
      root.permissions,
      elevatedSnapshot,
      "network",
      "network.connect",
    );
    assert.equal(elevated.ok, true);
    assert.equal(approvalRequests.length, 2);

    assert.throws(
      () => root.permissions.resolve({
        agent: { profile: "full-access" },
        subject,
        workspace,
        registeredTools: [],
      }),
      PermissionProfileUnavailableError,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("approval-required fails closed without an answerer and preserves abort", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  await root.plugin(DefaultPermissions);
  try {
    const snapshot = root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const denied = await execute(
      root.permissions,
      snapshot,
      "write",
      "filesystem.write",
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error.message, /no answerer is registered/u);

    const controller = new AbortController();
    const reason = new Error("stop permissions");
    controller.abort(reason);
    assert.throws(
      () => root.permissions.resolve({
        subject,
        workspace,
        registeredTools: [],
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("SandboxPolicy rejects unenforceable paths before asking for approval", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  const approvalRequests = [];
  root.approval.register({
    requestApproval(input) {
      approvalRequests.push(input);
      return { status: "approved", scope: "workspace" };
    },
  });
  await root.plugin(DefaultPermissions);
  try {
    const snapshot = root.permissions.resolve({
      subject,
      workspace,
      registeredTools: ["write"],
    });
    const denied = await execute(
      root.permissions,
      snapshot,
      "write",
      "filesystem.write",
      ".env",
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "permission_denied");
    assert.match(denied.error.message, /Sandbox preflight/u);
    assert.equal(approvalRequests.length, 0);
    assert.equal((await root.approvalRules.list()).length, 0);
  } finally {
    await root.fiber.dispose();
  }
});

test("once, run, session, and workspace approval scopes retain exact authority", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  const scopes = ["run", "session", "workspace", "once"];
  const approvalRequests = [];
  root.approval.register({
    requestApproval(input) {
      approvalRequests.push(input);
      return { status: "approved", scope: scopes.shift() };
    },
  });
  await root.plugin(DefaultPermissions);
  try {
    const permission = (nextSubject) => root.permissions.resolve({
      subject: nextSubject,
      workspace,
      registeredTools: ["write"],
    });
    const first = permission(subject);
    assert.equal((await execute(
      root.permissions,
      first,
      "write",
      "filesystem.write",
    )).ok, true);
    assert.equal(approvalRequests.length, 1);
    assert.equal((await root.approvalRules.list()).length, 1);

    assert.equal((await execute(
      root.permissions,
      first,
      "write",
      "filesystem.write",
    )).output.grant.metadata.authorizationSource, "approval-rule");
    assert.equal(approvalRequests.length, 1);

    const nextRunSubject = {
      ...subject,
      runId: "run-2",
      userTurnId: "turn-2",
      stepId: "step-2",
    };
    const nextRun = permission(nextRunSubject);
    assert.equal((await execute(
      root.permissions,
      nextRun,
      "write",
      "filesystem.write",
    )).ok, true);
    assert.equal(approvalRequests.length, 2);

    const sameSession = permission({
      ...nextRunSubject,
      runId: "run-3",
      userTurnId: "turn-3",
      stepId: "step-3",
    });
    assert.equal((await execute(
      root.permissions,
      sameSession,
      "write",
      "filesystem.write",
    )).output.grant.metadata.authorizationSource, "approval-rule");
    assert.equal(approvalRequests.length, 2);

    const nextSessionSubject = {
      ...nextRunSubject,
      sessionId: "session-2",
      runId: "run-4",
      userTurnId: "turn-4",
      stepId: "step-4",
    };
    const nextSession = permission(nextSessionSubject);
    assert.equal((await execute(
      root.permissions,
      nextSession,
      "write",
      "filesystem.write",
    )).ok, true);
    assert.equal(approvalRequests.length, 3);

    const workspaceMatch = permission({
      ...nextSessionSubject,
      sessionId: "session-3",
      runId: "run-5",
      userTurnId: "turn-5",
      stepId: "step-5",
    });
    assert.equal((await execute(
      root.permissions,
      workspaceMatch,
      "write",
      "filesystem.write",
    )).output.grant.metadata.authorizationSource, "approval-rule");
    assert.equal(approvalRequests.length, 3);

    const otherAgent = permission({
      ...nextSessionSubject,
      agentId: "agent-2",
      sessionId: "session-4",
      runId: "run-6",
      userTurnId: "turn-6",
      stepId: "step-6",
    });
    assert.equal((await execute(
      root.permissions,
      otherAgent,
      "write",
      "filesystem.write",
    )).ok, true);
    assert.equal(approvalRequests.length, 4);
    assert.equal((await root.approvalRules.list()).length, 3);
  } finally {
    await root.fiber.dispose();
  }
});

test("full-access is available only through the explicit enabled Host Shell", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  await root.plugin(MemoryApprovalRules);
  await root.plugin(LocalFilesystem);
  await root.plugin(HostShell, { enabled: true });
  await root.plugin(DefaultSandboxPolicy);
  await root.plugin(DefaultPermissions);
  try {
    const snapshot = root.permissions.resolve({
      agent: { profile: "full-access" },
      subject,
      workspace,
      registeredTools: ["exec"],
    });
    const allowed = await execute(
      root.permissions,
      snapshot,
      "exec",
      "process.exec",
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.output.grant.metadata.authorizationSource, "profile");

    assert.throws(
      () => root.permissions.resolve({
        agent: { profile: "workspace-write" },
        subject,
        workspace,
        registeredTools: [],
      }),
      PermissionProfileUnavailableError,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("Permissions Provider follows Approval service replacement", async () => {
  const root = new Context();
  const states = Object.freeze({ pending: 0, active: 2 });
  const permissions = root.plugin(DefaultPermissions);
  const consumer = root.plugin({
    inject: ["permissions"],
    apply() {},
  });
  assert.equal(permissions.state, states.pending);
  assert.equal(consumer.state, states.pending);

  try {
    await root.plugin(LocalFilesystem);
    await root.plugin(LinuxNativeShell);
    await root.plugin(DefaultSandboxPolicy);
    await root.plugin(MemoryApprovalRules);
    const approval = root.plugin(ApprovalHub);
    await permissions.await();
    await consumer.await();
    assert.equal(permissions.state, states.active);
    assert.equal(consumer.state, states.active);

    await approval.dispose();
    assert.equal(root.get("permissions"), undefined);
    assert.equal(consumer.state, states.pending);

    await root.plugin(ApprovalHub);
    await consumer.await();
    assert.equal(consumer.state, states.active);
  } finally {
    await root.fiber.dispose();
  }
});
