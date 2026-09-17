import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { createMemoryTools } from "../dist/memory/consumers/model-tools.js";
import { MemoryContextProvider } from "../dist/memory/consumers/context.js";
import { createMemorySessionFeature } from "../dist/memory/consumers/session-feature.js";
import { issueToolAuthorizationGrant, withActiveToolAuthorizationGrant } from "../dist/core/tools/authorization.js";
import { createPlanPermissionPolicy } from "../dist/plan/policy.js";
import { createCoordinatorPermissionPolicy } from "../dist/coordinator/policy.js";
import { basicToolContext } from "./support/basic-tool-context.mjs";

const ctx = basicToolContext("/workspace");
const evidence = [{ kind: "session", id: "session:run", revision: "r1", digest: "a".repeat(64), throughSequence: 1 }];
const proposal = { targetId: "tests", expectedDocumentVersion: 0, title: "Tests", content: "Use focused tests.", appliesTo: "Wish", keywords: ["tests"], evidence,
  operationId: "p1", actor: { kind: "agent", id: "wish", sessionId: "session", runId: "run" }, reason: "reusable" };
async function prepared() {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const candidate = await memory.propose(proposal);
  await memory.decide({ candidateId: candidate.id, expectedCandidateVersion: 1, decision: "accept", operationId: "a1", actor: { kind: "human", id: "operator" }, reason: "reviewed" });
  return memory;
}
function parsed(tool, input) { const result = tool.parse(input); assert.equal(result.ok, true); return result.input; }
function grant(tool, input, context = ctx) { return issueToolAuthorizationGrant({ grantId: "grant", call: { status: "ready", id: "call1", name: tool.name, input },
  capabilities: tool.resolveCapabilities(input, context), policyVersion: "policy-1", snapshot: { schemaVersion: 1, registryVersion: 1, authorityVersion: ctx.permissions.authorityVersion, availableTools: [tool.name] },
  clock: { now: () => new Date(1000) }, issuedAtEpochMs: 1000, ttlMs: 60000 }); }
function decode(result) { return JSON.parse(result.content[0].text.split("\n").slice(1).join("\n")); }

test("Memory Tools bind exact input and Step authority; writes remain candidates", async () => {
  const memory = await prepared();
  const tools = createMemoryTools(memory, { capture: async () => evidence });
  assert.deepEqual(tools.map(tool => tool.name), ["memory_search", "memory_read", "memory_write"]);
  const read = tools[1], input = parsed(read, { id: "tests", expectedVersion: 1, limit: 3 });
  const inactive = grant(read, input);
  await assert.rejects(read.execute(input, ctx, inactive), /not active/);
  const active = grant(read, input);
  const result = await withActiveToolAuthorizationGrant(active, () => read.execute(input, ctx, active));
  assert.equal(decode(result).content, "Use");
  assert.equal(decode(result).nextOffset, 3);
  const changed = grant(read, input);
  await assert.rejects(withActiveToolAuthorizationGrant(changed, () => read.execute({ ...input, id: "other" }, ctx, changed)), /exact request/);
  const wrongStep = grant(read, input);
  await assert.rejects(withActiveToolAuthorizationGrant(wrongStep, () => read.execute(input, { ...ctx, permissions: { ...ctx.permissions, subject: { ...ctx.permissions.subject, stepId: "other" } } }, wrongStep)), /exact request/);
  const write = tools[2], proposed = parsed(write, { id: "tests", expectedVersion: 1, title: "Tests", content: "New candidate", appliesTo: "Wish", keywords: [], reason: "update" });
  const writer = grant(write, proposed);
  assert.equal(decode(await withActiveToolAuthorizationGrant(writer, () => write.execute(proposed, ctx, writer))).status, "pending");
  assert.equal((await memory.read("tests")).content, proposal.content);
  for (const raw of [{ ...proposed, actor: { kind: "human" } }, { ...proposed, evidence }, { ...proposed, reviewSessionId: "other" }, { ...proposed, id: "../bad" }]) assert.equal(write.parse(raw).ok, false);
  assert.deepEqual(createMemoryTools(memory).map(tool => tool.name), ["memory_search", "memory_read"]);
});

