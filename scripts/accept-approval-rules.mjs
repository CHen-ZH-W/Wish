import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import {
  DomainApprovalRuleStore,
  approvalRuleDomain,
} from "../dist/permissions/rules/index.js";
import { StorageHub } from "../dist/storage/index.js";
import { FileStorageBackend } from
  "../dist/storage/providers/file/backend.js";

let fixtureOrdinal = 0;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-approval-rules-"));
  const root = new Context();
  await root.plugin(StorageHub);
  const backend = new FileStorageBackend({
    id: `rules-${++fixtureOrdinal}`,
    rootDirectory: directory,
  });
  root.storage.register(backend);
  let id = 0;
  const create = () => new DomainApprovalRuleStore({
    storage: root.storage,
    backendId: backend.id,
    id: () => `rule-${++id}`,
    now: () => new Date("2026-09-11T00:00:00.000Z"),
  });
  return {
    directory,
    root,
    backend,
    create,
    async dispose() {
      await root.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function request(overrides = {}) {
  const { identity = {}, ...fields } = overrides;
  return {
    profile: "approval-required",
    policyVersion: "permission-policy-1",
    toolName: "bash",
    capabilityDigest: "sha256:capability-1",
    identity: {
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      workspaceFingerprint: "workspace-1",
      ...identity,
    },
    ...fields,
  };
}

test("ApprovalRuleStore matches exact run, session, and workspace scopes", async () => {
  const state = await fixture();
  const store = state.create();
  try {
    const run = await store.remember({ ...request(), scope: "run" });
    assert.equal((await store.find(request())).id, run.id);
    assert.equal(await store.find(request({
      identity: { runId: "run-2" },
    })), undefined);

    const sessionRequest = request({ capabilityDigest: "sha256:session" });
    const session = await store.remember({
      ...sessionRequest,
      scope: "session",
    });
    assert.equal((await store.find(sessionRequest)).id, session.id);
    assert.equal(await store.find(request({
      capabilityDigest: "sha256:session",
      identity: { sessionId: "session-2" },
    })), undefined);

    const workspaceRequest = request({ capabilityDigest: "sha256:workspace" });
    const workspace = await store.remember({
      ...workspaceRequest,
      scope: "workspace",
    });
    await store.remember({
      ...workspaceRequest,
      scope: "session",
    });
    assert.equal((await store.remember({
      ...workspaceRequest,
      scope: "workspace",
    })).id, workspace.id);
    assert.equal((await store.find(request({
      capabilityDigest: "sha256:workspace",
      identity: { sessionId: "session-2", runId: "run-2" },
    }))).id, workspace.id);
    assert.equal(await store.find(request({
      capabilityDigest: "sha256:workspace",
      identity: { agentId: "agent-2" },
    })), undefined);
    await assert.rejects(
      store.remember({ ...request(), scope: "once" }),
      /retained scope is invalid/u,
    );
  } finally {
    await store.close();
    await state.dispose();
  }
});

test("session/workspace rules persist while run rules remain process-local", async () => {
  const state = await fixture();
  const first = state.create();
  try {
    await first.remember({ ...request({ capabilityDigest: "sha256:run" }), scope: "run" });
    await first.remember({
      ...request({ capabilityDigest: "sha256:session" }),
      scope: "session",
    });
    await first.remember({
      ...request({ capabilityDigest: "sha256:workspace" }),
      scope: "workspace",
    });
    await first.close();

    const restarted = state.create();
    assert.equal(await restarted.find(request({
      capabilityDigest: "sha256:run",
    })), undefined);
    assert.equal((await restarted.find(request({
      capabilityDigest: "sha256:session",
    }))).scope, "session");
    const workspace = await restarted.find(request({
      capabilityDigest: "sha256:workspace",
    }));
    assert.equal(workspace.scope, "workspace");
    assert.equal((await restarted.list()).length, 2);
    assert.equal(await restarted.revoke(workspace.id), true);
    assert.equal(await restarted.revoke(workspace.id), false);
    assert.equal((await restarted.list()).length, 1);
    await restarted.close();
  } finally {
    await state.dispose();
  }
});

test("ApprovalRuleStore fails closed on corrupted Domain state and after close", async () => {
  const state = await fixture();
  try {
    await state.backend.kv.put({
      namespace: approvalRuleDomain.id,
      key: "global",
      value: new TextEncoder().encode("{"),
      precondition: { kind: "absent" },
    });
    const store = state.create();
    await assert.rejects(
      store.list(),
      (error) => error?.code === "storage_corruption",
    );
    await store.close();
    await assert.rejects(store.list(), /closed/u);
  } finally {
    await state.dispose();
  }
});
