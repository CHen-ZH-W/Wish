import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { source as parseSource } from "../dist/candidates/validation.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";
import { ManagedPluginStore } from "../dist/boot/plugin-control/managed-store.js";
import { boot, base, source, models, definition, validation } from "./fixtures/candidates.mjs";

test("candidate source rejects traversal, dependency scripts and missing contract tests", () => {
  assert.equal(parseSource(source()).manifest.id, "fixture-candidate");
  for (const name of ["../evil.js", "/tmp/evil.js", ".env", "node_modules/pwn.js", "a//b", "package.json", "a/../x", "a\\b"]) assert.throws(() => parseSource({ ...source(), files: { ...source().files, [name]: "x" } }));
  assert.throws(() => parseSource({ ...source(), tests: [] }));
  assert.throws(() => parseSource({ ...source(), manifest: { ...source().manifest, entry: "./other.mjs" } }));
  assert.throws(() => parseSource({ ...source(), scripts: { postinstall: "touch /tmp/escape" } }));
  assert.throws(() => parseSource({ ...source(), files: { ...source().files, "index.ts/child": "x" } }));
});

function statefulSource(version) {
  const candidate = source(version);
  candidate.manifest.state = { mode: "versioned", schemaVersion: version, readableVersions: [version], ...(version === 2 ? { migratableVersions: [1] } : {}) };
  candidate.files["index.ts"] = candidate.files["index.ts"]
    .replace("import type { Context }", "import type { PluginStateSnapshot } from 'wish/plugins/state';\nimport type { Context }")
    .replace("candidateFixture: { version: number }", "candidateFixture: { version: number; read(): unknown; advance(): Promise<void> }")
    .replace("apply(ctx: Context)", "async apply(ctx: Context)")
    .replace(`ctx.provide('candidateFixture', { version: ${version} });`, `let cursor: any = ${version === 1 ? "0" : "{total:0}"};
  const state = await ctx.root.get('pluginState')!.open(ctx, {
    identity: {pluginId:'fixture-candidate',pluginVersion:'${version}',schemaVersion:${version}},readableVersions:[${version}],
    ${version === 2 ? "migratableVersions:[1],migrate:(s:PluginStateSnapshot)=>({total:s.value as number})," : ""}
    validate(v) { if (!(${version === 1 ? "Number.isInteger(v)" : "v && typeof v === 'object' && 'total' in v && Number.isInteger(v.total)"})) throw Error('invalid cursor'); },
    snapshot:()=>cursor,restore:s=>{cursor=s.value;}
  });
  ctx.provide('candidateFixture', {version:${version},read:()=>cursor,advance:()=>state.run(()=>{${version === 1 ? "cursor++" : "cursor.total++"};})});`);
  return candidate;
}

