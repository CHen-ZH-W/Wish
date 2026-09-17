import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Group from "@deepseek-ai/cordis-plugin-group";
import { installPluginInspection } from "../dist/boot/plugin-control/inspection.js";
import { previewPluginSelection } from "../dist/boot/plugin-control/selection.js";
import { assessPluginDisable } from "../dist/boot/plugin-control/assessment.js";
import { RunGeneration } from "../dist/core/runtime/generation.js";
import { StorageHub } from "../dist/storage/service.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";

async function fixture(run) {
  const root = new Context();
  try {
    await root.plugin(Loader);
    root.loader.builtins.group = Group;
    root.loader.builtins.source = { apply(ctx) { ctx.provide("managementSource", true); } };
    root.loader.builtins.tool = { inject: ["managementSource"], apply() {} };
    root.loader.builtins.backend = { apply() {} };
    await root.loader.create({ id: "app-a", name: "cordis:group", group: true, config: [
      { id: "source", name: "cordis:source" },
      { id: "tool", name: "cordis:tool" },
      { id: "backend", name: "cordis:backend" },
      { id: "dormant", name: "cordis:backend", disabled: true },
    ] });
    const inspection = installPluginInspection(root);
    await root.loader.await();
    await run({ root, inspection, snapshot: inspection.inspect() });
  } finally {
    await root.fiber.dispose();
  }
}

const select = (snapshot, ...entryIds) => ({ instanceId: snapshot.instanceId, entryIds });

// Test-owned Host evidence. Production collection and mutation are deliberately
// not installed yet; an inspection by itself must always assess as blocked.
function evidenceFor(snapshot, selection) {
  const impact = previewPluginSelection(snapshot, selection);
  return {
    observation: snapshot,
    configuration: "managed", recovery: "available", admission: "guarded",
    reports: [
      ...impact.gatedEntryIds.map(entryId => ({ subject: { kind: "entry", entryId }, disposition: "direct", code: "entry_ready" })),
      ...impact.affected.map(({ fiberId }) => ({ subject: { kind: "fiber", fiberId }, disposition: "direct", code: "owner_idle" })),
    ],
  };
}

test("feature selections explicitly name entries; tool-only selection leaves the Provider alone", async () => {
  await fixture(({ snapshot }) => {
    const tool = previewPluginSelection(snapshot, select(snapshot, "tool"));
    assert.deepEqual(tool.gatedEntryIds, ["tool"]);
    assert.equal(tool.affected.length, 1);
    const feature = previewPluginSelection(snapshot, select(snapshot, "source", "tool"));
    assert.deepEqual(feature.gatedEntryIds, ["source", "tool"]);
    assert.equal(new Set(feature.affected.map(item => item.fiberId)).size, feature.affected.length);
    assert.equal(feature.affected.some(item => snapshot.fibers.find(fiber => fiber.id === item.fiberId)?.entryId === "backend"), false);
    const request = select(snapshot, "source");
    const copied = previewPluginSelection(snapshot, request);
    request.entryIds.push("backend");
    assert.deepEqual(copied.selection.entryIds, ["source"]);
    assert.throws(() => copied.selection.entryIds.push("backend"), TypeError);
  });
});

test("malformed, duplicate, unknown and cross-Root selections are rejected without partial resolution", async () => {
  await fixture(({ snapshot }) => {
    for (const selection of [null, {}, select(snapshot), select(snapshot, "tool", "tool"), select(snapshot, " tool"), select(snapshot, 4)]) {
      assert.throws(() => previewPluginSelection(snapshot, selection), { code: "invalid-selection" });
    }
    assert.throws(() => previewPluginSelection(snapshot, select(snapshot, "source", "missing")), { code: "unknown-entry" });
    assert.throws(() => previewPluginSelection(snapshot, { instanceId: "previous-process", entryIds: ["source"] }), { code: "stale-instance" });
  });
});

test("Group selection covers dormant descendants but does not pretend its carrier is stopped", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "app-a");
    const impact = previewPluginSelection(snapshot, selection);
    assert.deepEqual(impact.gatedEntryIds, ["app-a", "backend", "dormant", "source", "tool"]);
    const carrier = snapshot.entries.find(entry => entry.id === "app-a").fiberId;
    assert.equal(impact.affected.some(item => item.fiberId === carrier), false);
    const evidence = evidenceFor(snapshot, selection);
    evidence.reports = evidence.reports.filter(report => report.subject.entryId !== "dormant");
    const assessment = assessPluginDisable(snapshot, selection, evidence);
    assert.equal(assessment.disposition, "blocked");
    assert.ok(assessment.conditions.some(condition => condition.subject.entryId === "dormant" && condition.code === "lifecycle_unassessed"));
  });
});

