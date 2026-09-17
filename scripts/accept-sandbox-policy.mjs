import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import LocalFilesystem, {
  LocalFilesystemBackend,
} from "../dist/filesystem/providers/local.js";
import LinuxNativeShell, {
  LinuxNativeShellBackend,
} from "../dist/shell/providers/linux-native.js";
import DefaultSandboxPolicy, {
  DefaultSandboxPolicyBackend,
} from "../dist/sandbox/providers/default.js";

function security(root) {
  const filesystem = new LocalFilesystemBackend();
  const shell = new LinuxNativeShellBackend(filesystem);
  const sandbox = new DefaultSandboxPolicyBackend(filesystem, shell);
  const workspace = Object.freeze({
    requestedRoot: root,
    root,
    fingerprint: `workspace:${root}`,
    revision: "workspace-revision-1",
    instructions: Object.freeze([]),
  });
  const permissions = Object.freeze({
    schemaVersion: 1,
    subject: Object.freeze({
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      userTurnId: "turn-1",
      stepId: "step-1",
    }),
    profile: "approval-required",
    availableTools: Object.freeze(["read", "write", "bash"]),
    ceiling: Object.freeze({
      allowedCapabilities: Object.freeze([
        "filesystem.read",
        "filesystem.write",
        "process.exec",
        "network.connect",
        "web.search",
        "web.fetch",
        "external.side_effect",
        "runtime.read",
        "runtime.control",
      ]),
    }),
    workspace: Object.freeze({
      fingerprint: workspace.fingerprint,
      revision: workspace.revision,
    }),
    filesystemPolicyVersion: filesystem.policy.version,
    shellPolicyVersion: shell.policy.version,
    sandboxPolicyVersion: sandbox.policy.version,
    policyVersion: "permission-policy-1",
    authorityVersion: "authority-1",
  });
  return {
    filesystem,
    shell,
    sandbox,
    context: Object.freeze({ workspace, permissions }),
  };
}

function authorizationInput(context, toolName, capabilities, input = {}) {
  return Object.freeze({
    call: Object.freeze({
      status: "ready",
      id: `call-${toolName}`,
      name: toolName,
      input: Object.freeze(input),
    }),
    descriptor: Object.freeze({
      name: toolName,
      description: toolName,
      inputSchemaJson: '{"type":"object"}',
      executionMode: "sequential",
      recoveryPolicy: "needs-reconciliation",
    }),
    capabilities: Object.freeze(capabilities),
    context,
    scope: Object.freeze({
      runId: context.permissions.subject.runId,
      userTurnId: context.permissions.subject.userTurnId,
      stepId: context.permissions.subject.stepId,
    }),
    snapshot: Object.freeze({
      schemaVersion: 1,
      registryVersion: 1,
      authorityVersion: context.permissions.authorityVersion,
      availableTools: Object.freeze([toolName]),
    }),
  });
}

