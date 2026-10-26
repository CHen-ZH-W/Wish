import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { AgentProfileError, canonical, record } from "../../agent-profiles/validation.js";
import { experimentDeployment, verifyCode } from "../../agent-profiles/composition.js";
import type { ExperimentExecutionInput, ExperimentExecutionResult } from "../types.js";

/** Trusted Wish runtime in a fresh process; model Tools retain the existing execution sandbox. */
export default {
  name: "experiment-process", inject: ["experiments", "launch"],
  apply(ctx: Context) {
    const retirement = new AbortController();
    const work = new PluginWorkOwner(ctx, { code: "experiment_process", codeReload: true,
      beforeDrain: () => retirement.abort(new Error("experiment_executor_closed")),
    });
    const remove = ctx.experiments.registerExecutor({ execute: (input, signal) => work.run(() => executeProfileTask(input, AbortSignal.any([signal, retirement.signal]), ctx.launch.environment)) });
    ctx.effect(() => remove, "experiment executor");
  },
};

/** Shared isolated Runtime invocation. Calling this function creates no Experiment/evaluation record. */
export async function executeProfileTask(input: ExperimentExecutionInput, signal: AbortSignal, environment: Readonly<Record<string, string | undefined>>): Promise<ExperimentExecutionResult> {
  signal.throwIfAborted(); await verifyCode(input.snapshot.code);
  if (input.snapshot.candidate) throw new AgentProfileError("experiment_candidate_requires_sandbox");
  if (!["read-only", "workspace-write"].includes(input.snapshot.definition.permissionProfile)) throw new AgentProfileError("experiment_permission_requires_confinement", "Experiments require read-only or workspace-write Tool permissions");
  await mkdir(dirname(input.directory), { recursive: true });
  await mkdir(input.directory, { mode: 0o700 });
  await mkdir(join(input.directory, "home"), { mode: 0o700 });
  await mkdir(join(input.directory, "tmp"), { mode: 0o700 });
  const request = join(input.directory, "request.json");
  await writeFile(join(input.directory, "cordis.json"), experimentDeployment(input.snapshot.deployment, input.directory, input.snapshot.resources, "sealed", !!input.requestBudget), { mode: 0o600, flag: "wx" });
  await writeFile(request, canonical({ schemaVersion: 1, snapshot: input.snapshot, testCase: input.testCase, maxSteps: input.maxSteps, ...(input.requestBudget ? { requestBudget: input.requestBudget } : {}) }), { mode: 0o600, flag: "wx" });
  const log = await open(join(input.directory, "worker.log"), "wx", 0o600);
  const started = performance.now();
  let timedOut = false;
  let killed = false;
  let cleanup: Promise<void> | undefined;
  let terminationError: unknown;
  let writes = Promise.resolve();
  let outputBytes = 0;
  let child: ReturnType<typeof spawn>;
  const credentialNames = new Set<string>();
  const findCredentials = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(findCredentials); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["apiKeyEnv", "fromEnv"].includes(key) && typeof item === "string") credentialNames.add(item);
      else findCredentials(item);
    }
  };
  findCredentials(input.snapshot.models);
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../worker.js", import.meta.url)), request], {
      cwd: input.directory, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...Object.fromEntries(Object.entries(environment).filter(([key]) => (!key.startsWith("WISH_") || credentialNames.has(key)) && !["CORDIS_CONFIG", "CORDIS_HMR", "NODE_OPTIONS"].includes(key))),
        HOME: join(input.directory, "home"), TMPDIR: join(input.directory, "tmp"),
        WISH_EXPERIMENT_WORKER: "1", WISH_AGENT_PROFILE: "", CORDIS_HMR: "0" },
    });
    const kill = (kind: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind); else child.kill(kind); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") terminationError = error; }
    };
    const terminate = () => {
      if (killed) return; killed = true;
      kill("SIGTERM");
      // Keep the escalation even if the leader exits first: its descendants may survive it.
      cleanup = new Promise<void>(accept => setTimeout(() => { kill("SIGKILL"); accept(); }, 2_500));
    };
    const append = (bytes: Buffer) => {
      const remaining = Math.max(0, 512 * 1024 - outputBytes);
      outputBytes += bytes.length;
      if (remaining > 0) { const chunk = bytes.subarray(0, remaining); writes = writes.then(async () => { await log.write(chunk); }); void writes.catch(() => {}); }
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    const timer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
    let code: number | null;
    try { code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }); }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", terminate);
      await cleanup;
      // The invocation owns the whole process group, including children left after normal exit.
      if (process.platform !== "win32") kill("SIGKILL");
    }
    if (terminationError) throw terminationError;
    const durationMs = Math.round(performance.now() - started);
    if (timedOut || signal.aborted) return { status: timedOut ? "timed-out" : "aborted", output: "", durationMs, attempts: [], attemptsComplete: false, error: timedOut ? "experiment_timeout" : "experiment_cancelled" };
    if (code !== 0) return { status: "failed", output: "", durationMs, attempts: [], attemptsComplete: false, error: "experiment_worker_failed" };
    const raw = await readFile(join(input.directory, "result.json"));
    if (raw.byteLength > 16 * 1024 * 1024) throw new AgentProfileError("experiment_result_limit");
    const result = record(JSON.parse(raw.toString("utf8")));
    if (!["completed", "failed", "aborted"].includes(String(result.status)) || typeof result.output !== "string" || !Array.isArray(result.attempts)) throw new AgentProfileError("experiment_invalid_result");
    return { ...result, durationMs } as unknown as ExperimentExecutionResult;
  } finally { try { await writes; } finally { await log.close(); } }
}
