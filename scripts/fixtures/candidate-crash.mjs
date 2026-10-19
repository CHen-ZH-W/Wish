import { writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, base, source, validation } from "./candidates.mjs";
const directory = process.argv[2], host = await boot(directory), ctx = host.surfaceContext;
const snapshot = await base(ctx), candidate = source();
candidate.files["index.test.ts"] = "import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('pending',async()=>{writeFileSync(process.env.TMPDIR+'/child-pid',String(process.pid));await new Promise(()=>{setInterval(()=>{},1000);});});";
const submitted = await ctx.get("candidates").submit(candidate);
const completion = ctx.get("candidates").validate(validation(submitted.digest, snapshot));
void completion.catch(() => {});
const started = Date.now();
while (Date.now() - started < 30_000) {
  const history = await ctx.get("candidates").history(), check = history.validations[0];
  if (check) try {
    const pid = Number(await readFile(join(directory, "candidates", "jobs", check.id, "check", "scratch", "child-pid"), "utf8"));
    await writeFile(join(directory, "ready.json"), JSON.stringify({ pid, validationId: check.id })); break;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await new Promise(accept => setTimeout(accept, 25));
}
setInterval(() => {}, 1000);
