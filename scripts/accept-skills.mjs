import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalSkills, parseSkillMarkdown, resourcePath } from "../dist/skills/index.js";

const markdown = (name, extra = "", body = "Inspect before changing code.") => `---\nname: ${name}\ndescription: >-\n  Inspect code\n  and validate changes.\n${extra}---\n${body}`;
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "wish-skills-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const userRoot = join(cwd, "user-skills"), workspaceRoot = join(cwd, ".agents", "skills");
  async function put(root, name, text = markdown(name)) {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), text);
    return directory;
  }
  return { cwd, userRoot, workspaceRoot, put };
}

test("Skills parse data-only YAML, require exact names and reject invalid metadata", () => {
  assert.equal(parseSkillMarkdown(markdown("inspect"), "inspect").description, "Inspect code and validate changes.");
  assert.equal(parseSkillMarkdown(markdown("inspect", "disable-model-invocation: true\n"), "inspect").modelInvocable, false);
  for (const content of ["no header", markdown("other"), markdown("inspect", "name: duplicate\n"), markdown("inspect", "disable-model-invocation: yes\n"), markdown("inspect", "payload: !!js/function function() {}\n"), markdown("inspect", "", " ")]) {
    assert.throws(() => parseSkillMarkdown(content, "inspect"));
  }
  for (const path of ["../secret", "/secret", "scripts/../secret", "scripts\\secret", "", "secret", "references//x"]) assert.throws(() => resourcePath(path));
});

test("Skill discovery is deterministic, metadata-only, bounded and pinned during reads", async t => {
  const { cwd, userRoot, workspaceRoot, put } = await fixture(t);
  await put(userRoot, "inspect", markdown("inspect", "", "user body"));
  await put(workspaceRoot, "inspect", markdown("inspect", "", "workspace body"));
  const resource = await put(workspaceRoot, "tests");
  await mkdir(join(resource, "references"));
  await writeFile(join(resource, "references", "guide.md"), "use focused tests");
  await put(workspaceRoot, "manual", markdown("manual", "disable-model-invocation: true\n"));
  const skills = new LocalSkills({ userRoot });
  const catalog = await skills.list({ cwd });
  assert.deepEqual(catalog.skills.map(s => s.name), ["inspect", "manual", "tests"]);
  assert.equal(catalog.skills[0].source, "user");
  assert.equal(catalog.skills[0].content, undefined);
  assert.equal(catalog.skills[1].modelInvocable, false);
  assert.match(catalog.issues[0].message, /Duplicate/);
  const entry = catalog.skills[2];
  assert.equal((await skills.read({ cwd, name: entry.name, expectedDigest: entry.digest, path: "references/guide.md" })).content, "use focused tests");
  await writeFile(join(resource, "SKILL.md"), markdown("tests", "", "changed"));
  await assert.rejects(skills.read({ cwd, name: entry.name, expectedDigest: entry.digest }), /changed/);
  const limited = await new LocalSkills({ userRoot, maxSkills: 1 }).list({ cwd });
  assert.equal(limited.skills.length, 1);
  assert.equal(limited.issues.length > 0, true);
});

