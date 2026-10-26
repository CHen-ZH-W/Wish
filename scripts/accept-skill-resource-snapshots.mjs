import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { LocalSkills, FrozenSkills, createSkillPackageSnapshot, validateSkillPackageSnapshot } from "../dist/skills/local.js";
import LocalSkillsService from "../dist/skills/providers/local.js";
import { captureProfileResources, validateProfileResources, freezeMemoryInitialState, profileResourceCoverage } from "../dist/agent-profiles/resources.js";
import { hash, content } from "../dist/memory/validation.js";
import { experimentDeployment } from "../dist/agent-profiles/composition.js";
import ProfileSkills from "../dist/agent-profiles/resource-skills.js";
import ProfileMemory from "../dist/agent-profiles/resource-memory.js";

test("frozen Worker catalog ignores workspace files created after capture and rejects changed contribution bytes", async t => {
  const original = await fixture(t, "frozen");
  const contributor = new LocalSkills();
  const remove = contributor.registerSource(source("managed", new FrozenSkills(await original.local.snapshot({ cwd: original.cwd }))));
  const resources = await captureProfileResources({ cwd: "/tmp", skills: contributor }); remove();
  const target = await fixture(t, "injected");
  const sealed = new LocalSkills({ frozenPackages: resources.skills.packages });
  assert.deepEqual((await sealed.list({ cwd: target.cwd })).skills.map(item => item.name), ["frozen"]);
  const pkg = resources.skills.packages[0], input = { cwd: target.cwd, name: "frozen", expectedDigest: pkg.skill.digest, expectedPackageId: pkg.skill.packageId, path: "scripts/check.sh", invocation: "model" };
  assert.equal((await sealed.read(input)).content, "printf checked\n");
  const raw = (await original.local.snapshot({ cwd: original.cwd }))[0];
  sealed.registerSource(source("managed", new FrozenSkills([raw])));
  assert.equal((await sealed.snapshot({ cwd: target.cwd }))[0].digest, pkg.digest);
  await writeFile(join(original.directory, "scripts/check.sh"), "printf mutated\n");
  const changed = (await original.local.snapshot({ cwd: original.cwd }))[0];
  const overlay = new LocalSkills({ frozenPackages: resources.skills.packages, frozenMode: "overlay" });
  overlay.registerSource(source("managed", new FrozenSkills([changed])));
  assert.notEqual((await overlay.snapshot({ cwd: target.cwd }))[0].digest, pkg.digest);
  const drifting = new LocalSkills({ frozenPackages: resources.skills.packages });
  drifting.registerSource(source("managed", new FrozenSkills([changed])));
  await assert.rejects(drifting.snapshot({ cwd: target.cwd }), /Frozen Skill resources changed/);
  assert.equal((await drifting.read(input)).content, "printf checked\n");
});

test("Worker deployment selects frozen providers and each Memory instance starts independently", async t => {
  const { cwd, local } = await fixture(t);
  const resources = await captureProfileResources({ cwd, skills: local });
  const rows = [{ id: "skills", name: new URL("../dist/skills/providers/local.js", import.meta.url).href }, { id: "memory", name: new URL("../dist/memory/providers/storage.js", import.meta.url).href }];
  const deployed = JSON.parse(experimentDeployment(rows, cwd, resources));
  assert.match(deployed[0].name, /resource-skills.js$/); assert.match(deployed[1].name, /resource-memory.js$/);
  assert.equal(deployed[0].config.mode, "sealed");
  const root = new Context();
  try {
    await root.plugin(ProfileSkills, deployed[0].config);
    await root.plugin(ProfileMemory, deployed[1].config);
    assert.equal((await root.skills.snapshot({ cwd }))[0].digest, resources.skills.packages[0].digest);
    assert.deepEqual((await root.memory.snapshot()).documents, []);
    assert.equal((await root.memory.state()).revision, 0);
  } finally { await root.fiber.dispose(); }
  assert.equal(rows[0].config, undefined);
});

const markdown = (name, manual = false) => `---\nname: ${name}\ndescription: Inspect and verify code.\n${manual ? "disable-model-invocation: true\n" : ""}---\nInspect before changing code.\n`;
async function fixture(t, name = "inspect", manual = false) {
  const cwd = await mkdtemp(join(tmpdir(), "wish-resource-snapshot-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, ".agents", "skills", name);
  await mkdir(join(directory, "references", "nested"), { recursive: true });
  await mkdir(join(directory, "scripts")); await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "SKILL.md"), markdown(name, manual));
  await writeFile(join(directory, "references", "nested", "guide.md"), "Keep complete references.\n");
  await writeFile(join(directory, "scripts", "check.sh"), "printf checked\n");
  await writeFile(join(directory, "assets", "template.txt"), "你好\n");
  return { cwd, directory, local: new LocalSkills() };
}
function source(id, frozen) { return { id, list: input => frozen.list(input), read: input => frozen.read(input), snapshot: input => frozen.snapshot(input) }; }

