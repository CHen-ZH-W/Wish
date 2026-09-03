import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { Agent } from "wish/core/agent";
import { AgentLoop } from "wish/core/agent-loop";
import { ContextProjector } from "wish/core/context";
import { Runtime } from "wish/core/runtime";
import { BoundedToolScheduler, ToolExecutor, ToolRegistry } from "wish/core/tools";
import {
  BASIC_TOOL_NAMES,
  createBasicToolResultRenderer,
  registerBasicTools,
} from "wish/tools";

function deterministicRuntimeServices() {
  const counters = { run: 0, turn: 0, control: 0, event: 0, time: 0 };
  return {
    ids: {
      runId: () => `run-${++counters.run}`,
      userTurnId: () => `turn-${++counters.turn}`,
      controlId: () => `control-${++counters.control}`,
      eventId: () => `event-${++counters.event}`,
    },
    now: () => new Date(Date.UTC(2026, 0, 1) + ++counters.time).toISOString(),
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function grepMatch(path, lineNumber, text) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: lineNumber,
    },
  });
}

function completedGrepProcess(events) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    for (const event of events) child.stdout.write(`${event}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

test("five Basic Tools complete Registry-to-AgentLoop integration", async () => {
  const operationCalls = [];
  const authorizations = [];
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  let editedContent;
  let writtenContent;

  const registry = new ToolRegistry();
  registerBasicTools(registry, {
    read: {
      operations: {
        async access(path) {
          operationCalls.push(["read.access", path]);
        },
        async detectImageMimeType(path) {
          operationCalls.push(["read.detect", path]);
          return "image/png";
        },
        async readFile(path) {
          operationCalls.push(["read.readFile", path]);
          return image;
        },
      },
    },
    write: {
      operations: {
        async mkdir(path) {
          operationCalls.push(["write.mkdir", path]);
        },
        async writeFile(path, content) {
          operationCalls.push(["write.writeFile", path]);
          writtenContent = content;
        },
      },
    },
    edit: {
      operations: {
        async access(path) {
          operationCalls.push(["edit.access", path]);
        },
        async readFile(path) {
          operationCalls.push(["edit.readFile", path]);
          return Buffer.from("before\n", "utf8");
        },
        async writeFile(path, content) {
          operationCalls.push(["edit.writeFile", path]);
          editedContent = content;
        },
      },
    },
    grep: {
      resolver: {
        async resolve() {
          operationCalls.push(["grep.resolve"]);
          return "/fixtures/rg";
        },
      },
      operations: {
        async isDirectory(path) {
          operationCalls.push(["grep.isDirectory", path]);
          return true;
        },
        async readFile(path) {
          operationCalls.push(["grep.readFile", path]);
          return "needle\n";
        },
        spawnRipgrep(executable, arguments_) {
          operationCalls.push(["grep.spawn", executable, arguments_]);
          return completedGrepProcess([
            grepMatch("/workspace/src/file.ts", 1, "needle"),
          ]);
        },
      },
    },
    bash: {
      operations: {
        async exec(command, cwd, options) {
          operationCalls.push(["bash.exec", command, cwd, options.timeout]);
          options.onData(Buffer.from("bash output", "utf8"));
          return { exitCode: 0 };
        },
      },
    },
  });

  let grantOrdinal = 0;
  let toolClock = 0;
  const executor = new ToolExecutor({
    registry,
    authorization: {
      authorize(input) {
        authorizations.push({
          callId: input.call.id,
          capabilities: input.capabilities,
        });
        return { status: "allowed", policyVersion: "policy-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "policy-1" };
      },
    },
    grantId: () => `grant-${++grantOrdinal}`,
    now: () => new Date(Date.UTC(2099, 0, 1) + ++toolClock),
  });
  const scheduler = new BoundedToolScheduler({ executor, maxParallelCalls: 2 });

  const requests = [];
  const calls = [
    { id: "read-1", name: "read", argumentsJson: '{"path":"image.png"}' },
    {
      id: "write-1",
      name: "write",
      argumentsJson: '{"path":"new.txt","content":"written"}',
    },
    {
      id: "edit-1",
      name: "edit",
      argumentsJson: JSON.stringify({
        path: "edit.txt",
        edits: [{ oldText: "before", newText: "after" }],
      }),
    },
    {
      id: "grep-1",
      name: "grep",
      argumentsJson: '{"pattern":"needle","path":"src"}',
    },
    {
      id: "bash-1",
      name: "bash",
      argumentsJson: '{"command":"printf done","timeout":2}',
    },
  ];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield { type: "start", model: request.model };
      if (requests.length === 1) {
        for (const call of calls) yield { type: "tool_call", call };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", text: "integration complete" };
      yield { type: "done", finishReason: "stop" };
    },
  };

  const loop = new AgentLoop({
    model,
    context: new ContextProjector(),
    tools: registry,
    toolScheduler: scheduler,
    toolResults: createBasicToolResultRenderer(),
    input: {
      renderUserInput(input) {
        return { role: "user", content: input.payload.text };
      },
      renderSteering(input) {
        return { role: "user", content: input.message.text };
      },
    },
    environment: {
      resolve() {
        return {
          model: { provider: "fixture", model: "integration-model" },
          context: { providers: [], input: {} },
          tools: {
            context: { cwd: "/workspace", modelSupportsImages: true },
            authorityVersion: "authority-1",
            availableTools: BASIC_TOOL_NAMES,
          },
        };
      },
    },
  });
  const runtime = new Runtime({
    ...deterministicRuntimeServices(),
    maxSteps: 3,
    stepPipeline: loop,
  });
  const agent = new Agent({ id: "agent" }, runtime);
  const handle = agent.startRun({
    scope: "basic-tools-integration",
    payload: { text: "exercise every Basic Tool" },
  });
  const eventsPromise = collect(agent.observe(handle.runId));
  const completion = await handle.completion;
  const events = await eventsPromise;

  assert.equal(completion.status, "completed");
  assert.equal(completion.result.output.text, "integration complete");
  assert.equal(completion.snapshot.userTurns[0].steps.length, 2);
  assert.equal(requests.length, 2);

  assert.deepEqual(requests[0].tools.map((tool) => tool.name), BASIC_TOOL_NAMES);
  assert.deepEqual(
    Object.fromEntries(requests[0].tools.map((tool) => {
      const schema = JSON.parse(tool.inputSchemaJson);
      assert.equal(schema.additionalProperties, false);
      return [tool.name, schema.required];
    })),
    {
      read: ["path"],
      write: ["path", "content"],
      edit: ["path", "edits"],
      grep: ["pattern"],
      bash: ["command"],
    },
  );

  const secondMessages = requests[1].messages;
  assert.deepEqual(secondMessages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "tool",
    "tool",
    "tool",
  ]);
  assert.deepEqual(
    secondMessages[1].toolCalls.map((call) => call.id),
    calls.map((call) => call.id),
  );
  const toolMessages = secondMessages.slice(2);
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), [
    "read-1",
    "write-1",
    "edit-1",
    "grep-1",
    "bash-1",
  ]);
  assert.equal(toolMessages[0].content, "Read image file [image/png]");
  assert.deepEqual(toolMessages[0].contentParts, [{
    type: "image_url",
    imageUrl: { url: `data:image/png;base64,${image.toString("base64")}` },
  }]);
  assert.equal(toolMessages[1].content, "Successfully wrote 7 bytes to new.txt");
  assert.equal(
    toolMessages[2].content,
    "Successfully replaced 1 block(s) in edit.txt.",
  );
  assert.equal(toolMessages[3].content, "file.ts:1: needle");
  assert.equal(toolMessages[4].content, "bash output");

  assert.deepEqual(authorizations, [
    {
      callId: "read-1",
      capabilities: {
        requirements: [{
          capability: "filesystem.read",
          paths: ["/workspace/image.png"],
        }],
      },
    },
    {
      callId: "write-1",
      capabilities: {
        requirements: [{
          capability: "filesystem.write",
          paths: ["/workspace/new.txt"],
        }],
      },
    },
    {
      callId: "edit-1",
      capabilities: {
        requirements: [
          { capability: "filesystem.read", paths: ["/workspace/edit.txt"] },
          { capability: "filesystem.write", paths: ["/workspace/edit.txt"] },
        ],
      },
    },
    {
      callId: "grep-1",
      capabilities: {
        requirements: [{
          capability: "filesystem.read",
          paths: ["/workspace/src"],
        }],
      },
    },
    {
      callId: "bash-1",
      capabilities: { requirements: [{ capability: "process.exec" }] },
    },
  ]);
  assert.equal(writtenContent, "written");
  assert.equal(editedContent, "after\n");
  assert.equal(
    operationCalls.some((call) =>
      call[0] === "bash.exec" && call[1] === "printf done" &&
      call[2] === "/workspace" && call[3] === 2
    ),
    true,
  );

  const terminalToolEvents = events.filter((event) =>
    event.type === "tool.lifecycle" && event.payload.type === "tool.completed"
  );
  assert.deepEqual(
    terminalToolEvents.map((event) => event.payload.call.id).sort(),
    calls.map((call) => call.id).sort(),
  );
});
