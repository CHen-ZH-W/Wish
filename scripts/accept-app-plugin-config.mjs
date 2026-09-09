import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Config as CliConfig } from "../dist/apps/cli/plugin.js";
import { Config as WebUiConfig } from "../dist/apps/webui/plugin.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("surface plugins validate their own typed configuration", () => {
  assert.deepEqual(CliConfig({
    dataDirectory: "state",
    modelsConfigurationPath: "models.json",
  }), {
    dataDirectory: "state",
    modelsConfigurationPath: "models.json",
  });
  assert.deepEqual(WebUiConfig({
    host: "127.0.0.1",
    port: 8790,
    workspaceRoot: "workspace",
    dataDirectory: "state",
    modelsConfigurationPath: "models.json",
  }), {
    host: "127.0.0.1",
    port: 8790,
    workspaceRoot: "workspace",
    dataDirectory: "state",
    modelsConfigurationPath: "models.json",
  });
  assert.throws(() => WebUiConfig({ port: 0 }), /expected number >= 1/u);
  assert.throws(() => WebUiConfig({ port: 65_536 }), /expected number <= 65535/u);
  assert.throws(() => CliConfig({ dataDirectory: 42 }), /expected string/u);
});

test("a WebUI Loader row owns settings and reloads them by stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-plugin-config-"));
  const workspace = join(directory, "workspace");
  const profile = join(directory, "cordis.yml");
  const [firstPort, secondPort, environmentPort] = await reservePorts(3);
  await mkdir(workspace);
  await writeFile(profile, webProfile({ port: firstPort }));

  const environment = cleanEnvironment();
  environment.CORDIS_CONFIG = profile;
  environment.WISH_DATA_DIR = join(directory, "environment-state");
  environment.WISH_WEBUI_HOST = "127.0.0.1";
  environment.WISH_WEBUI_PORT = String(environmentPort);
  environment.WISH_WEBUI_WORKSPACE_ROOT = join(directory, "missing-workspace");
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "dist/apps/webui/main.js")],
    {
      cwd: directory,
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
    await waitForHealthy(firstPort, () => `first configured port did not start:\n${stderr}`);
    await assertUnavailable(environmentPort);

    const created = await requestJson(firstPort, "/api/sessions", {
      method: "POST",
      body: { sessionId: "plugin-config-session" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.value.session.scope, workspace);
    assert.equal((await readdir(join(directory, "profile-state", "sessions"))).length, 1);
    await assert.rejects(access(join(directory, "environment-state")));

    await replaceProfile(profile, webProfile({ port: secondPort }));
    await waitForHealthy(secondPort, () => `updated configured port did not start:\n${stderr}`);
    await assertUnavailable(firstPort);
    const listed = await requestJson(secondPort, "/api/sessions");
    assert.equal(listed.response.status, 200);
    assert.deepEqual(
      listed.value.sessions.map((session) => session.sessionId),
      ["plugin-config-session"],
    );
    await delay(150);

    await replaceProfile(profile, webProfile({ port: 0 }));
    await waitFor(
      () => stderr.includes("Cordis config reload failed at"),
      () => `invalid surface configuration was not reported:\n${stderr}`,
    );
    await waitForHealthy(
      secondPort,
      () => `last-known-good WebUI configuration was not restored:\n${stderr}`,
    );

    assert.equal(child.kill("SIGTERM"), true);
    const [code, signal] = await withTimeout(
      exited,
      10_000,
      "configured WebUI did not stop after SIGTERM",
    );
    assert.equal(code, 143);
    assert.equal(signal, null);
    assert.equal(stdout, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

function webProfile({ port }) {
  return `- id: timer
  name: 'cordis:timer'

- id: hmr
  name: 'cordis:hmr'
  config:
    base: '.'
    root: ['.']
    ignored: ['**/.*', '**/*.tmp', 'profile-state/**', 'environment-state/**']
    debounce: 25

- id: app
  name: 'cordis:group'
  group: true
  config:
    - id: webui
      name: 'cordis:webui'
      config:
        host: '127.0.0.1'
        port: ${port}
        workspaceRoot: './workspace'
        dataDirectory: './profile-state'
`;
}

async function replaceProfile(path, content) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function requestJson(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    ...(options.body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
  return { response, value: await response.json() };
}

async function waitForHealthy(port, message) {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.status === 200;
    } catch {
      return false;
    }
  }, message);
}

async function assertUnavailable(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
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

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return servers.map((server) => {
      const address = server.address();
      assert.notEqual(address, null);
      assert.equal(typeof address, "object");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(async (server) => {
      server.close();
      await once(server, "close");
    }));
  }
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
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