test("opt-in captures complete package bytes and independent resource changes, without mutating live Skills", async t => {
  const { cwd, directory, local } = await fixture(t);
  const before = await local.list({ cwd });
  const first = (await local.snapshot({ cwd }))[0];
  assert.deepEqual(first.resources.map(item => item.path), ["SKILL.md", "assets/template.txt", "references/nested/guide.md", "scripts/check.sh"]);
  assert.equal(first.resources.find(item => item.path === "assets/template.txt").bytes, Buffer.byteLength("你好\n"));
  assert.equal(validateSkillPackageSnapshot(first).digest, first.digest);
  const frozen = new FrozenSkills([first]);
  await writeFile(join(directory, "references", "nested", "guide.md"), "new reference\n");
  const second = (await local.snapshot({ cwd }))[0];
  assert.equal(first.skill.digest, second.skill.digest); assert.notEqual(first.digest, second.digest);
  assert.deepEqual(await local.list({ cwd }), before);
  const input = { cwd, name: "inspect", expectedDigest: first.skill.digest, expectedPackageId: first.skill.packageId, path: "references/nested/guide.md", invocation: "model" };
  assert.equal((await frozen.read(input)).content, "Keep complete references.\n");
  assert.equal((await local.read(input)).content, "new reference\n");
  await assert.rejects(frozen.read({ ...input, path: "references/../../secret" }), /package/);
  const bad = structuredClone(first); bad.resources[0].content += "changed";
  assert.throws(() => validateSkillPackageSnapshot(bad), /digest/);
  assert.throws(() => createSkillPackageSnapshot(first.skill, { "SKILL.md": markdown("inspect"), "references/../outside": "escape" }), /package/);
});

test("full snapshots reject links, hard links, unsupported bytes, and bounded resource overflow", async t => {
  const { cwd, directory, local } = await fixture(t);
  const outside = join(cwd, "outside"); await writeFile(outside, "private");
  const target = join(directory, "references", "leak.md");
  await symlink(outside, target); await assert.rejects(local.snapshot({ cwd }), /symbolic|regular/);
  await rm(target); await link(outside, target); await assert.rejects(local.snapshot({ cwd }), /hard-linked/);
  await rm(target); await writeFile(target, Buffer.from([0xff])); await assert.rejects(local.snapshot({ cwd }));
  await writeFile(target, "x".repeat(64_001)); await assert.rejects(local.snapshot({ cwd }), /bounded|limit/);
  await rm(target); await symlink(directory, join(cwd, ".agents", "skills", "alias"));
  await assert.rejects(local.snapshot({ cwd }), /diagnostics/);
  await assert.rejects(local.snapshot({ cwd, signal: AbortSignal.abort(new Error("stop capture")) }), /stop capture/);
});

