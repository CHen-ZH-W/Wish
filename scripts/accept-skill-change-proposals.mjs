import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createSkillPackageSnapshot } from "../dist/skills/local.js";
import { proposeSkillPatch, mergeSkillPatches, resolveSkillPatchConflicts, proposeSkillMerge, proposeSkillSplit, proposeSkillRetirement, validateSkillChangeProposal } from "../dist/evolution/skill-proposals.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const manifest = name => `---\nname: ${name}\ndescription: Preserve complete resources.\n---\nRead the package resources.\n`;
function pkg(name = "inspect") {
  return createSkillPackageSnapshot({ name, description: "Preserve complete resources.", modelInvocable: true, source: "workspace", location: `fixture:${name}/SKILL.md`, packageId: hash(name), digest: hash(manifest(name)) },
    { "SKILL.md": manifest(name), "references/guide.md": `${name}: complete reference`, "scripts/check.sh": `${name}: script bytes`, "assets/template.txt": `${name}: template bytes` });
}
const identity = id => ({ id, version: 1, reason: "Review a precise resource change." });

test("local Skill patch pins complete base and preserves unrelated and removed bytes in the proposal", () => {
  const base = pkg(), before = JSON.stringify(base);
  const proposal = proposeSkillPatch({ ...identity("patch"), base, expectedBaseDigest: base.digest,
    changes: [{ path: "references/guide.md", content: "new guide" }, { path: "assets/template.txt", content: null }] });
  assert.equal(proposal.status, "ready"); assert.equal(JSON.stringify(base), before);
  assert.equal(proposal.outputs[0].resources.find(item => item.path === "scripts/check.sh").content, "inspect: script bytes");
  assert.equal(proposal.bases[0].resources.find(item => item.path === "assets/template.txt").content, "inspect: template bytes");
  assert.equal(validateSkillChangeProposal(proposal).digest, proposal.digest);
  assert.throws(() => proposeSkillPatch({ ...identity("stale"), base, expectedBaseDigest: "a".repeat(64), changes: [] }), /baseDigest/);
  assert.throws(() => proposeSkillPatch({ ...identity("escape"), base, expectedBaseDigest: base.digest, changes: [{ path: "references/../secret", content: "escape" }] }), /package/);
  assert.throws(() => proposeSkillPatch({ ...identity("manifest"), base, expectedBaseDigest: base.digest, changes: [{ path: "SKILL.md", content: null }] }), /retirement/);
});

test("same-base resource merges retain conflicts and require explicit versioned resolution", () => {
  const base = pkg(), change = (id, path, content) => proposeSkillPatch({ ...identity(id), base, expectedBaseDigest: base.digest, changes: [{ path, content }] });
  const a = change("a", "references/guide.md", "one"), b = change("b", "references/guide.md", "two"), c = change("c", "scripts/check.sh", "preserved independent edit");
  const merged = mergeSkillPatches({ ...identity("merge"), base, expectedBaseDigest: base.digest, proposals: [a, b, c] });
  assert.equal(merged.status, "conflicted"); assert.equal(merged.outputs.length, 0);
  assert.deepEqual(merged.conflicts[0].variants.map(item => item.content), ["one", "two"]);
  assert.equal(validateSkillChangeProposal(merged).digest, merged.digest);
  const resolved = resolveSkillPatchConflicts({ proposal: merged, expectedProposalDigest: merged.digest, resolutions: [{ path: "references/guide.md", content: "explicitly combined" }], reason: "Combine both changes after review." });
  assert.equal(resolved.version, 2); assert.equal(resolved.previousDigest, merged.digest); assert.equal(resolved.status, "ready");
  assert.equal(resolved.outputs[0].resources.find(item => item.path === "scripts/check.sh").content, "preserved independent edit");
  assert.throws(() => resolveSkillPatchConflicts({ proposal: merged, expectedProposalDigest: merged.digest, resolutions: [], reason: "Missing decision." }), /every conflicting/);
  const other = pkg("other"), otherPatch = proposeSkillPatch({ ...identity("other"), base: other, expectedBaseDigest: other.digest, changes: [] });
  assert.throws(() => mergeSkillPatches({ ...identity("bad-base"), base, expectedBaseDigest: base.digest, proposals: [a, otherPatch] }), /same|share/);
});

test("package merging names every resource destination and keeps all source bytes including manifests", () => {
  const bases = [pkg("inspect"), pkg("verify")];
  const proposal = proposeSkillMerge({ ...identity("combine"), bases, expectedBaseDigests: bases.map(base => base.digest), name: "combined", manifest: manifest("combined") });
  assert.equal(proposal.status, "ready");
  assert.equal(proposal.resourceMap.length, bases.reduce((sum, base) => sum + base.resources.length, 0));
  for (const base of bases) for (const resource of base.resources) {
    const move = proposal.resourceMap.find(item => item.baseDigest === base.digest && item.sourcePath === resource.path);
    assert.equal(proposal.outputs[0].resources.find(item => item.path === move.targetPath).content, resource.content);
  }
  assert.equal(validateSkillChangeProposal(proposal).digest, proposal.digest);
});

test("splitting never silently drops resources; retirement retains source snapshots", () => {
  const base = pkg();
  const split = parts => proposeSkillSplit({ ...identity("split"), base, expectedBaseDigest: base.digest, parts });
  const partial = split([{ name: "read-guide", manifest: manifest("read-guide"), paths: ["references/guide.md"] }, { name: "run-check", manifest: manifest("run-check"), paths: ["scripts/check.sh"] }]);
  assert.equal(partial.status, "conflicted"); assert.equal(partial.conflicts[0].path, "assets/template.txt");
  const complete = split([{ name: "read-guide", manifest: manifest("read-guide"), paths: ["references/guide.md", "assets/template.txt"] }, { name: "run-check", manifest: manifest("run-check"), paths: ["scripts/check.sh"] }]);
  assert.equal(complete.status, "ready"); assert.equal(validateSkillChangeProposal(complete).digest, complete.digest);
  const retirement = proposeSkillRetirement({ ...identity("retire"), base, expectedBaseDigest: base.digest });
  assert.equal(retirement.outputs.length, 0); assert.deepEqual(retirement.bases[0], base);
  const forged = structuredClone(complete); forged.outputs[0].resources[0].content = "tampered";
  assert.throws(() => validateSkillChangeProposal(forged));
});
