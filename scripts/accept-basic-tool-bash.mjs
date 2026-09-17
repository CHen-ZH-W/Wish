import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolExecutor } from "../dist/core/tools/executor.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { LocalFilesystemBackend } from
  "../dist/filesystem/providers/local.js";
import { HostShellBackend } from "../dist/shell/providers/host.js";
import { createBashTool } from "../dist/shell/consumers/model-tool.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "../dist/tools/presentation/truncate.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const scope = Object.freeze({ runId: "run", userTurnId: "turn", stepId: "step" });
let callOrdinal = 0;

function memoryArtifactStore() {
  const values = new Map();
  let ordinal = 0;
  return {
    async put(request) {
      const locator = `memory-artifact:${++ordinal}`;
      values.set(locator, Buffer.from(request.value));
      return Object.freeze({
        kind: "blob",
        locator,
        metadata: Object.freeze({
          mediaType: request.mediaType,
          bytes: request.value.byteLength,
        }),
      });
    },
    async get(request) {
      return values.get(request.artifact.locator);
    },
  };
}

async function executeBash(definition, input, options = {}) {
  const registry = new ToolRegistry();
  registry.register(definition);
  const snapshot = registry.captureSnapshot({ authorityVersion: "authority-1" });
  const parsed = registry.parseCall({
    id: `bash-${++callOrdinal}`,
    name: "bash",
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize(authorizationInput) {
        options.onAuthorize?.(authorizationInput);
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
  });
  return await executor.execute({
    call: parsed.call,
    context: options.context ?? basicToolContext(options.cwd ?? "/workspace"),
    scope,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

test("defines Bash scheduling, recovery, explicit authority, and safe defaults", () => {
  const definition = createBashTool();
  assert.equal(definition.name, "bash");
  assert.equal(definition.executionMode, "sequential");
  assert.equal(definition.recoveryPolicy, "needs-reconciliation");
  const schema = JSON.parse(definition.inputSchemaJson);
  assert.deepEqual(schema.required, ["command"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.permissions.required, [
    "filesystem",
    "network",
    "externalSideEffect",
    "destructive",
  ]);
  assert.deepEqual(
    definition.resolveCapabilities({ command: "printf hello" }, { cwd: "/workspace" }),
    {
      requirements: [
        {
          capability: "process.exec",
          commands: ["printf hello"],
          cwd: "/workspace",
        },
        { capability: "filesystem.read", paths: ["."] },
        { capability: "filesystem.write", paths: ["."] },
      ],
      effects: { destructive: false, openWorld: false },
    },
  );
});

test("accepts only command and an optional positive timeout in seconds", () => {
  const definition = createBashTool();
  assert.equal(definition.parse({ command: "" }).ok, false);
  assert.equal(definition.parse({}).ok, false);
  assert.equal(definition.parse({ command: "pwd", timeout: 0 }).ok, false);
  assert.equal(definition.parse({ command: "pwd", timeout: -1 }).ok, false);
  assert.equal(definition.parse({ command: "pwd", timeout: Number.NaN }).ok, false);
  assert.match(
    definition.parse({ command: "pwd", cwd: "/tmp" }).message,
    /unsupported field "cwd"/u,
  );
  assert.equal(
    definition.parse({ command: "pwd", permissions: ["network"] }).ok,
    false,
  );
  assert.equal(definition.parse({
    command: "pwd",
    permissions: {
      filesystem: { read: ["src"], write: [] },
      network: false,
      externalSideEffect: false,
      destructive: false,
    },
  }).ok, true);
});

test("uses the context cwd and passes timeout, signal, and merged data callback", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await executeBash(
    createBashTool({
      operations: {
        async exec(command, cwd, options) {
          calls.push({ command, cwd, options });
          options.onData(Buffer.from("stdout\n"));
          options.onData(Buffer.from("stderr\n"));
          return { exitCode: 0 };
        },
      },
    }),
    { command: "run command", timeout: 2.5 },
    {
      cwd: "/work/project",
      signal: controller.signal,
      onAuthorize(input) {
        assert.deepEqual(input.capabilities, {
          requirements: [
            {
              capability: "process.exec",
              commands: ["run command"],
              cwd: "/work/project",
              timeoutSeconds: 2.5,
            },
            { capability: "filesystem.read", paths: ["."] },
            { capability: "filesystem.write", paths: ["."] },
          ],
          effects: { destructive: false, openWorld: false },
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    content: [{ type: "text", text: "stdout\nstderr\n" }],
    exitCode: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "run command");
  assert.equal(calls[0].cwd, "/work/project");
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.timeout, 2.5);
  assert.equal(calls[0].options.env, undefined);
});

test("returns a stable empty-output marker and accepts a null exit code", async () => {
  const result = await executeBash(
    createBashTool({
      operations: {
        async exec() {
          return { exitCode: null };
        },
      },
    }),
    { command: "true" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, {
    content: [{ type: "text", text: "(no output)" }],
    exitCode: null,
  });
});

test("non-zero exits fail with the retained output and exit metadata", async () => {
  const result = await executeBash(
    createBashTool({
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("failure details"));
          return { exitCode: 7 };
        },
      },
    }),
    { command: "fail" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "execution_failed");
  assert.equal(result.error.message, "failure details\n\nCommand exited with code 7");
  assert.equal(result.error.details.exitCode, 7);
  assert.equal(result.error.details.output, result.error.message);
});

test("tail truncation stores complete output through the artifact seam", async () => {
  const fullOutput = Array.from(
    { length: DEFAULT_MAX_LINES + 1 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const artifacts = memoryArtifactStore();
  const result = await executeBash(
    createBashTool({
      artifacts,
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from(fullOutput));
          return { exitCode: 0 };
        },
      },
    }),
    { command: "many lines" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.truncation.truncatedBy, "lines");
  assert.equal(result.output.truncation.totalLines, DEFAULT_MAX_LINES + 1);
  assert.equal(result.output.artifact.kind, "blob");
  assert.equal(result.output.artifact.metadata.bytes, Buffer.byteLength(fullOutput));
  assert.equal(
    Buffer.from(await artifacts.get({ artifact: result.output.artifact })).toString("utf8"),
    fullOutput,
  );
  assert.match(result.output.content[0].text, /line-2/u);
  assert.match(result.output.content[0].text, /Full output:/u);
});

test("byte truncation preserves a UTF-8-safe tail and the complete artifact", async () => {
  const fullOutput = "🙂".repeat(DEFAULT_MAX_BYTES);
  const artifacts = memoryArtifactStore();
  const result = await executeBash(
    createBashTool({
      artifacts,
      operations: {
        async exec(_command, _cwd, options) {
          const buffer = Buffer.from(fullOutput);
          for (let offset = 0; offset < buffer.length; offset += 997) {
            options.onData(buffer.subarray(offset, offset + 997));
          }
          return { exitCode: 0 };
        },
      },
    }),
    { command: "large utf8" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.output.truncation.truncatedBy, "bytes");
  assert.equal(result.output.content[0].text.includes("�"), false);
  assert.equal(
    Buffer.byteLength(result.output.content[0].text, "utf8") <= DEFAULT_MAX_BYTES,
    true,
  );
  assert.equal(
    Buffer.from(await artifacts.get({ artifact: result.output.artifact })).toString("utf8"),
    fullOutput,
  );
});

test("artifact capture is bounded and fails closed without local temp files", async () => {
  const artifacts = memoryArtifactStore();
  const result = await executeBash(
    createBashTool({
      artifacts,
      maxArtifactBytes: 10,
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x61));
          return { exitCode: 0 };
        },
      },
    }),
    { command: "large" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.output.artifact, undefined);
  assert.match(result.output.content[0].text, /artifact unavailable/u);
});

test("timeout and abort return their stable Tool errors", async () => {
  const timedOut = await executeBash(
    createBashTool({
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("partial"));
          return { exitCode: null, termination: "timeout" };
        },
      },
    }),
    { command: "slow", timeout: 3 },
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, "timeout");
  assert.equal(timedOut.error.message, "partial\n\nCommand timed out after 3 seconds");
  assert.equal(timedOut.error.details.timeoutSeconds, 3);

  const controller = new AbortController();
  let executionStarted = false;
  const execution = executeBash(
    createBashTool({
      operations: {
        exec(_command, _cwd, options) {
          executionStarted = true;
          return new Promise((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => resolve({ exitCode: null, termination: "aborted" }),
              { once: true },
            );
          });
        },
      },
    }),
    { command: "wait" },
    { signal: controller.signal },
  );
  while (!executionStarted) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("bash cancelled"));
  const aborted = await execution;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.error.message, "bash cancelled");
});