test("stateful candidates pass sandbox contracts, migrate under Root control and roll back to the retained old build's private state", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-private-state-")); let host;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the model request. */ }
    response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const environment = { WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)) };
  try {
    host = await boot(directory, environment); let ctx = host.surfaceContext;
    const dataset = await ctx.get("experiments").registerDataset({ schemaVersion: 1, id: "stateful", version: 1, cases: [{ id: "answer", prompt: "Reply A", files: {}, assertion: { kind: "exact", expected: "A" } }] });
    const promote = async version => {
      const snapshot = await base(ctx, definition("stateful-base", version)), candidate = statefulSource(version);
      const submitted = await ctx.get("candidates").submit(candidate);
      const checked = await ctx.get("candidates").validate(validation(submitted.digest, snapshot, definition("stateful-candidate", version)));
      assert.equal(checked.status, "passed", checked.error);
      const evaluated = await ctx.get("candidates").evaluate({ validationId: checked.id, datasetDigest: dataset.digest, timeoutMs: 20000, maxSteps: 2 });
      const review = await ctx.get("candidates").prepareReview({ validationId: checked.id, evaluationId: evaluated.evaluation.id, reviewer: "operator", reason: "Verify private-state transaction" });
      const deployed = await ctx.get("candidates").promote(review, review.digest); assert.equal(deployed.status, "active", deployed.error); return { deployed, review };
    };
    const first = await promote(1); await ctx.get("candidateFixture").advance(); await ctx.get("candidateFixture").advance();
    const oldState = await host.context.get("pluginState").inspect("include:generated-plugin/fixture-candidate");
    const second = await promote(2); assert.deepEqual(ctx.get("candidateFixture").read(), { total: 2 });
    await ctx.get("candidateFixture").advance();
    await host.dispose(); host = await boot(directory, environment); ctx = host.surfaceContext;
    assert.deepEqual(ctx.get("candidateFixture").read(), { total: 3 });
    const result = await ctx.get("candidates").rollback(second.deployed.id, second.review.digest); assert.equal(result.status, "rolled-back", result.error);
    assert.equal(ctx.get("candidateFixture").read(), 2, "explicit rollback rewinds private state, including post-upgrade mutations");
    assert.equal((await host.context.get("pluginState").inspect("include:generated-plugin/fixture-candidate")).writer.artifactDigest, oldState.writer.artifactDigest);
    assert.equal((await ctx.get("candidates").rollback(first.deployed.id, first.review.digest)).status, "rolled-back");
  } finally { await host?.dispose(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test("build, tests, lifecycle contract, benchmark, explicit promotion, restart and rollback use retained identical bytes", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-e2e-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body)); response.setHeader("content-type", "text/event-stream");
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  const environment = { WISH_MODELS_JSON: JSON.stringify(models(`http://127.0.0.1:${server.address().port}/v1`)) };
  let host;
  try {
    host = await boot(directory, environment); let ctx = host.surfaceContext;
    const snapshot = await base(ctx), submitted = await ctx.get("candidates").submit(source());
    assert.equal((await ctx.get("candidates").submit(source())).digest, submitted.digest);
    await assert.rejects(ctx.get("candidates").submit({ ...source(), provenance: { author: "different", purpose: "same version" } }), { code: "profile_immutable_conflict" });
    const checked = await ctx.get("candidates").validate(validation(submitted.digest, snapshot));
    assert.equal(checked.status, "passed", checked.error);
    assert.equal(checked.checks.tests.passed, 1); assert.equal(checked.checks.tests.failed, 0);
    assert.equal(checked.checks.interfaces, "passed"); assert.equal(checked.checks.unload, "passed");
    assert.equal(ctx.get("candidateFixture"), undefined);

    const candidateSnapshot = await ctx.get("agentProfiles").get(checked.snapshotDigest);
    assert.equal(candidateSnapshot.candidate.artifactDigest, checked.artifactDigest);
    await assert.rejects(ctx.get("application").open({ agentProfile: checked.snapshotDigest }), { code: "profile_candidate_requires_sandbox" });
    const dataset = await ctx.get("experiments").registerDataset({ schemaVersion: 1, id: "regression", version: 1, cases: [{ id: "answer", prompt: "Reply A", files: {}, assertion: { kind: "exact", expected: "A" } }] });
    const result = await ctx.get("candidates").evaluate({ validationId: checked.id, datasetDigest: dataset.digest, repetitions: 1, timeoutMs: 20_000, maxSteps: 2 });
    assert.equal(result.experiment.status, "completed", JSON.stringify(result.experiment));
    assert.equal(result.experiment.metrics.candidate.successRate, 1, JSON.stringify(result.experiment.results));
    assert.equal(result.experiment.metrics.baseline.successRate, 1);
    assert.equal(requests.length, 2);
    const expensive = await ctx.get("candidates").evaluate({ validationId: checked.id, datasetDigest: dataset.digest, timeoutMs: 20_000, maxSteps: 2,
      gate: { minimumSuccessRate: 1, maximumSuccessRateRegression: 0, maximumTotalTokens: 0 } });
    await assert.rejects(ctx.get("candidates").prepareReview({ validationId: checked.id, evaluationId: expensive.evaluation.id, reviewer: "operator", reason: "A passing answer cannot bypass its token budget" }), { code: "candidate_performance_gate_failed" });
    const report = JSON.parse(await readFile(join(ctx.get("candidates").artifactPath(checked.artifactDigest), "admission.json"), "utf8"));
    assert.equal(report.digest, checked.admissionDigest); assert.equal(report.sourceDigest, submitted.digest);
    const badDataset = await ctx.get("experiments").registerDataset({ schemaVersion: 1, id: "failing-regression", version: 1, cases: [{ id: "answer", prompt: "Reply A", files: {}, assertion: { kind: "exact", expected: "B" } }] });
    const failedGate = await ctx.get("candidates").evaluate({ validationId: checked.id, datasetDigest: badDataset.digest, timeoutMs: 20_000, maxSteps: 2 });
    await assert.rejects(ctx.get("candidates").prepareReview({ validationId: checked.id, evaluationId: failedGate.evaluation.id, reviewer: "operator", reason: "Must not pass a failing regression" }), { code: "candidate_quality_gate_failed" });
    const review = await ctx.get("candidates").prepareReview({ validationId: checked.id, evaluationId: result.evaluation.id, reviewer: "operator", reason: "Inspect code and paired regression before granting Host trust" });
    assert.equal(review.trust, "trusted-in-process");
    await assert.rejects(ctx.get("candidates").promote(review, "0".repeat(64)), { code: "candidate_explicit_approval_required" });
    const artifactFile = join(ctx.get("candidates").artifactPath(checked.artifactDigest), "plugin.mjs"), originalCode = await readFile(artifactFile, "utf8");
    await chmod(artifactFile, 0o600); await writeFile(artifactFile, `${originalCode}\n// unvalidated mutation`);
    await assert.rejects(ctx.get("candidates").promote(review, review.digest), { code: "candidate_artifact_changed" });
    await writeFile(artifactFile, originalCode); await chmod(artifactFile, 0o400);

    const boundary = ctx.get("runEngine").execution;
    const lease = await boundary.source(() => ({ pipeline: {}, release() {} })).acquire({ signal: new AbortController().signal });
    const deploying = ctx.get("candidates").promote(review, review.digest);
    try {
      const deadline = Date.now() + 10_000;
      while (boundary.snapshot().phase !== "draining") { assert.ok(Date.now() < deadline, "candidate did not reach the existing Step boundary"); await new Promise(accept => setTimeout(accept, 10)); }
      assert.equal(ctx.get("candidateFixture"), undefined);

    } finally { lease.release(); }
    const deployed = await deploying;
    assert.equal(deployed.status, "active", deployed.error);
    assert.equal(ctx.get("candidateFixture").version, 1);
    await assert.rejects(async () => host.context.waterfall("hmr/reload-prepare", new Map([[{}, { filename: artifactFile }]]), new AbortController().signal, async () => { throw new Error("unvalidated artifact reached native import"); }), { code: "candidate_artifact_requires_new_version" });
    const after = await host.pluginManagement.deploymentSnapshot("generated-plugin");
    assert.ok(after.entries[0].entry.name.includes(checked.artifactDigest));
    await assert.rejects(ctx.get("candidates").promote(review, review.digest), { code: "candidate_deployment_changed_since_validation" });
    await host.dispose(); host = undefined;
    // Crash between overlay publication and durable success quarantines the
    // entry on restart; it must not re-import code before explicit recovery.
    const store = await ManagedPluginStore.open(join(directory, "management", "plugins.json")), state = store.snapshot();
    await store.commit(state.revision, { preferences: state.preferences, receipts: state.receipts, pending: {
      requestId: "configuration:crashed-candidate", revision: state.revision, preference: "inherit", selection: { instanceId: "dead-host", entryIds: ["include:generated-plugin"] },
      configuration: { beforeDigest: review.deploymentDigest, afterDigest: after.deploymentDigest, changes: [{ kind: "add", entryId: "include:generated-plugin", beforeName: null, afterName: after.entries[0].entry.name }] },
    } }); await store.close();
    host = await boot(directory, environment); ctx = host.surfaceContext;
    assert.equal(ctx.get("candidateFixture"), undefined);
    assert.equal(host.pluginManagement.snapshot().status, "recovery-required");
    await host.pluginManagement.recoverDisabled(host.pluginManagement.snapshot().revision);
    const recovered = host.pluginManagement.snapshot();
    assert.equal((await host.pluginManagement.change({ requestId: "recover-approved-candidate", revision: recovered.revision, preference: "enabled", selection: { instanceId: recovered.inspection.instanceId, entryIds: ["include:generated-plugin"] } })).status, "succeeded");
    assert.equal(ctx.get("candidateFixture").version, 1);
    assert.equal((await ctx.get("candidates").history()).promotions[0].status, "active");
    const snapshot2 = await base(ctx, definition("baseline", 2));
    const next = source(2); next.files["index.ts"] = next.files["index.ts"].replace("ctx.provide('candidateFixture'", "if (process.env.WISH_CANDIDATE_FAIL_MAIN) throw new Error('fixture_activation_failure');\n  ctx.provide('candidateFixture'");
    const checked2 = await ctx.get("candidates").validate(validation((await ctx.get("candidates").submit(next)).digest, snapshot2, definition("candidate", 2)));
    assert.equal(checked2.status, "passed", checked2.error);
    const evaluated2 = await ctx.get("candidates").evaluate({ validationId: checked2.id, datasetDigest: dataset.digest, timeoutMs: 20_000, maxSteps: 2 });
    const reviewInput2 = { validationId: checked2.id, evaluationId: evaluated2.evaluation.id, reviewer: "operator", reason: "Retained v1 rollback and v2 candidate" };
    process.env.WISH_CANDIDATE_FAIL_MAIN = "1";
    const rejectedReview = await ctx.get("candidates").prepareReview(reviewInput2);
    const rejected = await ctx.get("candidates").promote(rejectedReview, rejectedReview.digest);
    assert.equal(rejected.status, "rejected", rejected.error); assert.equal(ctx.get("candidateFixture").version, 1);
    delete process.env.WISH_CANDIDATE_FAIL_MAIN;
    const review2 = await ctx.get("candidates").prepareReview(reviewInput2);
    // Simulate a crash-equivalent loss of the candidate outcome after Root commit.
    const records = ctx.get("candidates").promotions, originalUpdate = records.update.bind(records);
    records.update = async (id, change) => {
      const prior = await records.get(id), next = change(prior);
      if (next.status === "active") throw new Error("fixture_outcome_save_failed");
      return originalUpdate(id, change);
    };
    await assert.rejects(ctx.get("candidates").promote(review2, review2.digest), /fixture_outcome_save_failed/u);
    records.update = originalUpdate;
    assert.equal(ctx.get("candidateFixture").version, 2);
    const uncertain = (await ctx.get("candidates").history()).promotions.find(item => item.review.digest === review2.digest);
    assert.equal(uncertain.status, "applying");
    let releaseObserver;
    const observerPending = new Promise(resolve => { releaseObserver = resolve; });
    const observer = host.context.get("pluginChanges").submit({ kind: "reconfigure", source: "configuration", requestId: "fixture-settling-watch" }, async () => observerPending);
    await observer.accepted;
    let reconciledEarly = false;
    const reconciliation = ctx.get("candidates").reconcile(uncertain.id).finally(() => { reconciledEarly = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(reconciledEarly, false, "reconciliation must wait for accepted Root changes");
    } finally { releaseObserver(); }
    await observer.completion;
    const reconciled = await reconciliation;
    assert.equal(reconciled.status, "active");
    // A policy upgrade must block new execution of legacy evidence while
    // preserving the operator's ability to undo its approved deployment.
    await ctx.get("candidates").validations.update(checked2.id, previous => {
      const { admissionDigest, checks, ...legacy } = previous; return legacy;
    });
    await assert.rejects(ctx.get("candidates").verifySnapshot(await ctx.get("agentProfiles").get(checked2.snapshotDigest)), { code: "candidate_admission_missing" });
    assert.equal((await ctx.get("candidates").rollback(reconciled.id, review2.digest)).status, "rolled-back");
    assert.equal(ctx.get("candidateFixture").version, 1);
    const rolledBack = await ctx.get("candidates").rollback(deployed.id, review.digest);
    assert.equal(rolledBack.status, "rolled-back", rolledBack.error);
    assert.equal(ctx.get("candidateFixture"), undefined);
    assert.equal((await host.pluginManagement.deploymentSnapshot("generated-plugin")).entries.length, 0);
    await host.dispose(); host = await boot(directory, environment);
    assert.equal(host.surfaceContext.get("candidateFixture"), undefined);
  } finally { delete process.env.WISH_CANDIDATE_FAIL_MAIN; await host?.dispose(); await new Promise(accept => server.close(accept)); await rm(directory, { recursive: true, force: true }); }
});