test("registered sources retain scope/manual rules, namespace package origin, and revoke reads in flight", async t => {
  const external = await fixture(t, "shared");
  const cwd = await mkdtemp(join(tmpdir(), "wish-empty-skills-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const pkg = (await external.local.snapshot({ cwd: external.cwd }))[0], frozen = new FrozenSkills([pkg]);
  const skills = new LocalSkills();
  const release = skills.registerSource(source("first", frozen));
  const visible = (await skills.list({ cwd })).skills[0];
  assert.equal(visible.source, pkg.skill.source); assert.notEqual(visible.packageId, pkg.skill.packageId);
  const input = { cwd, name: "shared", expectedDigest: visible.digest, expectedPackageId: visible.packageId, invocation: "model" };
  assert.equal((await skills.read(input)).content, markdown("shared"));
  assert.equal((await skills.snapshot({ cwd }))[0].skill.packageId, visible.packageId);
  release(); release(); assert.deepEqual((await skills.list({ cwd })).skills, []);
  await assert.rejects(skills.read(input), /unknown|available/);
  const mutable = source("stable-id", frozen), releaseMutable = skills.registerSource(mutable);
  const origin = (await skills.list({ cwd })).skills[0].packageId;
  mutable.id = "mutated-id";
  assert.equal((await skills.list({ cwd })).skills[0].packageId, origin);
  releaseMutable(); assert.deepEqual((await skills.list({ cwd })).skills, []);
  const next = skills.registerSource(source("second", frozen));
  await assert.rejects(skills.read(input), /origin changed/); next();
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { resume = resolve; });
  const delayed = { ...source("delayed", frozen), async read(request) { enter(); await waiting; return frozen.read(request); } };
  const remove = skills.registerSource(delayed), pinned = (await skills.list({ cwd })).skills[0];
  const reading = skills.read({ ...input, expectedPackageId: pinned.packageId }); await entered; remove(); resume();
  await assert.rejects(reading, /retired/);
  const manual = await fixture(t, "manual", true), manualPkg = (await manual.local.snapshot({ cwd: manual.cwd }))[0];
  const revokeManual = skills.registerSource(source("manual", new FrozenSkills([manualPkg])));
  const entry = (await skills.list({ cwd })).skills[0];
  await assert.rejects(skills.read({ cwd, name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId, invocation: "model" }), /does not allow/);
  assert.match((await skills.read({ cwd, name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId, invocation: "host" })).content, /disable-model-invocation/);
  revokeManual();
});

test("registered sources cannot advertise manual-only bytes as model-invocable or drift during capture", async t => {
  const { cwd, local } = await fixture(t, "manual", true), pkg = (await local.snapshot({ cwd }))[0];
  const frozen = new FrozenSkills([pkg]), target = await mkdtemp(join(tmpdir(), "wish-registered-capture-")); t.after(() => rm(target, { recursive: true, force: true }));
  const skills = new LocalSkills();
  const liar = { ...source("liar", frozen), async list(input) { const catalog = await frozen.list(input); return { ...catalog, skills: catalog.skills.map(item => ({ ...item, modelInvocable: true })) }; }, async read(input) { const result = await frozen.read({ ...input, invocation: "host" }); return { ...result, skill: { ...result.skill, modelInvocable: true } }; } };
  const release = skills.registerSource(liar), visible = (await skills.list({ cwd: target })).skills[0];
  await assert.rejects(skills.read({ cwd: target, name: visible.name, expectedDigest: visible.digest, expectedPackageId: visible.packageId, invocation: "model" }), /authority/);
  await assert.rejects(skills.snapshot({ cwd: target }), /changed/); release();
  let changed = false;
  skills.registerSource({ ...source("changing", frozen), async list(input) { return changed ? { skills: [], issues: [] } : frozen.list(input); }, async snapshot(input) { const result = await frozen.snapshot(input); changed = true; return result; } });
  await assert.rejects(skills.snapshot({ cwd: target }), /changed/);
});

test("Cordis source contributor disposal revokes its packages without stopping the Skills Provider", async t => {
  const external = await fixture(t, "contributed"), pkg = (await external.local.snapshot({ cwd: external.cwd }))[0];
  const cwd = await mkdtemp(join(tmpdir(), "wish-skill-source-owner-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = new Context();
  try {
    await root.plugin({ name: "fixture-launch", apply(ctx) { ctx.provide("launch", { homeDirectory: cwd }); } });
    await root.plugin(LocalSkillsService);
    const contributor = await root.plugin({ name: "fixture-source", inject: ["skills"], apply(ctx) { ctx.skills.registerSource(source("contributor", new FrozenSkills([pkg]))); } });
    assert.deepEqual((await root.skills.list({ cwd })).skills.map(item => item.name), ["contributed"]);
    await contributor.dispose();
    assert.deepEqual((await root.skills.list({ cwd })).skills, []);
  } finally { await root.fiber.dispose(); }
});

test("explicit resource helper freezes empty or accepted Memory, rejects tampering, and labels legacy honestly", async t => {
  const { cwd, local } = await fixture(t);
  const resources = await captureProfileResources({ cwd, skills: local });
  assert.equal(resources.memory.kind, "empty"); assert.equal(profileResourceCoverage({ resources }), "complete");
  assert.equal(profileResourceCoverage({ digest: "legacy stays unchanged" }), "legacy-unfrozen");
  assert.equal((await captureProfileResources({ cwd, emptySkills: true })).skills.packages.length, 0);
  await assert.rejects(captureProfileResources({ cwd }), { code: "profile_skills_snapshot_unavailable" });
  const body = content({ title: "Accepted fact", content: "Use focused tests.", appliesTo: "fixture", keywords: [], evidence: [{ kind: "operator", id: "test", revision: "1", digest: "a".repeat(64) }] });
  const document = { ...body, id: "fact", version: 2, digest: hash(body), status: "accepted", updatedAt: "2026-10-22T00:00:00.000Z" };
  const initial = freezeMemoryInitialState({ schemaVersion: 1, libraryId: "fixture", revision: 4, documents: [document] });
  const fixed = await captureProfileResources({ cwd, emptySkills: true, memory: initial });
  assert.equal(fixed.memory.snapshot.documents[0].version, 2); assert.equal(validateProfileResources(fixed).digest, fixed.digest);
  assert.throws(() => freezeMemoryInitialState({ schemaVersion: 1, libraryId: "fixture", revision: 4, documents: [{ ...document, status: "stale" }] }), { code: "profile_memory_resources_not_accepted" });
  const corrupted = structuredClone(fixed); corrupted.memory.snapshot.documents[0].content = "unverified overwrite";
  assert.throws(() => validateProfileResources(corrupted));
});
