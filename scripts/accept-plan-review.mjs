import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanRuntime, DomainPlanStateStore, MemoryPlanStateStore } from "../dist/plan/index.js";
import { FileKvStorageBackend } from "../dist/storage/providers/file/kv.js";
import { createPlanSessionFeature } from "../dist/plan/consumers/session-feature.js";
import { SessionFeatureRegistry } from "../dist/apps/session-features.js";
import { reviewCommand } from "../dist/apps/cli/session-features.js";

test("Review feedback persists, invalidates approval, and requires a revised document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-review-"));
  const kv = new FileKvStorageBackend({ backendId: "fixture", rootDirectory: directory });
  const storage = { backend: () => ({ id: "fixture", capabilities: { writerConcurrency: "process-local", kv: { list: true } }, kv }) };
  const open = () => new PlanRuntime({ store: new DomainPlanStateStore({ storage, backendId: "fixture" }) });
  let plan = open();
  try {
    await plan.enter({ sessionId: "s" });
    await plan.update({ sessionId: "s", markdown: "# First" });
    const submitted = await plan.review({ sessionId: "s", markdown: "# First", expectedPlanVersion: 1 });
    await plan.close(); plan = open();
    assert.deepEqual((await plan.get({ sessionId: "s" })).review, submitted.review);
    const old = { sessionId: "s", reviewId: submitted.review.id, expectedPlanVersion: 1, digest: submitted.document.digest, actor: "user" };
    await plan.decide({ ...old, decision: "keep-planning", feedback: "Use another design" });
    await assert.rejects(plan.decide({ ...old, decision: "approve" }), /no longer pending/);
    await assert.rejects(plan.review({ sessionId: "s", markdown: "# First", expectedPlanVersion: 1 }), /Revise/);
    await plan.update({ sessionId: "s", markdown: "# Second" });
    const second = await plan.review({ sessionId: "s", markdown: "# Second", expectedPlanVersion: 2 });
    await assert.rejects(plan.decide({ ...old, decision: "approve" }), /does not match/);
    const approved = await plan.decide({ ...old, reviewId: second.review.id, expectedPlanVersion: 2, digest: second.document.digest, decision: "approve" });
    assert.equal(approved.active, false);
  } finally { await plan.close(); await kv.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Ordinary human input resumes planning and stale review cannot approve", async () => {
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  const features = new SessionFeatureRegistry();
  features.register("plan", createPlanSessionFeature(plan));
  await plan.enter({ sessionId: "s" });
  await plan.update({ sessionId: "s", markdown: "# Plan" });
  await plan.review({ sessionId: "s", markdown: "# Plan", expectedPlanVersion: 1 });
  const [view] = await features.inspect("s");
  await features.beforeInput("s", "Add a migration test first");
  assert.equal((await plan.get({ sessionId: "s" })).review.feedback, "Add a migration test first");
  await assert.rejects(features.act("s", "plan", "approve", view.token), /no longer pending/);
  assert.equal((await plan.get({ sessionId: "s" })).active, true);
});

test("CLI review uses the displayed identity and supports another planning round", async () => {
  const plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  const features = new SessionFeatureRegistry(); features.register("plan", createPlanSessionFeature(plan));
  const output = []; const terminal = { async writeOutput(text) { output.push(text); }, async writeError(text) { output.push(text); } };
  await plan.enter({ sessionId: "s" }); await plan.update({ sessionId: "s", markdown: "first" });
  const submitted = await plan.review({ sessionId: "s", markdown: "first", expectedPlanVersion: 1 });
  assert.equal((await reviewCommand(features, "s", "/review", terminal)).handled, true);
  assert.match(output.join(""), new RegExp(submitted.review.id));
  const response = await reviewCommand(features, "s", `/review plan keep-planning ${submitted.review.id} revise the tests`, terminal);
  assert.match(response.message, /revise the tests/);
  assert.equal((await plan.get({ sessionId: "s" })).active, true);
  await assert.rejects(reviewCommand(features, "s", `/review plan approve ${submitted.review.id}`, terminal), /Stale/);
});