test("running WebUI Host exposes candidate operations through the existing authenticated management plane", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-management-")); let host;
  try {
    host = await bootstrap({ surface: "webui", cwd: directory, homeDirectory: directory, environment: { WISH_DATA_DIR: join(directory, "data"), WISH_CANDIDATES_DIR: join(directory, "candidates"), CORDIS_HMR: "0", WISH_MODELS_JSON: JSON.stringify(models()) }, management: managedWebUi({ directory: join(directory, "management"), port: 0 }) });
    const url = host.context.get("webManagementHost").url;
    const token = (await (await fetch(`${url}/api/management/bootstrap`)).json()).token;
    const post = (action, input, headers = {}) => fetch(`${url}/api/management/extensions/candidates/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-wish-management-token": token, ...headers }, body: JSON.stringify(input) });
    assert.equal((await post("submit", source(), { "x-wish-management-token": "invalid" })).status, 403);
    assert.equal((await post("submit", source(), { origin: "http://attacker.invalid" })).status, 403);
    const submitted = await (await post("submit", source())).json(); assert.equal(submitted.source.id, "fixture-candidate");
    assert.equal((await (await post("list", {})).json())[0].digest, submitted.digest);
    const revision = host.pluginManagement.snapshot();
    assert.equal((await host.pluginManagement.change({ requestId: "disable-candidate-management", revision: revision.revision, preference: "disabled", selection: { instanceId: revision.inspection.instanceId, entryIds: ["include:candidate-management"] } })).status, "succeeded");
    assert.equal((await post("list", {})).status, 404);
    const latest = host.pluginManagement.snapshot();
    assert.equal((await host.pluginManagement.change({ requestId: "enable-candidate-management", revision: latest.revision, preference: "enabled", selection: { instanceId: latest.inspection.instanceId, entryIds: ["include:candidate-management"] } })).status, "succeeded");
    assert.equal((await (await post("list", {})).json())[0].digest, submitted.digest);
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("actual sandbox denies Host secrets, outside writes, sockets, signals and child escapes", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-confinement-")); let host;
  const secret = join(directory, "host-secret.txt"); await writeFile(secret, "do-not-expose");
  process.env.WISH_CANDIDATE_HOST_SECRET = "must-not-cross-worker-boundary";
  try {
    host = await boot(directory); const ctx = host.surfaceContext, snapshot = await base(ctx);
    const candidate = source(); candidate.files["index.test.ts"] = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net'; import { spawnSync } from 'node:child_process';
test('confinement', async () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}));
  assert.throws(() => fs.writeFileSync(${JSON.stringify(secret)},'overwritten'));
  assert.throws(() => process.kill(${process.pid},0));
  assert.ok(spawnSync('/bin/sh',['-c','true']).error);
  assert.equal(process.env.WISH_CANDIDATE_HOST_SECRET, undefined);
  await new Promise<void>(accept => { const socket=net.connect('/tmp/wish-control.sock'); socket.on('error', error => { assert.equal((error as NodeJS.ErrnoException).code,'EPERM'); accept(); }); socket.on('connect', () => { assert.fail('socket escaped'); }); });
});`;
    const checked = await ctx.get("candidates").validate(validation((await ctx.get("candidates").submit(candidate)).digest, snapshot));
    assert.equal(checked.status, "passed", checked.error);
    assert.equal(await readFile(secret, "utf8"), "do-not-expose");
    assert.equal(ctx.get("candidateFixture"), undefined);
    // Exercise the syscall boundary with a native program as well as JS. The
    // candidate cannot clear its death signal or inspect/change Host rlimits.
    const native = join(directory, "native"); await mkdir(native);
    await writeFile(join(native, "probe.c"), `#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>
int main(void) {
 int sig=0; struct rlimit limits;
 assert(prctl(PR_GET_PDEATHSIG,&sig)==0 && sig==SIGKILL);
 errno=0; assert(prctl(PR_SET_PDEATHSIG,0)==-1 && errno==EPERM);
 sig=0; assert(prctl(PR_GET_PDEATHSIG,&sig)==0 && sig==SIGKILL);
 assert(prlimit(0,RLIMIT_NOFILE,0,&limits)==0);
 errno=0; assert(prlimit(getppid(),RLIMIT_NOFILE,0,&limits)==-1 && errno==EPERM);
 assert(open("/dev/ptmx",O_RDWR)==-1);
 return 0;
}`);
    await promisify(execFile)("cc", [join(native, "probe.c"), "-o", join(native, "probe")]);
    await promisify(execFile)(fileURLToPath(new URL("../native/bin/wish-linux-sandbox", import.meta.url)), ["--workspace", native, "--read-path", ".", "--network", "disabled", "--candidate-mode", "execute", "--protect-name", ".git", "--cwd", native, "--tmp", native, "--cpu-seconds", "5", "--max-processes", "4096", "--max-open-files", "256", "--max-file-size-bytes", "16777216", "--max-memory-bytes", "17179869184", "--", join(native, "probe")]);
  } finally { delete process.env.WISH_CANDIDATE_HOST_SECRET; await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("failed typechecks, tests, imports and lifecycle admission cannot become runnable candidates", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-rejections-")); let host;
  try {
    host = await boot(directory); const ctx = host.surfaceContext, snapshot = await base(ctx);
    const broken = [source(1), source(2), source(3), source(4)];
    broken[0].files["index.ts"] += "\nconst bad: number = 'not a number';";
    broken[1].files["index.test.ts"] = "import test from 'node:test'; import assert from 'node:assert/strict'; test('regression',()=>assert.equal(1,2));";
    broken[2].files["index.ts"] += "\nimport unknown from 'unknown-unlocked-package';";
    broken[3].files["index.ts"] = "export default { name:'unmanaged', apply() {} };";
    for (const candidate of broken) {
      const checked = await ctx.get("candidates").validate(validation((await ctx.get("candidates").submit(candidate)).digest, snapshot));
      assert.equal(checked.status, "failed", JSON.stringify(checked)); assert.equal(checked.snapshotDigest, undefined);
      await assert.rejects(ctx.get("candidates").evaluate({ validationId: checked.id, datasetDigest: "a".repeat(64) }), { code: "candidate_validation_not_passed" });
    }
    assert.equal(ctx.get("candidateFixture"), undefined);
    const cancelled = await ctx.get("candidates").validate(validation((await ctx.get("candidates").submit(source(5))).digest, snapshot), AbortSignal.abort());
    assert.equal(cancelled.status, "cancelled");
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("the real CLI submits and lists candidates without loading generated code", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-cli-"));
  try {
    const filename = join(directory, "source.json"); await writeFile(filename, JSON.stringify(source()));
    const environment = { PATH: process.env.PATH, HOME: directory, WISH_DATA_DIR: join(directory, "data"), WISH_CANDIDATES_DIR: join(directory, "candidates"), CORDIS_HMR: "0" };
    const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../dist/apps/cli/main.js", import.meta.url)), ...args], { env: environment, cwd: directory, maxBuffer: 8 * 1024 * 1024 })).stdout);
    const submitted = await cli("candidate", "submit", filename);
    assert.equal((await cli("candidate", "list"))[0].digest, submitted.digest);
    assert.equal((await cli("candidate", "history")).validations.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Host death kills an in-flight candidate process and recovery marks its validation interrupted without replay", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-candidate-crash-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/candidate-crash.mjs", import.meta.url)), directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const closed = new Promise(accept => child.once("close", accept)); let host;
  try {
    let info; const deadline = Date.now() + 30_000;
    while (!info) {
      try { info = JSON.parse(await readFile(join(directory, "ready.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.equal(child.exitCode, null, output); assert.ok(Date.now() < deadline, output);
      if (!info) await new Promise(accept => setTimeout(accept, 25));
    }
    child.kill("SIGKILL"); await closed;
    const dead = async () => { try { const stat = await readFile(`/proc/${info.pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"); } catch (error) { if (error.code === "ENOENT") return true; throw error; } };
    const killDeadline = Date.now() + 3000;
    while (!await dead()) { assert.ok(Date.now() < killDeadline, "candidate survived Host death"); await new Promise(accept => setTimeout(accept, 25)); }
    host = await boot(directory); const checked = (await host.surfaceContext.get("candidates").history()).validations.find(item => item.id === info.validationId);
    assert.equal(checked.status, "interrupted"); assert.equal(checked.artifactDigest, undefined); assert.equal(host.surfaceContext.get("candidateFixture"), undefined);
  } finally { child.kill("SIGKILL"); await closed; await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