test("inspection and missing safety facts cannot become permission to stop a plugin", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "source");
    const assessment = assessPluginDisable(snapshot, selection);
    assert.equal(assessment.disposition, "blocked");
    assert.equal(assessment.safety, "requires-execution-check");
    assert.equal(assessment.impact.safety, "not-assessed");
    assert.ok(assessment.conditions.some(condition => condition.code === "admission_unassessed"));
    const evidence = evidenceFor(snapshot, selection);
    evidence.reports.pop();
    assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "blocked");
  });
});

test("reports cannot be accidentally reused across distinct observations, even with unchanged fibers", async () => {
  await fixture(({ snapshot, inspection }) => {
    const selection = select(snapshot, "tool");
    const evidence = evidenceFor(snapshot, selection);
    const current = inspection.inspect();
    assert.deepEqual(current, snapshot);
    assert.notEqual(current, snapshot);
    const result = assessPluginDisable(current, selection, evidence);
    assert.equal(result.disposition, "blocked");
    assert.ok(result.conditions.some(condition => condition.code === "evidence_observation_mismatch"));
  });
});

test("ordinary idle capability assessment is non-mutating, immutable and independent of its name", async () => {
  await fixture(({ root, inspection, snapshot }) => {
    const selection = select(snapshot, "source");
    const evidence = evidenceFor(snapshot, selection);
    const result = assessPluginDisable(snapshot, selection, evidence);
    assert.equal(result.disposition, "direct");
    assert.equal(root.get("managementSource"), true);
    assert.deepEqual(inspection.inspect(), snapshot);
    evidence.reports[0].code = "changed_later";
    assert.notEqual(result.conditions[0].code, "changed_later");
    assert.throws(() => { result.conditions[0].subject.kind = "host"; }, TypeError);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    const renamed = { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry, name: "cordis:arbitrary" })) };
    assert.equal(assessPluginDisable(renamed, selection, evidenceFor(renamed, selection)).disposition, "direct");
  });
});

test("a backend-only plugin uses the same rules and needs no Tool or UI contribution", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "backend");
    const result = assessPluginDisable(snapshot, selection, evidenceFor(snapshot, selection));
    assert.equal(result.disposition, "direct");
    assert.deepEqual(result.impact.gatedEntryIds, ["backend"]);
    assert.equal(result.impact.affected.length, 1);
  });
});

test("an active Run is reported by its owner; assessment neither aborts nor drains it", async () => {
  await fixture(async ({ root, inspection }) => {
    let resolveRun;
    let controls = 0;
    const completion = new Promise(resolve => { resolveRun = resolve; });
    const generation = new RunGeneration({
      startRun(definition, input) { return { agentId: definition.id, runId: "run", scope: input.scope, initialUserTurnId: "turn", completion }; },
      control() { controls += 1; return { accepted: true }; },
      async *observe() {},
    }, { id: "managed-generation", drainTimeoutMs: 1000, abortControl: () => ({ type: "abort" }) });
    root.loader.builtins.execution = { apply(ctx) {
      ctx.provide("managementExecution", generation);
      ctx.effect(() => () => generation.retire());
    } };
    await root.loader.create({ id: "execution", name: "cordis:execution" });
    generation.startRun({ id: "agent" }, { scope: "session", payload: {} });
    try {
      const snapshot = inspection.inspect();
      const selection = select(snapshot, "execution");
      const evidence = evidenceFor(snapshot, selection);
      evidence.reports[0] = { subject: evidence.reports[0].subject,
        disposition: generation.snapshot().activeRuns.length ? "blocked" : "direct", code: "active_runs" };
      assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "blocked");
      evidence.reports[0].disposition = "drain";
      assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "drain");
      assert.equal(controls, 0);
      assert.equal(generation.state, "accepting");
      assert.equal(generation.snapshot().activeRuns.length, 1);
    } finally {
      resolveRun({ status: "completed" });
      await completion;
      await generation.retire();
    }
  });
});

