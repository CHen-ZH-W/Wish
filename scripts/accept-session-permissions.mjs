import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApplicationFacade } from "../dist/apps/application.js";
import { createPermissionProfileWebUiControl } from "../dist/permissions/consumers/webui-control.js";
import {
  DomainSessionPermissionProfileStore,
  SessionPermissionProfiles,
  availablePermissionProfiles,
} from "../dist/permissions/session-profiles.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

const nativeShellPolicy = Object.freeze({
  schemaVersion: 1,
  version: "native-v1",
  backend: "linux-native",
  filesystem: "path-scoped",
  network: "per-call",
  environment: "clean",
  automaticPermissionProfiles: Object.freeze(["workspace-write", "full-access"]),
  resourceLimits: Object.freeze({ maxProcesses: 10, maxOpenFiles: 10, maxFileSizeBytes: 1_000, maxMemoryBytes: 1_000, maxTimeoutSeconds: 10 }),
  filesystemPolicyVersion: "filesystem-v1",
});

test("Native Session permission choices persist across all four profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-session-permissions-"));
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  const storage = { backend(id) { assert.equal(id, "file"); return backend; } };
  let defaultProfile = "workspace-write";
  try {
    const firstStore = new DomainSessionPermissionProfileStore(storage, "file");
    const profiles = new SessionPermissionProfiles(firstStore, "approval-required", () => defaultProfile, nativeShellPolicy);
    assert.deepEqual(profiles.inspectDefault().availableProfiles, ["read-only", "approval-required", "workspace-write", "full-access"]);
    assert.equal((await profiles.inspect("legacy-session")).selected, "approval-required");
    assert.equal((await profiles.inspect("legacy-session")).source, "deployment");
    assert.equal((await profiles.initialize("new-session")).selected, "workspace-write");
    assert.equal((await profiles.inspect("new-session")).workspaceIsolation, true);
    defaultProfile = "read-only";
    assert.equal((await profiles.inspect("new-session")).selected, "workspace-write", "general defaults do not rewrite existing Sessions");
    await profiles.select("new-session", "read-only");
    const reopened = new SessionPermissionProfiles(
      new DomainSessionPermissionProfileStore(storage, "file"),
      "approval-required",
      () => defaultProfile,
      nativeShellPolicy,
    );
    assert.equal(await reopened.forRun("new-session"), "read-only");
    assert.equal((await reopened.select("new-session", "full-access")).selected, "full-access");
  } finally {
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host Shell advertises only its explicit full-access profile", () => {
  assert.deepEqual(availablePermissionProfiles({
    ...nativeShellPolicy,
    backend: "host",
    filesystem: "none",
    network: "none",
    environment: "inherit",
    automaticPermissionProfiles: ["full-access"],
  }), ["full-access"]);
});

test("Application initializes each new Session and pins permission for a whole Run", async () => {
  let selected = "workspace-write";
  let nextRun = 0;
  const initialized = [], starts = [], controls = [], completions = [];
  const session = { sessionId: "session-a", agentId: "wish", scope: "/workspace", status: "active" };
  const view = (profile) => ({ availableProfiles: ["read-only", "approval-required", "workspace-write"], selected: profile, source: "session", shellBackend: "linux-native", workspaceIsolation: profile === "workspace-write" });
  const application = new ApplicationFacade({
    sessions: { manager: {
      async create(input) { return { ...session, sessionId: input.sessionId }; },
      async get() { return session; },
    } },
    models: { configuredModel: {
      getDefaultModel() { return { provider: "fixture", model: "model" }; },
      resolve(model) { return { ref: model }; },
      getModelSpec() { return {}; },
    } },
    sessionPermissions: {
      inspectDefault() { return view(selected); },
      async inspect() { return view(selected); },
      async initialize(sessionId) { initialized.push(sessionId); return view(selected); },
      async select(_sessionId, profile) { selected = profile; return view(selected); },
      async forRun() { return selected; },
    },
    agent: {
      definition: { id: "wish" },
      startRun(input) {
        starts.push(input);
        let settle;
        const completion = new Promise((resolve) => { settle = resolve; });
        completions.push(settle);
        return { runId: `run-${++nextRun}`, scope: input.scope, completion };
      },
      control(runId, control) { controls.push({ runId, control }); return { accepted: true }; },
      async *observe() {},
    },
  });
  await application.createSession({ sessionId: "session-a", workspaceRoot: "/workspace" });
  assert.deepEqual(initialized, ["session-a"]);
  const first = await application.startRun({ sessionId: "session-a", payload: { text: "first" } });
  assert.equal(starts[0].payload.permissionProfile, "workspace-write");
  selected = "read-only";
  application.controlRun(first.runId, { type: "follow_up", id: "follow-1", payload: { text: "queued" } });
  assert.equal(controls[0].control.payload.permissionProfile, "workspace-write");
  assert.throws(() => application.controlRun(first.runId, { type: "follow_up", id: "follow-2", payload: { text: "queued", permissionProfile: "read-only" } }), /cannot change the permission profile/u);
  completions[0]({ status: "completed" });
  await first.completion;
  const second = await application.startRun({ sessionId: "session-a", payload: { text: "second" } });
  assert.equal(starts[1].payload.permissionProfile, "read-only");
  completions[1]({ status: "completed" });
  await second.completion;
});

test("Permissions WebUI control validates the profile and delegates Session state", async () => {
  let selected = "approval-required";
  const view = () => ({ availableProfiles: ["read-only", "approval-required", "workspace-write"], selected, source: "session", shellBackend: "linux-native", workspaceIsolation: selected === "workspace-write" });
  const application = { sessionPermissions: {
    inspectDefault: view,
    async inspect() { return view(); },
    async select(_sessionId, profile) { selected = profile; return view(); },
  } };
  const control = createPermissionProfileWebUiControl();
  assert.equal((await control.inspectDefault(application, AbortSignal.abort())).selected, "approval-required");
  assert.equal((await control.updateSession(application, "session-a", { profile: "workspace-write" }, new AbortController().signal)).selected, "workspace-write");
  await assert.rejects(control.updateSession(application, "session-a", { profile: "unknown" }, new AbortController().signal), { code: "invalid_permission_profile", status: 400 });
  await assert.rejects(control.updateSession(application, "session-a", { profile: "read-only", extra: true }, new AbortController().signal), { code: "invalid_request", status: 400 });
});
