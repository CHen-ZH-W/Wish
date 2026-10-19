import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bootstrap } from "../../dist/boot/bootstrap.js";

const directory = process.argv[2];
const booted = await bootstrap({ surface: "cli", argv: ["--version"], cwd: directory, homeDirectory: directory,
  environment: { WISH_DATA_DIR: join(directory, "data"), WISH_EXPERIMENTS_DIR: join(directory, "jobs"), WISH_PERMISSION_PROFILE: "workspace-write", CORDIS_HMR: "0" },
});
const ctx = booted.surfaceContext, profiles = ctx.get("agentProfiles"), experiments = ctx.get("experiments");
const host = await ctx.get("application").resolve();
await profiles.register({ schemaVersion: 1, id: "crash", version: 1, model: `${host.models.defaultModel.provider}/${host.models.defaultModel.model}`, tools: ["read"], permissionProfile: "read-only", memory: "none" });
const snapshot = await profiles.capture("crash@1", host);
await profiles.bind(snapshot.digest, "crash-session", "crash-run");
const dataset = await experiments.registerDataset({ schemaVersion: 1, id: "crash", version: 1, cases: [{ id: "case", prompt: "hi", files: {}, assertion: { kind: "exact", expected: "A" } }] });
await booted.context.loader.resolve("include:experiment-process").update({ disabled: true });
experiments.registerExecutor({ async execute() { await new Promise(() => {}); } });
const job = await experiments.start({ datasetDigest: dataset.digest, variants: [{ label: "base", snapshotDigest: snapshot.digest }], baseline: "base", repetitions: 1, timeoutMs: 10_000, maxSteps: 2 }, "crash-experiment");
await writeFile(join(directory, "ready.json"), JSON.stringify({ experimentId: job.id }));
setInterval(() => {}, 1_000);
