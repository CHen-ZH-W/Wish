import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import ApprovalHub from "../dist/approval/service.js";
import MemoryApprovalRules from "../dist/permissions/rules/providers/memory.js";
import DefaultPermissions from "../dist/permissions/providers/default.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import HostShell from "../dist/shell/providers/host.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";
import { ToolExecutor, ToolRegistry } from "../dist/core/tools/scheduler.js";
import { DevelopmentRuntime } from "../dist/development/runtime.js";
import { MemoryDevelopmentStore } from "../dist/development/store.js";
import { DevelopmentContextProvider } from "../dist/development/consumers/context.js";
import { createDevelopmentTools } from "../dist/development/consumers/model-tools.js";
import { createDevelopmentPermissionPolicy } from "../dist/development/consumers/policy.js";
import { createDevelopmentVerificationTool } from "../dist/development/consumers/verification-tool.js";
import { PlanRuntime } from "../dist/plan/runtime.js";
import { MemoryPlanStateStore } from "../dist/plan/store.js";
import { createPlanPermissionPolicy } from "../dist/plan/policy.js";

const spec = {
  objective: "Deliver a checked greeting", scope: ["Print verified"], outOfScope: ["Network services"], constraints: ["Keep user files"],
  criteria: [{ id: "greeting", text: "The command prints verified", kind: "technical" }, { id: "clarity", text: "The delivery explanation is understandable", kind: "user" }],
  questions: [], assumptions: ["Local use"], decisions: ["One increment"], planMarkdown: "Inspect, implement the greeting, run the check, explain the result.",
  assessment: { complexity: "low", uncertainty: "low", risk: "low", recommendedLevel: "light", reason: "Local bounded change" },
};
const current = project => project.changes.find(change => change.id === project.activeChangeId);
const request = project => ({ projectId: project.id, changeId: current(project).id, sessionId: "session", expectedRevision: project.revision });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wish-development-consumers-"));
  await writeFile(join(directory, "source.txt"), "user data\n");
  const state = new DevelopmentRuntime(new MemoryDevelopmentStore());
  const root = new Context();
  await root.plugin(ApprovalHub); await root.plugin(MemoryApprovalRules); await root.plugin(LocalFilesystem);
  await root.plugin(HostShell, { enabled: true }); await root.plugin(DefaultSandboxPolicy); await root.plugin(DefaultPermissions);
  const begins = [], beginRequests = new Set();
  let conversationInput;
  const port = { state, async begin(input) {
    begins.push(input);
    const project = await state.forSession(input.sessionId), active = project && current(project);
    if (!active) return state.open(input);
    if (active.phase === "stopping" && active.starts.some(start => start.runId === input.runId && ["dispatching", "running"].includes(start.status))) return project;
    if (beginRequests.has(input.requestId) || active.originRequestId === input.requestId) return project;
    beginRequests.add(input.requestId);
    return state.revise({ projectId: project.id, changeId: active.id, sessionId: input.sessionId, expectedRevision: project.revision, rawWish: input.rawWish });
  }, conversationInput: async (sessionId, runId) => conversationInput?.sessionId === sessionId && conversationInput.runId === runId ? { rawWish: conversationInput.rawWish, requestId: conversationInput.requestId } : undefined,
  propose: input => state.propose(input), report: input => state.report(input), recordVerification: input => state.recordVerification(input) };
  root.permissions.registerPolicy(createDevelopmentPermissionPolicy(state));
  const registry = new ToolRegistry();
  for (const definition of createDevelopmentTools(port)) registry.register(definition);
  registry.register(createDevelopmentVerificationTool({ development: port, shell: root.shell }));
  let writes = 0, ordinal = 0;
  registry.register({ name: "write", description: "fixture source mutation", inputSchemaJson: '{"type":"object"}', executionMode: "sequential", recoveryPolicy: "retry-safe",
    parse: input => ({ ok: true, input }), resolveCapabilities: () => ({ requirements: [{ capability: "filesystem.write", paths: ["source.txt"] }] }), execute: () => ({ writes: ++writes }) });
  registry.register({ name: "spawn_agent", description: "fixture child", inputSchemaJson: '{"type":"object"}', executionMode: "sequential", recoveryPolicy: "retry-safe",
    parse: input => ({ ok: true, input }), resolveCapabilities: () => ({ requirements: [{ capability: "runtime.control", resources: ["subagents.spawn:session"] }] }), execute: () => { throw new Error("child must never start"); } });
  const executor = new ToolExecutor({ registry, authorization: root.permissions });
  const workspace = { requestedRoot: directory, root: directory, fingerprint: "development-fixture", revision: "workspace-v1", instructions: [] };
  const subject = (runId = "human-run", stepId = `step-${++ordinal}`) => ({ agentId: "wish", sessionId: "session", runId, userTurnId: "human-turn", stepId });
  async function step(runId = "human-run", sessionId = "session", userTurnId = "human-turn") {
    const identity = { ...subject(runId), sessionId, userTurnId };
    const permissions = await root.permissions.resolve({ subject: identity, workspace, registeredTools: registry.list().map(tool => tool.name), agent: { profile: "full-access" } });
    return { permissions, identity, snapshot: registry.captureSnapshot({ authorityVersion: permissions.authorityVersion, availableTools: permissions.availableTools }) };
  }
  async function call(name, input, captured, options = {}) {
    const selected = captured ?? await step(options.runId);
    const parsed = registry.parseCall({ id: `call-${++ordinal}`, name, argumentsJson: JSON.stringify(input) });
    assert.equal(parsed.ok, true, parsed.call?.error?.message);
    return executor.execute({ call: parsed.call, scope: selected.identity, snapshot: selected.snapshot,
      context: { cwd: directory, workspace, permissions: selected.permissions, userTurn: {
        runId: selected.identity.runId, userTurnId: selected.identity.userTurnId, ordinal: 1, inputSource: "user", provenance: { origin: "run_input", source: "user", receivedAt: new Date().toISOString() },
        ...options.userTurn,
      }, ...(options.sessionHistory ? { sessionHistory: { read: async () => options.sessionHistory } } : {}) }, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  }
  async function open() { return state.open({ sessionId: "session", workspaceRoot: directory, rawWish: "Make a greeting" }); }
  async function running() {
    let project = await open(); project = await state.propose({ ...request(project), spec });
    project = await state.confirm({ ...request(project), specVersion: 1, specDigest: current(project).specs[0].digest, actor: "human" });
    project = await state.reserveStart({ ...request(project), requestId: "start-1", confirmationDigest: current(project).confirmations.at(-1).digest });
    const start = current(project).starts.at(-1);
    project = await state.bindStart({ projectId: project.id, requestId: start.id, runId: start.runId });
    return { project, runId: start.runId };
  }
  const binding = project => ({ expectedRevision: project.revision, executionEpoch: current(project).executionEpoch, confirmationDigest: current(project).confirmations.at(-1).digest });
  return { directory, root, state, port, begins, registry, workspace, step, call, open, running, binding, writes: () => writes, setConversationInput: value => { conversationInput = value; },
    async close() { await root.fiber.dispose(); await state.close(); await rm(directory, { recursive: true, force: true }); } };
}

const providerInput = (fixture, availableTools, content = "请帮我增加一个搜索功能") => ({ sessionId: "session", runId: "human-run", workspace: { cwd: fixture.directory },
  request: { availableTools, source: "user", currentMessage: { role: "user", content } } });
const humanHistory = (rawWish, runId = "human-run", userTurnId = "human-turn", sessionId = "session") => ({ sessionId, historyRevision: "human-history",
  records: [{ kind: "message", runId, userTurnId, origin: "user_input", inputSource: "user", message: { role: "user", content: rawWish } }] });

test("ordinary coding requests receive tool-scoped discovery guidance without an opt-in mode or new state for read-only questions", async () => {
  const f = await fixture();
  try {
    const provider = new DevelopmentContextProvider(f.state);
    const entry = await provider.provide(providerInput(f, ["wish_begin", "wish_read", "wish_propose"]));
    assert.equal(entry.length, 1);
    assert.match(entry[0].message.content, /ordinary conversation/);
    assert.match(entry[0].message.content, /automatically call wish_begin before implementation/);
    assert.match(entry[0].message.content, /Pure explanation, code reading, status questions and explicitly read-only analysis do not create an increment/);
    assert.match(entry[0].message.content, /use wish_propose/);
    assert.deepEqual(await f.state.list(), [], "Guidance must not itself create an increment");
    const readOnly = await provider.provide(providerInput(f, ["wish_read"], "解释一下这段代码"));
    assert.doesNotMatch(readOnly[0].message.content, /wish_begin|wish_propose|wish_verify|wish_report/);
    assert.deepEqual(await provider.provide(providerInput(f, ["read", "grep"])), []);
    assert.deepEqual(await provider.provide({ sessionId: "session", runId: "human-run" }), []);
  } finally { await f.close(); }
});

test("wish_begin preserves authenticated human wording and binds the actual chat Run", async () => {
  const f = await fixture();
  try {
    const rawWish = "我想给当前项目增加标签搜索，数据仍保存在本地。";
    const result = await f.call("wish_begin", { rawWish: "Model summary with an inferred cloud service" }, undefined, { sessionHistory: humanHistory(rawWish) });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(current(result.output.project).rawWish, rawWish);
    assert.equal(f.begins[0].runId, "human-run");
    assert.equal(f.begins[0].requestId, "human-turn");
    assert.equal(current(result.output.project).confirmations.length, 0);
  } finally { await f.close(); }
});

test("wish_begin rejects missing current human evidence and does not claim continuation text as a human request", async () => {
  const f = await fixture();
  try {
    const history = humanHistory("another turn", "other-run", "other-turn");
    const missing = await f.call("wish_begin", { rawWish: "invented request" }, undefined, { sessionHistory: history });
    assert.equal(missing.ok, false); assert.equal(missing.error.code, "permission_denied");
    const continuation = await f.call("wish_begin", { rawWish: "not a human request" }, undefined, { userTurn: {
      provenance: { origin: "continuation", source: "wish-webui", receivedAt: new Date().toISOString(), controlId: "host-result" },
    } });
    assert.equal(continuation.ok, false); assert.equal(continuation.error.code, "permission_denied");
    const internal = await f.call("wish_begin", { rawWish: "host exploration instructions" }, undefined, { userTurn: {
      inputSource: "follow_up", provenance: { origin: "run_input", source: "follow_up", receivedAt: new Date().toISOString() },
    } });
    assert.equal(internal.ok, false); assert.equal(internal.error.code, "permission_denied");
    assert.deepEqual(await f.state.list(), []);
  } finally { await f.close(); }
});

test("a later human coding request revises the same idle increment without approving it; an active execution or other owner is rejected", async () => {
  const f = await fixture();
  try {
    let project = await f.open();
    const initialChangeId = current(project).id;
    const rawWish = "再加上批量编辑标签，但先不要加入云同步。";
    const revised = await f.call("wish_begin", { rawWish }, await f.step("next-run", "session", "next-turn"), { sessionHistory: humanHistory(rawWish, "next-run", "next-turn") });
    assert.equal(revised.ok, true, revised.error?.message);
    project = revised.output.project;
    assert.equal(current(project).id, initialChangeId);
    assert.equal(current(project).rawWish, "Make a greeting");
    assert.deepEqual(current(project).wishUpdates, [rawWish]);
    assert.equal(current(project).confirmations.length, 0);
    const provider = new DevelopmentContextProvider(f.state);
    const context = await provider.provide(providerInput(f, ["wish_begin", "wish_read", "wish_propose"]));
    assert.match(context[0].message.content, /再加上批量编辑标签/);
    assert.match(context[0].message.content, /preserve it as a revision/);
    assert.match(context[0].message.content, /Only the conversation's human review controls/);
    const other = await f.call("wish_begin", { rawWish: "Replace this project" }, await f.step("other-run", "other-session", "other-turn"));
    assert.equal(other.ok, false); assert.equal(other.error.code, "conflict");
    assert.equal(f.begins.length, 1, "A rejected owner must not call the business mutation port");
  } finally { await f.close(); }
  const executing = await fixture();
  try {
    const { project, runId } = await executing.running();
    const result = await executing.call("wish_begin", { rawWish: "Change the approved scope" }, await executing.step(runId));
    assert.equal(result.ok, false); assert.equal(result.error.code, "conflict");
    assert.equal((await executing.state.forSession("session")).revision, project.revision);
    assert.equal(executing.begins.length, 0);
  } finally { await executing.close(); }
});

test("accepted and detached history remains readable while a new natural request can create the next increment", async () => {
  const f = await fixture();
  try {
    let project = await f.open();
    project = await f.state.propose({ ...request(project), spec: { ...spec, criteria: [spec.criteria[1]] } });
    project = await f.state.confirm({ ...request(project), specVersion: 1, specDigest: current(project).specs[0].digest, actor: "human" });
    project = await f.state.report({ ...request(project), summary: "The first increment was delivered", limitations: ["Local only"], nextSteps: ["Add filtering"] });
    const report = current(project).reports.at(-1);
    project = await f.state.accept({ ...request(project), reportId: report.id, reportDigest: report.digest, actor: "human" });
    const acceptedId = project.changes[0].id;
    const historical = await f.call("wish_read", {});
    assert.equal(historical.ok, true);
    assert.match(historical.output.content[0].text, /The first increment was delivered/);
    assert.match(historical.output.content[0].text, /"historyOnly": true/);
    const provider = new DevelopmentContextProvider(f.state);
    const entry = await provider.provide(providerInput(f, ["wish_begin", "wish_read", "wish_propose"], "增加一个筛选功能"));
    assert.match(entry[0].message.content, /Previous project facts are historical reference/);
    assert.match(entry[0].message.content, /Local only/);
    assert.doesNotMatch(entry[0].message.content, /"files"\s*:/);
    await f.state.detachSession("session");
    const newStep = await f.step("new-run", "new-session", "new-turn");
    const readDetached = await f.call("wish_read", {}, newStep);
    assert.equal(readDetached.output.project.id, project.id);
    const next = await f.call("wish_begin", { rawWish: "Add filtering" }, newStep);
    assert.equal(next.ok, true, next.error?.message);
    assert.equal(next.output.project.id, project.id);
    assert.equal(next.output.project.changes.length, 2);
    assert.equal(next.output.project.changes[0].id, acceptedId);
    assert.equal(next.output.project.changes[0].reports[0].acceptedBy, "human");
    assert.equal(current(next.output.project).rawWish, "Add filtering");
    assert.equal(current(next.output.project).confirmations.length, 0);
  } finally { await f.close(); }
});

test("a stopping Run records the latest accepted human steering request without reusing its old UserTurn wording", async () => {
  const f = await fixture();
  try {
    let { project, runId } = await f.running();
    project = await f.state.requestPause(request(project));
    const rawWish = "先把搜索改为按标签筛选，暂时不要继续原来的实现。";
    f.setConversationInput({ sessionId: "session", runId, rawWish, requestId: "host-steering-request" });
    const history = humanHistory("old implementation request", runId);
    history.records.push({ kind: "message", runId, userTurnId: "human-turn", origin: "steering", inputSource: "steering", message: { role: "user", content: rawWish } });
    const result = await f.call("wish_begin", { rawWish: "model summary" }, await f.step(runId), { sessionHistory: history, userTurn: {
      inputSource: "follow_up", provenance: { origin: "follow_up", source: "wish-goal-round-driver", receivedAt: new Date().toISOString(), controlId: "goal-round" },
    } });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(f.begins[0].rawWish, rawWish);
    assert.equal(f.begins[0].requestId, "host-steering-request");
    assert.equal(f.begins[0].runId, runId);
    assert.equal(result.output.project.revision, project.revision, "Consumer records the pending request without editing the stopping increment");
    assert.match(result.output.content[0].text, /End this turn now/);
    const provider = new DevelopmentContextProvider(f.state);
    const context = await provider.provide(providerInput(f, ["wish_begin", "wish_read", "wish_propose"]));
    assert.match(context[0].message.content, /Do not submit a proposal or keep polling/);
    assert.doesNotMatch(context[0].message.content, /Use wish_propose while exploring/);
  } finally { await f.close(); }
});

test("Host pre-input alone cannot authorize a deferred request before Runtime accepts its message", async () => {
  const f = await fixture();
  try {
    let { project, runId } = await f.running();
    project = await f.state.requestPause(request(project));
    f.setConversationInput({ sessionId: "session", runId, rawWish: "new unaccepted request", requestId: "pre-input-only" });
    const result = await f.call("wish_begin", { rawWish: "old implementation request" }, await f.step(runId), { sessionHistory: humanHistory("old implementation request", runId) });
    assert.equal(result.ok, false); assert.equal(result.error.code, "permission_denied");
    assert.equal(f.begins.length, 0);
    assert.equal((await f.state.forSession("session")).revision, project.revision);
  } finally { await f.close(); }
});

test("Wish begin requires a direct human and immediately fences an already captured unmanaged Step", async () => {
  const f = await fixture();
  try {
    const captured = await f.step();
    const otherSession = await f.step("other-run", "other-session");
    const automatic = await f.call("wish_begin", { rawWish: "Make a greeting" }, captured, { userTurn: { provenance: { origin: "follow_up", source: "wish-goal-round-driver", receivedAt: new Date().toISOString(), controlId: "auto" } } });
    assert.equal(automatic.ok, false); assert.equal(automatic.error.code, "permission_denied");
    assert.equal(await f.state.forSession("session"), undefined);
    const begun = await f.call("wish_begin", { rawWish: "Make a greeting" }, captured);
    assert.equal(begun.ok, true);
    const mutation = await f.call("write", {}, captured);
    assert.equal(mutation.ok, false); assert.equal(f.writes(), 0);
    assert.equal((await f.call("write", {}, otherSession)).ok, false);
    assert.equal((await f.call("write", {}, await f.step("other-run", "other-session"))).ok, false);
    assert.equal((await f.call("wish_read", {}, captured)).ok, true);
    const project = await f.state.forSession("session");
    const proposed = await f.call("wish_propose", { expectedRevision: project.revision, spec }, captured);
    assert.equal(proposed.ok, true); assert.equal(current(proposed.output.project).specs.length, 1);
    assert.equal(current(proposed.output.project).confirmations.length, 0);
  } finally { await f.close(); }
});

test("confirmation cannot loosen an old Step; only the exact bound Run can mutate and pause revokes it immediately", async () => {
  const f = await fixture();
  try {
    let project = await f.open(); const discussion = await f.step();
    project = await f.state.propose({ ...request(project), spec });
    project = await f.state.confirm({ ...request(project), specVersion: 1, specDigest: current(project).specs[0].digest, actor: "human" });
    project = await f.state.reserveStart({ ...request(project), requestId: "start", confirmationDigest: current(project).confirmations.at(-1).digest });
    const runId = current(project).starts.at(-1).runId;
    assert.equal((await f.call("write", {}, discussion)).ok, false);
    assert.equal((await f.call("write", {}, await f.step("wrong-run"))).ok, false);
    const executing = await f.step(runId);
    assert.equal((await f.call("write", {}, executing)).ok, true);
    assert.equal((await f.call("spawn_agent", {}, executing)).ok, false);
    project = await f.state.requestPause(request(project));
    assert.equal((await f.call("write", {}, executing)).ok, false);
    assert.equal((await f.call("wish_read", {}, executing)).ok, true);
    assert.equal(f.writes(), 1);
    const projected = await f.step(runId);
    assert.equal(projected.permissions.ceiling.allowedCapabilities.includes("process.exec"), false);
  } finally { await f.close(); }
});

test("dynamic context retains confirmed scope and plan after approval and does not infer acceptance", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const provider = new DevelopmentContextProvider(f.state);
    const context = await provider.provide({ sessionId: "session", runId, workspace: { cwd: f.directory }, request: { availableTools: ["wish_begin", "wish_read", "wish_propose", "wish_verify", "wish_report"] } });
    assert.equal(context.length, 1);
    assert.match(context[0].message.content, /Network services/);
    assert.match(context[0].message.content, /Inspect, implement the greeting/);
    assert.match(context[0].message.content, new RegExp(current(project).confirmations.at(-1).digest));
    assert.match(context[0].message.content, /never imply product acceptance/);
  } finally { await f.close(); }
});