test("Storage lease assessment requires owner facts and does not retire or delete data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-plugin-management-"));
  let lease;
  try {
    await fixture(async ({ root, inspection }) => {
      await root.plugin(StorageHub);
      root.loader.builtins.store = { inject: ["storage"], apply(ctx) {
        ctx.storage.register(new FileStorageBackend({ rootDirectory: directory }));
      } };
      await root.loader.create({ id: "store", name: "cordis:store" });
      lease = root.storage.acquire("file");
      try {
        await lease.resolve("file", "kv").put({ namespace: "management", key: "kept", value: new TextEncoder().encode("retained"), precondition: { kind: "absent" } });
        const snapshot = inspection.inspect();
        const selection = select(snapshot, "store");
        const evidence = evidenceFor(snapshot, selection);
        evidence.reports[0] = { subject: evidence.reports[0].subject,
          disposition: lease.released ? "direct" : "drain", code: "storage_lease_outstanding" };
        assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "drain");
        assert.equal(root.storage.has("file"), true);
        assert.equal(lease.released, false);
        const kept = await lease.resolve("file", "kv").get({ namespace: "management", key: "kept" });
        assert.equal(new TextDecoder().decode(kept.value), "retained");
        evidence.recovery = "restart";
        assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "restart");
      } finally {
        lease.release();
        await root.loader.resolve("store").update({ disabled: true });
      }
    });
  } finally {
    lease?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("maintenance, restart and missing admission guarantees cannot be waived by an idle owner", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "backend");
    const evidence = evidenceFor(snapshot, selection);
    evidence.configuration = "read-only";
    assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "maintenance");
    evidence.recovery = "restart";
    assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "restart");
    evidence.admission = "unknown";
    assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "blocked");
    evidence.admission = "guarded";
    evidence.reports[0].disposition = "blocked";
    assert.equal(assessPluginDisable(snapshot, selection, evidence).disposition, "blocked");
  });
});

test("transitions, gate errors, and absent fibers cannot be interpreted as successful cleanup", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "backend");
    const fiberId = snapshot.entries.find(entry => entry.id === "backend").fiberId;
    for (const phase of ["loading", "unloading"]) {
      const changing = { ...snapshot, fibers: snapshot.fibers.map(fiber => fiber.id === fiberId ? { ...fiber, phase } : fiber) };
      assert.equal(assessPluginDisable(changing, selection, evidenceFor(changing, selection)).disposition, "blocked");
    }
    const unknown = { ...snapshot, entries: snapshot.entries.map(entry => entry.id === "backend" ? { ...entry, enabled: null } : entry) };
    assert.equal(assessPluginDisable(unknown, selection, evidenceFor(unknown, selection)).disposition, "blocked");
    const consumerUnknown = { ...snapshot, entries: snapshot.entries.map(entry => entry.id === "tool" ? { ...entry, enabled: null } : entry) };
    const providerSelection = select(snapshot, "source");
    assert.equal(assessPluginDisable(consumerUnknown, providerSelection, evidenceFor(consumerUnknown, providerSelection)).disposition, "blocked");
    const groupChanging = { ...snapshot, entries: snapshot.entries.map(entry => entry.id === "app-a" ? { ...entry, phase: "unloading" } : entry) };
    const groupSelection = select(snapshot, "app-a");
    assert.equal(assessPluginDisable(groupChanging, groupSelection, evidenceFor(groupChanging, groupSelection)).disposition, "blocked");
    const absent = select(snapshot, "dormant");
    const evidence = evidenceFor(snapshot, absent);
    evidence.reports = [];
    assert.equal(assessPluginDisable(snapshot, absent, evidence).disposition, "blocked");
  });
});

test("duplicate, foreign and malformed reports fail closed without exposing their content", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "tool");
    for (const change of [
      evidence => evidence.reports.push(evidence.reports[0]),
      evidence => { evidence.reports[0].subject = { kind: "entry", entryId: "backend" }; },
      evidence => { evidence.reports[0].code = "/secret/path: private-error"; },
      evidence => { evidence.reports[0].disposition = "__proto__"; },
      evidence => { evidence.reports[0] = null; },
      evidence => { evidence.reports[1].subject.kind = "unknown"; },
      evidence => { evidence.reports = "malformed"; },
    ]) {
      const evidence = evidenceFor(snapshot, selection);
      change(evidence);
      const result = assessPluginDisable(snapshot, selection, evidence);
      assert.equal(result.disposition, "blocked");
      assert.doesNotMatch(JSON.stringify(result), /secret\/path|private-error|__proto__/u);
    }
  });
});

test("report projection never copies undeclared fields from a module's subject", async () => {
  await fixture(({ snapshot }) => {
    const selection = select(snapshot, "tool");
    const evidence = evidenceFor(snapshot, selection);
    evidence.reports[0].subject.privateCredential = "private-value";
    evidence.reports[1].privatePayload = "private-payload";
    const result = assessPluginDisable(snapshot, selection, evidence);
    assert.equal(result.disposition, "direct");
    assert.doesNotMatch(JSON.stringify(result), /privateCredential|private-value|private-payload/u);
  });
});

test("management semantics have no business imports, Cordis runtime, IO, or module-name branches", async () => {
  for (const file of ["management-types.ts", "selection.ts", "assessment.ts"]) {
    const source = await readFile(new URL(`../src/boot/plugin-control/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'](?:node:|@deepseek|\.\.\/)/u);
    assert.doesNotMatch(source, /(?:module|entry)\.name\s*===|\.dispose\(|\.update\(|process\./u);
  }
});
