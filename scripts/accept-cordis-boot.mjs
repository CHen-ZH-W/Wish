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
    assert.equal(application.context.launch.surface, "cli");
    assert.deepEqual(application.context.launch.argv, ["fixture"]);
    assert.equal(application.context.launch.configurationSource, "option");
    assert.equal(application.context.launch.configurationFile, join(directory, "cordis.yml"));
    assert.notEqual(application.context.get("loader"), undefined);
    const include = application.context.loader.resolve("include");
    const selected = application.context.loader.resolve("include:cli");
    const disabled = application.context.loader.resolve("include:webui");
    const selectedFiber = selected.fiber;
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
  const result = await execFileAsync(
    process.execPath,
    [join(repositoryRoot, "dist/apps/cli/main.js"), "--version"],
    {
      cwd: repositoryRoot,
      env: cleanWishEnvironment(),
      timeout: 10_000,
    },
  );
  assert.equal(result.stdout, "wish 0.1.0\n");
  assert.equal(result.stderr, "");
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
      () => stderr.includes(`Wish WebUI API listening at http://127.0.0.1:${port}`),
      () => `WebUI did not start through Cordis:\n${stderr}`,
    );
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Wish<\/title>/u);

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await withTimeout(exited, 10_000, "WebUI did not stop after SIGTERM");
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    assert.match(stderr, /Wish WebUI API stopping after SIGTERM/u);
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
    if (predicate()) return;
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
