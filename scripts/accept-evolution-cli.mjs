import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { models } from "./fixtures/candidates.mjs";

const cli = fileURLToPath(new URL("../dist/apps/cli/main.js", import.meta.url));
const invoke = promisify(execFile);
const SECTION = "Before retrying an uncertain operation, inspect its committed result and preserve unresolved side effects.";

async function environment(directory, options = {}) {
  const temporary = join(directory, "tmp"); await mkdir(temporary, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, TMPDIR: temporary, LANG: "C.UTF-8",
    WISH_DATA_DIR: join(directory, "data"), WISH_CANDIDATES_DIR: join(directory, "candidates"),
    WISH_EXPERIMENTS_DIR: join(directory, "experiments"), WISH_MANAGEMENT_DATA_DIR: join(directory, "management"),
    WISH_MODELS_JSON: JSON.stringify(models(options.baseUrl)), WISH_PERMISSION_PROFILE: "workspace-write",
    WISH_EVOLUTION_ENABLED: "1", WISH_MANAGED_CLI: options.managed ? "1" : "0", CORDIS_HMR: "0",
  };
}

async function command(directory, env, args, timeout = 30_000) {
  const result = await invoke(process.execPath, [cli, ...args], { cwd: directory, env, timeout, maxBuffer: 16 * 1024 * 1024 });
  assert.doesNotMatch(result.stderr, /Unexpected argument: evolution/u);
  try { return JSON.parse(result.stdout); }
  catch { assert.fail(`CLI must exit cleanly with machine-readable JSON: ${result.stdout.slice(-4_000)}\n${result.stderr.slice(-4_000)}`); }
}

for (const managed of [false, true]) {
  test(`actual Evolution CLI list claims its prefix before base dispatch (managed=${managed})`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wish-evolution-cli-list-"));
    try {
      const env = await environment(directory, { managed });
      assert.deepEqual(await command(directory, env, ["evolution", "list"]), []);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("actual CLI begin validates one isolated prompt candidate and exits without evaluation or publication", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-cli-begin-"));
  const skillRoot = join(directory, ".agents", "skills", "frozen-inspect");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: frozen-inspect\ndescription: Inspect committed code\n---\nRead references/guide.md before inspecting.\n");
  await writeFile(join(skillRoot, "references", "guide.md"), "Frozen original reference\n");
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("test_model_request_limit"); }
      requests.push(JSON.parse(body));
      await writeFile(join(skillRoot, "references", "guide.md"), "Changed after baseline capture\n");
      const content = JSON.stringify({ content: SECTION, rationale: "A bounded prompt hypothesis whose actual effect is not measured by this CLI test." });
      response.setHeader("content-type", "text/event-stream");
      response.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 32, total_tokens: 56 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""));
    } catch (error) { response.writeHead(400); response.end(String(error)); }
  });
  try {
    await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
    const address = server.address();
    const env = await environment(directory, { managed: true, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const campaign = await command(directory, env, ["evolution", "begin", "Improve the guidance for retrying uncertain operations"], 150_000);
    const history = await command(directory, env, ["candidate", "history"]);
    const diagnostics = JSON.stringify(history.validations.map(item => ({ id: item.id, status: item.status, error: item.error })));
    assert.equal(campaign.state, "awaiting-external-validation", `${campaign.error ?? ""}\n${diagnostics}`);
    assert.equal(campaign.stopReason, "technical-candidate-ready"); assert.equal(campaign.attempts.length, 1);
    const attempt = campaign.attempts[0];
    assert.deepEqual(attempt.operations.map(item => item.stage), ["evidence", "generate", "candidate", "feedback"]);
    assert.ok(attempt.operations.every(item => item.status === "completed"));
    assert.equal(attempt.verdict, undefined); assert.equal(campaign.bestScore, undefined);
    assert.equal(campaign.review, undefined); assert.equal(campaign.publication, undefined);
    assert.equal(attempt.proposal.target, "prompt");
    assert.ok(Object.values(attempt.proposal.source.files).some(content => content.includes(SECTION)));

    assert.equal(requests.length, 1, "Only the deterministic generation model may be called");
    assert.equal(requests[0].model, "a"); assert.ok(!requests[0].tools?.length);
    assert.ok(Number.isSafeInteger(requests[0].max_tokens) && requests[0].max_tokens <= 1024);
    const validation = history.validations.find(item => item.id === attempt.candidate.validationId);
    assert.equal(validation?.status, "passed", diagnostics);
    for (const name of ["typecheck", "build", "activation", "interfaces", "ownership", "unload"]) assert.equal(validation.checks[name], "passed");
    assert.equal(validation.checks.tests.passed, 1); assert.equal(validation.checks.tests.failed, 0);
    assert.equal(history.evaluations.length, 0); assert.equal(history.promotions.length, 0);
    assert.deepEqual(await command(directory, env, ["experiment", "list"]), []);
    const admission = JSON.parse(await readFile(join(directory, "candidates", "artifacts", attempt.candidate.artifactDigest, "admission.json"), "utf8"));
    assert.equal(admission.sourceDigest, attempt.candidate.candidateDigest); assert.equal(admission.digest, validation.admissionDigest);
    const frozenBase = await command(directory, env, ["profile", "inspect", campaign.spec.baselineSnapshotDigest]);
    const frozenCandidate = await command(directory, env, ["profile", "inspect", attempt.candidate.snapshotDigest]);
    assert.equal(frozenBase.resources.coverage, "complete");
    assert.equal(frozenBase.resources.skills.packages[0].resources.find(item => item.path === "references/guide.md").content, "Frozen original reference\n");
    assert.equal(frozenCandidate.resources.digest, frozenBase.resources.digest);
    assert.equal(await readFile(join(skillRoot, "references", "guide.md"), "utf8"), "Changed after baseline capture\n");

    // Each command is a new actual process. Successful follow-up commands also
    // prove the prior CLI released its persistent stores and management lock.
    assert.equal((await command(directory, env, ["evolution", "list"]))[0].id, campaign.id);
    assert.deepEqual(await command(directory, env, ["evolution", "show", campaign.id]), campaign);
    assert.equal(requests.length, 1);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(accept => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  }
});
