import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../boot/bootstrap.js";
import { canonical, record, validateSnapshot } from "../agent-profiles/validation.js";
import { validateDataset } from "./validation.js";

/** Internal executor entry: a complete Loader composition, with private storage and seeded workspace. */
async function run(requestPath: string): Promise<void> {
  const request = record(JSON.parse(await readFile(requestPath, "utf8")));
  const snapshot = validateSnapshot(request.snapshot);
  const testCase = validateDataset({ schemaVersion: 1, id: "worker", version: 1, cases: [request.testCase] }).cases[0]!;
  const directory = dirname(requestPath), workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: false });
  for (const [path, text] of Object.entries(testCase.files)) {
    const filename = join(workspace, path); await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, text, { flag: "wx", mode: 0o600 });
  }
  let booted: Awaited<ReturnType<typeof bootstrap>> | undefined;
  const stopOrphan = () => {
    const kill = () => {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL");
      else process.exit(1);
    };
    // IPC closure also happens when the experiment Host is killed without teardown.
    setTimeout(kill, 1_000);
    void booted?.dispose().then(kill, kill);
  };
  if (process.send) process.once("disconnect", stopOrphan);
  try {
    booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: workspace, homeDirectory: join(directory, "home"), configurationFile: join(directory, "cordis.json"),
      environment: { ...process.env, WISH_EXPERIMENT_WORKER: "1", WISH_AGENT_PROFILE: "", WISH_DATA_DIR: join(directory, "data") },
    });
    const ctx = booted.surfaceContext;
    const profiles = ctx.get("agentProfiles"), applicationService = ctx.get("application"), ledger = ctx.get("modelAttemptLedger");
    if (!profiles || !applicationService || !ledger) throw new Error("Experiment composition is incomplete");
    await profiles.importSnapshot(snapshot);
    const application = await applicationService.open({ agentProfile: snapshot.digest, dataDirectory: join(directory, "data"), maxRunSteps: Number(request.maxSteps) });
    const session = await application.createSession({ workspaceRoot: workspace });
    const handle = await application.startRun({ sessionId: session.sessionId, inputSource: "continuation", payload: { text: testCase.prompt } });
    const completion = await handle.completion;
    const history = await application.readSessionHistory({ sessionId: session.sessionId });
    const output = history.records.filter(item => item.kind === "message" && item.message.role === "assistant").map(item => item.kind === "message" ? item.message.content : "").at(-1) ?? "";
    let assertionPassed: boolean | undefined;
    if (testCase.assertion.kind === "file-equals") {
      try {
        const filename = await realpath(join(workspace, testCase.assertion.path));
        const fromWorkspace = relative(workspace, filename);
        assertionPassed = fromWorkspace !== ".." && !fromWorkspace.startsWith("../") && !isAbsolute(fromWorkspace) && await readFile(filename, "utf8") === testCase.assertion.expected;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; assertionPassed = false; }
    }
    const result = { status: completion.status, output, sessionId: session.sessionId, runId: handle.runId,
      attempts: await ledger.list({ runId: handle.runId }),
      ...(assertionPassed === undefined ? {} : { assertionPassed }),
      ...(completion.status === "failed" ? { error: completion.snapshot.error?.message ?? "run_failed" } : {}),
    };
    await writeFile(join(directory, "result.json"), canonical(result), { mode: 0o600, flag: "wx" });
    await application.runGeneration?.retire();
  } finally {
    await booted?.dispose();
    process.removeListener("disconnect", stopOrphan);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!process.argv[2]) throw new Error("Missing experiment request"); await run(resolve(process.argv[2])); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; }
}