test("Plan and development policies allow narrow Wish draft controls while preserving the execution hold", async () => {
  const f = await fixture(), plan = new PlanRuntime({ store: new MemoryPlanStateStore() });
  try {
    const controls = ["wish_begin", "wish_read", "wish_propose"].map(toolName => ({ toolName, resourcePrefix: "wish." }));
    f.root.permissions.registerPolicy(createPlanPermissionPolicy(plan, () => controls));
    const project = await f.open();
    await plan.enter({ sessionId: "session", goal: "Explore this Wish" });
    const discussion = await f.step();
    assert.equal((await f.call("wish_read", {}, discussion)).ok, true);
    const proposed = await f.call("wish_propose", { expectedRevision: project.revision, spec }, discussion);
    assert.equal(proposed.ok, true, proposed.error?.message);
    assert.equal((await f.call("write", {}, discussion)).ok, false);
    assert.equal(discussion.permissions.availableTools.includes("wish_verify"), false);
  } finally { await plan.close(); await f.close(); }
});

test("wish_verify uses actual authorized Shell execution and Host evidence; report preserves separate human criteria", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const userCriterion = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["clarity"], command: "true" }, await f.step(runId));
    assert.equal(userCriterion.ok, false); assert.equal(userCriterion.error.code, "invalid_input");
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], command: "printf verified" }, await f.step(runId));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.output.receipt.exitCode, 0); assert.equal(result.output.receipt.output, "verified");
    assert.equal(result.output.receipt.runId, runId); assert.match(result.output.receipt.outputDigest, /^[a-f0-9]{64}$/);
    const saved = await f.state.forSession("session");
    const report = await f.call("wish_report", { ...f.binding(saved), summary: "Greeting implemented and command checked", limitations: [], nextSteps: ["Review the explanation"] }, await f.step(runId));
    assert.equal(report.ok, true, report.error?.message);
    const latest = current(report.output.project).reports.at(-1);
    assert.deepEqual(latest.criteria.map(item => item.status), ["verified", "waiting-user"]);
    assert.equal(latest.acceptedAt, undefined);
    assert.equal(await readFile(join(f.directory, "source.txt"), "utf8"), "user data\n");
  } finally { await f.close(); }
});