test("Memory projection is bounded reference data, excludes pending and does not invent Tool availability", async () => {
  const memory = await prepared(), provider = new MemoryContextProvider(memory);
  const input = { sessionId: "session", runId: "run", userTurnId: "turn", stepId: "step", model: { provider: "mock", model: "mock" },
    workspace: { cwd: "/workspace", fingerprint: "w", revision: "v", instructions: [] }, runtime: { capturedAt: "2026-09-13T00:00:00Z", stateVersion: 1, userTurnOrdinal: 1, stepOrdinal: 1 },
    request: { currentMessage: { role: "user", content: "tests" }, source: "user", availableTools: ["memory_read"] } };
  let result = await provider.provide(input);
  assert.equal(result[0].kind, "reference");
  assert.equal(result[0].message.role, "assistant");
  assert.match(result[0].message.content, /Use memory_read/);
  assert.ok(result[0].message.content.length < 7000);
  result = await provider.provide({ ...input, request: { ...input.request, availableTools: [] } });
  assert.doesNotMatch(result[0].message.content, /Use memory_read/);
  await memory.propose({ ...proposal, operationId: "pending", targetId: "private-candidate", content: "not visible yet" });
  assert.doesNotMatch(JSON.stringify(await provider.provide({ ...input, request: undefined })), /not visible yet/);
});

test("Plan and Coordinator permit read controls but reject stale Memory write calls", async () => {
  const controls = () => ["memory_read", "memory_search"].map(toolName => ({ toolName, resourcePrefix: "memory." }));
  for (const policy of [createPlanPermissionPolicy({ get: async () => ({ active: true, version: 1 }) }, controls), createCoordinatorPermissionPolicy({ get: async () => ({ active: true, version: 1 }) }, controls)]) {
    const projection = await policy.project({ request: { subject: ctx.permissions.subject }, availableTools: ["memory_read", "memory_search", "memory_write"], allowedCapabilities: ["runtime.read", "runtime.control"] });
    assert.deepEqual(projection.availableTools, ["memory_read", "memory_search"]);
    const result = await policy.authorize({ context: ctx, call: { name: "memory_write" }, capabilities: { requirements: [{ capability: "runtime.control", resources: ["memory.memory_write:default:tests"] }] } }, projection);
    assert.equal(result.status, "denied");
  }
});

test("Human Memory review is Session-bound, version-pinned and does not accept forged tokens", async () => {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  await memory.propose(proposal);
  const feature = createMemorySessionFeature(memory);
  assert.equal(await feature.inspect("other-session"), undefined);
  const view = await feature.inspect("session");
  await assert.rejects(feature.act("other-session", "accept", view.token), /identity/);
  await assert.rejects(feature.act("session", "accept", { ...view.token, digest: "forged" }), /identity/);
  await feature.act("session", "accept", view.token, "Reviewed original source");
  assert.equal((await memory.read("tests")).status, "accepted");
  await assert.rejects(feature.act("session", "accept", view.token), /version changed/);
});

test("Host review routing brings child candidates to the parent without changing source identity", async () => {
  const memory = new MemoryRuntime(new InMemoryStateStore());
  const child = { ...proposal, actor: { kind: "child", id: "child", sessionId: "child-session", runId: "child-run" }, reviewSessionId: "parent-session" };
  const candidate = await memory.propose(child);
  assert.equal(candidate.actor.sessionId, "child-session");
  const feature = createMemorySessionFeature(memory);
  assert.equal(await feature.inspect("child-session"), undefined);
  const view = await feature.inspect("parent-session");
  assert.ok(view);
  await assert.rejects(memory.propose({ ...child, reviewSessionId: "another-parent" }), /idempotency conflict/);
  await assert.rejects(feature.act("child-session", "accept", view.token), /identity/);
  await feature.act("parent-session", "accept", view.token);
  assert.equal((await memory.read("tests")).status, "accepted");
});
