import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { HOST_PLUGIN_MANAGEMENT, MODEL_TOOL_PLUGIN_MANAGEMENT } from "../dist/boot/plugin-catalog.js";

test("Goal and Todo entries are managed, isolated, and wired as separate provider/consumer plugins", async () => {
  for (const name of ["goal-storage", "goal-context", "goal-round-driver", "goal-session-feature", "todo", "todo-context", "todo-session-feature"]) {
    assert.equal(HOST_PLUGIN_MANAGEMENT[name], "managed");
  }
  assert.equal(MODEL_TOOL_PLUGIN_MANAGEMENT["goal-tools"], "managed");
  assert.equal(MODEL_TOOL_PLUGIN_MANAGEMENT["todo-tools"], "managed");
  const manifest = JSON.parse(await readFile(join(process.cwd(), "dist/apps/webui/public/ui-modules.json"), "utf8"));
  assert.deepEqual(manifest.modules.find((item) => item.id === "TodoClientUi").entryIds, ["include:todo-session-feature"]);
  assert.deepEqual(manifest.modules.find((item) => item.id === "GoalClientUi").entryIds, ["include:goal-session-feature"]);
});

test("Cordis provider restart recovers durable Goal disarmed and Todo reload resets turn-local state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-goal-todo-cordis-"));
  let booted;
  try {
    booted = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      cwd: process.cwd(),
      homeDirectory: directory,
      environment: {
        CORDIS_HMR: "0",
        WISH_DATA_DIR: join(directory, "data"),
        WISH_STORAGE_FILE_ROOT: join(directory, "storage"),
      },
    });
    assert.equal(await booted.completion, 0);
    const context = booted.surfaceContext;
    const firstGoal = context.get("goal");
    const firstTodo = context.get("todo");
    assert.ok(firstGoal); assert.ok(firstTodo);
    const created = await firstGoal.create({ sessionId: "session-restart", objective: "Persist across provider restart" });
    assert.equal(created.activation, "armed");
    await firstTodo.openTurn({ sessionId: "session-restart", runId: "run-1", userTurnId: "turn-1" });
    await firstTodo.replace({ sessionId: "session-restart", runId: "run-1", userTurnId: "turn-1", items: [{ id: "one", content: "Temporary", status: "in_progress" }] });
    const application = await context.get("application").open();
    assert.deepEqual((await application.sessionFeatures.inspect("session-restart")).filter((view) => view.key === "goal" || view.key === "todo").map((view) => view.key).sort(), ["goal", "todo"]);

    const todoFeatureEntry = booted.context.loader.resolve("include:todo-session-feature");
    await todoFeatureEntry.update({ disabled: true });
    assert.equal((await application.sessionFeatures.inspect("session-restart")).some((view) => view.key === "todo"), false);
    await todoFeatureEntry.update({ disabled: false });
    await todoFeatureEntry.fiber.await();
    assert.equal((await application.sessionFeatures.inspect("session-restart")).some((view) => view.key === "todo"), true);

    await booted.context.loader.update("include:goal-storage", {
      config: { backendId: "file", defaultMaxGoalRounds: 8 },
    });
    await booted.context.loader.resolve("include:goal-storage").fiber.await();
    const restartedGoal = context.get("goal");
    assert.ok(restartedGoal); assert.notEqual(restartedGoal, firstGoal);
    const recovered = await restartedGoal.get({ sessionId: "session-restart" });
    assert.equal(recovered.id, created.id);
    assert.equal(recovered.phase, "active");
    assert.equal(recovered.activation, "disarmed");
    assert.equal((await application.sessionFeatures.inspect("session-restart")).find((view) => view.key === "goal").data.activation, "disarmed");

    const todoEntry = booted.context.loader.resolve("include:todo");
    await todoEntry.update({ disabled: true });
    assert.equal(context.get("todo"), undefined);
    await todoEntry.update({ disabled: false });
    await todoEntry.fiber.await();
    const restartedTodo = context.get("todo");
    assert.ok(restartedTodo); assert.notEqual(restartedTodo, firstTodo);
    assert.equal(await restartedTodo.get("session-restart"), undefined);
  } finally {
    await booted?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
