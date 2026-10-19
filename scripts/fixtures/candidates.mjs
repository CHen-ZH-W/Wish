import { join } from "node:path";
import { bootstrap } from "../../dist/boot/bootstrap.js";
import { headlessManagement } from "../../dist/boot/plugin-control/headless-management.js";

export const definition = (id = "baseline", version = 1) => ({ schemaVersion: 1, id, version, model: "fixture/a", tools: ["read"], permissionProfile: "read-only", memory: "none", reservedOutputTokens: 128, compaction: { keepRecentTokens: 128, summaryMaxOutputTokens: 128 } });
export function models(baseUrl = "http://127.0.0.1:1/v1") {
  return { schemaVersion: 1, defaultModel: "fixture/a", maxRetries: 0, providers: [{ id: "fixture", protocol: "openai-chat-completions", baseUrl, auth: { type: "none" }, developerRoleMode: "native", request: { streamUsage: false, supportsTemperature: true, maxTokensField: "max_tokens", extraBody: {} }, models: [{ id: "a", status: "active", contextWindowTokens: 32768, maxOutputTokens: 1024, input: { text: true, image: false }, reasoning: false, toolCalling: true, developerRole: true }] }] };
}
export const source = (version = 1, extra = "") => ({ schemaVersion: 1, id: "fixture-candidate", version, entry: "index.ts", tests: ["index.test.ts"], config: {}, provenance: { author: "acceptance", purpose: "Exercise the actual candidate lifecycle" },
  manifest: { apiVersion: "wish.plugin/v1", id: "fixture-candidate", entry: "./plugin.mjs", managementClass: "managed", replacement: "drain", configSchema: { type: "object", additionalProperties: false }, permissions: { capabilities: [] }, sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" }, contracts: { requires: { compaction: { version: 1, methods: ["registerStrategy"] } }, provides: { candidateFixture: { version: 1, methods: [] } } } },
  files: { "index.ts": `import type { Context } from '@deepseek-ai/cordis';
import { PluginWorkOwner } from 'wish/plugins/work-owner';
import { createCompactionResources } from 'wish/compaction/service';
declare module '@deepseek-ai/cordis' { interface Context { candidateFixture: { version: number } } }
export const double = (value: number): number => value * 2;
${extra}
export default { name: 'fixture-candidate', inject: ['compaction'], apply(ctx: Context) {
  const work = new PluginWorkOwner(ctx, { code: 'fixture_candidate', codeReload: true });
  ctx.provide('candidateFixture', { version: ${version} });
  ctx.compaction.registerStrategy(ctx, { id: 'fixture-candidate-v1', open(input) {
    const compactor = createCompactionResources(input);
    return { keepRecentTokens: compactor.keepRecentTokens, compact: (request: Parameters<typeof compactor.compact>[0]) => work.run(() => compactor.compact(request)) };
  } });
} };`,
  "index.test.ts": "import test from 'node:test'; import assert from 'node:assert/strict'; import { double } from './index.js'; test('algorithm', () => assert.equal(double(3),6));" },
});
export function boot(directory, environment = {}) {
  return bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_CANDIDATES_DIR: join(directory, "candidates"), WISH_EXPERIMENTS_DIR: join(directory, "experiments"), WISH_MODELS_JSON: JSON.stringify(models()), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0", ...environment },
    management: headlessManagement(join(directory, "management")),
  });
}
export async function base(ctx, profile = definition()) { await ctx.get("agentProfiles").register(profile); return ctx.get("agentProfiles").capture(`${profile.id}@${profile.version}`, await ctx.get("application").resolve()); }
export const validation = (candidateDigest, snapshot, profile = definition("candidate")) => ({ candidateDigest, baseSnapshotDigest: snapshot.digest, target: { parentId: "app", entryId: "generated-plugin" }, profile: { ...profile, compaction: { ...profile.compaction, strategyId: "fixture-candidate-v1" } } });
