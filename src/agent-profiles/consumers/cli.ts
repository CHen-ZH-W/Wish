import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { AgentProfileError } from "../validation.js";
import type {} from "../../apps/cli/commands.js";

export default {
  name: "agent-profile-cli", inject: ["launch"],
  apply(ctx: Context) {
    const retirement = new AbortController();
    const work = new PluginWorkOwner(ctx, { code: "agent_profile_cli", codeReload: true, beforeDrain: () => retirement.abort() });
    ctx.on("cli/command", (argv, terminal, signal) => {
      if (argv[0] !== "profile" && argv[0] !== "experiment") return undefined;
      return work.run(async () => {
        const profiles = ctx.get("agentProfiles"), experiments = ctx.get("experiments");
        if (!profiles || !experiments) throw new AgentProfileError("profile_services_unavailable");
        const print = async (value: unknown) => { await terminal.writeOutput(`${JSON.stringify(value, null, 2)}\n`); };
        const json = async (filename: string | undefined): Promise<unknown> => {
          if (!filename) throw new Error("Missing JSON file argument");
          const bytes = await readFile(resolve(ctx.launch.cwd, filename));
          if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("JSON input is too large");
          return JSON.parse(bytes.toString("utf8"));
        };
        if (argv[0] === "profile") {
          if (argv[1] === "register" && argv.length === 3) await print(await profiles.register(await json(argv[2])));
          else if (argv[1] === "list" && argv.length === 2) await print(await profiles.list());
          else if (argv[1] === "capture" && argv.length === 3) {
            const application = ctx.get("application"); if (!application) throw new Error("Application unavailable");
            await print(await profiles.capture(argv[2]!, await application.resolve()));
          } else if (argv[1] === "inspect" && argv.length === 3) await print(await profiles.get(argv[2]!));
          else if (argv[1] === "bindings" && argv.length === 2) await print(await profiles.listBindings());
          else throw new Error("Usage: wish profile register <file.json> | list | capture <id@version> | inspect <digest> | bindings");
          return 0;
        }
        if (argv[1] === "dataset" && argv.length === 3) { await print(await experiments.registerDataset(await json(argv[2]))); return 0; }
        if (argv[1] === "datasets" && argv.length === 2) { await print(await experiments.listDatasets()); return 0; }
        if (argv[1] === "list" && argv.length === 2) { await print(await experiments.list()); return 0; }
        if (argv[1] === "show" && argv.length === 3) { await print(await experiments.get(argv[2]!)); return 0; }
        if (argv[1] !== "run" || argv.length !== 3) throw new Error("Usage: wish experiment dataset <file.json> | datasets | run <plan.json> | list | show <id>");
        const job = await experiments.start(await json(argv[2]));
        await terminal.writeError(`Experiment ${job.id}\n`);
        const cancel = () => { void experiments.cancel(job.id).catch(error => ctx.launch.fail(error)); };
        const cancelled = AbortSignal.any([signal, retirement.signal]);
        cancelled.addEventListener("abort", cancel, { once: true });
        const removeSignal = ctx.launch.onSignal(cancel);
        if (cancelled.aborted) cancel();
        try { const result = await job.completion; await print(result); return result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1; }
        finally { removeSignal(); cancelled.removeEventListener("abort", cancel); }
      });
    });
  },
};
