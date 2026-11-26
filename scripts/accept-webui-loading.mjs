import test from "node:test";
import assert from "node:assert/strict";
import { RefreshQueue, SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { UiSlots } from "../dist/apps/webui/client/slots.js";
import { bindPageReadiness } from "../dist/apps/webui/client/plugins.js";
import { pageLoading } from "../dist/apps/webui/client/ui/loading-boundary.js";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
class Probe extends SnapshotStore { update(value) { this.publish(value); } }

test("page readiness covers folded successor reads without affecting unrelated pages", async () => {
  const gates = [deferred(), deferred()]; let reads = 0;
  const queue = new RefreshQueue(async () => { await gates[reads++].promise; });
  const resource = new Probe("first"), slots = new UiSlots();
  const remove = slots.loading({ id: "probe", panels: ["conversation", "archives"], sources: [queue, resource],
    getState: () => ({ key: resource.getSnapshot(), pending: queue.getSnapshot() }) });
  try {
    const initial = pageLoading(slots.getSnapshot().loading, "conversation");
    const reading = queue.request(); queue.request();
    const observed = queue.whenSettled();
    assert.equal(pageLoading(slots.getSnapshot().loading, "conversation").pending, true);
    assert.equal(pageLoading(slots.getSnapshot().loading, "skills").pending, false);
    gates[0].resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(pageLoading(slots.getSnapshot().loading, "conversation").pending, true, "successor read remains part of the initial wait");
    gates[1].resolve(); await Promise.all([reading, observed]);
    assert.equal(reads, 2, "observing readiness never schedules another baseline read");
    assert.deepEqual(pageLoading(slots.getSnapshot().loading, "conversation"), initial, "refresh does not change the displayed resource identity");
    resource.update("second");
    assert.notEqual(pageLoading(slots.getSnapshot().loading, "conversation").identity, initial.identity);
    remove(); resource.update("late");
    assert.equal(slots.getSnapshot().loading.length, 0, "owner teardown removes subscriptions and readiness");
  } finally { queue.close(); }
});


test("verified cached content is readable while its owner checks freshness", () => {
  const slots = new UiSlots(), reading = new Probe(true), connection = new Probe({ online: true, instanceId: "first" });
  let cached = true;
  const remove = bindPageReadiness({ wishConnection: connection, wishUiSlots: slots }, "cached", ["skills"], reading, false, () => cached);
  const first = pageLoading(slots.getSnapshot().loading, "skills");
  assert.equal(first.pending, false);
  cached = false; connection.update({ online: true, instanceId: "second" });
  assert.equal(pageLoading(slots.getSnapshot().loading, "skills").pending, true);
  assert.notEqual(pageLoading(slots.getSnapshot().loading, "skills").identity, first.identity);
  const states = slots.getSnapshot().loading;
  const second = { id: "another", panels: ["skills"], key: "stable", pending: false };
  assert.equal(pageLoading([...states, second], "skills").identity, pageLoading([second, ...states], "skills").identity, "module registration order cannot reset page presentation");
  remove(); assert.equal(slots.getSnapshot().loading.length, 0);
});
