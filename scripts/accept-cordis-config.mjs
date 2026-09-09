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

import { bootstrap } from "../dist/boot/bootstrap.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

test("configuration option overrides CORDIS_CONFIG and paths resolve from launch cwd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-config-source-"));
  globalThis.__cordisConfigEvents = [];

  try {
    await writeFile(
      join(directory, "surface.mjs"),
      `export const inject = ["launch"];
export function apply(ctx, config) {
  globalThis.__cordisConfigEvents.push(config.label);
  ctx.launch.complete(config.code);
}
`,
    );
    await writeFile(join(directory, "environment.yml"), profileForSource("environment", 31));
    await writeFile(join(directory, "option.yml"), profileForSource("option", 32));

    const fromEnvironment = await bootstrap({
      surface: "cli",
      cwd: directory,
      homeDirectory: directory,
      environment: { CORDIS_CONFIG: "environment.yml" },
    });
    assert.equal(fromEnvironment.context.launch.configurationSource, "environment");
    assert.equal(
      fromEnvironment.context.launch.configurationFile,
      join(directory, "environment.yml"),
    );
    assert.equal(await fromEnvironment.completion, 31);
    await fromEnvironment.dispose();

    const fromOption = await bootstrap({
      surface: "cli",
      cwd: directory,
      homeDirectory: directory,
      environment: { CORDIS_CONFIG: "environment.yml" },
      configurationFile: "option.yml",
    });
    assert.equal(fromOption.context.launch.configurationSource, "option");
    assert.equal(fromOption.context.launch.configurationFile, join(directory, "option.yml"));
    assert.equal(await fromOption.completion, 32);
    await fromOption.dispose();

    assert.deepEqual(globalThis.__cordisConfigEvents, ["environment", "option"]);
    await assert.rejects(
      bootstrap({
        surface: "cli",
        cwd: directory,
        environment: { CORDIS_CONFIG: " " },
      }),
      /CORDIS_CONFIG must be a non-empty trimmed path/u,
    );
  } finally {
    delete globalThis.__cordisConfigEvents;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the built-in profile can enable and dispose HMR for a one-shot CLI", async () => {
  const environment = cleanEnvironment();
  environment.CORDIS_HMR = "1";
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
});

test("a built WebUI process applies and rolls back external profile updates", async () => {
  // Keep the fixture below the repository so its ESM plugin can resolve the
  // pinned Schemastery package from this project's node_modules.
  const directory = await mkdtemp(join(repositoryRoot, "cordis-config-live-"));
  const eventFile = join(directory, "events.log");
  const configurationFile = join(directory, "cordis.yml");
  const port = await reservePort();
  await writeFile(join(directory, "probe.mjs"), liveProbeModule());
  await writeFile(configurationFile, liveProfile({ eventFile, label: "v1" }));

  const environment = cleanEnvironment();
  environment.CORDIS_CONFIG = configurationFile;
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
      async () =>
        stderr.includes(`Wish WebUI API listening at http://127.0.0.1:${port}`) &&
        (await readEvents(eventFile)).includes("apply:v1"),
      () => `external profile did not boot:\n${stderr}`,
    );
    await assertHealthy(port);

    await writeFile(configurationFile, liveProfile({ eventFile, label: "v2" }));
    await waitFor(
      async () => {
        const events = await readEvents(eventFile);
        return events.includes("dispose:v1") && events.includes("apply:v2");
      },
      () => "valid profile update did not replace the probe",
    );
    // The plugin activation marker is written from inside the transactional
    // update. Wait past chokidar's coalescing window before the next edit so
    // this test exercises two distinct configuration generations.
    await delay(150);

    await writeFile(
      configurationFile,
      liveProfile({ eventFile, label: 42 }),
    );
    await waitFor(
      async () => (await readEvents(eventFile)).includes("config-failed"),
      async () =>
        `invalid profile update was not reported; events=${JSON.stringify(
          await readEvents(eventFile),
        )}; stderr=${stderr}`,
    );
    assert.match(stderr, /Cordis config reload failed at .*cordis\.yml:/u);
    await assertHealthy(port);
    await delay(150);

    const beforeDisable = count(await readEvents(eventFile), "dispose:v2");
    await writeFile(
      configurationFile,
      liveProfile({ eventFile, label: "v2", disabled: true }),
    );
    await waitFor(
      async () => count(await readEvents(eventFile), "dispose:v2") > beforeDisable,
      async () =>
        `disabled profile row did not dispose the probe; events=${JSON.stringify(
          await readEvents(eventFile),
        )}; stderr=${stderr}`,
    );
    await assertHealthy(port);
    await delay(150);

    await writeFile(configurationFile, liveProfile({ eventFile, label: "v3" }));
    await waitFor(
      async () => (await readEvents(eventFile)).includes("apply:v3"),
      () => "re-enabled profile row did not activate the probe",
    );

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await withTimeout(exited, 10_000, "WebUI did not stop after SIGTERM");
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(stdout, "");
    await waitFor(
      async () => (await readEvents(eventFile)).includes("dispose:v3"),
      () => "Root disposal did not clean the final probe generation",
    );
    assert.deepEqual(await readEvents(eventFile), [
      "apply:v1",
      "dispose:v1",
      "apply:v2",
      "dispose:v2",
      "apply:v2",
      "config-failed",
      "dispose:v2",
      "apply:v3",
      "dispose:v3",
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

function profileForSource(label, code) {
  return `- id: app
  name: 'cordis:group'
  group: true
  config:
    - id: cli
      name: './surface.mjs'
      config:
        label: ${JSON.stringify(label)}
        code: ${code}
    - id: webui
      name: './surface.mjs'
      disabled: true
`;
}

function liveProfile({ eventFile, label, disabled = false }) {
  return `- id: timer
  name: 'cordis:timer'

- id: hmr
  name: 'cordis:hmr'
  config:
    base: '.'
    root: ['.']
    ignored: ['**/node_modules', '**/.*', 'data/**', 'events.log']
    debounce: 25

- id: app
  name: 'cordis:group'
  group: true
  config:
    - id: probe
      name: './probe.mjs'
      disabled: ${disabled}
      config:
        events: ${JSON.stringify(eventFile)}
        label: ${JSON.stringify(label)}

    - id: cli
      name: 'cordis:cli'
      disabled: !!js launch.surface !== 'cli'

    - id: webui
      name: 'cordis:webui'
      disabled: !!js launch.surface !== 'webui'
`;
}

function liveProbeModule() {
  return `import { appendFile } from "node:fs/promises";
import Schema from "@deepseek-ai/schemastery";

export const inject = ["hmr"];
export const Config = Schema.object({
  events: Schema.string().required(),
  label: Schema.string().required(),
});

export async function apply(ctx, config) {
  await appendFile(config.events, "apply:" + config.label + "\\n");
  ctx.on("hmr/config-update-failed", async () => {
    await appendFile(config.events, "config-failed\\n");
  });
  return async () => {
    await appendFile(config.events, "dispose:" + config.label + "\\n");
  };
}
`;
}

async function assertHealthy(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
}

async function readEvents(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function count(values, expected) {
  return values.filter((value) => value === expected).length;
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("WISH_") || name.startsWith("CORDIS_")) {
      delete environment[name];
    }
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(await message());
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
