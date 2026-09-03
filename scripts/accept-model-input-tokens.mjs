import assert from "node:assert/strict";
import test from "node:test";

import { ModelRequestTokenCounter } from "../dist/models/input-tokens.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function request() {
  return {
    model: { ...model },
    messages: [
      {
        role: "assistant",
        content: "answer",
        reasoningContent: "reasoning",
        toolCalls: [{
          id: "call-1",
          name: "lookup",
          argumentsJson: '{"query":"value"}',
        }],
      },
      {
        role: "user",
        content: "question",
        contentParts: [{
          type: "image_url",
          imageUrl: { url: "data:image/png;base64,YQ==", detail: "low" },
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Lookup a value",
      inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}}}',
    }],
    maxOutputTokens: 512,
    metadata: { trace: { id: "trace-1" } },
  };
}

test("counts one immutable complete request for an exact model identity", async () => {
  const counter = new ModelRequestTokenCounter();
  let tokenizerInput;
  counter.register(model, {
    method: "fixture-request-tokenizer-v1",
    count(input) {
      tokenizerInput = input;
      assert.equal(input.request.messages[0].reasoningContent, "reasoning");
      assert.equal(
        input.request.messages[0].toolCalls[0].argumentsJson,
        '{"query":"value"}',
      );
      assert.equal(input.request.messages[1].contentParts[0].type, "image_url");
      assert.match(input.request.tools[0].inputSchemaJson, /properties/u);
      return 73;
    },
  });
  const source = request();
  const count = await counter.count({ request: source });

  source.messages[0].content = "mutated";
  source.messages[1].contentParts[0].imageUrl.url = "mutated";
  source.tools[0].inputSchemaJson = "{}";
  assert.deepEqual(count, {
    inputTokens: 73,
    method: "fixture-request-tokenizer-v1",
  });
  assert.equal(tokenizerInput.request.messages[0].content, "answer");
  assert.equal(
    tokenizerInput.request.messages[1].contentParts[0].imageUrl.url,
    "data:image/png;base64,YQ==",
  );
  assert.match(tokenizerInput.request.tools[0].inputSchemaJson, /properties/u);
  assert.equal(Object.isFrozen(tokenizerInput.request), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.messages), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.messages[1].contentParts), true);
  assert.equal(Object.isFrozen(tokenizerInput.request.tools), true);
  assert.equal(Object.isFrozen(count), true);
});

test("returns unavailable for an unregistered model or tokenizer failure", async () => {
  const counter = new ModelRequestTokenCounter();
  counter.register(model, {
    method: "failing-tokenizer",
    count() {
      throw new Error("tokenizer data unavailable");
    },
  });

  assert.equal(await counter.count({
    request: { ...request(), model: { provider: "provider", model: "other" } },
  }), undefined);
  assert.equal(await counter.count({ request: request() }), undefined);
});

test("rejects duplicate registration and invalid counts", async () => {
  const counter = new ModelRequestTokenCounter();
  counter.register(model, { method: "fixture", count: () => -1 });
  assert.throws(() => counter.register(model, {
    method: "duplicate",
    count: () => 1,
  }), /already registered/u);
  await assert.rejects(
    counter.count({ request: request() }),
    /inputTokens must be a non-negative safe integer/u,
  );
  assert.throws(() => new ModelRequestTokenCounter().register(model, {
    method: " untrimmed ",
    count: () => 1,
  }), /non-empty trimmed string/u);
});

test("passes abort to the active request tokenizer", async () => {
  const counter = new ModelRequestTokenCounter();
  const controller = new AbortController();
  const reason = new Error("stop request counting");
  let observedSignal;
  counter.register(model, {
    method: "abortable-tokenizer",
    count(input) {
      observedSignal = input.signal;
      controller.abort(reason);
      throw reason;
    },
  });

  await assert.rejects(counter.count({
    request: request(),
    signal: controller.signal,
  }), reason);
  assert.strictEqual(observedSignal, controller.signal);
});
