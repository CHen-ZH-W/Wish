import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createContextBundle } from "../dist/context/context.js";
import ContextEngine from "../dist/context/service.js";

const item = { id: "source:item", kind: "reference", placement: "before_current_user", message: { role: "assistant", content: "source" } };
const source = { id: "source", provide: () => [item] };
const options = {
  history: { read: () => [] }, agentInstructions: [], archive: {},
  models: { getContextWindowTokens: () => 4096 }, counter: { count: () => ({ inputTokens: 32, method: "fixture" }) },
  configuration: { reservedOutputTokens: 512 },
};
function step(ordinal = 1) {
  return { snapshot: { schemaVersion: 1, capturedAt: "2026-09-13T00:00:00Z", stateVersion: ordinal,
    run: { runId: "run" }, userTurn: { userTurnId: "turn", ordinal: 1 }, step: { stepId: `step-${ordinal}`, ordinal } },
    sessionId: "session", model: { provider: "mock", model: "mock" },
    workspace: { cwd: "/workspace", fingerprint: "w", revision: "r", instructions: [] } };
}

test("live sources refresh existing bundles between Steps, never during a retry", () => {
  let sources = [];
  const bundle = createContextBundle({ ...options, additionalProviderSource: () => sources });
  const first = step(); const initial = bundle.forStep(first);
  sources = [source];
  assert.deepEqual(bundle.forStep(first).providers, initial.providers);
  assert.equal(initial.providers.some(p => p.id === "source"), false);
  assert.equal(bundle.forStep(step(2)).providers.at(-1), source);
  assert.equal(bundle.configuration.providerOrder.at(-1), "source");
  sources = [];
  assert.equal(bundle.forStep(step(3)).providers.some(p => p.id === "source"), false);
  sources = [{ ...source, id: "history" }];
  assert.throws(() => bundle.forStep(step(4)), /Duplicate/);
});

test("ContextEngine registration unload aborts and drains reads, then existing bundle sees replacement", async () => {
  const root = new Context();
  root.provide("sessions", { open: () => ({ history: { context: options.history } }) });
  root.provide("models", {});
  let releases = 0;
  root.provide("toolResultArchive", { open: () => ({ release: () => { releases++; return true; } }) });
  await root.plugin(ContextEngine);
  const bundle = root.contextEngine.open({ dataDirectory: "/tmp/fixture", agentInstructions: [],
    models: { configuredModel: options.models, requestCounter: options.counter }, configuration: options.configuration });
  let begun, drained = false, seen;
  const started = new Promise(resolve => { begun = resolve; });
  const fiber = root.plugin({ inject: ["contextEngine"], apply(ctx) {
    ctx.contextEngine.registerProvider({ id: "source", provide(_input, signal) {
      seen = signal; begun();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        setImmediate(() => { drained = true; reject(signal.reason); });
      }, { once: true }));
    } });
  } });
  try {
    await fiber.await();
    const view = bundle.forStep(step()); const old = view.providers.at(-1);
    const pending = old.provide(view.input); const rejected = assert.rejects(pending, /unregistered/);
    await started; await fiber.dispose(); await rejected;
    assert.equal(seen.aborted, true); assert.equal(drained, true);
    await assert.rejects(old.provide(view.input), /unregistered/);
    assert.equal(bundle.providers.some(p => p.id === "source"), false);
    const next = root.plugin({ inject: ["contextEngine"], apply(ctx) { ctx.contextEngine.registerProvider(source); } });
    await next.await();
    const current = bundle.forStep(step(2));
    assert.deepEqual(await current.providers.at(-1).provide(current.input), [item]);
    assert.equal(bundle.configuration.providerOrder.at(-1), "source");
    await next.dispose();
  } finally {
    assert.equal(bundle.release(), true); assert.equal(bundle.release(), false);
    await root.fiber.dispose();
  }
  assert.equal(releases, 1);
});
