import { build } from "esbuild";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

// Composition metadata only; implementations stay in their owning modules.
const modules = [
  ["skills", "SkillsClientUi", ["include:skills-local", "include:skills-session-feature"]],
  ["models", "ModelsClientUi", ["include:models"]],
  ["plan", "PlanClientUi", ["include:plan-session-feature"]],
  ["todo", "TodoClientUi", ["include:todo-session-feature"]],
  ["goal", "GoalClientUi", ["include:goal-session-feature"]],
  ["tasks", "TasksClientUi", ["include:tasks-session-feature"]],
  ["memory", "MemoryClientUi", ["include:memory-session-feature"]],
  ["workflow", "WorkflowClientUi", ["include:workflow-session-feature"]],
  ["approval", "ApprovalClientUi", ["include:webui"]],
  ["context", "ContextClientUi", ["include:context-session-feature"]],
  ["subagents", "SubagentsClientUi", ["include:subagents-session-feature"]],
  ["tmux", "TmuxClientUi", ["include:tmux-session-feature"]],
  ["shell", "ShellClientUi", ["include:tool-bash"]],
  ["filesystem", "ReadClientUi", ["include:tool-read"]],
  ["filesystem", "WriteClientUi", ["include:tool-write"]],
  ["filesystem", "EditClientUi", ["include:tool-edit"]],
  ["filesystem", "SearchClientUi", ["include:tool-grep"]],
].map(([owner, exportName, entryIds]) => ({ id: exportName, file: `src/${owner}/consumers/webui/index.tsx`, exportName, entryIds }));
const outdir = resolve("dist/apps/webui/public");
const entryPoints = { "core/client": "src/apps/webui/client/main.tsx" };
for (const item of modules) entryPoints[`modules/${item.id}`] = item.file;
const css = await readFile("src/apps/webui/public/app.css", "utf8");
const shellRevision = createHash("sha256").update(css).digest("hex");
// One build graph means one React/Cordis runtime. A shared/core change changes the
// core URL; an open browser refuses to mix it with its already-loaded runtime.
const result = await build({ entryPoints, outdir, entryNames: "[dir]/[name]-[hash]", chunkNames: "chunks/[name]-[hash]",
  bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
  minify: true, sourcemap: false, metafile: true, write: false,
  banner: { js: `/* Wish shared stylesheet: ${shellRevision} */` },
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "info" });
const entryUrl = (prefix) => {
  const output = result.outputFiles.find(file => relative(outdir, file.path).startsWith(`${prefix}-`));
  if (!output) throw Error(`Missing UI output: ${prefix}`);
  return `/assets/${relative(outdir, output.path).replaceAll("\\", "/")}`;
};
// A failed compilation never publishes a new manifest. Keep old immutable assets
// for open pages; do not clean this directory during an in-process deployment.
for (const output of result.outputFiles) {
  await mkdir(dirname(output.path), { recursive: true });
  await writeFile(output.path, output.contents, { flag: "wx" }).catch(async error => {
    if (error.code !== "EEXIST" || !(await readFile(output.path)).equals(Buffer.from(output.contents))) throw error;
  });
}
const manifest = { schemaVersion: 1, core: entryUrl("core/client"), modules: modules.map(({ file, ...item }) => ({ ...item, url: entryUrl(`modules/${item.id}`) })) };
for (const [name, content] of [["app.css", css], ["client.js", `import ${JSON.stringify(manifest.core)};\n`], ["ui-modules.json", JSON.stringify(manifest)]]) {
  const temporary = resolve(outdir, `${name}.${process.pid}.tmp`);
  await writeFile(temporary, content); await rename(temporary, resolve(outdir, name));
}
