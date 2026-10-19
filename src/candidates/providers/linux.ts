import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { canonical, record, validateSnapshot } from "../../agent-profiles/validation.js";
import { verifyCode } from "../../agent-profiles/composition.js";
import { regularFile } from "../artifacts.js";
import { fail, fileMap, candidateChecks } from "../validation.js";
import type { CandidateRunner } from "../types.js";
import type { AgentProfileSnapshot } from "../../agent-profiles/types.js";
import type { ModelRequest } from "../../core/model/model.js";

const release = fileURLToPath(new URL("../../../", import.meta.url));
const worker = fileURLToPath(new URL("../worker.js", import.meta.url));

/** The only production Runner; an absent Linux sandbox is a hard failure. */
export default {
  name: "candidate-linux", inject: ["candidates", "experiments", "models"],
  apply(ctx: Context) {
    const retirement = new AbortController();
    const work = new PluginWorkOwner(ctx, { code: "candidate_linux", codeReload: true, beforeDrain: () => retirement.abort() });
    const run = (mode: string, request: unknown, directory: string, signal: AbortSignal, timeoutMs: number, snapshot?: AgentProfileSnapshot) => work.run(() => confined(ctx, mode, request, directory, AbortSignal.any([signal, retirement.signal]), timeoutMs, snapshot));
    const runner: CandidateRunner = {
      async build(source, directory, signal) {
        const result = await run("build", { source }, directory, signal, 120_000);
        return { files: fileMap(result.files), imports: Array.isArray(result.imports) ? result.imports.map(String) : fail("candidate_build_result_invalid") };
      },
      async check(input, signal) {
        const result = await run("check", input, input.directory, signal, 120_000);
        return { snapshot: validateSnapshot(result.snapshot), checks: candidateChecks(result.checks) };
      },
      async execute(input, signal) {
        const started = performance.now();
        try {
          const result = await run("execute", input, input.directory, signal, input.timeoutMs, input.snapshot);
          if (!["completed", "failed", "aborted"].includes(String(result.status)) || typeof result.output !== "string" || !Array.isArray(result.attempts)) fail("candidate_execution_result_invalid");
          return result as unknown as Awaited<ReturnType<CandidateRunner["execute"]>>;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: signal.aborted ? "aborted" : message.includes("candidate_timeout") ? "timed-out" : "failed", output: "", attempts: [], attemptsComplete: false, durationMs: Math.round(performance.now() - started), error: message.slice(0, 6000) };
        }
      },
    };
    const remove = ctx.candidates.registerRunner(runner);
    const removeExecutor = ctx.experiments.registerExecutor(runner, "candidate-sandbox", snapshot => snapshot.candidate !== undefined);
    ctx.effect(() => () => { removeExecutor(); remove(); }, "candidate confined execution");
  },
};

