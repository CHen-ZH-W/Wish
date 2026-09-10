import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { bootstrap } from "../dist/boot/bootstrap.js";
import Sessions, {
  Config as SessionsConfig,
} from "../dist/sessions/service.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("Sessions service owns construction, dependency lifecycle, and persistence", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "wish-cordis-sessions-"));
  const root = new Context();
  root.provide("launch", {
    cwd: rootDirectory,
    homeDirectory: rootDirectory,
    environment: {},
  });
  const generations = [];
  let disposals = 0;
  const consumer = root.plugin({
    inject: ["sessions"],
    apply(ctx) {
      generations.push(ctx.sessions);
      ctx.effect(() => () => {
        disposals += 1;
      }, "sessions consumer");
    },
  });

  assert.equal(consumer.state, fiberState.pending);
  let provider;
  try {
    provider = await root.plugin(Sessions, { dataDirectory: "./state-a" });
    await consumer.await();
    assert.equal(consumer.state, fiberState.active);
    assert.equal(generations.length, 1);
    assert.equal(generations[0].dataDirectory, join(rootDirectory, "state-a"));
    assert.equal(
      generations[0].open().manager,
      generations[0].manager,
    );
    const override = generations[0].open("./override-state");
    assert.equal(
      generations[0].open("./override-state"),
      override,
      "one service generation must reuse the graph for one resolved directory",
    );

    await generations[0].manager.create({
      sessionId: "session-persisted",
      agentId: "agent",
      scope: rootDirectory,
    });

    await provider.update({ dataDirectory: "./state-b" });
    await consumer.await();
    assert.equal(disposals, 1);
    assert.equal(generations.length, 2);
    assert.notEqual(generations[1], generations[0]);
    assert.equal(generations[1].dataDirectory, join(rootDirectory, "state-b"));
    await assert.rejects(
      generations[1].manager.get({ sessionId: "session-persisted" }),
      (error) => error?.code === "session_not_found",
    );

    await provider.update({ dataDirectory: "./state-a" });
    await consumer.await();
    assert.equal(disposals, 2);
    assert.equal(generations.length, 3);
    assert.equal(
      (await generations[2].manager.get({
        sessionId: "session-persisted",
      })).sessionId,
      "session-persisted",
    );

    assert.throws(
      () => provider.update({ dataDirectory: 42 }),
      /expected string/u,
    );
    assert.equal(
      root.get("sessions")?.dataDirectory,
      generations[2].dataDirectory,
    );
    assert.equal(consumer.state, fiberState.active);
    assert.equal(disposals, 2);

    await provider.dispose();
    assert.equal(root.get("sessions"), undefined);
    assert.equal(consumer.state, fiberState.pending);
    assert.equal(disposals, 3);
    assert.deepEqual(consumer.getEffects(), []);
  } finally {
    await root.fiber.dispose();
    await rm(rootDirectory, { recursive: true, force: true });
  }

  assert.equal(consumer.state, fiberState.disposed);
  assert.deepEqual(consumer.getEffects(), []);
});

test("Loader stable id disables and restores Sessions without losing facts", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "wish-loader-sessions-"));
  const configurationFile = join(rootDirectory, "cordis.yml");
  await writeFile(
    configurationFile,
    await readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
  );
  let booted;
  try {
    booted = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: repositoryRoot,
      homeDirectory: rootDirectory,
      environment: { WISH_DATA_DIR: join(rootDirectory, "state") },
      configurationFile,
    });
    assert.equal(await booted.completion, 0);
    await booted.surfaceContext.get("sessions").manager.create({
      sessionId: "loader-session",
      agentId: "agent",
      scope: rootDirectory,
    });
    const overrideDirectory = join(rootDirectory, "cli-override");
    const overrideApplication = await booted.surfaceContext
      .get("application")
      .open({
        dataDirectory: overrideDirectory,
      });
    await overrideApplication.createSession({
      sessionId: "override-session",
      workspaceRoot: rootDirectory,
    });
    assert.equal(
      (await booted.surfaceContext
        .get("sessions")
        .open(overrideDirectory)
        .manager.get({ sessionId: "override-session" })).sessionId,
      "override-session",
    );
    await assert.rejects(
      booted.surfaceContext.get("sessions").manager.get({
        sessionId: "override-session",
      }),
      (error) => error?.code === "session_not_found",
    );

    const id = "include:sessions";
    const entry = booted.context.loader.resolve(id);
    await booted.context.loader.update(id, {
      config: { dataDirectory: join(rootDirectory, "state-v2") },
    });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(
      booted.surfaceContext.get("sessions").dataDirectory,
      join(rootDirectory, "state-v2"),
    );
    await assert.rejects(
      booted.surfaceContext.get("sessions").manager.get({
        sessionId: "loader-session",
      }),
      (error) => error?.code === "session_not_found",
    );

    await booted.context.loader.update(id, {
      config: { dataDirectory: join(rootDirectory, "state") },
    });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(
      (await booted.surfaceContext.get("sessions").manager.get({
        sessionId: "loader-session",
      })).sessionId,
      "loader-session",
    );

    await booted.context.loader.update(id, { disabled: true });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, true);
    assert.equal(booted.surfaceContext.get("sessions"), undefined);

    await booted.context.loader.update(id, { disabled: false });
    assert.equal(booted.context.loader.resolve(id), entry);
    assert.equal(entry.disabled, false);
    assert.equal(
      (await booted.surfaceContext.get("sessions").manager.get({
        sessionId: "loader-session",
      })).sessionId,
      "loader-session",
    );
  } finally {
    await booted?.dispose();
    await rm(rootDirectory, { recursive: true, force: true });
  }
  assert.equal(booted?.context.get("sessions"), undefined);
  assert.deepEqual(booted?.context.fiber.getEffects(), []);
});

test("Sessions owns its schema and Application no longer constructs its graph", async () => {
  assert.deepEqual(SessionsConfig({ dataDirectory: "state" }), {
    dataDirectory: "state",
  });
  assert.throws(
    () => SessionsConfig({ dataDirectory: 42 }),
    /expected string/u,
  );

  const invalidRoot = new Context();
  invalidRoot.provide("launch", {
    cwd: repositoryRoot,
    homeDirectory: repositoryRoot,
    environment: {},
  });
  try {
    await assert.rejects(
      async () => await invalidRoot.plugin(Sessions, { dataDirectory: 42 }),
      /expected string/u,
    );
    assert.equal(invalidRoot.get("sessions"), undefined);
  } finally {
    await invalidRoot.fiber.dispose();
  }
  assert.deepEqual(invalidRoot.fiber.getEffects(), []);

  const applicationSource = await readFile(
    join(repositoryRoot, "src/apps/application.ts"),
    "utf8",
  );
  for (const construction of [
    "new SessionManager",
    "new FileSessionStore",
    "new SessionHistoryAdapter",
  ]) {
    assert.doesNotMatch(applicationSource, new RegExp(construction, "u"));
  }
  assert.match(applicationSource, /sessions: options\.sessions\.manager/u);
  assert.doesNotMatch(applicationSource, /options\.sessions\.history/u);
});
