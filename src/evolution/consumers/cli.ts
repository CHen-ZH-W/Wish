import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { EvolutionCampaignSpec } from "../types.js";
import type {} from "../service.js";
import type {} from "../../apps/cli/commands.js";
const USAGE = 'Usage: wish evolution begin "objective" [prompt|skill|tool|plugin] [structured|runtime] | create <spec.json> <request-id> | list | traces | show <id> | run <id> | continue <id> <revision> "feedback" | pause|cancel|resume|recover <id> <revision> | experiences | genes | skill-usage <package-digest> | experience-record <file.json> | experience-review <digest> accepted|rejected "reason" | gene-propose <file.json> <profile-digest>';

/** Local operator entrypoint. No model-visible publication capability. */
export default { name: "evolution-cli", inject: ["evolution", "launch"], apply(ctx: Context): void {
  const work = new PluginWorkOwner(ctx, { code: "evolution_cli", codeReload: true, busy: "blocked" });
  ctx.on("cli/command", (argv, terminal, signal) => {
    if (argv[0] !== "evolution") return undefined;
    return work.run(async () => {
      signal.throwIfAborted();
      if (argv.length === 1 || ["--help", "help"].includes(argv[1]!)) { await terminal.writeOutput(`${USAGE}\n`); return 0; }
      const print = async (value: unknown) => terminal.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
      const readJson = async (filename: string) => {
        const bytes = await readFile(resolve(ctx.launch.cwd, filename)); if (bytes.byteLength > 256 * 1024) throw new Error("evolution_input_limit"); return JSON.parse(bytes.toString("utf8"));
      };
      if (argv[1] === "list" && argv.length === 2) { await print(await ctx.evolution.list()); return 0; }
      if (argv[1] === "traces" && argv.length === 2) { await print(await ctx.evolution.traces()); return 0; }
      if (argv[1] === "show" && argv.length === 3) { await print(await ctx.evolution.get(argv[2]!)); return 0; }
      if (argv[1] === "experiences" && argv.length === 2) { await print(await ctx.evolution.experiences(ctx.launch.cwd)); return 0; }
      if (argv[1] === "genes" && argv.length === 2) { await print(await ctx.evolution.strategyGenes(ctx.launch.cwd)); return 0; }
      if (argv[1] === "skill-usage" && argv.length === 3) { await print(await ctx.evolution.skillUsageSummary(argv[2]!)); return 0; }
      if (argv[1] === "experience-record" && argv.length === 3) { await print(await ctx.evolution.recordExperience({ ...await readJson(argv[2]!), scope: ctx.launch.cwd })); return 0; }
      if (argv[1] === "experience-review" && argv.length === 5) {
        if (!["accepted", "rejected"].includes(argv[3]!)) throw new Error("evolution_invalid_review");
        await print(await ctx.evolution.reviewExperience({ subjectDigest: argv[2]!, decision: argv[3] as "accepted" | "rejected", actorId: "cli-operator", reason: argv[4]! })); return 0;
      }
      if (argv[1] === "gene-propose" && argv.length === 4) { await print(await ctx.evolution.proposeStrategyGene({ ...await readJson(argv[2]!), scope: ctx.launch.cwd }, argv[3]!)); return 0; }
      if (argv[1] === "begin" && argv.length >= 3 && argv.length <= 5) {
        if (argv[3] && !["prompt", "skill", "tool", "plugin", "workflow"].includes(argv[3]) || argv[4] && !["structured", "runtime"].includes(argv[4])) throw new Error("evolution_invalid_begin_options");
        const campaign = await ctx.evolution.begin({ objective: argv[2]!, requestId: crypto.randomUUID(), workspaceRoot: ctx.launch.cwd,
          ...(argv[3] ? { target: argv[3] as import("../types.js").EvolutionTarget } : {}), ...(argv[4] ? { generator: argv[4] as "structured" | "runtime" } : {}) });
        const remove = ctx.launch.onSignal(() => { void ctx.evolution.controller.pause(campaign.id).catch(() => {}); });
        try { const result = await ctx.evolution.waitFor(campaign.id); await print(result); return result.state === "failed" ? 1 : 0; }
        finally { remove(); }
      }
      if (argv[1] === "create" && argv.length === 4) {
        await print(await ctx.evolution.create(await readJson(argv[2]!) as EvolutionCampaignSpec, argv[3]!)); return 0;
      }
      if (argv[1] === "run" && argv.length === 3) {
        const cancel = () => { void ctx.evolution.controller.pause(argv[2]!).catch(() => {}); };
        const remove = ctx.launch.onSignal(cancel); signal.addEventListener("abort", cancel, { once: true });
        try { const result = await ctx.evolution.controller.run(argv[2]!, { signal }); await print(result); return ["failed", "cancelled", "reconciliation-required"].includes(result.state) ? 1 : 0; }
        finally { remove(); signal.removeEventListener("abort", cancel); }
      }
      if (argv[1] === "continue" && argv.length === 5) {
        const campaign = await ctx.evolution.continue(argv[2]!, { expectedRevision: Number(argv[3]), requestId: crypto.randomUUID(), feedback: argv[4]! });
        const remove = ctx.launch.onSignal(() => { void ctx.evolution.controller.pause(campaign.id).catch(() => {}); });
        try { const result = await ctx.evolution.waitFor(campaign.id); await print(result); return result.state === "failed" ? 1 : 0; }
        finally { remove(); }
      }
      if (["pause", "cancel", "resume", "recover"].includes(argv[1] ?? "") && argv.length === 4) {
        const result = await ctx.evolution.control(argv[2]!, argv[1] as "pause" | "cancel" | "resume" | "recover", Number(argv[3]));
        if (["resume", "recover"].includes(argv[1]!) && result.state === "waiting-input") {
          const remove = ctx.launch.onSignal(() => { void ctx.evolution.controller.pause(result.id).catch(() => {}); });
          try { await print(await ctx.evolution.waitFor(result.id)); } finally { remove(); }
        } else await print(result);
        return 0;
      }
      throw new Error(USAGE);
    });
  });
} };