test("Skill roots, packages and resources reject symlinks; abort and file limits fail closed", async t => {
  const { cwd, workspaceRoot, put } = await fixture(t);
  const directory = await put(workspaceRoot, "inspect");
  await writeFile(join(cwd, "secret"), "secret outside package");
  await mkdir(join(directory, "references"));
  await symlink(join(cwd, "secret"), join(directory, "references", "leak.md"));
  const skills = new LocalSkills();
  const entry = (await skills.list({ cwd })).skills[0];
  await assert.rejects(skills.read({ cwd, name: "inspect", expectedDigest: entry.digest, path: "references/leak.md" }), /regular/);
  await symlink(directory, join(workspaceRoot, "alias"));
  assert.equal((await skills.list({ cwd })).skills.length, 1);
  assert.equal((await new LocalSkills({ maxFileBytes: 10 }).list({ cwd })).skills.length, 0);
  await assert.rejects(skills.list({ cwd, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  assert.deepEqual((await skills.list({ cwd: join(cwd, "empty") })).skills, []);
});

test("Skill pages preserve Unicode, pin resources and never grant model invocation", async t => {
  const { cwd, workspaceRoot, put } = await fixture(t);
  const directory = await put(workspaceRoot, "manual", markdown("manual", "disable-model-invocation: true\n"));
  await mkdir(join(directory, "references"));
  const resourcePath = join(directory, "references", "unicode.md");
  const original = "中文😀\n".repeat(20);
  await writeFile(resourcePath, original);
  const source = new LocalSkills();
  const skill = (await source.list({ cwd })).skills[0];
  const request = { cwd, name: skill.name, expectedDigest: skill.digest, expectedPackageId: skill.packageId, path: "references/unicode.md" };
  await assert.rejects(source.read({ ...request, invocation: "model" }), /Host/);
  const full = await source.read(request);
  assert.equal(full.complete, true);
  assert.equal(full.content, original);
  let page = await source.read({ ...request, limit: 3 });
  assert.equal(page.complete, false);
  assert.equal(page.content, "中文😀");
  let rebuilt = page.content;
  while (page.nextOffset !== undefined) {
    page = await source.read({ ...request, offset: page.nextOffset, limit: 3, expectedResourceDigest: page.digest });
    rebuilt += page.content;
  }
  assert.equal(rebuilt, original);
  await assert.rejects(source.read({ ...request, offset: 3 }), /expectedResourceDigest/);
  await writeFile(resourcePath, original + "changed");
  await assert.rejects(source.read({ ...request, offset: 3, expectedResourceDigest: full.digest }), /changed/);
  for (const extra of [{ offset: -1 }, { limit: 0 }, { limit: 32_001 }, { expectedDigest: "bogus" }]) await assert.rejects(source.read({ ...request, ...extra }));
});

test("Discovery uses only .agents/skills and does not execute package scripts", async t => {
  const { cwd, workspaceRoot, put } = await fixture(t);
  await put(join(cwd, ".wish", "skills"), "legacy");
  const directory = await put(workspaceRoot, "inspect");
  await mkdir(join(directory, "scripts"));
  await writeFile(join(directory, "scripts", "check.sh"), "exit 73\n");
  const source = new LocalSkills();
  const catalog = await source.list({ cwd });
  assert.deepEqual(catalog.skills.map(skill => skill.name), ["inspect"]);
  assert.equal((await source.read({ cwd, name: "inspect", expectedDigest: catalog.skills[0].digest, path: "scripts/check.sh" })).content, "exit 73\n");
});

test("Pinned package identity detects a source replacement even with identical manifest content", async t => {
  const { cwd, userRoot, workspaceRoot, put } = await fixture(t);
  await put(workspaceRoot, "inspect");
  const source = new LocalSkills({ userRoot });
  const entry = (await source.list({ cwd })).skills[0];
  await put(userRoot, "inspect");
  const replacement = (await source.list({ cwd })).skills[0];
  assert.equal(replacement.digest, entry.digest);
  assert.notEqual(replacement.packageId, entry.packageId);
  await assert.rejects(source.read({ cwd, name: entry.name, expectedPackageId: entry.packageId, expectedDigest: entry.digest }), /origin changed/);
  await assert.rejects(source.read({ cwd, name: entry.name, expectedDigest: entry.digest, invocation: "model" }), /expectedPackageId/);
});

test("Skill resources reject hard-linked external files and bound root enumeration", async t => {
  const { cwd, workspaceRoot, put } = await fixture(t);
  const directory = await put(workspaceRoot, "inspect");
  await mkdir(join(directory, "references"));
  const secret = join(cwd, "private.txt");
  await writeFile(secret, "private outside package");
  await link(secret, join(directory, "references", "linked.txt"));
  const skills = new LocalSkills();
  const entry = (await skills.list({ cwd })).skills[0];
  await assert.rejects(skills.read({ cwd, name: entry.name, expectedDigest: entry.digest, expectedPackageId: entry.packageId, path: "references/linked.txt" }), /hard-linked/);
  for (let start = 0; start < 1000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(join(workspaceRoot, `entry-${start + i}`), "")));
  const catalog = await skills.list({ cwd });
  assert.equal(catalog.skills.length, 0);
  assert.ok(catalog.issues.some(issue => /1000 entries/u.test(issue.message)));
});
