import assert from "node:assert/strict";
import test from "node:test";
import { captureSessionEvidence, SessionRunEvidenceSource } from "../dist/memory/adapters/session-evidence.js";
import { WorkflowAttemptEvidenceSource } from "../dist/memory/adapters/workflow-evidence.js";
import { hash } from "../dist/memory/validation.js";

function message(sequence, runId = "run-1", role = "user", inputSource) {
  return { schemaVersion: 1, kind: "message", recordId: `record-${sequence}`, sequence,
    idempotencyKey: `message-${sequence}`, runId, userTurnId: "turn-1", stepId: "step-1",
    origin: role === "assistant" ? "assistant" : "user_input", createdAt: "2026-09-13T00:00:00.000Z",
    message: { role, content: role === "system" ? "SECRET SYSTEM INSTRUCTION" : `message ${sequence}` },
    ...(inputSource === undefined ? {} : { inputSource }) };
}
function event(type, runId = "run-1") { return { schemaVersion: 1, type, runId, occurredAt: "2026-09-13T00:01:00.000Z", scope: "session-1" }; }

test("Session evidence is bounded to committed Run records and stable after later conversation", async () => {
  const records = [message(1), message(2, "run-1", "assistant"), message(3, "run-1", "user", "follow_up")];
  let revision = "global-v1";
  const sessions = { readHistory: async () => ({ records, historyRevision: revision }) };
  const input = { sessions, sessionId: "session-1", runId: "run-1", terminal: event("run.completed") };
  const first = await captureSessionEvidence(input);
  assert.equal(first.references[0].digest, hash(records));
  assert.equal(first.references[0].throughSequence, 3);
  assert.equal(first.references[0].id, "session-1:run-1");
  assert.match(first.text, /"inputSource":"unknown"/);
  assert.match(first.text, /"inputSource":"follow_up"/);
  records.push(message(4, "run-2")); revision = "global-v2";
  assert.deepEqual(await captureSessionEvidence(input), first);
  assert.equal(Object.isFrozen(first.references), true);
  await assert.rejects(captureSessionEvidence({ ...input, terminal: event("run.opened") }), /terminal/);
  await assert.rejects(captureSessionEvidence({ ...input, signal: AbortSignal.abort(new Error("stop")) }), /stop/);
});

test("backscan recovers missed terminal notifications, excludes active Runs and system instructions", async () => {
  const records = [message(1, "run-1", "system"), message(2), message(3, "run-2")];
  let events = [event("run.opened"), event("run.opened", "run-2")];
  const source = new SessionRunEvidenceSource({ readHistory: async () => ({ records }) }, { readEvents: async () => events });
  assert.deepEqual(await source.scan(), []);
  events = [...events, event("run.failed")];
  const found = await source.scan();
  assert.equal(found.length, 1); assert.equal(found[0].outcome, "failed");
  assert.equal(found[0].text.includes("SECRET SYSTEM INSTRUCTION"), false);
  assert.deepEqual(await source.scan(), found);
});

test("Workflow evidence uses terminal attempt identity, not later unrelated workflow revisions", async () => {
  const attempt = { id: "attempt-1", status: "failed", ordinal: 1, result: "Tests did not run", endedAt: "2026-09-13T00:01:00.000Z" };
  const workflow = { id: "workflow-1", revision: 1, owner: { parentSessionId: "session-1", parentRunId: "run-1", workspaceRoot: "/project" },
    steps: [{ task: { id: "task-1" }, attempts: [attempt, { id: "attempt-2", status: "running" }] }] };
  const source = new WorkflowAttemptEvidenceSource({ list: async () => [workflow] });
  const first = await source.scan();
  assert.equal(first.length, 1); assert.equal(first[0].outcome, "failed");
  workflow.revision++; workflow.steps.push({ task: { id: "task-other" }, attempts: [] });
  assert.deepEqual(await source.scan(), first);
  attempt.status = "interrupted";
  assert.equal((await source.scan())[0].outcome, "unknown");
});

test("clipped evidence is visibly incomplete while references bind original committed records", async () => {
  const records = [message(1), message(2, "run-1", "assistant"), message(3)];
  for (const record of records) record.message.content = "x".repeat(20_000);
  const captured = await captureSessionEvidence({ sessions: { readHistory: async () => ({ records }) },
    sessionId: "session-1", runId: "run-1", terminal: event("run.completed") });
  assert.match(captured.text, /TRUNCATED EVIDENCE/);
  assert.equal(captured.text.length <= 30_000, true);
  assert.equal(captured.references[0].digest, hash(records));
  assert.equal(captured.references[0].throughSequence, 3);
});
