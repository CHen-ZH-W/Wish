import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import ApprovalHub from "../dist/approval/service.js";
import { ApprovalConflictError } from "../dist/approval/index.js";

const request = Object.freeze({
  call: Object.freeze({ status: "ready", id: "call-1", name: "write", input: {} }),
  descriptor: Object.freeze({
    name: "write",
    description: "write",
    inputSchemaJson: "{}",
    executionMode: "sequential",
    recoveryPolicy: "needs-reconciliation",
  }),
  capabilities: Object.freeze({ requirements: Object.freeze([]) }),
  context: Object.freeze({}),
  scope: Object.freeze({ runId: "run-1", userTurnId: "turn-1", stepId: "step-1" }),
  snapshot: Object.freeze({
    schemaVersion: 1,
    registryVersion: 1,
    authorityVersion: "authority-1",
    availableTools: Object.freeze(["write"]),
  }),
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test("Approval Hub is fail-closed and owns one lifecycle-bound answerer", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  try {
    assert.equal(root.approval.hasAnswerer(), false);
    assert.deepEqual(await root.approval.requestApproval(request), {
      status: "denied",
      reason: "Tool approval is unavailable because no answerer is registered",
    });

    const calls = [];
    const answerer = root.plugin({
      inject: ["approval"],
      apply(ctx) {
        ctx.approval.register({
          requestApproval(input, signal) {
            calls.push({ input, signal });
            return {
              status: "approved",
              scope: "run",
              metadata: { source: "test", nested: { once: true } },
            };
          },
        });
      },
    });
    await answerer.await();
    assert.equal(root.approval.hasAnswerer(), true);
    const approved = await root.approval.requestApproval(request);
    assert.deepEqual(approved, {
      status: "approved",
      scope: "run",
      metadata: { source: "test", nested: { once: true } },
    });
    assert.equal(Object.isFrozen(approved), true);
    assert.equal(Object.isFrozen(approved.metadata), true);
    assert.equal(Object.isFrozen(approved.metadata.nested), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, request);

    assert.throws(
      () => root.approval.register({
        requestApproval: () => ({ status: "approved" }),
      }),
      ApprovalConflictError,
    );

    await answerer.dispose();
    assert.equal(root.approval.hasAnswerer(), false);
    assert.equal(
      (await root.approval.requestApproval(request)).status,
      "denied",
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("Approval Hub preserves AbortSignal and validates the answer", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  root.approval.register({
    requestApproval() {
      return { status: "approved", metadata: { invalid: new Date() } };
    },
  });
  try {
    await assert.rejects(
      root.approval.requestApproval(request),
      /metadata must contain only plain values/u,
    );
    const controller = new AbortController();
    const reason = new Error("stop approval");
    controller.abort(reason);
    await assert.rejects(
      root.approval.requestApproval(request, controller.signal),
      reason,
    );
  } finally {
    await root.fiber.dispose();
  }
});

test("same-surface generation replacement rolls back to the prior answerer", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  const answerer = (label) => root.plugin({
    inject: ["approval"],
    apply(ctx) {
      ctx.approval.register({
        requestApproval: () => ({
          status: "approved",
          metadata: { label },
        }),
      }, { id: "webui-surface", replace: true });
    },
  });

  try {
    const first = answerer("first");
    await first.await();
    assert.equal(
      (await root.approval.requestApproval(request)).metadata.label,
      "first",
    );

    const second = answerer("second");
    await second.await();
    assert.equal(
      (await root.approval.requestApproval(request)).metadata.label,
      "second",
    );

    await second.dispose();
    assert.equal(
      (await root.approval.requestApproval(request)).metadata.label,
      "first",
    );

    await first.dispose();
    assert.equal(root.approval.hasAnswerer(), false);
  } finally {
    await root.fiber.dispose();
  }
});

test("answerer retirement cancels pending approval and ignores a late allow", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  const answer = deferred();
  let answerSignal;
  const answerer = root.plugin({
    inject: ["approval"],
    apply(ctx) {
      ctx.approval.register({
        requestApproval(_input, signal) {
          answerSignal = signal;
          return answer.promise;
        },
      });
    },
  });
  try {
    await answerer.await();
    const pending = root.approval.requestApproval(request);
    assert.equal(answerSignal.aborted, false);
    await answerer.dispose();
    assert.equal(answerSignal.aborted, true);
    assert.deepEqual(await pending, {
      status: "denied",
      reason: "Tool approval was cancelled because its answerer was unregistered",
    });
    answer.resolve({ status: "approved", scope: "workspace" });
    await Promise.resolve();
    assert.equal(root.approval.hasAnswerer(), false);
  } finally {
    answer.resolve({ status: "denied", reason: "fixture cleanup" });
    await root.fiber.dispose();
  }
});

test("answerer replacement cancels requests routed to the old generation", async () => {
  const root = new Context();
  await root.plugin(ApprovalHub);
  const oldAnswer = deferred();
  const first = root.plugin({
    inject: ["approval"],
    apply(ctx) {
      ctx.approval.register({
        requestApproval: () => oldAnswer.promise,
      }, { id: "webui-surface", replace: true });
    },
  });
  let second;
  try {
    await first.await();
    const pending = root.approval.requestApproval(request);
    second = root.plugin({
      inject: ["approval"],
      apply(ctx) {
        ctx.approval.register({
          requestApproval: () => ({ status: "approved", scope: "once" }),
        }, { id: "webui-surface", replace: true });
      },
    });
    await second.await();
    assert.deepEqual(await pending, {
      status: "denied",
      reason: "Tool approval was cancelled because its answerer was replaced",
    });
    assert.equal(
      (await root.approval.requestApproval(request)).status,
      "approved",
    );
  } finally {
    oldAnswer.resolve({ status: "approved", scope: "workspace" });
    await second?.dispose();
    await first.dispose();
    await root.fiber.dispose();
  }
});
