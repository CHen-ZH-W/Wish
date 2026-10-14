import assert from "node:assert/strict";
import test from "node:test";

import { SnapshotStore } from "../dist/apps/webui/client/model/store.js";
import { PermissionProfileClientModel } from "../dist/permissions/consumers/webui/profile-model.js";
import { NewSessionPermissionProfileClientModel } from "../dist/permissions/consumers/webui/new-session-profile-model.js";

const view = (selected) => ({
  availableProfiles: ["read-only", "approval-required", "workspace-write", "full-access"],
  selected,
  source: "session",
  shellBackend: "linux-native",
  workspaceIsolation: selected === "workspace-write",
});

test("current Session permission follows selection and changes only through its control", async () => {
  const choices = new Map([["session-a", "approval-required"]]);
  const requests = [];
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a" });
  connection.onInvalidation = () => () => {};
  connection.request = async (path, body) => {
    requests.push({ path, body });
    const sessionId = path.split("/")[3];
    if (body) choices.set(sessionId, body.profile);
    return { value: view(choices.get(sessionId) ?? "approval-required") };
  };
  const sessions = new SnapshotStore({ selectedId: "session-a" });
  const model = new PermissionProfileClientModel(connection, sessions);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().view.selected, "approval-required");
    await model.select("workspace-write");
    assert.equal(choices.get("session-a"), "workspace-write");
    assert.equal(model.getSnapshot().status, "下次新运行生效");
    sessions.publish({ selectedId: "session-b" });
    await model.refresh();
    assert.equal(model.getSnapshot().view.selected, "approval-required");
    assert.ok(requests.some((request) => request.path.endsWith("/session-a/controls/permission-profile") && request.body?.profile === "workspace-write"));
  } finally {
    model.close();
  }
});

test("new Session permission stays browser-local until first-message setup", async () => {
  const requests = [];
  let generalDefault = "workspace-write";
  const connection = new SnapshotStore({ online: true, businessAvailable: true, instanceId: "host-a" });
  const settings = new SnapshotStore({ sections: [] });
  connection.onInvalidation = () => () => {};
  connection.request = async (path, body) => {
    requests.push({ path, body });
    if (path === "/api/controls/permission-profile/default") return { value: { ...view(generalDefault), source: "default" } };
    if (path === "/api/sessions/new/controls/permission-profile") return { value: view(body.profile) };
    throw new Error(`Unexpected ${path}`);
  };
  const model = new NewSessionPermissionProfileClientModel(connection, settings);
  try {
    await model.refresh();
    assert.equal(model.getSnapshot().selected, "workspace-write");
    model.select("read-only");
    assert.equal(requests.some((request) => request.body?.profile === "read-only"), false, "no Host Session exists yet");
    generalDefault = "approval-required";
    settings.publish({ sections: [{ namespace: "permissions" }] });
    await model.refresh();
    assert.equal(model.getSnapshot().selected, "read-only", "a local explicit choice survives a general-default refresh");
    await model.capture()("new");
    assert.deepEqual(requests.at(-1), { path: "/api/sessions/new/controls/permission-profile", body: { profile: "read-only" } });
    model.reset();
    await model.refresh();
    assert.equal(model.getSnapshot().selected, "approval-required");
  } finally {
    model.close();
  }
});
