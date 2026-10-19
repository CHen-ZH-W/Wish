import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { fail } from "../validation.js";
import type {} from "../../apps/cli/commands.js";

export default {
  name: "candidate-cli", inject: ["candidates", "launch"],
  apply(ctx: Context) {
    const retirement = new AbortController();
    const owner = new PluginWorkOwner(ctx, { code: "candidate_cli", codeReload: true, beforeDrain: () => retirement.abort() });
    ctx.on("cli/command", (argv, terminal, signal) => {
      if (argv[0] !== "candidate") return undefined;
      return owner.run(async () => {
        const controller = new AbortController(), combined = AbortSignal.any([signal, retirement.signal, controller.signal]);
        const remove = ctx.launch.onSignal(() => controller.abort());
        const json = async (name: string | undefined): Promise<unknown> => {
          if (!name) fail("candidate_json_file_required");
          const raw = await readFile(resolve(ctx.launch.cwd, name));
          if (raw.byteLength > 8 * 1024 * 1024) fail("candidate_file_limit");
          return JSON.parse(raw.toString("utf8"));
        };
        let result: unknown;
        try {
          if (argv[1] === "submit" && argv.length === 3) result = await ctx.candidates.submit(await json(argv[2]));
          else if (argv[1] === "list" && argv.length === 2) result = await ctx.candidates.list();
          else if (argv[1] === "history" && argv.length === 2) result = await ctx.candidates.history();
          else if (argv[1] === "reconcile" && argv.length === 3) result = await ctx.candidates.reconcile(argv[2]!);
          else if (argv[1] === "validate" && argv.length === 3) result = await ctx.candidates.validate(await json(argv[2]), combined);
          else if (argv[1] === "evaluate" && argv.length === 3) result = await ctx.candidates.evaluate(await json(argv[2]), combined);
          else if (argv[1] === "review" && argv.length === 3) result = await ctx.candidates.prepareReview(await json(argv[2]));
          else if (argv[1] === "promote" && argv.length === 5 && argv[3] === "--approve") result = await ctx.candidates.promote(await json(argv[2]), argv[4]!, combined);
          else if (argv[1] === "rollback" && argv.length === 5 && argv[3] === "--approve") result = await ctx.candidates.rollback(argv[2]!, argv[4]!, combined);
          else throw new Error("Usage: wish candidate submit <source.json> | list | history | validate <request.json> | evaluate <request.json> | review <request.json> | promote <review.json> --approve <review-digest> | rollback <promotion-id> --approve <review-digest> | reconcile <promotion-id>");
          await terminal.writeOutput(`${JSON.stringify(result, null, 2)}\n`);
          const status = (result as { status?: string }).status ?? (result as { experiment?: { status: string } }).experiment?.status;
          return combined.aborted ? 130 : status && ["failed", "cancelled", "interrupted", "rejected", "recovery-required"].includes(status) ? 1 : 0;
        } finally { remove(); }
      });
    });
  },
};
