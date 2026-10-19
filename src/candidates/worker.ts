import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { canonical, digest, record, validateSnapshot } from "../agent-profiles/validation.js";
import { experimentDeployment } from "../agent-profiles/composition.js";
import { bootstrap } from "../boot/bootstrap.js";
import { source, target, fail } from "./validation.js";
import type { AgentProfileSnapshot } from "../agent-profiles/types.js";
import type { ModelRequest, ModelStreamEvent } from "../core/model/model.js";
import type { Context } from "@deepseek-ai/cordis";
import { verifyPluginContracts } from "../plugin-admission/runtime.js";
import { pluginManifestView, parseWishPluginManifest, type WishPluginManifest } from "../boot/plugin-control/manifest.js";

const release = fileURLToPath(new URL("../../", import.meta.url));
// Installed before importing any candidate tests, including asynchronous ones.
const parentDisconnected = () => process.exit(1);
if (process.send) process.once("disconnect", parentDisconnected);
// node:test's in-process harness completes at beforeExit. The native parent
// death signal still owns cancellation while no model request is pending.
process.channel?.unref();

async function build(request: Record<string, unknown>, scratch: string): Promise<unknown> {
  const candidate = source(request.source), root = join(scratch, "source"); await mkdir(root);
  (await import("../plugin-admission/architecture.js")).inspectArchitecture(candidate);
  for (const [name, content] of Object.entries(candidate.files)) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content, { flag: "wx" }); }
  await writeFile(join(root, "package.json"), '{"type":"module","private":true}');
  const ts = await import("typescript");
  const options: import("typescript").CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, allowJs: true, checkJs: false, types: ["node"], typeRoots: [join(release, "node_modules/@types")] };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (name.startsWith("wish/")) {
      const runtime = fileURLToPath(import.meta.resolve(name));
      return { resolvedFileName: runtime.replace(/\.js$/u, ".d.ts"), extension: ts.Extension.Dts };
    }
    return ts.resolveModuleName(name, name.startsWith(".") ? containingFile : join(release, "candidate.ts"), options, host).resolvedModule;
  });
  const program = ts.createProgram(Object.keys(candidate.files).filter(name => /\.[cm]?[jt]s$/u.test(name)).map(name => join(root, name)), options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors.slice(0, 20), { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  const esbuild = await import("esbuild"); const imports = new Set<string>();
  const files: Record<string, string> = {};
  for (const [index, name] of [candidate.entry, ...candidate.tests].entries()) {
    const result = await esbuild.build({ entryPoints: [join(root, name)], bundle: true, platform: "node", format: "esm", target: "node22", write: false, logLevel: "silent",
      plugins: [{ name: "wish-candidate-imports", setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.kind === "entry-point") return undefined;
          if (args.path.startsWith(".")) {
            const filename = resolve(args.resolveDir, args.path), child = relative(root, filename);
            if (child.startsWith("..") || isAbsolute(child)) throw new Error("candidate_import_escape");
            return undefined;
          }
          if (args.path.startsWith("node:")) { imports.add(args.path); return { path: args.path, external: true }; }
          if (args.path.startsWith("wish/") || ["@deepseek-ai/cordis", "@deepseek-ai/schemastery"].includes(args.path)) {
            const url = import.meta.resolve(args.path); imports.add(url); return { path: url, external: true };
          }
          throw new Error(`candidate_import_not_allowed: ${args.path}`);
        });
      } }],
    });
    const content = result.outputFiles[0]?.text; if (!content) fail("candidate_build_empty");
    files[index === 0 ? "plugin.mjs" : `test-${index}.mjs`] = content;
  }
  files["wish-plugin.json"] = canonical(candidate.manifest);
  files["dependencies.json"] = canonical({ imports: [...imports].sort(), packageLock: digest(await readFile(join(release, "package-lock.json"), "utf8")), node: process.version });
  return { files, imports: [...imports].sort() };
}

function addEntry(rows: Record<string, unknown>[], parentId: string, entry: Record<string, unknown>): void {
  let parent: Record<string, unknown> | undefined, duplicate: Record<string, unknown> | undefined;
  const visit = (items: Record<string, unknown>[]) => {
    for (const row of items) { if (row.id === parentId) parent = row; if (row.id === entry.id) duplicate = row; if (row.group === true && Array.isArray(row.config)) visit(row.config as Record<string, unknown>[]); }
  };
  visit(rows);
  if (!parent || parent.group !== true || !Array.isArray(parent.config)) fail("candidate_parent_missing");
  if (duplicate) {
    if (!(parent.config as Record<string, unknown>[]).includes(duplicate)) fail("candidate_target_parent_mismatch");
    Object.keys(duplicate).forEach(key => delete duplicate![key]); Object.assign(duplicate, entry);
  } else parent.config.push(entry);
}

