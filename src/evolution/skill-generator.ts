import { digest } from "../agent-profiles/validation.js";
import type { CandidateSource } from "../candidates/types.js";
import { source as validateSource } from "../candidates/validation.js";
import { validateSkillPackageSnapshot } from "../skills/local.js";
import type { SkillPackageSnapshot } from "../skills/types.js";

/** Host-authored wrapper. Model text remains immutable package data, never plugin source. */
export function skillCandidate(input: {
  readonly id: string; readonly version: number; readonly package: SkillPackageSnapshot;
  readonly purpose: string; readonly runId: string;
}): CandidateSource {
  const pkg = validateSkillPackageSnapshot(input.package);
  const sourceId = `candidate-skill-${digest(input.id).slice(0, 32)}`;
  return validateSource({ schemaVersion: 1, id: input.id, version: input.version, entry: "index.ts", tests: ["index.test.ts"], config: {},
    provenance: { author: "wish-evolution", purpose: input.purpose.slice(0, 2000), runId: input.runId },
    manifest: { apiVersion: "wish.plugin/v1", id: input.id, entry: "./plugin.mjs", managementClass: "managed", replacement: "drain",
      configSchema: { type: "object", additionalProperties: false }, permissions: { capabilities: [] },
      sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" },
      contracts: { requires: { skills: { version: 1, methods: ["registerSource"] } }, provides: {} } },
    files: {
      "skill-package.json": JSON.stringify(pkg),
      "index.ts": `import type { Context } from '@deepseek-ai/cordis';\nimport type {} from 'wish/skills/service';\nimport { FrozenSkills } from 'wish/skills/local';\nimport { PluginWorkOwner } from 'wish/plugins/work-owner';\nexport const packageSnapshot = ${JSON.stringify(pkg)} as const;\nexport const sourceId = ${JSON.stringify(sourceId)};\nexport default { name: ${JSON.stringify(input.id)}, inject: ['skills'], apply(ctx: Context) {\n  const owner = new PluginWorkOwner(ctx, {code:'evolved_skill',codeReload:true});\n  const frozen = new FrozenSkills([packageSnapshot]);\n  ctx.skills.registerSource({ id: sourceId, list: input => owner.run(() => frozen.list(input)), read: input => owner.run(() => frozen.read(input)), snapshot: input => owner.run(() => frozen.snapshot(input)) });\n} };\n`,
      "index.test.ts": `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { Context } from '@deepseek-ai/cordis';\nimport { mkdtemp, rm } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport LocalSkillsService from 'wish/skills/providers/local';\nimport plugin, { packageSnapshot } from './index.js';\ntest('complete Skill bytes are read-only and contribution follows plugin lifetime', async () => {\n  const directory = await mkdtemp(join(tmpdir(), 'wish-candidate-skill-'));\n  const ctx = new Context();\n  try {\n    await ctx.plugin({ name:'fixture-launch', apply(ctx: Context) { ctx.provide('launch', {homeDirectory:directory} as any); } });\n    await ctx.plugin(LocalSkillsService, {userRoot:join(directory,'user-skills')});\n    const fork = await ctx.plugin(plugin);\n    const entry = (await ctx.skills.list({cwd:directory})).skills.find(item => item.name === packageSnapshot.skill.name);\n    assert.ok(entry);\n    assert.equal(entry.modelInvocable, packageSnapshot.skill.modelInvocable);\n    const request = {cwd:directory,name:entry.name,expectedDigest:entry.digest,expectedPackageId:entry.packageId};\n    for (const resource of packageSnapshot.resources) { const loaded = await ctx.skills.read({...request,path:resource.path,invocation:'host'}); assert.equal(loaded.content,resource.content); assert.equal(loaded.digest,resource.digest); }\n    if (entry.modelInvocable) assert.equal((await ctx.skills.read({...request,invocation:'model'})).content,packageSnapshot.resources.find(item => item.path === 'SKILL.md')!.content);\n    else await assert.rejects(ctx.skills.read({...request,invocation:'model'}));\n    await fork.dispose();\n    assert.equal((await ctx.skills.list({cwd:directory})).skills.some(item => item.name === entry.name),false);\n    await assert.rejects(ctx.skills.read({...request,invocation:'host'}));\n  } finally { await ctx.fiber.dispose(); await rm(directory,{recursive:true,force:true}); }\n});\n`,
    } });
}
