import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { projectLedger } from "../dist/apps/webui/client/projection/ledger.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { registerManagedContextObserver } from "../dist/context/managed.js";
import { projectSystemPromptSnapshot } from "../dist/system-prompt/consumers/history.js";
import { SystemPromptHistoryClientModel } from "../dist/system-prompt/consumers/webui/model.js";
import { coalescePromptSections, SystemPromptHistoryRow } from "../dist/system-prompt/consumers/webui/view.js";
import { JournalSystemPromptHistory, SYSTEM_PROMPT_HISTORY_NAMESPACE } from "../dist/system-prompt/history/ledger.js";
import { FileJournalStorageBackend } from "../dist/storage/providers/file/journal.js";

const model = Object.freeze({ provider: "deepseek", model: "deepseek-chat" });
const contextInput = Object.freeze({
  sessionId: "session-a", runId: "run-a", userTurnId: "turn-a", stepId: "step-a", model,
  workspace: { cwd: "/workspace", fingerprint: "workspace", revision: "revision", instructions: [] },
  runtime: { capturedAt: "2026-10-10T10:00:00.000Z", stateVersion: 1, userTurnOrdinal: 1, stepOrdinal: 1 },
});

function projection(stable = "Stable rules", dynamic = "Tool rules") {
  const item = { id: "system-prompt:tool", kind: "instruction", placement: "dynamic_tail",
    message: { role: "developer", content: dynamic } };
  return { status: "ready", request: { model, instructions: [{ role: "system", content: stable }], messages: [], tools: [] },
    includedItems: [item], providerGroups: [{ providerId: "system-prompt", items: [item] }], history: { items: [] }, budget: { status: "unknown" } };
}

test("ready projection preserves exact instruction and dynamic-tail channels", () => {
  const snapshot = projectSystemPromptSnapshot(contextInput, projection());
  assert.deepEqual(snapshot.sections, [
    { channel: "instructions", role: "system", content: "Stable rules" },
    { channel: "dynamic_tail", role: "developer", content: "Tool rules" },
  ]);
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/u);
  assert.equal(projectSystemPromptSnapshot(contextInput, { ...projection(), status: "rejected", candidateRequest: projection().request }), undefined);
});

test("WebUI coalesces adjacent prompt sections with the same channel and role", () => {
  const sections = [
    { channel: "instructions", role: "system", content: "Stable rules" },
    { channel: "dynamic_tail", role: "developer", content: "Read guidance" },
    { channel: "dynamic_tail", role: "developer", content: "Edit guidance" },
    { channel: "dynamic_tail", role: "system", content: "System guidance" },
    { channel: "dynamic_tail", role: "developer", content: "Later guidance" },
  ];
  assert.deepEqual(coalescePromptSections(sections), [
    { channel: "instructions", role: "system", content: "Stable rules" },
    { channel: "dynamic_tail", role: "developer", content: "Read guidance\n\nEdit guidance" },
    { channel: "dynamic_tail", role: "system", content: "System guidance" },
    { channel: "dynamic_tail", role: "developer", content: "Later guidance" },
  ]);
});

test("managed projection observer unplugs with its consumer and drains admitted work", async () => {
  const root = new Context();
  let observer;
  let unregistered = false;
  root.provide("contextEngine", {
    registerObserver(_id, value) {
      observer = value;
      return { id: "probe", unregister() { observer = undefined; unregistered = true; return true; } };
    },
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const consumer = root.plugin({ name: "prompt-observer-probe", inject: ["contextEngine"], apply(ctx) {
    registerManagedContextObserver(ctx, "probe", async () => { await held; });
  } });
  await consumer;
  const admitted = observer(contextInput, projection());
  const disposing = consumer.dispose();
  await Promise.resolve();
  assert.equal(unregistered, false);
  release();
  await admitted;
  await disposing;
  assert.equal(unregistered, true);
  assert.equal(observer, undefined);
  await root.fiber.dispose();
});

test("System Prompt history survives reopen and keeps the latest Step snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-system-prompt-history-"));
  const backend = new FileJournalStorageBackend({ backendId: "test", rootDirectory: directory });
  try {
    const first = new JournalSystemPromptHistory(backend.open({ namespace: SYSTEM_PROMPT_HISTORY_NAMESPACE }), "test");
    const snapshot = projectSystemPromptSnapshot(contextInput, projection());
    await first.record(snapshot);
    await first.record(snapshot);
    await first.close();

    const second = new JournalSystemPromptHistory(backend.open({ namespace: SYSTEM_PROMPT_HISTORY_NAMESPACE }), "test");
    const records = await second.list("session-a");
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].sections, snapshot.sections);
    assert.equal(Object.isFrozen(records[0]), true);
    await second.close();
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("client contributes collapsed initial and changed prompts in conversation order", async () => {
  const first = { schemaVersion: 1, ...projectSystemPromptSnapshot(contextInput, projection()) };
  const same = { ...first, stepId: "step-b", capturedAt: "2026-10-10T10:01:00.000Z" };
  const changedInput = { ...contextInput, stepId: "step-c", runtime: { ...contextInput.runtime, capturedAt: "2026-10-10T10:02:00.000Z" } };
  const changed = { schemaVersion: 1, ...projectSystemPromptSnapshot(changedInput, projection("Changed rules", "Tool rules")) };
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  connection.onInvalidation = () => () => {};
  connection.request = async () => ({ value: { schemaVersion: 1, sessionId: "session-a", snapshots: [first, same, changed] } });
  const sessions = new SnapshotStore({ selectedId: "session-a" });
  sessions.run = new SnapshotStore({ runId: "run-a", events: [], terminal: false });
  const source = new SystemPromptHistoryClientModel(connection, sessions);
  try {
    await source.refresh();
    const blocks = source.getSnapshot();
    assert.deepEqual(blocks.map(block => block.title), ["系统提示词", "系统提示词更新"]);
    assert.deepEqual(blocks.map(block => block.anchor), ["turn-start", "step-start"]);

    const turns = projectLedger(null, [{
      type: "runtime.transition", runId: "run-a", userTurnId: "turn-a", stepId: "step-a",
      occurredAt: "2026-10-10T09:59:59.000Z", payload: { type: "user_turn.started", userTurnId: "turn-a", input: { text: "Hello" } },
    }], "zh-CN", blocks);
    assert.equal(turns[0].blocks[0].title, "系统提示词");
    const html = renderToStaticMarkup(createElement(SystemPromptHistoryRow, { block: blocks[0] }));
    assert.match(html, /<details class="system-prompt-disclosure">/u);
    assert.match(html, /系统提示词/u);
    assert.doesNotMatch(html, /Stable rules/u, "large prompt bodies mount only after disclosure");

    const slots = new UiSlots();
    const remove = slots.ledger({ id: "system-prompt-history", source, View: SystemPromptHistoryRow });
    assert.deepEqual(slots.getSnapshot().ledgerContributions.map(item => item.id), ["system-prompt-history"]);
    remove();
    assert.deepEqual(slots.getSnapshot().ledgerContributions, []);
  } finally { source.close(); }
});