async function boot(request: Record<string, unknown>, scratch: string, mode: string) {
  const snapshot = validateSnapshot(mode === "check" ? request.base : request.snapshot);
  const rows = JSON.parse(experimentDeployment(snapshot.deployment, scratch)) as Record<string, unknown>[];
  const artifact = mode === "check" ? record(request.artifact) : undefined;
  const candidate = mode === "check" ? source(request.source) : undefined;
  const spec = mode === "check" ? record(request.validation) : undefined;
  const pluginManifests: Record<string, WishPluginManifest> = {};
  for (const plugin of snapshot.plugins) if (plugin.module.startsWith(pathToFileURL(String(request.artifactDirectory) + "/").href) && plugin.module.endsWith("/plugin.mjs")) {
    pluginManifests[plugin.id] = parseWishPluginManifest(JSON.parse(await readFile(new URL("wish-plugin.json", plugin.module), "utf8")));
  }
  if (candidate && artifact && spec) {
    const to = target(spec.target);
    const directory = join(String(request.artifactDirectory), String(artifact.digest));
    pluginManifests[`include:${to.entryId}`] = candidate.manifest;
    addEntry(rows, to.parentId, { id: to.entryId, name: pathToFileURL(join(directory, "plugin.mjs")).href, config: candidate.config });
  }
  if (mode === "execute") {
    const disable = (items: Record<string, unknown>[]) => { for (const row of items) {
      if (row.group === true && Array.isArray(row.config)) disable(row.config as Record<string, unknown>[]);
      else if (/\/models\/model-[a-z-]+-entry\.js$/u.test(String(row.name))) row.disabled = true;
    } };
    disable(rows);
  }
  const filename = join(scratch, "cordis.json"); await writeFile(filename, canonical(rows));
  const workspace = join(scratch, "workspace"); await mkdir(workspace);
  const orphan = () => process.exit(1);
  process.once("disconnect", orphan);
  const booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: workspace, homeDirectory: join(scratch, "home"), configurationFile: filename,
    pluginManifests,
    environment: { PATH: process.env.PATH, HOME: scratch, WISH_DATA_DIR: join(scratch, "data"), WISH_EXPERIMENT_WORKER: "1", WISH_CANDIDATE_WORKER: "1", CORDIS_HMR: "0" } });
  return { ctx: booted.surfaceContext, workspace, async close() { await booted.dispose(); process.off("disconnect", orphan); } };
}

async function check(request: Record<string, unknown>, scratch: string): Promise<unknown> {
  const artifact = record(request.artifact), directory = join(String(request.artifactDirectory), String(artifact.digest));
  // Node's in-process test harness sets exitCode on failed assertions. No child
  // process may be created in this mode, including by candidate tests.
  const { run } = await import("node:test");
  let tests = 0, failures = 0;
  for await (const event of run({ files: Object.keys(record(artifact.files)).filter(name => /^test-[0-9]+\.mjs$/u.test(name)).sort().map(name => join(directory, name)), isolation: "none" })) {
    if (event.type === "test:pass" && !event.data.skip && !event.data.todo && event.data.details.type !== "suite") tests++;
    if (event.type === "test:fail") { failures++; process.stderr.write(`${JSON.stringify(event.data).slice(0, 4000)}\n`); }
  }
  if (tests === 0 || failures > 0) fail("candidate_tests_failed");
  const host = await boot(request, scratch, "check");
  try {
    const to = target(record(request.validation).target);
    const entry = [...host.ctx.root.get("loader")!.entries()].find(entry => entry.options.id === to.entryId);
    const { FiberState } = await import("@deepseek-ai/cordis");
    if (entry?.fiber?.state !== FiberState.ACTIVE) fail("candidate_activation_incomplete");
    const coverage = host.ctx.root.get("pluginOwners")?.coverage(entry.fiber!.uid!);
    const owner = host.ctx.root.get("pluginOwners")?.record(entry.fiber!.uid!);
    if (coverage?.lifecycle !== "managed" || coverage.codeReload !== "registered" || !owner?.canonical) fail("candidate_lifecycle_contract_missing");
    const candidate = source(request.source);
    if (owner.replacement !== candidate.manifest.replacement) fail("candidate_replacement_contract_mismatch");
    verifyPluginContracts(host.ctx.root, entry.fiber!, pluginManifestView(candidate.manifest), true);
    if (candidate.manifest.state.mode === "versioned" && !host.ctx.root.get("pluginState")?.conforms(entry.fiber!.uid!, candidate.manifest.state, candidate.manifest.id)) fail("candidate_state_contract_missing");
    const definition = record(request.validation).profile;
    await host.ctx.get("agentProfiles")!.register(definition);
    const config = await host.ctx.get("application")!.resolve();
    const recipe = record(definition);
    const captured = await host.ctx.get("agentProfiles")!.capture(`${recipe.id}@${recipe.version}`, config);
    const { digest: _, ...body } = captured;
    const augmented = { ...body, candidate: { sourceDigest: String(record(request.validation).candidateDigest), artifactDigest: String(artifact.digest) } };
    const snapshot = validateSnapshot({ ...augmented, digest: digest(augmented) });
    await host.ctx.get("agentProfiles")!.importSnapshot(snapshot);
    const application = await host.ctx.get("application")!.open({ agentProfile: snapshot.digest, dataDirectory: join(scratch, "data") });
    await application.runGeneration?.retire();
    return { snapshot, checks: { typecheck: "passed", build: "passed", tests: { passed: tests, failed: 0 }, activation: "passed", interfaces: "passed", ownership: "passed", unload: "passed" } };
  } finally { await host.close(); }
}

