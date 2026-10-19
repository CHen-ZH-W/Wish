import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseContracts, inspectArchitecture, checkContractTopology, checkQualityGate, qualityGate, verifyCompiledImports } from "../dist/plugin-admission/index.js";
import { verifyPluginContracts } from "../dist/plugin-admission/runtime.js";
import { candidateAdmission } from "../dist/plugin-admission/candidate.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import { headlessManagement } from "../dist/boot/plugin-control/headless-management.js";
import { source } from "./fixtures/candidates.mjs";
import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

test("service contracts reject ambiguous versions, malformed interfaces and self-dependencies", () => {
  const valid = { requires: { compaction: { version: 1, methods: ["registerStrategy"] } }, provides: {} };
  assert.equal(parseContracts(valid).requires.compaction.version, 1);
  for (const version of [0, -1, "^1", NaN, 1.5]) assert.throws(() => parseContracts({ ...valid, requires: { compaction: { version, methods: [] } } }));
  assert.throws(() => parseContracts({ requires: { counter: { version: 1, methods: [] } }, provides: { counter: { version: 1, methods: [] } } }), { code: "plugin_contract_self_dependency" });
  assert.throws(() => parseContracts({ ...valid, provides: { counter: { version: 1, methods: ["constructor"] } } }));
});

test("declared provider graphs reject missing dependencies, version/method mismatch and cycles", () => {
  const row = (id, requires, provides) => ({ id, contracts: parseContracts({ requires, provides }) });
  const api = { version: 1, methods: ["run"] };
  assert.throws(() => checkContractTopology([row("a", { missing: api }, {})]), { code: "plugin_contract_provider_missing" });
  assert.throws(() => checkContractTopology([row("a", { b: api }, { a: api }), row("b", { a: api }, { b: api })]), { code: "plugin_contract_dependency_cycle" });
  assert.throws(() => checkContractTopology([row("a", { b: { ...api, version: 2 } }, {}), row("b", {}, { b: api })]), { code: "plugin_contract_version_mismatch" });
  assert.doesNotThrow(() => checkContractTopology([row("optional", { missing: { ...api, optional: true } }, {})]));
  assert.doesNotThrow(() => checkContractTopology([
    { ...row("isolated-v2", {}, { compaction: { version: 2, methods: ["open"] } }), isolation: { compaction: "entry:experiment" } },
    row("root-consumer", { compaction: { version: 1, methods: ["open"] } }, {}),
  ]), "an unrelated isolated provider must not override the root protocol");
  assert.throws(() => checkContractTopology([
    { ...row("isolated", {}, { counter: api }), isolation: { counter: "entry:private" } }, row("consumer", { counter: api }, {}),
  ]), { code: "plugin_contract_provider_missing" });
});

test("candidate architecture permits public strategy contracts and type-only stable-core imports", () => {
  const candidate = source(); candidate.files["index.ts"] = "import type { AgentLoopOptions } from 'wish/core/agent-loop';\n" + candidate.files["index.ts"];
  const report = inspectArchitecture(candidate); assert.deepEqual(report.runtimeFiles, ["index.ts"]);
  assert.equal(report.policyVersion, "wish.admission/v1");
});

