import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import { HostShellBackend } from "../dist/shell/providers/host.js";
import LinuxNativeShell, {
  LinuxNativeShellBackend,
} from "../dist/shell/providers/linux-native.js";
import { createBashTool } from "../dist/shell/consumers/model-tool.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

async function executeBash(root, input, shell, options = {}) {
  const registry = new ToolRegistry();
  registry.register(createBashTool({ shell }));
  const context = basicToolContext(root, {
    shell,
    filesystem: options.filesystem,
    profile: options.profile,
  });
  const snapshot = registry.captureSnapshot({
    authorityVersion: context.permissions.authorityVersion,
  });
  const parsed = registry.parseCall({
    id: `shell-bash-${++callOrdinal}`,
    name: "bash",
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  return await new ToolExecutor({
    registry,
    authorization: {
      authorize() {
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
  }).execute({
    call: parsed.call,
    context,
    scope,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function nativeShell(filesystem = new LocalFilesystemBackend(), options = {}) {
  return {
    filesystem,
    shell: new LinuxNativeShellBackend(filesystem, options),
  };
}

test("Linux Native Shell policy is deterministic, immutable, and path-scoped", () => {
  const filesystem = new LocalFilesystemBackend();
  const first = new LinuxNativeShellBackend(filesystem);
  const second = new LinuxNativeShellBackend(filesystem);
  const changed = new LinuxNativeShellBackend(filesystem, {
    maxProcesses: 32,
  });
  assert.equal(first.policy.version, second.policy.version);
  assert.notEqual(first.policy.version, changed.policy.version);
  assert.equal(first.policy.backend, "linux-native");
  assert.equal(first.policy.filesystem, "path-scoped");
  assert.equal(first.policy.network, "per-call");
  assert.equal(first.policy.environment, "clean");
  assert.deepEqual(first.policy.automaticPermissionProfiles, ["workspace-write"]);
  assert.equal(Object.isFrozen(first.policy), true);
  assert.equal(Object.isFrozen(first.policy.resourceLimits), true);
});

test("native Shell executes Bash with a clean environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-command-"));
  const { filesystem, shell } = nativeShell();
  const previous = process.env.WISH_SHELL_TEST_SECRET;
  process.env.WISH_SHELL_TEST_SECRET = "must-not-leak";
  try {
    const result = await executeBash(root, {
      command:
        'test -z "$WISH_SHELL_TEST_SECRET" && printf native-ok',
      permissions: {
        filesystem: "read",
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, shell, { filesystem });
    assert.equal(result.ok, true);
    assert.equal(result.output.content[0].text, "native-ok");
  } finally {
    if (previous === undefined) delete process.env.WISH_SHELL_TEST_SECRET;
    else process.env.WISH_SHELL_TEST_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Landlock confines reads, writes, protected files, and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-landlock-"));
  const outside = await mkdtemp(join(tmpdir(), "wish-shell-outside-"));
  const { filesystem, shell } = nativeShell();
  try {
    await writeFile(join(root, "input.txt"), "visible", "utf8");
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".env"), "secret", "utf8");
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const result = await executeBash(root, {
      command:
        "cat input.txt && ! cat .env && ! cat link.txt && ! cat /etc/passwd && printf written > src/output.txt",
    }, shell, { filesystem });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.output.content[0].text, /visible/u);
    assert.equal(await readFile(join(root, "src", "output.txt"), "utf8"), "written");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Landlock enforces exact path grants and existing writable parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-scoped-"));
  const { filesystem, shell } = nativeShell();
  try {
    await mkdir(join(root, "output"));
    await writeFile(join(root, "input.txt"), "scoped", "utf8");
    await writeFile(join(root, "other.txt"), "hidden", "utf8");
    const result = await executeBash(root, {
      command:
        "cat input.txt > output/result.txt && ! cat other.txt && printf scoped-ok",
      permissions: {
        filesystem: { read: ["input.txt"], write: ["output"] },
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, shell, { filesystem });
    assert.equal(result.ok, true);
    assert.match(result.output.content[0].text, /scoped-ok/u);
    assert.equal(await readFile(join(root, "output", "result.txt"), "utf8"), "scoped");

    const protectedResult = await executeBash(root, {
      command: "cat .env",
      permissions: {
        filesystem: { read: [".env"], write: [] },
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, shell, { filesystem });
    assert.equal(protectedResult.ok, false);
    assert.equal(protectedResult.error.code, "permission_denied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seccomp allows local IPC but denies internet sockets without network authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-network-"));
  const { filesystem, shell } = nativeShell();
  const localCommand =
    "python3 -c 'import socket; socket.socket(socket.AF_UNIX); print(\"socket-ok\")'";
  const networkCommand =
    "python3 -c 'import socket; socket.socket(socket.AF_INET); print(\"network-ok\")'";
  try {
    await mkdir(join(root, "ipc"));
    const local = await executeBash(root, {
      command: localCommand,
      permissions: {
        filesystem: "read",
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, shell, { filesystem });
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.match(local.output.content[0].text, /socket-ok/u);

    const denied = await executeBash(root, {
      command: networkCommand,
      permissions: {
        filesystem: "read",
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, shell, { filesystem });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "execution_failed");

    let observedSpec;
    const observedShell = {
      policy: shell.policy,
      async resolve(request) {
        observedSpec = await shell.resolve(request);
        return observedSpec;
      },
      run(request) {
        return shell.run(request);
      },
    };
    const allowed = await executeBash(root, {
      // Use AF_UNIX here because the outer test runner may independently deny
      // internet sockets even after the nested Wish policy enables them.
      command: localCommand,
      permissions: {
        filesystem: "read",
        network: true,
        externalSideEffect: false,
        destructive: false,
      },
    }, observedShell, { filesystem });
    assert.equal(observedSpec.networkEnabled, true);
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.match(allowed.output.content[0].text, /socket-ok/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout and abort terminate the native process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-termination-"));
  const { filesystem, shell } = nativeShell();
  try {
    const timedOut = await executeBash(root, {
      command: "sleep 5",
      timeout: 0.05,
    }, shell, { filesystem });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error.code, "timeout");

    const controller = new AbortController();
    const pending = executeBash(root, {
      command: "sleep 5",
    }, shell, { filesystem, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop native shell")), 50);
    const aborted = await pending;
    assert.equal(aborted.ok, false);
    assert.equal(aborted.error.code, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host Shell is double-opt-in and remains an explicit escape hatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-shell-host-"));
  const filesystem = new LocalFilesystemBackend();
  try {
    const disabled = new HostShellBackend(filesystem);
    const denied = await executeBash(root, { command: "printf denied" }, disabled, {
      filesystem,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error.message, /disabled/u);

    const enabled = new HostShellBackend(filesystem, { enabled: true });
    const notFullAccess = await executeBash(root, {
      command: "printf must-not-run",
      permissions: {
        filesystem: { read: [], write: [] },
        network: false,
        externalSideEffect: false,
        destructive: false,
      },
    }, enabled, { filesystem });
    assert.equal(notFullAccess.ok, false);
    assert.match(notFullAccess.error.message, /full-access/u);

    const allowed = await executeBash(root, { command: "printf host-ok" }, enabled, {
      filesystem,
      profile: "full-access",
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.output.content[0].text, "host-ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cordis Shell Provider unload and replacement return consumers to pending", async () => {
  const root = new Context();
  const states = Object.freeze({ pending: 0, active: 2 });
  const consumer = root.plugin({ inject: ["shell"], apply() {} });
  assert.equal(consumer.state, states.pending);
  await root.plugin(LocalFilesystem);
  const native = root.plugin(LinuxNativeShell);
  await native.await();
  await consumer.await();
  assert.equal(native.state, states.active);
  assert.equal(consumer.state, states.active);
  try {
    await native.dispose();
    assert.equal(root.get("shell"), undefined);
    assert.equal(consumer.state, states.pending);
    await root.plugin(LinuxNativeShell);
    await consumer.await();
    assert.equal(consumer.state, states.active);
  } finally {
    await root.fiber.dispose();
  }
});
