import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boot, base } from "./fixtures/candidates.mjs";
import { createCandidateEvolutionPorts } from "../dist/evolution/adapters/candidates.js";
import { assertEvolutionTargetSource } from "../dist/evolution/adapters/targets.js";
import { source } from "../dist/candidates/validation.js";
import { digest } from "../dist/agent-profiles/validation.js";
const name = "evolved_text_clean";
function candidate(version) {
  return source({ schemaVersion: 1, id: "evolved-text", version, entry: "index.ts", tests: ["index.test.ts"], config: {}, provenance: { author: "acceptance", purpose: "A new pure Tool and a bounded revision; no effectiveness claim" },
    manifest: { apiVersion: "wish.plugin/v1", id: "evolved-text", entry: "./plugin.mjs", managementClass: "managed", replacement: "drain", configSchema: { type: "object", additionalProperties: false }, permissions: { capabilities: [] }, sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" }, contracts: { requires: { tools: { version: 1, methods: ["register"] } }, provides: {} } },
    files: { "evolution-target.json": JSON.stringify({ schemaVersion: 1, kind: "tool", tools: [name] }),
      "index.ts": `import type {Context} from '@deepseek-ai/cordis';
import type {} from 'wish/tools';
import {ManagedToolOwner} from 'wish/tools/managed';
export const clean=(value:string)=>${version === 1 ? "value.trim()" : "value.trim().replace(/ +/g,' ')"};
export default {name:'evolved-text',inject:['tools'],apply(ctx:Context){const owner=new ManagedToolOwner(ctx,{code:'evolved_text',codeReload:true});owner.register({name:'${name}',description:'Normalize surrounding whitespace',inputSchemaJson:JSON.stringify({type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}),executionMode:'parallel',recoveryPolicy:'retry-safe',parse(input){return typeof input.text==='string'?{ok:true,value:undefined,input:{text:input.text}}:{ok:false,message:'text required'};},resolveCapabilities(){return {requirements:[]};},async execute(input){return {text:clean(input.text)};}});}};
`,
      "index.test.ts": `import test from 'node:test';import assert from 'node:assert/strict';import {Context} from '@deepseek-ai/cordis';import {Tools} from 'wish/tools';import plugin,{clean} from './index.js';test('algorithm and real contribution lifetime',async()=>{assert.equal(clean(' a  b '),'${version === 1 ? "a  b" : "a b"}');const ctx=new Context();try{await ctx.plugin(Tools);const fork=await ctx.plugin(plugin);assert.ok(ctx.tools.registry.has('${name}'));await fork.dispose();assert.equal(ctx.tools.registry.has('${name}'),false);}finally{await ctx.fiber.dispose();}});` } });
}
test("Tool target rejects relabelled Prompt or undeclared names before admission", () => {
  const value = candidate(1); assert.doesNotThrow(() => assertEvolutionTargetSource("tool", value));
  assert.throws(() => assertEvolutionTargetSource("prompt", value), /scope_mismatch/);
  const changed = structuredClone(value); changed.files["evolution-target.json"] = JSON.stringify({ schemaVersion: 1, kind: "tool", tools: ["read"] });
  assert.throws(() => assertEvolutionTargetSource("tool", changed), /descriptor_invalid/);
  assert.throws(() => assertEvolutionTargetSource("kernel", value), /contract_unavailable/);
});
test("new and revised Tool candidates really register, enter the exact Profile and unload under Linux admission", { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-evolution-tool-")); let host;
  try {
    host = await boot(directory, { WISH_EVOLUTION_ENABLED: "0" }); const ctx = host.surfaceContext, baseline = await base(ctx);
    const ports = createCandidateEvolutionPorts({ candidates: ctx.get("candidates"), agentProfiles: ctx.get("agentProfiles"), evidence: async () => assert.fail("unused"), generate: async () => assert.fail("unused") });
    for (const version of [1, 2]) {
      const value = candidate(version), context = { campaign: { id: "tool-research", spec: { baselineSnapshotDigest: baseline.digest, allowedTargets: ["tool"], context: { parentId: "app", entryId: "new-text-tool" } } }, attempt: { id: `tool-round-${version}`, round: version, proposal: { id: `proposal-${version}`, ticketIds: ["manual"], target: "tool", rationale: "Bounded pure transformation", source: value } }, operationId: `tool-round-${version}-candidate`, signal: new AbortController().signal };
      const receipt = await ports.candidate(context), snapshot = await ctx.get("agentProfiles").get(receipt.snapshotDigest);
      assert.equal(receipt.candidateDigest, digest(value)); assert.ok(snapshot.definition.tools.includes(name));
      assert.equal(snapshot.definition.permissionProfile, baseline.definition.permissionProfile);
      assert.equal(ctx.get("tools").registry.has(name), false, "Technical candidate stays outside the main Host");
    }
    const history = await ctx.get("candidates").history(); assert.equal(history.validations.length, 2); assert.ok(history.validations.every(item => item.status === "passed"));
    assert.equal(history.evaluations.length, 0); assert.equal(history.promotions.length, 0);
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