test("SandboxPolicy is deterministic, immutable, and validates direct paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sandbox-policy-"));
  try {
    await writeFile(join(root, "input.txt"), "safe", "utf8");
    const first = security(root);
    const second = new DefaultSandboxPolicyBackend(
      first.filesystem,
      first.shell,
    );
    assert.equal(first.sandbox.policy.version, second.policy.version);
    assert.equal(Object.isFrozen(first.sandbox.policy), true);

    const allowed = await first.sandbox.preflight(authorizationInput(
      first.context,
      "write",
      {
        requirements: [
          { capability: "filesystem.write", paths: ["new.txt"] },
        ],
      },
    ));
    assert.equal(allowed.status, "allowed");
    assert.deepEqual(allowed.effective.writePaths, ["new.txt"]);
    assert.equal(Object.isFrozen(allowed.effective), true);

    const protectedPath = await first.sandbox.preflight(authorizationInput(
      first.context,
      "read",
      {
        requirements: [
          { capability: "filesystem.read", paths: [".env"] },
        ],
      },
    ));
    assert.equal(protectedPath.status, "denied");
    assert.match(protectedPath.reason, /protected/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SandboxPolicy resolves exact native command, path, and network enforcement", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sandbox-command-"));
  try {
    await writeFile(join(root, "input.txt"), "safe", "utf8");
    await mkdir(join(root, "output"));
    const fixture = security(root);
    const command = "cat input.txt > output/result.txt";
    const result = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "bash",
      {
        requirements: [
          { capability: "process.exec", commands: [command] },
          { capability: "filesystem.read", paths: ["input.txt"] },
          { capability: "filesystem.write", paths: ["output"] },
          { capability: "network.connect", hosts: ["*"] },
        ],
        effects: { openWorld: true },
      },
      { command },
    ));
    assert.equal(result.status, "allowed", result.reason);
    assert.equal(result.effective.shellBackend, "linux-native");
    assert.equal(result.effective.networkEnabled, true);
    assert.deepEqual(result.effective.readPaths, ["input.txt"]);
    assert.deepEqual(result.effective.writePaths, ["output"]);
    assert.equal(result.effective.commands[0].command, command);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SandboxPolicy rejects network and process scopes the provider cannot enforce", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sandbox-deny-"));
  try {
    const fixture = security(root);
    const networkOnly = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "remote",
      {
        requirements: [
          { capability: "network.connect", hosts: ["*"] },
        ],
      },
    ));
    assert.equal(networkOnly.status, "denied");
    assert.match(networkOnly.reason, /only through process\.exec/u);

    const command = "true";
    const hostname = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "bash",
      {
        requirements: [
          { capability: "process.exec", commands: [command] },
          { capability: "network.connect", hosts: ["example.com"] },
        ],
      },
    ));
    assert.equal(hostname.status, "denied");
    assert.match(hostname.reason, /all-or-none/u);

    const missingScope = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "bash",
      {
        requirements: [
          { capability: "process.exec", commands: [command] },
          { capability: "filesystem.write", paths: ["missing-directory"] },
        ],
      },
    ));
    assert.equal(missingScope.status, "denied");
    assert.match(missingScope.reason, /does not exist/u);

    const excessiveTimeout = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "bash",
      {
        requirements: [{
          capability: "process.exec",
          commands: [command],
          cwd: root,
          timeoutSeconds: fixture.shell.policy.resourceLimits.maxTimeoutSeconds + 1,
        }],
      },
    ));
    assert.equal(excessiveTimeout.status, "denied");
    assert.match(excessiveTimeout.reason, /at most|not exceed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SandboxPolicy accepts grant-enforced Web scopes only as open-world calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sandbox-web-"));
  try {
    const fixture = security(root);
    const capabilities = {
      requirements: [
        { capability: "web.search", providers: ["deepseek"] },
        {
          capability: "web.fetch",
          providers: ["http-public"],
          origins: ["https://example.com"],
        },
      ],
      effects: { openWorld: true },
    };
    const allowed = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "web",
      capabilities,
    ));
    assert.equal(allowed.status, "allowed", allowed.reason);
    assert.deepEqual(allowed.effective.webSearchProviders, ["deepseek"]);
    assert.deepEqual(allowed.effective.webFetchProviders, ["http-public"]);
    assert.deepEqual(allowed.effective.webFetchOrigins, ["https://example.com"]);
    assert.equal(Object.isFrozen(allowed.effective.webFetchOrigins), true);

    const hiddenEffect = await fixture.sandbox.preflight(authorizationInput(
      fixture.context,
      "web",
      { requirements: capabilities.requirements },
    ));
    assert.equal(hiddenEffect.status, "denied");
    assert.match(hiddenEffect.reason, /openWorld/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SandboxPolicy revalidation detects a path changed to a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-sandbox-recheck-"));
  const outside = await mkdtemp(join(tmpdir(), "wish-sandbox-outside-"));
  try {
    await mkdir(join(root, "output"));
    const fixture = security(root);
    const command = "printf x > output/result.txt";
    const input = authorizationInput(fixture.context, "bash", {
      requirements: [
        { capability: "process.exec", commands: [command] },
        { capability: "filesystem.write", paths: ["output"] },
      ],
    });
    const first = await fixture.sandbox.preflight(input);
    assert.equal(first.status, "allowed");
    await rm(join(root, "output"), { recursive: true, force: true });
    await symlink(outside, join(root, "output"));
    const changed = await fixture.sandbox.revalidate(first.effective, input);
    assert.equal(changed.status, "denied");
    assert.match(changed.reason, /Symbolic links/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Cordis SandboxPolicy follows Filesystem and Shell lifecycle", async () => {
  const root = new Context();
  const states = Object.freeze({ pending: 0, active: 2 });
  const sandbox = root.plugin(DefaultSandboxPolicy);
  const consumer = root.plugin({ inject: ["sandboxPolicy"], apply() {} });
  assert.equal(sandbox.state, states.pending);
  try {
    await root.plugin(LocalFilesystem);
    const shell = root.plugin(LinuxNativeShell);
    await sandbox.await();
    await consumer.await();
    assert.equal(sandbox.state, states.active);
    await shell.dispose();
    assert.equal(root.get("sandboxPolicy"), undefined);
    assert.equal(consumer.state, states.pending);
  } finally {
    await root.fiber.dispose();
  }
});