test("verification timeouts preserve an unsuccessful Host receipt", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], timeout: 0.05, command: "node -e 'setTimeout(()=>{},1000)'" }, await f.step(runId));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.output.receipt.timedOut, true);
    assert.notEqual(result.output.receipt.exitCode, 0);
    assert.equal(current(await f.state.forSession("session")).verifications.length, 1);
  } finally { await f.close(); }
});

test("verification output is bounded by UTF-8 bytes and retains an inspectable tail", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], command: "for ((i=0;i<6000;i++)); do printf '中'; done" }, await f.step(runId));
    assert.equal(result.ok, true, result.error?.message);
    assert.ok(Buffer.byteLength(result.output.receipt.output, "utf8") <= 16384);
    assert.match(result.output.receipt.output, /^\[Output truncated/);
    assert.ok(result.output.receipt.output.endsWith("中"));
  } finally { await f.close(); }
});

test("nonzero verification exit is preserved as failed evidence and cannot be replaced by model passed flags", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const definition = f.registry.list().find(tool => tool.name === "wish_verify");
    assert.equal(JSON.parse(definition.inputSchemaJson).properties.passed, undefined);
    const forged = f.registry.parseCall({ id: "forged", name: "wish_verify", argumentsJson: JSON.stringify({ ...f.binding(project), criterionIds: ["greeting"], command: "true", passed: true }) });
    assert.equal(forged.ok, false);
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], command: "printf 'failed check' >&2; exit 7" }, await f.step(runId));
    assert.equal(result.ok, true, result.error?.message); assert.equal(result.output.receipt.exitCode, 7);
    assert.equal(result.output.receipt.output, "failed check");
    const saved = await f.state.forSession("session");
    const report = await f.call("wish_report", { ...f.binding(saved), summary: "Check failed", limitations: ["Greeting unverified"], nextSteps: ["Fix and rerun"] }, await f.step(runId));
    assert.equal(report.ok, true, report.error?.message);
    assert.equal(current(report.output.project).reports.at(-1).criteria[0].status, "failed");
  } finally { await f.close(); }
});