for (const [name, extra, code] of [
  ["direct Agent Loop import", "import { AgentLoop } from 'wish/core/agent-loop';", "plugin_architecture_core_boundary"],
  ["type import disguising a value import", "import type { AgentLoopOptions } from 'wish/core/agent-loop'; import { AgentLoop } from 'wish/core/agent-loop';", "plugin_architecture_core_boundary"],
  ["runtime re-export", "export * from 'wish/composition/runtime-service';", "plugin_architecture_core_boundary"],
  ["absolute Host imports", "import '/tmp/host.js';", "plugin_architecture_import_forbidden"],
  ["raw filesystem bypass", "import fs from 'node:fs';", "plugin_architecture_privileged_import"],
  ["dynamic imports", "const module = import('wish/core/agent-loop');", "plugin_architecture_dynamic_code"],
  ["unowned timers", "setInterval(()=>{}, 1);", "plugin_architecture_unowned_execution"],
  ["Host namespace access", "globalThis.x = 1;", "plugin_architecture_host_control"],
  ["undeclared methods", "const f = (ctx: Context) => ctx.compaction.selectScoped(ctx, {} as never, {});", "plugin_contract_method_undeclared"],
  ["management access", "const f = (ctx: Context) => ctx.root.get('managedPlugins');", "plugin_architecture_host_control"],
  ["native bindings", "process.getBuiltinModule('fs');", "plugin_architecture_host_control"],
  ["prototype escapes", "const f = (()=>{}).constructor;", "plugin_architecture_dynamic_code"],
  ["context reflection", "const f = (ctx: Context) => Reflect.get(ctx, 'root');", "plugin_architecture_context_alias"],
  ["Service context escape", "class X { ctx: Context; bad() { return this.ctx.root.get('managedPlugins'); } }", "plugin_architecture_host_control"],
  ["service replacement", "const f = (ctx: Context) => { ctx.compaction.registerStrategy = (()=>{}) as never; };", "plugin_architecture_host_mutation"],
  ["global event listeners", "const f = (ctx: Context) => ctx.on('event' as never, (()=>{}) as never, {global:true});", "plugin_architecture_host_control"],
]) test(`architecture rejects ${name}`, () => {
  const candidate = source(); candidate.files["index.ts"] += `\n${extra}`;
  assert.throws(() => inspectArchitecture(candidate), { code });
});

test("runtime closure cannot disguise privileged code as a test helper; static analysis ignores comments", () => {
  const candidate = source(); candidate.files["index.ts"] += "\nimport './helper.js'; // import fs from 'node:fs'";
  candidate.files["helper.ts"] = "import fs from 'node:fs'; export const state = fs;";
  assert.throws(() => inspectArchitecture(candidate), { code: "plugin_architecture_privileged_import" });
  candidate.files["helper.ts"] = "export const message = \"import fs from 'node:fs'\";";
  assert.deepEqual(inspectArchitecture(candidate).runtimeFiles, ["helper.ts", "index.ts"]);
});

test("compiled code imports are rechecked independently of worker-supplied metadata", () => {
  assert.throws(() => verifyCompiledImports("import fs from 'node:fs';", ["node:path"]), { code: "plugin_architecture_compiled_import" });
  assert.throws(() => verifyCompiledImports("import('node:fs');", ["node:fs"]), { code: "plugin_architecture_dynamic_code" });
});

test("Agent capability ceiling is bound into candidate admission instead of granting declared capabilities", () => {
  const candidate = source(); candidate.manifest.permissions.capabilities = ["runtime.control"];
  const request = { candidateDigest: "a".repeat(64), baseSnapshotDigest: "b".repeat(64), target: { parentId: "app", entryId: "candidate" }, profile: { permissionProfile: "workspace-write" } };
  assert.throws(() => candidateAdmission(candidate, request, { permissions: { allowedCapabilities: ["runtime.read"] } }), { code: "plugin_admission_agent_capability_mismatch" });
});

const metrics = { cases: 2, successful: 2, successRate: 1, meanLatencyMs: 100, attempts: 2, knownUsageAttempts: 2, inputTokens: 20, outputTokens: 4, costByCurrency: { USD: 0.01 } };
test("behavior and performance gates fail closed for regression and unknown usage/cost", () => {
  const base = { minimumSuccessRate: 1, maximumSuccessRateRegression: 0 };
  assert.doesNotThrow(() => checkQualityGate(qualityGate({ ...base, maximumMeanLatencyMs: 150, maximumTotalTokens: 24, maximumCostByCurrency: { USD: 0.01 } }), metrics, metrics));
  for (const gate of [{ maximumMeanLatencyMs: 99 }, { maximumLatencyRatio: 0.9 }, { maximumTotalTokens: 23 }, { maximumTokenRatio: 0.9 }, { maximumAttempts: 1 }, { maximumCostByCurrency: { USD: 0.001 } }]) {
    assert.throws(() => checkQualityGate(qualityGate({ ...base, ...gate }), metrics, metrics), { code: "candidate_performance_gate_failed" });
  }
  assert.throws(() => checkQualityGate({ ...base, maximumTotalTokens: 100 }, { ...metrics, inputTokens: null }, metrics), { code: "candidate_metrics_incomplete" });
  assert.throws(() => checkQualityGate({ ...base, maximumCostByCurrency: { USD: 1 } }, { ...metrics, costByCurrency: null }, metrics), { code: "candidate_metrics_incomplete" });
  assert.throws(() => qualityGate({ ...base, maximumMeanLatencyMs: -1 }), { code: "candidate_gate_invalid" });
});

