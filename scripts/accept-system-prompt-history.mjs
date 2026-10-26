import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { ClientApiError } from "../dist/apps/webui/client/connection.js";
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

function promptResponse(sessionId) {
  return { value: { schemaVersion: 1, sessionId, snapshots: [{
    schemaVersion: 1, ...projectSystemPromptSnapshot({ ...contextInput, sessionId }, projection()),
  }] } };
}

function promptClient() {
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a", error: null });
  connection.onInvalidation = () => () => {};
  let read = async sessionId => promptResponse(sessionId);
  connection.request = path => read(decodeURIComponent(path.split("/")[3]));
  const sessions = new SnapshotStore({ selectedId: "session-a" });
  sessions.run = new SnapshotStore({ runId: null, events: [], terminal: false });
  const source = new SystemPromptHistoryClientModel(connection, sessions);
  return { connection, sessions, source, readWith(handler) { read = handler; } };
}

test("a transient prompt freshness failure does not unmount a verified disclosure", async () => {
  const fixture = promptClient(), { source } = fixture;
  try {
    await source.refresh();
    const verified = source.getSnapshot(), block = verified[0];
    source.disclosure(block.id).setOpen(true);
    const visibleLengths = [];
    const remove = source.subscribe(() => visibleLengths.push(source.getSnapshot().length));
    for (const error of [new TypeError("Failed to fetch"), new ClientApiError("internal_error", 500)]) {
      fixture.readWith(async () => { throw error; });
      await source.refresh();
      assert.strictEqual(source.getSnapshot(), verified, "failed freshness reads retain the verified blocks, keeping their React subtree mounted");
      assert.equal(source.disclosure(block.id).open, true);
    }
    assert.deepEqual(visibleLengths, [], "there is no empty-state publication between verified reads");
    remove();
  } finally { source.close(); }
});

test("returning from a new intent or another Session restores the cached prompt before its HTTP refresh", async () => {
  const fixture = promptClient(), { source, sessions } = fixture;
  let release;
  try {
    await source.refresh();
    const verified = source.getSnapshot(), block = verified[0];
    source.disclosure(block.id).setOpen(true);
    sessions.publish({ selectedId: null });
    assert.equal(source.getSnapshot().length, 0, "a new intent does not display the previous Session prompt");
    sessions.publish({ selectedId: "session-b" });
    await source.refresh();
    assert.equal(source.disclosure(source.getSnapshot()[0].id).open, false, "another Session does not inherit expansion, even with identical run/Step/digest IDs");
    const gate = new Promise(resolve => { release = resolve; });
    fixture.readWith(async sessionId => { await gate; return promptResponse(sessionId); });
    sessions.publish({ selectedId: "session-a" });
    assert.strictEqual(source.getSnapshot(), verified, "the original prompt is restored synchronously while its freshness request is blocked");
    assert.equal(source.disclosure(block.id).open, true, "the owner restores the original disclosure after its view was unmounted");
    release(); await source.refresh();
  } finally { release?.(); source.close(); }
});

test("prompt cache and disclosure state are fenced by Host, availability and owner lifetime", async () => {
  const fixture = promptClient(), { source, connection } = fixture;
  let release;
  try {
    await source.refresh();
    const block = source.getSnapshot()[0], previousDisclosure = source.disclosure(block.id);
    previousDisclosure.setOpen(true);
    const gate = new Promise(resolve => { release = resolve; });
    fixture.readWith(async sessionId => { await gate; return promptResponse(sessionId); });
    connection.publish({ ...connection.getSnapshot(), instanceId: "host-b" });
    assert.equal(source.getSnapshot().length, 0, "the same Session ID in a replacement Host cannot reuse previous data");
    release(); await source.refresh();
    previousDisclosure.setOpen(true);
    assert.equal(source.disclosure(source.getSnapshot()[0].id).open, false, "late toggle handlers from a retired Host are ignored");
    for (const state of [{ online: false }, { online: true, businessAvailable: false }]) {
      connection.publish({ ...connection.getSnapshot(), ...state });
      assert.equal(source.getSnapshot().length, 0);
      connection.publish({ ...connection.getSnapshot(), online: true, businessAvailable: true });
      assert.equal(source.getSnapshot().length, 0, "reconnection performs a new read instead of restoring revoked cached data");
      await source.refresh();
    }
    fixture.readWith(async () => { throw new ClientApiError("control_not_found", 404); });
    await source.refresh();
    assert.equal(source.getSnapshot().length, 0, "adapter removal still removes the prompt contribution");
    source.close();
    assert.equal(source.getSnapshot().length, 0);
  } finally { release?.(); source.close(); }
});