test("source changes during verification retain user changes but cannot create successful evidence", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], command: "node -e 'require(\"node:fs\").writeFileSync(\"source.txt\",\"changed\")'" }, await f.step(runId));
    assert.equal(result.ok, false); assert.equal(result.error.code, "conflict");
    assert.equal(current(await f.state.forSession("session")).verifications.length, 0);
    assert.equal(await readFile(join(f.directory, "source.txt"), "utf8"), "changed");
  } finally { await f.close(); }
});

test("process capability denial reaches wish_verify through Permissions before any command runs", async () => {
  const f = await fixture();
  try {
    const { project, runId } = await f.running();
    f.root.permissions.registerPolicy({ id: "deny-verification-process", project() { return { id: "deny-verification-process", revision: "1" }; },
      authorize(input) { return input.capabilities.requirements.some(item => item.capability === "process.exec") ? { status: "denied", reason: "fixture process denied" } : { status: "allowed" }; } });
    const result = await f.call("wish_verify", { ...f.binding(project), criterionIds: ["greeting"], command: "node -e 'require(\"node:fs\").writeFileSync(\"unexpected.txt\",\"ran\")'" }, await f.step(runId));
    assert.equal(result.ok, false); assert.equal(result.error.code, "permission_denied");
    await assert.rejects(readFile(join(f.directory, "unexpected.txt")), error => error.code === "ENOENT");
    assert.equal(current(await f.state.forSession("session")).verifications.length, 0);
  } finally { await f.close(); }
});