function installBroker(ctx: Context, snapshot: AgentProfileSnapshot): () => void {
  process.channel?.ref();
  const remove: (() => void)[] = [];
  const pending = new Map<string, { queue: ModelStreamEvent[]; ended: boolean; wake: () => void }>();
  const listener = (raw: unknown) => {
    const msg = record(raw), item = pending.get(String(msg.id)); if (!item) return;
    if (msg.type === "candidate/model-event") item.queue.push(msg.event as ModelStreamEvent);
    else if (msg.type === "candidate/model-end") item.ended = true;
    item.wake();
  };
  process.on("message", listener);
  for (const protocol of new Set(snapshot.models.providers.map(provider => provider.protocol))) {
    const handle = ctx.get("models")!.register(protocol, () => ({ async *stream(request: ModelRequest, signal?: AbortSignal) {
      const id = randomUUID(), item = { queue: [] as ModelStreamEvent[], ended: false, wake: () => {} }; pending.set(id, item);
      const abort = () => { item.ended = true; item.wake(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!process.send) fail("candidate_model_broker_missing");
        process.send({ type: "candidate/model", id, request });
        while (!item.ended || item.queue.length) {
          signal?.throwIfAborted();
          if (item.queue.length) yield item.queue.shift()!;
          else await new Promise<void>(accept => { item.wake = accept; });
        }
      } finally { signal?.removeEventListener("abort", abort); pending.delete(id); }
    } }));
    remove.push(() => { handle.unregister(); });
  }
  return () => { process.off("message", listener); process.channel?.unref(); remove.forEach(fn => fn()); };
}

async function execute(request: Record<string, unknown>, scratch: string): Promise<unknown> {
  const snapshot = validateSnapshot(request.snapshot);
  const { validateDataset } = await import("../experiments/validation.js");
  const testCase = validateDataset({ schemaVersion: 1, id: "candidate", version: 1, cases: [request.testCase] }).cases[0]!;
  const host = await boot(request, scratch, "execute");
  let remove: (() => void) | undefined;
  try {
    remove = installBroker(host.ctx, snapshot);
    for (const [path, content] of Object.entries(testCase.files)) { await mkdir(dirname(join(host.workspace, path)), { recursive: true }); await writeFile(join(host.workspace, path), content, { flag: "wx" }); }
    await host.ctx.get("agentProfiles")!.importSnapshot(snapshot);
    const application = await host.ctx.get("application")!.open({ agentProfile: snapshot.digest, maxRunSteps: Number(request.maxSteps), dataDirectory: join(scratch, "data") });
    const session = await application.createSession({ workspaceRoot: host.workspace });
    const handle = await application.startRun({ sessionId: session.sessionId, inputSource: "continuation", payload: { text: testCase.prompt } });
    const completion = await handle.completion;
    const history = await application.readSessionHistory({ sessionId: session.sessionId });
    const output = history.records.filter(item => item.kind === "message" && item.message.role === "assistant").map(item => item.kind === "message" ? item.message.content : "").at(-1) ?? "";
    let assertionPassed: boolean | undefined;
    if (testCase.assertion.kind === "file-equals") try {
      const filename = await realpath(join(host.workspace, testCase.assertion.path));
      const child = relative(host.workspace, filename);
      assertionPassed = !child.startsWith("..") && !isAbsolute(child) && await readFile(filename, "utf8") === testCase.assertion.expected;
    } catch { assertionPassed = false; }
    return { status: completion.status, output, sessionId: session.sessionId, runId: handle.runId, attempts: await host.ctx.get("modelAttemptLedger")!.list({ runId: handle.runId }),
      ...(assertionPassed === undefined ? {} : { assertionPassed }), ...(completion.status === "failed" ? { error: completion.snapshot.error?.message ?? "run_failed" } : {}) };
  } finally { remove?.(); await host.close(); }
}

const mode = process.argv[2], requestFile = process.argv[3];
if (requestFile && ["build", "check", "execute"].includes(mode ?? "")) {
  try {
    const request = record(JSON.parse(await readFile(requestFile, "utf8"))), scratch = join(dirname(requestFile), "scratch");
    const result = mode === "build" ? await build(request, scratch) : mode === "check" ? await check(request, scratch) : await execute(request, scratch);
    await writeFile(join(scratch, "result.json"), canonical(result), { flag: "wx", mode: 0o600 });
    process.off("disconnect", parentDisconnected);
    if (process.connected) process.disconnect();
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; if (process.connected) process.disconnect(); }
}
