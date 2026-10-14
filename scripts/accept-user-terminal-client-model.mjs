import assert from "node:assert/strict";
import { UserTerminalClientModel } from "../dist/terminal/consumers/webui/model.js";

class FakeEventSource {
  listeners = new Map(); closed = false;
  constructor(url) { this.url = url; }
  addEventListener(name, listener) { const values = this.listeners.get(name) ?? []; values.push(listener); this.listeners.set(name, values); }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(value) }); }
  close() { this.closed = true; }
}

const terminal = Object.freeze({
  id: "terminal-1", label: "Terminal", createdAt: "2026-10-12T00:00:00.000Z",
  active: true, authority: "host-user", shell: "bash", columns: 100, rows: 30,
});
const writes = [], resizes = [], streams = [], creates = [];
const connection = {
  async request(_path, body) {
    if (body?.action === "shells") return { value: { shells: [{ path: "/bin/bash", name: "bash" }] } };
    if (body?.action === "create") { creates.push(body); return { value: terminal }; }
    if (body?.action === "write") { writes.push(body); return { value: { accepted: true } }; }
    if (body?.action === "resize") { resizes.push(body); return { value: { accepted: true } }; }
    return { value: { schemaVersion: 2, sessionId: "session-1", authority: "host-user", terminals: [terminal] } };
  },
  stream(path) { const source = new FakeEventSource(path); streams.push(source); return source; },
};
const model = new UserTerminalClientModel(connection);
let publications = 0;
const unsubscribe = model.subscribe(() => { publications++; });

assert.deepEqual(await model.listShells("session-1"), [{ path: "/bin/bash", name: "bash" }]);
await model.create("session-1", "/bin/bash");
assert.deepEqual(creates, [{ action: "create", shellPath: "/bin/bash" }]);
await model.refresh("session-1", true);
assert.equal(model.getSnapshot().pending, false);
assert.equal(model.getSnapshot().authority, "host-user");
const settledPublications = publications;
await model.refresh("session-1");
assert.equal(publications, settledPublications, "unchanged roster polling must not republish or enter a loading state");

model.observe("session-1", terminal.id);
const source = streams[0];
assert.match(source.url, /\/streams\/user-terminal/u);
source.emit("terminal.snapshot", { type: "snapshot", sequence: 0, screen: "user@wish:/workspace$ ", terminal, writable: true });
assert.equal(model.getSnapshot().writable, true);
assert.equal(model.getSnapshot().render.frame.screen, "user@wish:/workspace$ ");
const snapshotRevision = model.getSnapshot().render.revision;
model.acknowledge(snapshotRevision);
source.emit("terminal.output", { type: "output", sequence: 1, data: "user@wish:/workspace$ " });
const outputRevision = model.getSnapshot().render.revision;
assert.equal(model.getSnapshot().render.frame.type, "output");
model.acknowledge(outputRevision);

model.writeRaw("session-1", terminal.id, "w");
model.writeRaw("session-1", terminal.id, "d");
model.resize("session-1", terminal.id, 100, 30);
await new Promise(resolve => setTimeout(resolve, 10));
assert.deepEqual(writes.map(item => item.text), ["w", "d"], "raw keystrokes stay ordered");
assert.equal(writes[0].attachmentId, resizes[0].attachmentId, "input and resize use the active attachment identity");
assert.equal(model.getSnapshot().pending, false, "raw input never replaces the mounted screen with a loading state");

source.emit("terminal.state", { type: "state", terminal, writable: false });
model.writeRaw("session-1", terminal.id, "ignored");
await new Promise(resolve => setTimeout(resolve, 5));
assert.deepEqual(writes.map(item => item.text), ["w", "d"], "a read-only attachment cannot write");

unsubscribe(); model.close();
assert.equal(source.closed, true);
console.log("User Terminal streaming client acceptance passed");
