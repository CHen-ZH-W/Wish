import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { LocalSkills } from "../dist/skills/local.js";
import { LocalSkillImporter, SkillImportError, skillCatalogDigest } from "../dist/skills/import.js";
import LocalSkillsService from "../dist/skills/providers/local.js";

const markdown = (name, body = "Inspect code before editing.") => `---\nname: ${name}\ndescription: A reusable test workflow.\n---\n${body}\n`;
const packageFiles = (name, extra = []) => [{ path: "SKILL.md", content: markdown(name) }, ...extra];
const errorCode = code => error => error instanceof SkillImportError && error.code === code;
async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "wish-skill-import-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const userRoot = join(cwd, "user-skills"), source = new LocalSkills({ userRoot, ...options });
  const importer = new LocalSkillImporter(source, { userRoot, ...options });
  const request = async (files, extra = {}) => ({ cwd, files, expectedCatalogDigest: skillCatalogDigest(await source.list({ cwd })), ...extra });
  const leftovers = async () => (await readdir(userRoot).catch(() => [])).filter(name => name.startsWith(".wish-skill-"));
  return { cwd, userRoot, source, importer, request, leftovers };
}

test("imports a complete prefixed folder and a standalone manifest using its declared name", async t => {
  const f = await fixture(t);
  const files = packageFiles("workflow", [{ path: "references/guide.md", content: "中文😀" }, { path: "scripts/check.sh", content: "touch must-not-exist" }, { path: "assets/nested/template.txt", content: "template" }]).map(file => ({ ...file, path: `downloaded-folder/${file.path}` }));
  const skill = await f.importer.importPackage(await f.request(files));
  assert.equal(skill.name, "workflow");
  assert.deepEqual((await f.source.list({ cwd: f.cwd })).skills, [skill]);
  assert.equal(await readFile(join(f.userRoot, "workflow", "references", "guide.md"), "utf8"), "中文😀");
  await assert.rejects(lstat(join(f.cwd, "must-not-exist")), { code: "ENOENT" });
  const single = [{ path: "SKILL.md", content: markdown('"standalone"') }];
  assert.equal((await f.importer.importPackage(await f.request(single))).name, "standalone");
  assert.deepEqual(await f.leftovers(), []);
});

test("explicit overwrite replaces the entire user package and removes obsolete resources", async t => {
  const f = await fixture(t);
  await f.importer.importPackage(await f.request(packageFiles("workflow", [{ path: "references/old.md", content: "old" }])));
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("workflow"))), errorCode("skill_import_conflict"));
  const replacement = [{ path: "SKILL.md", content: markdown("workflow", "new instructions") }, { path: "references/new.md", content: "new" }];
  await f.importer.importPackage(await f.request(replacement, { overwrite: true }));
  assert.match(await readFile(join(f.userRoot, "workflow", "SKILL.md"), "utf8"), /new instructions/);
  await assert.rejects(lstat(join(f.userRoot, "workflow", "references", "old.md")), { code: "ENOENT" });
  assert.deepEqual(await f.leftovers(), []);
});

test("all imports require current catalog CAS and concurrent requests serialize", async t => {
  const f = await fixture(t);
  const first = await f.request(packageFiles("first")), second = await f.request(packageFiles("second"));
  const results = await Promise.allSettled([f.importer.importPackage(first), f.importer.importPackage(second)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "skill_import_catalog_changed");
  assert.deepEqual((await f.source.list({ cwd: f.cwd })).skills.map(skill => skill.name), ["first"]);
  assert.deepEqual(await f.leftovers(), []);
});

test("workspace and registered contributions cannot be overwritten by a user import", async t => {
  const f = await fixture(t);
  const directory = join(f.cwd, ".agents", "skills", "workspace-only");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), markdown("workspace-only"));
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("workspace-only"), { overwrite: true })), errorCode("skill_import_source_conflict"));
  const base = (await f.source.list({ cwd: f.cwd })).skills[0];
  const unregister = f.source.registerSource({ id: "managed", list: async () => ({ skills: [{ ...base, name: "managed-only", source: "user", location: join(f.userRoot, "managed-only", "SKILL.md") }], issues: [] }), read: async () => { throw new Error("unused"); }, snapshot: async () => [] });
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("managed-only"), { overwrite: true })), errorCode("skill_import_source_conflict"));
  unregister();
  await assert.rejects(lstat(f.userRoot), { code: "ENOENT" });
});

