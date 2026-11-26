import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemorySessionStore, SessionManager, SessionTitleConflictError } from "../dist/sessions/index.js";
import { FileSessionStore, sessionStorageKey } from "../dist/sessions/providers/file/store.js";

for (const kind of ["memory", "file"]) {
  test(`${kind} title CAS admits one concurrent writer and preserves the transcript`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wish-title-cas-"));
    const store = kind === "memory" ? new InMemorySessionStore() : new FileSessionStore({ rootDirectory: root });
    const sessions = new SessionManager(store);
    try {
      const created = await sessions.create({ sessionId: "s", agentId: "a", scope: root });
      assert.equal(created.titleRevision, 0);
      await sessions.appendMessages({ sessionId: "s", messages: [{ idempotencyKey: "input", runId: "run", userTurnId: "turn", stepId: "step", origin: "user_input", message: { role: "user", content: "Inspect the title race" } }] });
      const history = await sessions.readHistory({ sessionId: "s" });
      const attempts = await Promise.allSettled([
        sessions.updateMetadata({ sessionId: "s", title: "Model title", titleSource: "model", expectedTitleRevision: 0 }),
        sessions.updateMetadata({ sessionId: "s", title: "My title", expectedTitleRevision: 0 }),
      ]);
      assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
      const rejection = attempts.find(result => result.status === "rejected");
      assert.ok(rejection.reason instanceof SessionTitleConflictError);
      assert.equal(rejection.reason.code, "session_title_conflict");
      assert.equal(rejection.reason.expectedTitleRevision, 0);
      assert.equal(rejection.reason.actualTitleRevision, 1);
      assert.equal((await sessions.get({ sessionId: "s" })).titleRevision, 1);
      assert.deepEqual(await sessions.readHistory({ sessionId: "s" }), history);

      const pinned = await sessions.updateMetadata({ sessionId: "s", title: "My choice", expectedTitleRevision: 1 });
      assert.equal(pinned.titleSource, "manual");
      await assert.rejects(sessions.updateMetadata({ sessionId: "s", title: "Late model title", titleSource: "model", expectedTitleRevision: 1 }), SessionTitleConflictError);
      assert.equal((await sessions.get({ sessionId: "s" })).title, "My choice");
    } finally { await store.close?.(); await rm(root, { recursive: true, force: true }); }
  });

  test(`${kind} title provenance changes and clears advance only the title revision`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wish-title-source-"));
    const store = kind === "memory" ? new InMemorySessionStore() : new FileSessionStore({ rootDirectory: root });
    const sessions = new SessionManager(store);
    try {
      const created = await sessions.create({ sessionId: "s", agentId: "a", scope: root, title: "Same text", titleSource: "fallback" });
      assert.equal(created.titleRevision, 1);
      const pinned = await sessions.updateMetadata({ sessionId: "s", title: "Same text", expectedTitleRevision: 1 });
      assert.equal(pinned.titleSource, "manual");
      assert.equal(pinned.titleRevision, 2);
      const cleared = await sessions.updateMetadata({ sessionId: "s", title: null, expectedTitleRevision: 2 });
      assert.equal(cleared.title, undefined);
      assert.equal(cleared.titleSource, "manual");
      assert.equal(cleared.titleRevision, 3);
      assert.equal(cleared.historyRevision, created.historyRevision);
      const unchanged = await sessions.updateMetadata({ sessionId: "s", expectedTitleRevision: 3 });
      assert.equal(unchanged.titleRevision, 3);
      await assert.rejects(sessions.updateMetadata({ sessionId: "s", titleSource: "model" }), /requires a title write/u);
      await assert.rejects(sessions.create({ sessionId: "invalid", agentId: "a", scope: root, titleSource: "model" }), /requires a title write/u);
      for (const expectedTitleRevision of [-1, 0.5, null, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(sessions.updateMetadata({ sessionId: "s", title: "invalid", expectedTitleRevision }), /non-negative safe integer/u);
      }
      for (const titleSource of ["unknown", null]) {
        await assert.rejects(sessions.updateMetadata({ sessionId: "s", title: "invalid", titleSource }), /titleSource must/u);
      }
      assert.equal((await sessions.get({ sessionId: "s" })).titleRevision, 3);
    } finally { await store.close?.(); await rm(root, { recursive: true, force: true }); }
  });
}

test("file title CAS upgrades legacy metadata and keeps cleared manual pins across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-title-legacy-"));
  let store = new FileSessionStore({ rootDirectory: root });
  try {
    const created = await store.create({ sessionId: "legacy", agentId: "a", scope: root, title: "Old user title" });
    assert.equal(created.titleSource, "manual");
    await store.close();
    const path = join(root, `session-${sessionStorageKey("legacy")}`, "session.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    delete document.session.titleSource;
    delete document.session.titleRevision;
    await writeFile(path, JSON.stringify(document));

    store = new FileSessionStore({ rootDirectory: root });
    const old = await store.get({ sessionId: "legacy" });
    assert.equal(old.titleSource, "manual");
    assert.equal(old.titleRevision, 0);
    assert.equal((await store.list())[0].titleRevision, 0);
    const cleared = await store.updateMetadata({ sessionId: "legacy", title: null, expectedTitleRevision: 0 });
    assert.equal(cleared.titleRevision, 1);
    assert.equal(cleared.historyRevision, created.historyRevision);
    await store.close();
    store = new FileSessionStore({ rootDirectory: root });
    const restarted = await store.get({ sessionId: "legacy" });
    assert.equal(restarted.title, undefined);
    assert.equal(restarted.titleSource, "manual");
    assert.equal(restarted.titleRevision, 1);
    await assert.rejects(store.updateMetadata({ sessionId: "legacy", title: "Stale model", titleSource: "model", expectedTitleRevision: 0 }), SessionTitleConflictError);
    assert.equal((await store.get({ sessionId: "legacy" })).title, undefined);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("file title metadata rejects corrupt revision and provenance instead of resetting its guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-title-invalid-"));
  let store = new FileSessionStore({ rootDirectory: root });
  try {
    await store.create({ sessionId: "s", agentId: "a", scope: root });
    await store.close();
    const path = join(root, `session-${sessionStorageKey("s")}`, "session.json");
    const document = JSON.parse(await readFile(path, "utf8"));
    for (const titleRevision of [-1, 1.5, null, "1"]) {
      document.session.titleRevision = titleRevision;
      await writeFile(path, JSON.stringify(document));
      store = new FileSessionStore({ rootDirectory: root });
      await assert.rejects(store.get({ sessionId: "s" }), { code: "session_corruption" });
      await store.close();
    }
    document.session.titleRevision = 0;
    document.session.titleSource = "invalid";
    await writeFile(path, JSON.stringify(document));
    store = new FileSessionStore({ rootDirectory: root });
    await assert.rejects(store.get({ sessionId: "s" }), { code: "session_corruption" });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