const ownerModule = new URL("../dist/boot/plugin-control/work-owner.js", import.meta.url).href;
const manifest = (id, contracts) => ({ apiVersion: "wish.plugin/v1", id, entry: `./${id}.mjs`, managementClass: "managed", replacement: "drain", configSchema: { type: "object", additionalProperties: false }, permissions: { capabilities: [] }, sandbox: { isolation: "trusted-in-process", filesystem: "none", process: "none", network: "none" }, state: { mode: "stateless" }, contracts });
test("real Loader binds versioned custom providers and checks actual methods before committing replacement", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-contract-graph-")); let host;
  try {
    const provider = join(directory, "provider.mjs"), broken = join(directory, "broken.mjs"), consumer = join(directory, "consumer.mjs");
    const plugin = body => `import { PluginWorkOwner } from ${JSON.stringify(ownerModule)}; export default {async apply(ctx) {new PluginWorkOwner(ctx,{code:'fixture',codeReload:true});${body}}};`;
    await writeFile(provider, plugin("ctx.provide('versionedCounter',{run:()=>7});"));
    await writeFile(broken, plugin("ctx.provide('versionedCounter',{run:7});"));
    await writeFile(consumer, plugin("ctx.provide('consumerResult',{read:()=>ctx.versionedCounter.run()});").replace("async apply", "inject:['versionedCounter'],async apply"));
    const required = { version: 1, methods: ["run"] };
    const providerManifest = manifest("provider", { requires: {}, provides: { versionedCounter: required } });
    const consumerManifest = manifest("consumer", { requires: { versionedCounter: required }, provides: { consumerResult: { version: 1, methods: ["read"] } } });
    await writeFile(join(directory, "provider.json"), JSON.stringify(providerManifest)); await writeFile(join(directory, "broken.json"), JSON.stringify({ ...providerManifest, entry: "./broken.mjs" })); await writeFile(join(directory, "consumer.json"), JSON.stringify(consumerManifest));
    const entry = (id, name = id) => ({ id, name: pathToFileURL(join(directory, `${name}.mjs`)).href, config: {}, management: { manifest: pathToFileURL(join(directory, `${name}.json`)).href } });
    const filename = join(directory, "cordis.json"); await writeFile(filename, JSON.stringify([{ id: "app", name: "cordis:group", group: true, config: [entry("provider"), entry("consumer")] }]));
    host = await bootstrap({ surface: "cli", configurationFile: filename, cwd: directory, homeDirectory: directory, environment: { WISH_DATA_DIR: join(directory, "data") }, management: headlessManagement(join(directory, "management")) });
    assert.equal(host.context.get("consumerResult").read(), 7);
    const current = await host.pluginManagement.deploymentSnapshot("provider");
    await assert.rejects(host.pluginManagement.applyDeploymentOverlay({ requestId: "bad-interface", revision: current.revision, deploymentDigest: current.deploymentDigest, overlayDigest: current.overlayDigest,
      entries: [{ parentId: "app", entry: entry("provider", "broken") }] }), /rolled_back/);
    assert.equal(host.context.get("consumerResult").read(), 7, "verified old provider and dependent survive rejected interface");
    const fiber = host.context.get("pluginOwners").record(host.plugins.inspect().entries.find(e => e.id === "include:consumer").fiberId).fiber;
    assert.throws(() => verifyPluginContracts(host.context, fiber, { id: "consumer", contracts: { requires: { versionedCounter: { ...required, version: 2 } }, provides: {} } }), { code: "plugin_contract_version_mismatch" });
    const runtime = host.context.loader.resolve("include:provider").fiber.runtime, signal = new AbortController().signal;
    await assert.rejects(async () => host.context.waterfall("hmr/reload-batch", signal, async () =>
      host.context.waterfall("hmr/reload-prepare", new Map([[runtime.callback, { filename: provider, runtime }]]), signal, async () => {
        // Model a native apply that returned an active owner but broke its API.
        // The post-apply Host check must prevent a durable success receipt.
        host.context.get("versionedCounter").run = 7;
      })), /plugin_contract_interface_mismatch/);
    assert.equal(host.codeReload.snapshot().phase, "recovery-required");
    assert.equal(host.pluginManagement.snapshot().status, "recovery-required");
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("actual isolated Cordis bindings cannot substitute a same-named provider in a different Scope", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-contract-scope-")); let host;
  try {
    const declarations = {}, group = (id, rows) => ({ id, name: "cordis:group", group: true, isolate: { versionedCounter: true, consumerResult: true }, config: rows });
    const entry = async (id, version, consumer = false) => {
      const required = { version, methods: ["run"] };
      const contracts = consumer ? { requires: { versionedCounter: required }, provides: {} } : { requires: {}, provides: { versionedCounter: required } };
      const definition = manifest(id, contracts); declarations[`include:${id}`] = definition;
      await writeFile(join(directory, `${id}.mjs`), `import { PluginWorkOwner } from ${JSON.stringify(ownerModule)};export default {${consumer ? "inject:['versionedCounter']," : ""}apply(ctx){new PluginWorkOwner(ctx,{code:'scoped_contract',codeReload:true});${consumer ? "void ctx.versionedCounter;" : "ctx.provide('versionedCounter',{run:()=>7});"}}};`);
      return { id, name: pathToFileURL(join(directory, `${id}.mjs`)).href, config: {} };
    };
    const a = await entry("a", 1), b = await entry("b", 2), c = await entry("c", 1, true);
    const file = join(directory, "cordis.json"); await writeFile(file, JSON.stringify([group("scope-a", [a]), group("scope-b", [b, c])]));
    await assert.rejects(bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, configurationFile: file, environment: { WISH_DATA_DIR: join(directory, "data") }, pluginManifests: declarations }), /plugin_contract_version_mismatch/);
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("owned timers require an explicit versioned Timer dependency", () => {
  const candidate = source(); candidate.files["index.ts"] += "\nconst schedule = (ctx: Context) => ctx.timeout(()=>{},10);";
  assert.throws(() => inspectArchitecture(candidate), { code: "plugin_contract_access_undeclared" });
  candidate.manifest.contracts.requires.timer = { version: 1, methods: ["timeout"] };
  assert.doesNotThrow(() => inspectArchitecture(candidate));
});

test("isolated Loader Manifest metadata enforces actual tool capability declarations", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-contract-permissions-")); let host;
  try {
    const toolOwner = new URL("../dist/tools/managed.js", import.meta.url).href;
    const plugin = join(directory, "undeclared.mjs");
    await writeFile(plugin, `import {ManagedToolOwner} from ${JSON.stringify(toolOwner)};
export default {inject:['tools'],apply(ctx){const owner=new ManagedToolOwner(ctx,{code:'undeclared_tool',codeReload:true});
owner.register({name:'undeclared_tool',description:'fixture',inputSchemaJson:'{}',executionMode:'sequential',recoveryPolicy:'needs-reconciliation',parse:x=>({ok:true,input:x}),
resolveCapabilities:()=>({requirements:[{capability:'filesystem.write'}]}),execute:()=>({output:'must not execute'})});}};`);
    const filename = join(directory, "cordis.json");
    await writeFile(filename, JSON.stringify([{ id: "cli", name: "cordis:group", group: true, config: [
      { id: "tools", name: "cordis:tools", config: {} }, { id: "undeclared", name: pathToFileURL(plugin).href, config: {} },
    ] }]));
    host = await bootstrap({ surface: "cli", cwd: directory, homeDirectory: directory, configurationFile: filename,
      environment: { WISH_DATA_DIR: join(directory, "data") }, pluginManifests: { "include:undeclared": manifest("undeclared", { requires: { tools: { version: 1, methods: ["register"] } }, provides: {} }) } });
    const registry = host.context.get("tools").registry;
    const parsed = registry.parseCall({ id: "write-attempt", name: "undeclared_tool", argumentsJson: "{}" }); assert.equal(parsed.ok, true);
    await assert.rejects(registry.resolveCapabilities(parsed.call, {}, new AbortController().signal), /plugin_manifest_capability_undeclared/);
  } finally { await host?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("stable core source cannot import application composition or plugin control, including re-exports", async () => {
  const root = new URL("../src/core/", import.meta.url); let scanned = 0;
  const visit = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = new URL(item.name + (item.isDirectory() ? "/" : ""), directory);
      if (item.isDirectory()) await visit(file);
      else if (item.name.endsWith(".ts")) {
        scanned++; const source = ts.createSourceFile(file.pathname, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
        const check = node => {
          let name;
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) name = node.moduleSpecifier.text;
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
            assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `${file.pathname}: dynamic dependency cannot be audited`);
            name = node.arguments[0].text;
          }
          assert.ok(!ts.isImportEqualsDeclaration(node), `${file.pathname}: CommonJS import requires explicit policy`);
          if (name) {
            const target = name.startsWith("wish/") ? new URL(`../src/${name.slice(5)}`, import.meta.url).pathname : new URL(name, file).pathname;
            if (!(file.pathname.endsWith("/core/runtime/durability/providers/journal.ts") && target.endsWith("/boot/plugin-control/work-owner.js"))) {
              assert.doesNotMatch(target, /\/src\/(?:apps|boot|composition|candidates|plugin-admission)\//, file.pathname);
            }
          }
          ts.forEachChild(node, check);
        }; check(source);
      }
    }
  }; await visit(root); assert.ok(scanned >= 29, "the complete stable core must be scanned");
});

test("every Compaction Provider runtime dependency stays outside Agent Loop, Runtime and Host internals", async () => {
  const root = new URL("../src/compaction/providers/", import.meta.url), visited = new Set(); let providers = 0;
  const inspect = async file => {
    if (visited.has(file.href)) return; visited.add(file.href);
    const source = ts.createSourceFile(file.pathname, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const dependencies = [];
    const check = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const typeOnly = node.isTypeOnly || node.importClause?.isTypeOnly || node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
          !node.importClause.name && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(item => item.isTypeOnly);
        if (!typeOnly) dependencies.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `${file.pathname}: dynamic dependency cannot be audited`);
        dependencies.push(node.arguments[0].text);
      }
      assert.ok(!ts.isImportEqualsDeclaration(node), `${file.pathname}: CommonJS import requires explicit policy`);
      ts.forEachChild(node, check);
    }; check(source);
    for (const name of dependencies) {
      if (!name.startsWith(".")) { assert.doesNotMatch(name, /^wish\/(?:core\/(?:agent|agent-loop|runtime)|apps|composition)/); continue; }
      const target = new URL(name.replace(/\.js$/, ".ts"), file);
      if (target.pathname.endsWith("/boot/plugin-control/work-owner.ts") || target.pathname.endsWith("/compaction/service.ts")) continue;
      assert.doesNotMatch(target.pathname, /\/src\/(?:core\/(?:agent|agent-loop|runtime)|boot|apps|composition)\//, `${file.pathname}: ${name}`);
      await inspect(target);
    }
  };
  const visit = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await visit(file); else if (entry.name.endsWith(".ts")) { providers++; await inspect(file); }
  } }; await visit(root); assert.ok(providers >= 1); assert.ok(visited.size >= 3, "algorithm dependencies must be traversed");
});
