import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap, BootstrapError } from "../dist/boot/bootstrap.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ active: 2, disposed: 4 });

test("the CLI and WebUI bins delegate process composition only to bootstrap", async () => {
  const [cliMain, webUiMain, bootstrapSource, cliPlugin, webUiPlugin, composition] = await Promise.all([
    readFile(join(repositoryRoot, "src/apps/cli/main.ts"), "utf8"),
    readFile(join(repositoryRoot, "src/apps/webui/main.ts"), "utf8"),
    readFile(join(repositoryRoot, "src/boot/bootstrap.ts"), "utf8"),
    readFile(join(repositoryRoot, "src/apps/cli/plugin.ts"), "utf8"),
    readFile(join(repositoryRoot, "src/apps/webui/plugin.ts"), "utf8"),
    readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
  ]);

  for (const source of [cliMain, webUiMain]) {
    assert.match(source, /import \{ bootstrap \} from "\.\.\/\.\.\/boot\/bootstrap\.js"/u);
    assert.match(source, /await bootstrap\(/u);
    assert.doesNotMatch(
      source,
      /createWishApplication|createWishHostApplication|createWishCli|startWishWebUiServer/u,
    );
  }
  assert.match(webUiMain, /management: managedWebUi\(/u);
  assert.doesNotMatch(webUiMain, /WISH_WEBUI_NEXT/u);
  assert.doesNotMatch(
    bootstrapSource,
    /createWishApplication|createWishHostApplication|createWishCli|startWishWebUiServer/u,
  );
  for (const source of [cliPlugin, webUiPlugin]) {
    assert.match(source, /launch\.onSignal/u);
    assert.doesNotMatch(source, /process\.(?:on|off)\(/u);
  }
  assert.match(composition, /id: timer[\s\S]*name: 'cordis:timer'/u);
  assert.match(composition, /id: hmr[\s\S]*name: 'cordis:hmr'/u);
  assert.match(composition, /id: app[\s\S]*name: 'cordis:group'[\s\S]*group: true/u);
  assert.match(
    composition,
    /id: workspace-local[\s\S]*name: 'cordis:workspace-local'/u,
  );
  assert.match(
    composition,
    /id: filesystem-local[\s\S]*name: 'cordis:filesystem-local'/u,
  );
  assert.match(
    composition,
    /id: filesystem-search-local[\s\S]*name: 'cordis:filesystem-search-local'/u,
  );
  assert.match(
    composition,
    /id: tool-output-artifacts[\s\S]*name: 'cordis:tool-output-artifacts-blob'/u,
  );
  assert.match(
    composition,
    /id: shell-linux-native[\s\S]*name: 'cordis:shell-linux-native'/u,
  );
  assert.match(
    composition,
    /id: tmux-local[\s\S]*name: 'cordis:tmux-local'/u,
  );
  assert.match(
    composition,
    /id: subagent-execution-tmux[\s\S]*name: 'cordis:subagent-execution-tmux'/u,
  );
  assert.match(
    composition,
    /id: subagents-runtime[\s\S]*name: 'cordis:subagents-runtime'/u,
  );
  assert.match(
    composition,
    /id: tool-subagents[\s\S]*name: 'cordis:subagent-tools'/u,
  );
  assert.match(composition, /id: plan-storage[\s\S]*name: 'cordis:plan-storage'/u);
  assert.match(
    composition,
    /id: coordinator-storage[\s\S]*name: 'cordis:coordinator-storage'/u,
  );
  assert.match(composition, /id: tool-plan[\s\S]*name: 'cordis:plan-tools'/u);
  assert.match(
    composition,
    /id: tool-coordinator[\s\S]*name: 'cordis:coordinator-tools'/u,
  );
  assert.match(composition, /WISH_TMUX_ENABLED === '0'/u);
  assert.match(composition, /WISH_SUBAGENTS_ENABLED === '0'/u);
  assert.match(composition, /WISH_SUBAGENT_TOOLS_ENABLED === '0'/u);
  assert.match(composition, /WISH_PLAN_ENABLED === '0'/u);
  assert.match(composition, /WISH_COORDINATOR_ENABLED === '0'/u);
  assert.match(composition, /id: storage[\s\S]*name: 'cordis:storage'/u);
  assert.match(
    composition,
    /id: storage-file[\s\S]*name: 'cordis:storage-file'/u,
  );
  assert.match(
    composition,
    /id: runtime-lifecycle-journal[\s\S]*name: 'cordis:runtime-lifecycle-journal'/u,
  );
  assert.match(composition, /id: cli[\s\S]*name: 'cordis:cli'/u);
  assert.match(composition, /id: webui[\s\S]*name: 'cordis:webui'/u);
  assert.match(composition, /disabled: !!js launch\.surface !== 'cli'/u);
  assert.match(composition, /disabled: !!js launch\.surface !== 'webui'/u);
});

test("bootstrap owns one Root, Loader, Include, selected surface, and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g1-root-"));
  const events = [];
  globalThis.__wishCordisG1Events = events;
  let application;
  const signalListenersBefore = process.listenerCount("SIGINT");

  try {
    await writeFile(
      join(directory, "surface.mjs"),
      `export const inject = ["launch"];
export function apply(ctx) {
  globalThis.__wishCordisG1Events.push("apply:" + ctx.launch.surface);
  ctx.effect(() => () => globalThis.__wishCordisG1Events.push("dispose:surface"));
  ctx.launch.complete(23);
}
`,
    );
    await writeFile(
      join(directory, "cordis.yml"),
      `- id: cli
  name: './surface.mjs'
- id: webui
  name: './surface.mjs'
  disabled: true
`,
    );

    application = await bootstrap({
      surface: "cli",
      argv: ["fixture"],
      cwd: directory,
      homeDirectory: directory,
      environment: { CORDIS_CONFIG: join(directory, "not-selected.yml") },
      configurationFile: join(directory, "cordis.yml"),
    });

    assert.equal(Context.is(application.context), true);
    assert.equal(application.context.root, application.context);
    assert.equal(Context.is(application.surfaceContext), true);
    assert.equal(application.surfaceContext.root, application.context);
    assert.equal(application.context.launch.surface, "cli");
    assert.deepEqual(application.context.launch.argv, ["fixture"]);
    assert.equal(application.context.launch.configurationSource, "option");
    assert.equal(application.context.launch.configurationFile, join(directory, "cordis.yml"));
    assert.notEqual(application.context.get("loader"), undefined);
    const include = application.context.loader.resolve("include");
    const selected = application.context.loader.resolve("include:cli");
    const disabled = application.context.loader.resolve("include:webui");
    const selectedFiber = selected.fiber;
    assert.equal(application.surfaceContext, selected.ctx);
    assert.equal(include.fiber.state, fiberState.active);
    assert.equal(selected.fiber.state, fiberState.active);
    assert.equal(disabled.disabled, true);
    assert.equal(disabled.fiber, undefined);
    assert.equal(application.context.loader.locate(selected.fiber), selected.id);
    assert.equal(process.listenerCount("SIGINT"), signalListenersBefore + 1);
    assert.equal(await application.completion, 23);
    assert.deepEqual(events, ["apply:cli"]);

    await application.dispose();
    assert.equal(application.context.get("loader"), undefined);
    assert.equal(application.context.get("launch"), undefined);
    assert.deepEqual(application.context.fiber.getEffects(), []);
    assert.equal(selected.fiber, undefined);
    assert.equal(selectedFiber.state, fiberState.disposed);
    assert.deepEqual(selectedFiber.getEffects(), []);
    assert.equal(process.listenerCount("SIGINT"), signalListenersBefore);
    assert.deepEqual(events, ["apply:cli", "dispose:surface"]);
  } finally {
    await application?.dispose();
    delete globalThis.__wishCordisG1Events;
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap rejects a permanently pending surface and cleans partial effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g1-failure-"));
  const events = [];
  globalThis.__wishCordisG1Events = events;

  try {
    await writeFile(
      join(directory, "probe.mjs"),
      `export function apply(ctx) {
  globalThis.__wishCordisG1Events.push("apply:probe");
  ctx.effect(() => () => globalThis.__wishCordisG1Events.push("dispose:probe"));
}
`,
    );
    await writeFile(
      join(directory, "pending.mjs"),
      `export const inject = ["missingWishService"];
export function apply() {
  globalThis.__wishCordisG1Events.push("unexpected:pending-activated");
}
`,
    );
    await writeFile(
      join(directory, "cordis.yml"),
      `- id: cleanup-probe
  name: './probe.mjs'
- id: cli
  name: './pending.mjs'
- id: webui
  name: './pending.mjs'
  disabled: true
`,
    );

    await assert.rejects(
      bootstrap({
        surface: "cli",
        cwd: directory,
        homeDirectory: directory,
        environment: {},
        configurationFile: join(directory, "cordis.yml"),
      }),
      (error) =>
        error instanceof BootstrapError &&
        /pending \(waiting for missingWishService\)/u.test(error.message),
    );
    assert.deepEqual(events, ["apply:probe", "dispose:probe"]);
  } finally {
    delete globalThis.__wishCordisG1Events;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the built CLI reaches its Loader-managed production surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g1-cli-"));
  try {
    const environment = cleanWishEnvironment();
    environment.WISH_DATA_DIR = join(directory, "data");
    const result = await execFileAsync(
      process.execPath,
      [join(repositoryRoot, "dist/apps/cli/main.js"), "--version"],
      {
        cwd: repositoryRoot,
        env: environment,
        timeout: 10_000,
      },
    );
    assert.equal(result.stdout, "wish 0.1.0\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the built WebUI is Loader-managed and Root disposal closes the process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-cordis-g1-webui-"));
  const port = await reservePort();
  const environment = cleanWishEnvironment();
  environment.WISH_DATA_DIR = join(directory, "data");
  environment.WISH_WEBUI_WORKSPACE_ROOT = directory;
  environment.WISH_WEBUI_HOST = "127.0.0.1";
  environment.WISH_WEBUI_PORT = String(port);
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "dist/apps/webui/main.js")],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");

  try {
    await waitFor(
      () => stderr.includes(`Wish management listening at http://127.0.0.1:${port}`),
      () => `WebUI did not start through Cordis:\n${stderr}`,
    );
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /id="wish-root"/u);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/u);
    const base = `http://127.0.0.1:${port}`;
    const bootstrapView = await (await fetch(`${base}/api/management/bootstrap`)).json();
    assert.match(bootstrapView.token, /^[a-f0-9]{64}$/u);
    await waitFor(async () => (await fetch(`${base}/api/health`)).status === 200,
      () => `business routes did not activate:\n${stderr}`);
    for (const path of ["/legacy", "/next", "/assets/app.js", "/assets/next.css"]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    const script = await fetch(`${base}/assets/client.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /text\/javascript/u);
    const css = await fetch(`${base}/assets/app.css`, { method: "HEAD" });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/u);
    assert.equal((await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    const created = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Wish-Management-Token": bootstrapView.token }, body: "{}" });
    assert.equal(created.status, 201);

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await withTimeout(exited, 10_000, "WebUI did not stop after SIGTERM");
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    await assert.rejects(fetch(`${base}/api/management/bootstrap`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

function cleanWishEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("WISH_")) delete environment[name];
  }
  return environment;
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message());
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
