import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { boot } from "./fixtures/candidates.mjs";
import { previewPluginSelection } from "../dist/boot/plugin-control/selection.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const RESPONSE = "ordinary-run-survived-evolution-removal";

async function sourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(...await sourceFiles(join(directory, entry.name)));
    else if (/\.tsx?$/u.test(entry.name)) paths.push(join(directory, entry.name));
  }
  return paths;
}

test("Core, AgentLoop, Sessions, Permissions and BaseApp have no reverse Evolution dependency", async () => {
  const files = [
    ...await sourceFiles(join(repository, "src/core")),
    ...await sourceFiles(join(repository, "src/sessions")),
    ...await sourceFiles(join(repository, "src/permissions")),
    ...["agent-loop-service.ts", "agent-loop-standalone.ts"].map(name => join(repository, "src/composition", name)),
    ...["application.ts", "service.ts", "types.ts", "config.ts", "execution-profile.ts", "session-features.ts", "session-feature-owner.ts"].map(name => join(repository, "src/apps", name)),
  ];
  const violations = [];
  for (const filename of files) {
    const content = await readFile(filename, "utf8");
    const file = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      let imported;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) imported = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) imported = node.arguments[0];
      if (imported && ts.isStringLiteralLike(imported)) {
        const target = imported.text.startsWith(".") ? resolve(dirname(filename), imported.text).replaceAll("\\", "/") : imported.text;
        if (/(?:^|\/)evolution(?:\/|$)/u.test(target)) violations.push(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${imported.text}`);
      }
      if ((ts.isCallExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && /(?:\.get\(["']evolution(?:Trigger)?["']\)|\.evolution(?:Trigger)?\b|\[["']evolution(?:Trigger)?["']\])/u.test(node.getText(file))) {
        violations.push(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}:Evolution service access`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (file.parseDiagnostics.length) assert.fail(`Could not parse ${filename}`);
  }
  assert.deepEqual(violations, []);
  for (const owner of ["src/core/agent-loop", "src/sessions", "src/permissions", "src/apps/application.ts"]) {
    assert.ok(files.some(filename => filename.includes(owner)), `Missing architecture scope: ${owner}`);
  }
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function modelResponse() {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: RESPONSE }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
async function awaitRelease(gate, signal) {
  signal?.throwIfAborted();
  let abort;
  try {
    await Promise.race([gate.promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("model_aborted"));
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal?.removeEventListener("abort", abort); }
}

test("Root unloads optional Evolution at the existing Step safe point and ordinary Runs remain usable", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-lifecycle-"));
  const originalFetch = globalThis.fetch, entered = deferred(), release = deferred();
  let host, application, handle;
  let requests = 0, settled = false;
  globalThis.fetch = async (_url, input) => {
    requests++; entered.resolve(); await awaitRelease(release, input.signal); return modelResponse();
  };
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "1", WISH_EVOLUTION_TRIGGER_MODE: "advisory" });
    const ctx = host.surfaceContext, evolution = ctx.get("evolution"), trigger = ctx.get("evolutionTrigger");
    assert.ok(evolution); assert.equal(evolution.available, true); assert.equal(trigger?.mode, "advisory");
    const applicationOwner = ctx.get("application");
    application = await applicationOwner.open({ maxRunSteps: 2 });
    const session = await application.createSession({ workspaceRoot: directory });
    handle = await application.startRun({ sessionId: session.sessionId, inputSource: "user", payload: { text: "Finish the ordinary task while optional Evolution is removed." } });
    void handle.completion.then(() => { settled = true; });
    await Promise.race([entered.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("main_model_request_not_started")), 10_000); timer.unref(); })]);
    assert.equal(settled, false);

    const control = host.pluginManagement, before = control.snapshot();
    const expected = ["evolution", "evolution-candidate-pipeline", "evolution-runtime-observer", "evolution-trigger", "evolution-cli"];
    const entries = expected.map(name => before.inspection.entries.find(entry => entry.id === `include:${name}`));
    assert.ok(entries.every(entry => entry?.phase === "active"), JSON.stringify(entries));
    const selection = { instanceId: before.inspection.instanceId, entryIds: entries.map(entry => entry.id).sort() };
    const impact = previewPluginSelection(before.inspection, selection);
    const affected = new Set(impact.affected.map(item => item.fiberId));
    const foundations = before.inspection.entries.filter(entry => /\/(?:apps\/service|sessions\/service|models\/service|composition\/agent-loop-service)\.js$/u.test(entry.name));
    for (const entry of foundations) {
      assert.equal(affected.has(entry.fiberId), false, `${entry.id} must not depend on Evolution`);
    }
    for (const entry of entries) {
      const coverage = before.owners.find(owner => owner.fiberId === entry.fiberId);
      assert.equal(coverage?.lifecycle, "managed", entry.id);
      assert.equal(coverage?.declaration, "canonical", entry.id);
      assert.equal(coverage?.replacement, entry.id === "include:evolution-cli" ? "drain" : "generation", entry.id);
      if (entry.manifest) assert.equal(coverage.replacement, entry.manifest.replacement, entry.id);
      assert.equal(before.controls[entry.id]?.canDisable, true, entry.id);
    }
    let disableSettled = false;
    const disabling = control.change({ requestId: "disable-optional-evolution", revision: before.revision, preference: "disabled", selection });
    void disabling.then(() => { disableSettled = true; }, () => { disableSettled = true; });
    // All configuration changes respect the existing Step boundary, including
    // optional consumers. Finishing the current Step must not be mistaken for
    // a dependency on the optional Evolution service or a cancelled Run.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disableSettled, false); assert.equal(settled, false);
    release.resolve();
    assert.equal((await handle.completion).status, "completed");
    const changed = await disabling;
    assert.equal(changed.status, "succeeded", JSON.stringify(changed));
    assert.equal(control.snapshot().status, "ready");
    assert.equal(Boolean(ctx.get("evolution")), false); assert.equal(Boolean(ctx.get("evolutionTrigger")), false);
    for (const entry of foundations) {
      const current = control.snapshot().inspection.entries.find(item => item.id === entry.id);
      assert.equal(current?.phase, "active", entry.id); assert.equal(current.fiberId, entry.fiberId, entry.id);
    }
    await assert.rejects(async () => evolution.list(), /evolution_closed/u);
    await assert.rejects(async () => trigger.inspectSession(session.sessionId), /evolution_trigger_closed/u);
    for (const entry of entries) {
      const after = control.snapshot().inspection.entries.find(item => item.id === entry.id);
      assert.equal(after.enabled, false, entry.id);
      assert.ok(["absent", "disposed"].includes(after.phase), JSON.stringify(after));
    }

    const history = await application.readSessionHistory({ sessionId: session.sessionId });
    assert.equal(history.records.filter(item => item.kind === "message" && item.message.role === "assistant").at(-1)?.message.content, RESPONSE);
    assert.equal(requests, 1, "Advisory Evolution must not start model work");
    const next = await application.startRun({ sessionId: session.sessionId, inputSource: "user", payload: { text: "Complete another ordinary task after Evolution was unloaded." } });
    assert.equal((await next.completion).status, "completed");
    assert.equal(requests, 2);
    assert.equal((await ctx.get("candidates").history()).promotions.length, 0);
  } finally {
    release.resolve();
    await handle?.completion.catch(() => {}); await application?.runGeneration?.retire();
    globalThis.fetch = originalFetch; await host?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
