import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import * as WebUi from "../dist/apps/webui/plugin.js";
import { createLaunch } from "../dist/boot/launch.js";
import ApprovalHub from "../dist/approval/service.js";
import MemoryApprovalRules from
  "../dist/permissions/rules/providers/memory.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FiberState = Object.freeze({ PENDING: 0, ACTIVE: 2, DISPOSED: 4 });

test("async surface startup is registered inside its Cordis effect", async () => {
  const source = await readFile(
    join(repositoryRoot, "src/apps/webui/plugin.ts"),
    "utf8",
  );
  assert.match(
    source,
    /await ctx\.effect\(async \(\) => \{[\s\S]*await startWishWebUiServer\(/u,
  );
  assert.doesNotMatch(
    source,
    /const started = await startWishWebUiServer\(/u,
  );
});

test("provider loss drains every WebUI effect before reactivation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-lifecycle-"));
  const port = await reservePort();
  const root = new Context();
  const launch = createLaunch({
    surface: "webui",
    argv: [],
    cwd: directory,
    homeDirectory: directory,
    environment: {},
    configurationFile: join(directory, "cordis.yml"),
    configurationSource: "option",
  });
  root.provide("launch", launch);

  const application = Object.freeze({ agentId: "wish" });
  const applicationService = Object.freeze({
    async open() {
      return application;
    },
  });
  const providerPlugin = (ctx) =>
    ctx.provide("application", applicationService);

  let provider;
  let surface;
  try {
    await root.plugin(ApprovalHub);
    await root.plugin(MemoryApprovalRules);
    provider = await root.plugin(providerPlugin);
    surface = await root.plugin(WebUi, {
      host: "127.0.0.1",
      port,
      workspaceRoot: directory,
    });
    assert.equal(surface.state, FiberState.ACTIVE);
    assert.deepEqual(effectLabels(surface), [
      "WebUI process surface",
      "approval.register(answerer)",
    ]);
    await assertHealthy(port);

    await provider.dispose();
    await surface.await();
    assert.equal(surface.state, FiberState.PENDING);
    assert.deepEqual(effectLabels(surface), []);
    await assertUnavailable(port);

    provider = await root.plugin(providerPlugin);
    await surface.await();
    assert.equal(surface.state, FiberState.ACTIVE);
    assert.deepEqual(effectLabels(surface), [
      "WebUI process surface",
      "approval.register(answerer)",
    ]);
    await assertHealthy(port);

    await root.fiber.dispose();
    assert.equal(surface.state, FiberState.DISPOSED);
    assert.deepEqual(effectLabels(surface), []);
    assert.deepEqual(root.fiber.getEffects(), []);
    await assertUnavailable(port);
  } finally {
    if (root.fiber.state !== FiberState.DISPOSED) {
      await root.fiber.dispose();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

function effectLabels(fiber) {
  return fiber.getEffects().map((effect) => effect.label).sort();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

async function assertHealthy(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", agentId: "wish" });
}

async function assertUnavailable(port) {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/api/health`),
    /fetch failed/u,
  );
}
