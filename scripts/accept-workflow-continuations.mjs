import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowContinuations } from "../dist/workflow/continuations.js";
import { ChildWorkflowScheduler } from "../dist/workflow/child-scheduler.js";

const terminal = { id: "workflow", status: "completed", steps: [] };
function parent(accepted = true) {
  const view = { holds: 0, releases: 0, messages: [] };
  return { view, deferCompletion() { view.holds++; return { release() { view.releases++; } }; },
    followUp(message) { assert.equal(view.releases, 0); view.messages.push(message); return { accepted }; } };
}
const options = continuations => ({ continuations,
  workflow: { get: async () => terminal, list: async () => [terminal] }, subagents: {} });

test("replacing observers keeps the original parent hold and delivers once without re-watch", async () => {
  const continuations = new WorkflowContinuations(), p = parent();
  const old = new ChildWorkflowScheduler(options(continuations));
  old.watch(terminal.id, p); await old.close();
  assert.equal(p.view.releases, 0); assert.equal(continuations.size, 1);
  const next = new ChildWorkflowScheduler(options(continuations));
  await next.tick(); await next.tick();
  assert.equal(p.view.holds, 1); assert.equal(p.view.releases, 1); assert.equal(p.view.messages.length, 1);
  await next.close(); continuations.close(); assert.equal(p.view.releases, 1);
});

test("failed restoration does not release parents; cancellation and owner teardown do", async () => {
  const continuations = new WorkflowContinuations(), p = parent(), abort = new AbortController();
  const broken = new ChildWorkflowScheduler({ ...options(continuations), workflow: { get: async () => { throw Error("storage unavailable"); } } });
  broken.watch(terminal.id, p, abort.signal); await broken.close();
  assert.equal(p.view.releases, 0); assert.equal(p.view.messages.length, 0);
  abort.abort(); assert.equal(p.view.releases, 1); assert.equal(continuations.size, 0);
  const other = parent(); continuations.watch("other", other); continuations.close(); continuations.close();
  assert.equal(other.view.releases, 1);
});

test("duplicate watch shares a hold; rejected follow-up is not silently discarded", () => {
  const continuations = new WorkflowContinuations(), p = parent(false);
  continuations.watch(terminal.id, p); continuations.watch(terminal.id, p);
  continuations.publish(terminal);
  assert.equal(p.view.holds, 1); assert.equal(p.view.releases, 0); assert.equal(continuations.size, 1);
  continuations.close(); assert.equal(p.view.releases, 1);
});
