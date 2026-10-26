import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { skillCandidate } from "../dist/evolution/skill-generator.js";
import { createSkillPackageSnapshot } from "../dist/skills/local.js";
import LocalSkillsService from "../dist/skills/providers/local.js";
import { inspectArchitecture } from "../dist/plugin-admission/architecture.js";
import { boot, base, definition } from "./fixtures/candidates.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function pkg(manual = false) {
  const manifest = `---\nname: generated-inspection\ndescription: Inspect before editing.\n${manual ? "disable-model-invocation: true\n" : ""}---\nRead all references and verify changes.\n`;
  return createSkillPackageSnapshot({ name: "generated-inspection", description: "Inspect before editing.", source: "workspace", location: "inline:generated-inspection/SKILL.md", modelInvocable: !manual, packageId: hash("generated-inspection"), digest: hash(manifest) },
    { "SKILL.md": manifest, "references/guide.md": "原始资源\n", "scripts/check.sh": "printf check\n", "assets/template.txt": "{complete}\n" });
}
const input = (manual = false) => ({ id: "generated-skill", version: 1, package: pkg(manual), purpose: "Inspect before editing", runId: "generation-run" });

test("Skill wrapper is immutable inline data, has no host capabilities, and passes narrow architecture admission", () => {
  const candidate = skillCandidate(input());
  assert.equal(candidate.manifest.sandbox.filesystem, "none"); assert.deepEqual(candidate.manifest.permissions.capabilities, []);
  assert.deepEqual(candidate.manifest.contracts.requires, { skills: { version: 1, methods: ["registerSource"] } });
  assert.match(candidate.files["index.ts"], /FrozenSkills/); assert.doesNotMatch(candidate.files["index.ts"], /node:fs|LocalSkills|writeFile|exec/);
  assert.match(candidate.files["index.test.ts"], /fork.dispose/);
  assert.ok(inspectArchitecture(candidate).runtimeFiles.includes("index.ts")); assert.ok(Object.isFrozen(candidate));
  const damaged = structuredClone(input()); damaged.package.resources[0].content = "tampered";
  assert.throws(() => skillCandidate(damaged), /digest/);
  const unsafe = { ...candidate, files: { ...candidate.files, "index.ts": candidate.files["index.ts"].replace("{ FrozenSkills }", "{ LocalSkills }") } };
  assert.throws(() => inspectArchitecture(unsafe), { code: "plugin_architecture_core_boundary" });
});

test("generated plugin runs against the real Skills Provider, preserves bytes/manual-only, and unloads independently", async t => {
  for (const manual of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "wish-skill-wrapper-")); t.after(() => rm(directory, { recursive: true, force: true }));
    const candidate = skillCandidate(input(manual)), source = join(directory, "index.ts"), output = join(directory, "plugin.mjs");
    await writeFile(source, candidate.files["index.ts"]);
    await build({ entryPoints: [source], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22", plugins: [{ name: "public-contract-imports", setup(builder) {
      builder.onResolve({ filter: /^(?:wish\/|@deepseek-ai\/cordis$)/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }] });
    const plugin = (await import(pathToFileURL(output).href)).default, root = new Context();
    await mkdir(join(directory, "home"));
    try {
      await root.plugin({ name: "fixture-launch", apply(ctx) { ctx.provide("launch", { homeDirectory: join(directory, "home") }); } });
      await root.plugin(LocalSkillsService);
      const fork = await root.plugin(plugin);
      const entry = (await root.skills.list({ cwd: directory })).skills[0];
      assert.equal(entry.name, "generated-inspection"); assert.equal(entry.modelInvocable, !manual);
      const request = { cwd: directory, name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId };
      for (const resource of input(manual).package.resources) assert.equal((await root.skills.read({ ...request, path: resource.path, invocation: "host" })).content, resource.content);
      if (manual) await assert.rejects(root.skills.read({ ...request, invocation: "model" }), /does not allow/);
      else assert.match((await root.skills.read({ ...request, invocation: "model" })).content, /Read all references/);
      await fork.dispose(); assert.equal((await root.skills.list({ cwd: directory })).skills.length, 0);
    } finally { await root.fiber.dispose(); }
  }
});

test("complete inline Skill passes the production Linux build, node:test and Loader lifecycle checks", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-skill-linux-admission-"));
  let host;
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "0" });
    const ctx = host.surfaceContext, baseline = await base(ctx), candidates = ctx.get("candidates");
    const before = await ctx.get("skills").list({ cwd: directory });
    const submitted = await candidates.submit(skillCandidate(input()));
    const checked = await candidates.validate({ candidateDigest: submitted.digest, baseSnapshotDigest: baseline.digest,
      target: { parentId: "app", entryId: "generated-skill" }, profile: definition("skill-candidate") });
    assert.equal(checked.status, "passed", checked.error);
    assert.equal(checked.checks.tests.passed, 1); assert.equal(checked.checks.ownership, "passed"); assert.equal(checked.checks.unload, "passed");
    assert.deepEqual(await ctx.get("skills").list({ cwd: directory }), before, "technical validation must not install a Skill into the main Host");
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