test("prompt caches evict old Sessions and suppress a late response from a previous selection", async () => {
  const fixture = promptClient(), { source, sessions } = fixture;
  let release;
  try {
    await source.refresh();
    for (let index = 1; index <= 6; index++) { sessions.publish({ selectedId: "session-" + index }); await source.refresh(); }
    const latest = source.getSnapshot();
    const gate = new Promise(resolve => { release = resolve; });
    fixture.readWith(async sessionId => { await gate; return promptResponse(sessionId); });
    sessions.publish({ selectedId: "session-a" });
    assert.equal(source.getSnapshot().length, 0, "a seventh Session evicts the oldest cached prompt");
    sessions.publish({ selectedId: "session-6" });
    assert.strictEqual(source.getSnapshot(), latest);
    release(); await source.refresh();
    assert.equal(source.getSnapshot()[0].data.snapshot.sessionId, "session-6", "the stale request cannot overwrite the restored Session");
  } finally { release?.(); source.close(); }
});

test("empty or truncated successful reads cannot erase a verified append-only prompt history", async () => {
  const fixture = promptClient(), { source } = fixture;
  try {
    fixture.readWith(async sessionId => ({ value: { schemaVersion: 1, sessionId, snapshots: [] } }));
    await source.refresh();
    assert.equal(source.getSnapshot().length, 0, "a genuinely empty first read is valid");
    const original = promptResponse("session-a");
    const changed = { ...original.value.snapshots[0], stepId: "step-b", capturedAt: "2026-10-10T10:01:00.000Z", digest: "b".repeat(64),
      sections: [{ channel: "instructions", role: "system", content: "Changed historical prompt" }] };
    fixture.readWith(async () => ({ value: { ...original.value, snapshots: [...original.value.snapshots, changed] } }));
    await source.refresh();
    const verified = source.getSnapshot();
    assert.equal(verified.length, 2);
    source.disclosure(verified[1].id).setOpen(true);
    for (const snapshots of [[], original.value.snapshots, [changed]]) {
      fixture.readWith(async () => ({ value: { ...original.value, snapshots } }));
      await source.refresh();
      assert.strictEqual(source.getSnapshot(), verified, "a successful but regressive read does not remove a verified historical snapshot");
      assert.equal(source.disclosure(verified[1].id).open, true);
    }
  } finally { source.close(); }
});

test("complete unchanged reads retain identity and earlier same-digest snapshots do not block new history", async () => {
  const fixture = promptClient(), { source } = fixture;
  try {
    await source.refresh();
    const verified = source.getSnapshot();
    await source.refresh();
    assert.strictEqual(source.getSnapshot(), verified, "an unchanged full response does not republish identical prompt UI");
    const original = promptResponse("session-a");
    const earlier = { ...original.value.snapshots[0], stepId: "step-earlier", capturedAt: "2026-10-10T09:59:00.000Z" };
    const newest = { ...original.value.snapshots[0], stepId: "step-newest", capturedAt: "2026-10-10T10:02:00.000Z", digest: "c".repeat(64),
      sections: [{ channel: "instructions", role: "system", content: "Newest verified snapshot" }] };
    fixture.readWith(async () => ({ value: { ...original.value, snapshots: [earlier, ...original.value.snapshots, newest] } }));
    await source.refresh();
    assert.equal(source.getSnapshot()[0].stepId, "step-earlier", "projection may now coalesce an older identical digest without making the raw history incomplete");
    assert.equal(source.getSnapshot().at(-1).stepId, "step-newest", "a genuinely new snapshot remains visible");
  } finally { source.close(); }
});

test("the latest digest for an existing Step and later Steps follow the Journal list contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-prompt-step-replacement-"));
  const backend = new FileJournalStorageBackend({ backendId: "step-replacement", rootDirectory: directory });
  const history = new JournalSystemPromptHistory(backend.open({ namespace: SYSTEM_PROMPT_HISTORY_NAMESPACE }), "step-replacement");
  const fixture = promptClient(), { source } = fixture;
  fixture.readWith(async sessionId => ({ value: { schemaVersion: 1, sessionId, snapshots: await history.list(sessionId) } }));
  try {
    await history.record(projectSystemPromptSnapshot(contextInput, projection()));
    await source.refresh();
    const firstBlock = source.getSnapshot()[0];
    await history.record(projectSystemPromptSnapshot(contextInput, projection("Replacement prompt", "New tool rules")));
    await source.refresh();
    assert.equal(source.getSnapshot().length, 1, "Journal.list returns only the latest snapshot for this Run/Step");
    assert.equal(source.getSnapshot()[0].stepId, firstBlock.stepId);
    assert.notEqual(source.getSnapshot()[0].id, firstBlock.id, "a replacement digest updates the displayed snapshot instead of being rejected as an incomplete read");
    assert.equal(source.getSnapshot()[0].data.snapshot.sections[0].content, "Replacement prompt");
    const nextInput = { ...contextInput, stepId: "step-next", runtime: { ...contextInput.runtime, capturedAt: "2026-10-10T10:03:00.000Z" } };
    await history.record(projectSystemPromptSnapshot(nextInput, projection("Later Step prompt", "Later rules")));
    await source.refresh();
    assert.equal(source.getSnapshot().length, 2);
    assert.equal(source.getSnapshot().at(-1).stepId, "step-next", "subsequent complete history updates still publish after a same-Step replacement");
  } finally { source.close(); await history.close(); await backend.close(); await rm(directory, { recursive: true, force: true }); }
});