test("rejects path escapes, unsupported policies, duplicate manifests and non-UTF8 text before writes", async t => {
  const f = await fixture(t);
  const invalid = [
    packageFiles("workflow", [{ path: "../escape", content: "bad" }]),
    packageFiles("workflow", [{ path: "/absolute", content: "bad" }]),
    packageFiles("workflow", [{ path: "scripts\\escape", content: "bad" }]),
    packageFiles("workflow", [{ path: "agents/openai.yaml", content: "policy:\n  allow_implicit_invocation: false\n" }]),
    packageFiles("workflow", [{ path: "nested/SKILL.md", content: markdown("nested") }]),
    packageFiles("workflow", [{ path: "references/a", content: "file" }, { path: "references/a/b", content: "collision" }]),
    packageFiles("workflow", [{ path: "references/a", content: "\ud800" }]),
    packageFiles("workflow", [{ path: "references/a", content: "\0" }]),
    packageFiles("workflow", [{ path: "SKILL.md", content: markdown("duplicate") }]),
  ];
  for (const files of invalid) await assert.rejects(f.importer.importPackage(await f.request(files)), SkillImportError);
  await assert.rejects(lstat(f.userRoot), { code: "ENOENT" });
});

test("enforces file and catalog limits without leaving partial packages", async t => {
  const f = await fixture(t, { maxFileBytes: 128, maxSkills: 1 });
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("workflow", [{ path: "assets/large.txt", content: "x".repeat(129) }]))), errorCode("skill_import_limit"));
  await f.importer.importPackage(await f.request(packageFiles("first")));
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("second"))), errorCode("skill_import_limit"));
  assert.deepEqual(await f.leftovers(), []);
});

test("rejects symbolic or hard linked old resources and symlinked user directory parents", async t => {
  const f = await fixture(t);
  await f.importer.importPackage(await f.request(packageFiles("workflow")));
  const references = join(f.userRoot, "workflow", "references"), outside = join(f.cwd, "outside.txt");
  await mkdir(references); await writeFile(outside, "preserve me");
  const resource = join(references, "unsafe.txt");
  await symlink(outside, resource);
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("workflow"), { overwrite: true })), errorCode("skill_import_unsafe_target"));
  await rm(resource); await link(outside, resource);
  await assert.rejects(f.importer.importPackage(await f.request(packageFiles("workflow"), { overwrite: true })), errorCode("skill_import_unsafe_target"));
  assert.equal(await readFile(outside, "utf8"), "preserve me");
  const actual = join(f.cwd, "actual"), alias = join(f.cwd, "alias");
  await mkdir(actual); await symlink(actual, alias);
  const unsafe = new LocalSkillImporter(new LocalSkills({ userRoot: join(alias, "skills") }), { userRoot: join(alias, "skills") });
  await assert.rejects(unsafe.importPackage(await f.request(packageFiles("fresh"), { expectedCatalogDigest: skillCatalogDigest({ skills: [], issues: [] }) })), SkillImportError);
  assert.deepEqual(await readdir(actual), []);
  assert.deepEqual(await f.leftovers(), []);
});

test("a failure after staging preserves the old package and cleans all staged files", async t => {
  const f = await fixture(t);
  const original = packageFiles("workflow", [{ path: "references/original.md", content: "keep" }]);
  await f.importer.importPackage(await f.request(original));
  let calls = 0;
  const failing = new LocalSkillImporter({ list: async input => { if (++calls === 2) throw new Error("injected catalog failure after staging"); return f.source.list(input); }, read: input => f.source.read(input) }, { userRoot: f.userRoot });
  await assert.rejects(failing.importPackage(await f.request([{ path: "SKILL.md", content: markdown("workflow", "replacement") }], { overwrite: true })), errorCode("skill_import_failed"));
  assert.equal(await readFile(join(f.userRoot, "workflow", "SKILL.md"), "utf8"), original[0].content);
  assert.equal(await readFile(join(f.userRoot, "workflow", "references", "original.md"), "utf8"), "keep");
  assert.deepEqual(await f.leftovers(), []);
});

test("Provider disables frozen imports and rejects writes after owner detach", async t => {
  const f = await fixture(t), ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin({ name: "fixture-launch", apply(ctx) { ctx.provide("launch", { homeDirectory: f.cwd }); } });
  const fork = await ctx.plugin(LocalSkillsService, { userRoot: f.userRoot });
  const service = ctx.skills;
  assert.equal(service.importCapabilities().maxFileBytes, 64000);
  await service.importPackage(await f.request(packageFiles("workflow")));
  await fork.dispose();
  await assert.rejects(service.importPackage(await f.request(packageFiles("after-close"))), /skills_owner_closed/);
  await assert.rejects(lstat(join(f.userRoot, "after-close")), { code: "ENOENT" });
  const frozenFork = await ctx.plugin(LocalSkillsService, { userRoot: f.userRoot, frozenPackages: [] });
  assert.equal(ctx.skills.importCapabilities(), undefined);
  await assert.rejects(ctx.skills.importPackage(await f.request(packageFiles("frozen"))), errorCode("skill_import_unavailable"));
  await frozenFork.dispose();
});
