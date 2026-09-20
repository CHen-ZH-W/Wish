import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSessionResources } from "../dist/sessions/index.js";
import { createContextBundle } from "../dist/context/index.js";
import { createAgentLoopPipeline } from "../dist/composition/agent-loop-standalone.js";
import { Runtime } from "../dist/core/runtime/runtime.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";
import { MemoryRuntime, InMemoryStateStore } from "../dist/memory/index.js";
import { MemoryWriteTool, captureCurrentSessionEvidence } from "../dist/memory/consumers/model-tools.js";
import { hash } from "../dist/memory/validation.js";

test("Memory proposal follows the Application Session lease, never the default data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "wish-memory-session-isolation-"));
  const memory = new MemoryRuntime(new InMemoryStateStore());
  try {
    const defaults = createFileSessionResources(join(root, "default"));
    const custom = createFileSessionResources(join(root, "custom"));
    for (const sessions of [defaults, custom]) await sessions.manager.create({ sessionId: "same-session", agentId: "agent", scope: root });
    await defaults.manager.appendMessages({ sessionId: "same-session", messages: [{
      idempotencyKey: "default-input", runId: "same-run", userTurnId: "default-turn", stepId: "default-step", origin: "user_input",
      message: { role: "user", content: "WRONG DEFAULT EVIDENCE" },
    }] });
    const registry = new ToolRegistry();
    // A default manager with identical logical IDs must not be used by this Consumer.
    MemoryWriteTool.apply({ memory, tools: { register: definition => registry.register(definition) }, sessions: defaults });
    const ref = { provider: "fixture", model: "fixture" };
    let invocations = 0;
    const context = createContextBundle({ history: custom.history.context,
      archive: { archive: ({ result }) => ({ locator: `tool:${result.callId}`, hash: `sha256:${hash(result)}` }) },
      models: { getContextWindowTokens: () => 4096 }, counter: { count: () => ({ inputTokens: 16, method: "fixture" }) }, configuration: { reservedOutputTokens: 512 } });
    const pipeline = createAgentLoopPipeline({ sessions: custom, agentId: "agent", context,
      compaction: { compact() { throw new Error("Unexpected compaction"); } },
      workspace: { resolve: ({ root }) => ({ requestedRoot: root, root, fingerprint: "workspace:fixture", revision: "revision:fixture", instructions: [] }) },
      models: { configuredModel: { resolve: () => ({ ref }), getDefaultModel: () => ref, getModelSpec: () => ({ toolCalling: true, input: { image: false } }) },
        model: { async *stream(request) {
          yield { type: "start", model: request.model };
          if (invocations++ === 0) yield { type: "tool_call", call: { id: "write-candidate", name: "memory_write", argumentsJson: JSON.stringify({
            id: "test-knowledge", expectedVersion: 0, title: "Actual source", content: "Derived from custom Session", appliesTo: "fixture", keywords: [], reason: "reviewable",
          }) } };
          else yield { type: "text_delta", text: "Candidate submitted" };
          yield { type: "done", finishReason: invocations === 1 ? "tool_calls" : "stop" };
        } } },
      tools: { registry, approval: { requestApproval: () => ({ status: "approved" }) } },
    });
    const runtime = new Runtime({ stepPipeline: pipeline });
    const handle = runtime.startRun({ id: "agent" }, { runId: "same-run", scope: "same-session", inputSource: "user", payload: { text: "CUSTOM ACTUAL EVIDENCE" } });
    assert.equal((await handle.completion).status, "completed");
    const candidate = (await memory.state()).candidates[0];
    assert.ok(candidate, "memory_write must succeed with the current Session-bound Port");
    const history = await custom.manager.readHistory({ sessionId: "same-session" });
    const prefix = history.records.filter(record => record.kind === "message" && record.runId === "same-run" && record.sequence <= candidate.evidence[0].throughSequence);
    const defaultHistory = await defaults.manager.readHistory({ sessionId: "same-session" });
    assert.equal(candidate.evidence[0].digest, hash(prefix));
    assert.notEqual(candidate.evidence[0].digest, hash(defaultHistory.records));
    assert.equal(prefix[0].message.content, "CUSTOM ACTUAL EVIDENCE");
    assert.equal(defaultHistory.records.length, 1);
    assert.equal((await memory.query()).length, 0);
  } finally { await memory.close(); await rm(root, { recursive: true, force: true }); }
});

test("Memory evidence fails closed without a Host port or with a foreign Session", async () => {
  const context = { permissions: { subject: { sessionId: "session", runId: "run" } } };
  await assert.rejects(captureCurrentSessionEvidence(context), /Host-bound/);
  await assert.rejects(captureCurrentSessionEvidence({ ...context, sessionHistory: { read: async () => ({ sessionId: "foreign", records: [] }) } }), /does not match/);
  await assert.rejects(captureCurrentSessionEvidence({ ...context, sessionHistory: { read: async () => ({ sessionId: "session", records: [] }) } }), /committed/);
});