async function confined(ctx: Context, mode: string, input: unknown, directory: string, signal: AbortSignal, timeoutMs: number, snapshot?: AgentProfileSnapshot): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") fail("candidate_sandbox_unavailable");
  signal.throwIfAborted();
  const request = record(input);
  if (snapshot) { await verifyCode(snapshot.code); await ctx.candidates.verifySnapshot(snapshot); }
  if (request.base) await verifyCode(validateSnapshot(request.base).code);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const scratch = join(directory, "scratch"); await mkdir(scratch, { mode: 0o700 });
  const requestFile = join(directory, "request.json");
  await writeFile(requestFile, canonical({ ...request, directory, artifactDirectory: ctx.candidates.artifactDirectory }), { flag: "wx", mode: 0o400 });
  const reads = new Set([join(release, "dist"), join(release, "node_modules"), join(release, "package.json"), join(release, "package-lock.json"), directory, await realpath(process.execPath)]);
  const base = snapshot ?? (request.base ? validateSnapshot(request.base) : undefined);
  if (base) {
    // A frozen external plugin is readable only after its bytes were verified.
    for (const file of base.code) reads.add(file.path);
    for (const plugin of base.plugins) if (plugin.enabled && plugin.module.startsWith("file:") && !plugin.module.startsWith(new URL("../../../", import.meta.url).href)) reads.add(dirname(fileURLToPath(plugin.module)));
  }
  if (request.artifact) reads.add(ctx.candidates.artifactPath(String(record(request.artifact).digest)));
  // Coalesce only explicit release directories. Never grant the user's home or repository root.
  const allowed = [...reads].filter(path => ![...reads].some(parent => parent !== path && path.startsWith(`${parent}/`)));
  if (allowed.length > 120) fail("candidate_sandbox_path_limit");
  const launcher = join(release, "native/bin/wish-linux-sandbox");
  const args = ["--workspace", "/", ...allowed.flatMap(path => ["--read-path", relative("/", resolve(path))]),
    "--write-path", relative("/", scratch), "--network", "disabled", "--candidate-mode", mode === "build" ? "build" : "execute",
    "--protect-name", ".git", "--protect-name", ".aws", "--protect-name", ".codex", "--protect-prefix", ".env",
    "--cwd", directory, "--tmp", scratch, "--cpu-seconds", String(Math.ceil(timeoutMs / 1000) + 1), "--max-processes", "4096", "--max-open-files", "256", "--max-file-size-bytes", "16777216", "--max-memory-bytes", "17179869184",
    "--", process.execPath, "--max-old-space-size=512", worker, mode, requestFile];
  const child = spawn(launcher, args, { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8", WISH_EXPERIMENT_WORKER: "1", WISH_CANDIDATE_WORKER: "1", CORDIS_HMR: "0" },
  });
  const started = performance.now(); let output = "", bytes = 0, timedOut = false, outputLimit = false;
  const groupKill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
  const controller = new AbortController();
  const broker = snapshot ? modelBroker(ctx, child, snapshot, controller.signal, Number(request.maxSteps)) : undefined;
  const append = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 512 * 1024) { outputLimit = true; groupKill(); } else output += chunk.toString("utf8"); };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  signal.addEventListener("abort", groupKill, { once: true }); if (signal.aborted) groupKill();
  const timer = setTimeout(() => { timedOut = true; groupKill(); }, timeoutMs);
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    if (signal.aborted) signal.throwIfAborted();
    if (timedOut) fail("candidate_timeout"); if (outputLimit) fail("candidate_output_limit");
    if (code !== 0) throw new Error(`candidate_${code === 125 ? "sandbox_setup_failed" : "worker_failed"}: ${output.slice(-6000)}`);
    const result = record(JSON.parse(await regularFile(join(scratch, "result.json"), 16 * 1024 * 1024)));
    return { ...result, durationMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", groupKill); groupKill(); controller.abort();
    await broker?.close();
    await writeFile(join(directory, "worker.log"), output, { flag: "wx", mode: 0o600 });
  }
}

/** No credentials or arbitrary URLs cross IPC; only the pinned model Port does. */
function modelBroker(ctx: Context, child: ChildProcess, snapshot: AgentProfileSnapshot, signal: AbortSignal, maxSteps: number) {
  const model = ctx.models.open({ ...snapshot.models, maxRetries: 0, fallbackModels: [] }, { fixedConfiguration: true }).model;
  const active = new Set<Promise<void>>(); const ids = new Set<string>(); let requests = 0, totalBytes = 0;
  const send = (value: Record<string, unknown>) => new Promise<void>((accept, reject) => { if (!child.connected) { reject(new Error("candidate_worker_disconnected")); return; } child.send(value, error => error ? reject(error) : accept()); });
  const listener = (raw: unknown) => {
    const job = (async () => {
      const msg = record(raw);
      if (msg.type !== "candidate/model" || typeof msg.id !== "string" || msg.id.length > 64 || ids.has(msg.id) || active.size > 4 || ++requests > Math.min(512, Math.max(8, maxSteps * 4 + 8))) fail("candidate_model_budget");
      ids.add(msg.id);
      const request = record(msg.request); const ref = record(request.model);
      if (ref.provider !== snapshot.model.provider || ref.model !== snapshot.model.model || !Array.isArray(request.messages) || !Array.isArray(request.instructions) || !Array.isArray(request.tools)) fail("candidate_model_not_pinned");
      const requestBytes = Buffer.byteLength(JSON.stringify(request)); totalBytes += requestBytes;
      if (requestBytes > 2 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) fail("candidate_model_budget");
      // metadata/URLs/options supplied by unknown code never change the transport.
      const options = snapshot.definition.request;
      const invocation: ModelRequest = { model: snapshot.model, instructions: request.instructions as unknown as ModelRequest["instructions"], messages: request.messages as unknown as ModelRequest["messages"], tools: request.tools as unknown as ModelRequest["tools"],
        ...(snapshot.definition.reasoningEffort ? { reasoningEffort: snapshot.definition.reasoningEffort } : {}),
        maxOutputTokens: Math.min(options?.maxOutputTokens ?? snapshot.reservedOutputTokens, typeof request.maxOutputTokens === "number" ? Math.max(1, request.maxOutputTokens) : snapshot.reservedOutputTokens),
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }) };
      for await (const event of model.stream(invocation, signal)) {
        signal.throwIfAborted(); await send({ type: "candidate/model-event", id: msg.id, event });
      }
      await send({ type: "candidate/model-end", id: msg.id });
    })();
    active.add(job);
    void job.catch(() => { child.kill("SIGKILL"); }).finally(() => active.delete(job));
  };
  child.on("message", listener);
  return { async close() { child.off("message", listener); await Promise.allSettled(active); } };
}
