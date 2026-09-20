import assert from "node:assert/strict";
import test from "node:test";

import { ModelContextBudgetEvaluator } from "../dist/context/index.js";
import { ContextProjector } from "../dist/core/context/projector.js";

const model = Object.freeze({ provider: "provider", model: "model" });

function request() {
  return {
    model,
    instructions: [{ role: "system", content: "stable" }],
    messages: [{ role: "user", content: "complete final request" }],
    tools: [{
      name: "lookup",
      description: "Lookup",
      inputSchemaJson: '{"type":"object"}',
    }],
  };
}

function evaluator(inputTokens, overrides = {}) {
  return new ModelContextBudgetEvaluator({
    models: {
      getContextWindowTokens(reference) {
        assert.deepEqual(reference, model);
        return 100;
      },
    },
    counter: {
      count({ request: finalRequest }) {
        assert.equal(finalRequest.instructions[0].content, "stable");
        assert.equal(finalRequest.messages[0].content, "complete final request");
        assert.equal(finalRequest.tools[0].inputSchemaJson, '{"type":"object"}');
        return { inputTokens, method: "fixture-request-tokenizer-v1" };
      },
    },
    reservedOutputTokens: 20,
    ...overrides,
  });
}

async function project(budget) {
  return new ContextProjector({ budget }).project({
    request: request(),
    groups: [],
    currentUserMessageIndex: 0,
  });
}

test("accepts the exact input limit and reports deterministic budget details", async () => {
  const projection = await project(evaluator(80));

  assert.equal(projection.status, "ready");
  assert.deepEqual(projection.budget, {
    status: "within_budget",
    estimatedInputTokens: 80,
    inputLimitTokens: 80,
    details: {
      contextWindowTokens: 100,
      reservedOutputTokens: 20,
      remainingInputTokens: 0,
      countMethod: "fixture-request-tokenizer-v1",
    },
  });
  assert.equal(Object.isFrozen(projection.budget), true);
  assert.equal(Object.isFrozen(projection.budget.details), true);
});

test("turns one token over the limit into Core rejected(over_budget)", async () => {
  const projection = await project(evaluator(81));

  assert.equal(projection.status, "rejected");
  assert.equal(projection.reason, "over_budget");
  assert.equal(projection.budget.status, "over_budget");
  assert.equal(projection.budget.estimatedInputTokens, 81);
  assert.equal(projection.budget.inputLimitTokens, 80);
  assert.equal(projection.budget.details.remainingInputTokens, -1);
  assert.equal(projection.candidateRequest.messages[0].content, "complete final request");
  assert.equal("request" in projection, false);
});

test("reports unknown without inventing a model window or token count", async () => {
  let countCalls = 0;
  const missingWindow = new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => undefined },
    counter: {
      count() {
        countCalls += 1;
        return { inputTokens: 1, method: "must-not-run" };
      },
    },
    reservedOutputTokens: 20,
  });
  const windowProjection = await project(missingWindow);
  assert.equal(windowProjection.status, "ready");
  assert.deepEqual(windowProjection.budget, {
    status: "unknown",
    details: {
      reason: "context_window_unavailable",
      reservedOutputTokens: 20,
    },
  });
  assert.equal(countCalls, 0);

  const missingTokenizer = new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => 100 },
    counter: { count: () => undefined },
    reservedOutputTokens: 20,
  });
  const tokenizerProjection = await project(missingTokenizer);
  assert.equal(tokenizerProjection.status, "ready");
  assert.deepEqual(tokenizerProjection.budget, {
    status: "unknown",
    inputLimitTokens: 80,
    details: {
      reason: "input_token_count_unavailable",
      reservedOutputTokens: 20,
      contextWindowTokens: 100,
    },
  });
});

test("fails closed for impossible limits and invalid counter output", async () => {
  assert.throws(() => new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => 100 },
    counter: { count: () => ({ inputTokens: 1, method: "fixture" }) },
    reservedOutputTokens: -1,
  }), /reservedOutputTokens must be a non-negative safe integer/u);

  await assert.rejects(project(new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => 20 },
    counter: { count: () => ({ inputTokens: 1, method: "fixture" }) },
    reservedOutputTokens: 20,
  })), /must be less than contextWindowTokens/u);

  await assert.rejects(project(new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => 100 },
    counter: { count: () => ({ inputTokens: -1, method: "fixture" }) },
    reservedOutputTokens: 20,
  })), /inputTokens must be a non-negative safe integer/u);
});

test("passes abort through the request token-count boundary", async () => {
  const controller = new AbortController();
  const reason = new Error("stop budget evaluation");
  let observedSignal;
  const budget = new ModelContextBudgetEvaluator({
    models: { getContextWindowTokens: () => 100 },
    counter: {
      count(input) {
        observedSignal = input.signal;
        controller.abort(reason);
        return { inputTokens: 10, method: "abortable" };
      },
    },
    reservedOutputTokens: 20,
  });

  await assert.rejects(budget.assess({
    request: request(),
    signal: controller.signal,
  }), reason);
  assert.strictEqual(observedSignal, controller.signal);
});