test("the explicit Host Shell merges output and executes in BasicToolContext.cwd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-bash-local-"));
  const filesystem = new LocalFilesystemBackend();
  const shell = new HostShellBackend(filesystem, { enabled: true });
  try {
    const result = await executeBash(
      createBashTool({ shell }),
      { command: "printf 'stdout\\n'; printf 'stderr\\n' >&2; pwd" },
      {
        context: basicToolContext(directory, {
          filesystem,
          shell,
          profile: "full-access",
        }),
      },
    );
    assert.equal(result.ok, true);
    assert.match(result.output.content[0].text, /stdout/u);
    assert.match(result.output.content[0].text, /stderr/u);
    assert.equal(result.output.content[0].text.split("\n").includes(directory), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the local timeout kills the shell's complete process tree", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix process-group assertion");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "wish-bash-tree-"));
  const filesystem = new LocalFilesystemBackend();
  const shell = new HostShellBackend(filesystem, { enabled: true });
  const marker = join(directory, "descendant-survived.txt");
  try {
    const result = await executeBash(
      createBashTool({ shell }),
      {
        command:
          `(sleep 0.25; printf survived > ${shellQuote(marker)}) & wait`,
        timeout: 0.05,
      },
      {
        context: basicToolContext(directory, {
          filesystem,
          shell,
          profile: "full-access",
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "timeout");
    assert.match(result.error.message, /timed out after 0\.05 seconds/u);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
