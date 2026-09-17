import assert from "node:assert/strict";
import test from "node:test";

import {
  createBasicToolResultRenderer,
  renderBasicToolResult,
} from "../dist/tools/presentation/result-renderer.js";

function success(toolName, output, callId = `${toolName}-call`) {
  return {
    ok: true,
    callId,
    toolName,
    output,
    phase: "completed",
  };
}

test("renders text content as one paired Tool message", () => {
  const result = success("read", {
    path: "notes.txt",
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  }, "read-1");

  assert.deepEqual(renderBasicToolResult(result), {
    role: "tool",
    content: "first\nsecond",
    toolCallId: "read-1",
  });
});

test("maps Read images to provider-neutral image_url content parts", () => {
  const message = renderBasicToolResult(success("read", {
    path: "image.png",
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  }, "read-image"));

  assert.deepEqual(message, {
    role: "tool",
    content: "Read image file [image/png]",
    toolCallId: "read-image",
    contentParts: [{
      type: "image_url",
      imageUrl: { url: "data:image/png;base64,aGVsbG8=" },
    }],
  });
  assert.equal(message.content.includes("aGVsbG8="), false);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.contentParts), true);
  assert.equal(Object.isFrozen(message.contentParts[0]), true);
  assert.equal(Object.isFrozen(message.contentParts[0].imageUrl), true);
});

test("does not promote image-shaped content from a non-Read Tool", () => {
  assert.deepEqual(renderBasicToolResult(success("bash", {
    content: [
      { type: "text", text: "kept" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    exitCode: 0,
  })), {
    role: "tool",
    content: "kept",
    toolCallId: "bash-call",
  });
});

test("renders Write and Edit outputs as stable success text", () => {
  assert.equal(
    renderBasicToolResult(success("write", {
      path: "src/new.ts",
      bytesWritten: 12,
    })).content,
    "Successfully wrote 12 bytes to src/new.ts",
  );
  assert.equal(
    renderBasicToolResult(success("edit", {
      path: "src/edit.ts",
      editsApplied: 2,
      diff: "a very large diff is not model-visible",
      firstChangedLine: 3,
    })).content,
    "Successfully replaced 2 block(s) in src/edit.ts.",
  );
});

test("renders Grep and Bash text without exposing their result metadata", () => {
  assert.deepEqual(renderBasicToolResult(success("grep", {
    path: ".",
    content: [{ type: "text", text: "src/a.ts:1:match" }],
    matches: 1,
  })), {
    role: "tool",
    content: "src/a.ts:1:match",
    toolCallId: "grep-call",
  });
  assert.deepEqual(renderBasicToolResult(success("bash", {
    content: [{ type: "text", text: "command output" }],
    exitCode: 0,
  })), {
    role: "tool",
    content: "command output",
    toolCallId: "bash-call",
  });
});

test("renders failures with their stable code and message", () => {
  assert.deepEqual(renderBasicToolResult({
    ok: false,
    callId: "edit-failed",
    toolName: "edit",
    error: {
      code: "conflict",
      message: "old text is not unique",
      retryable: false,
      phase: "dispatched",
      details: { internal: "not model-visible" },
    },
    phase: "dispatched",
  }), {
    role: "tool",
    content: "Tool failed [conflict]: old text is not unique",
    toolCallId: "edit-failed",
  });
});

test("uses compact JSON and a stable empty marker for unknown output shapes", () => {
  assert.equal(
    renderBasicToolResult(success("custom", { value: 1, ready: true })).content,
    '{"value":1,"ready":true}',
  );
  assert.equal(
    renderBasicToolResult(success("custom", undefined)).content,
    "(no output)",
  );
  assert.equal(
    renderBasicToolResult(success("custom", "plain text")).content,
    "plain text",
  );
});

test("factory implements the AgentLoop renderer contract", () => {
  const renderer = createBasicToolResultRenderer();
  const result = success("read", {
    path: "a.txt",
    content: [{ type: "text", text: "hello" }],
  }, "factory-call");

  assert.deepEqual(renderer.render({
    call: { status: "ready", id: "factory-call", name: "read", input: {} },
    result,
    snapshot: {},
  }), {
    role: "tool",
    content: "hello",
    toolCallId: "factory-call",
  });
  assert.equal(Object.isFrozen(renderer), true);
});
