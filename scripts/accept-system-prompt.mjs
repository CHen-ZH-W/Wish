import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import SystemPrompt from "../dist/system-prompt/service.js";
import BaseSystemPrompt from "../dist/system-prompt/consumers/base.js";
import { SystemPromptContextProvider } from
  "../dist/system-prompt/consumers/context.js";
import FilesystemToolGuidance from
  "../dist/filesystem/consumers/model-tools/guidance.js";
import BashToolGuidance from "../dist/shell/consumers/guidance.js";
import WebToolGuidance from "../dist/web/guidance.js";
import SubagentToolGuidance from
  "../dist/subagents/consumers/model-tools/guidance.js";

test("base instructions stay stable and Agent additions follow them", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(BaseSystemPrompt);

  const instructions = root.systemPrompt.assembleInstructions({
    availableTools: [],
  });
  assert.deepEqual(
    root.systemPrompt.assemble({ availableTools: [] }).map(({ id }) => id),
    [
      "wish.identity",
      "wish.authority",
      "wish.behavior",
      "wish.tool-use",
      "wish.output",
    ],
  );
  assert.deepEqual(
    instructions.map(({ role }) => role),
    ["system", "system", "developer", "developer", "developer"],
  );
  assert.match(instructions[0].content, /You are Wish/u);
  assert.match(instructions[1].content, /Tool visibility, permissions/u);

  await root.fiber.dispose();
});

test("capability owners contribute guidance only for final visible Tools", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(FilesystemToolGuidance);
  await root.plugin(BashToolGuidance);
  await root.plugin(WebToolGuidance);
  await root.plugin(SubagentToolGuidance);

  const ids = (availableTools) => root.systemPrompt
    .assemble({ availableTools })
    .map(({ id }) => id);
  assert.deepEqual(ids([]), []);
  assert.deepEqual(ids(["read"]), []);
  assert.deepEqual(ids(["read", "edit", "bash", "web_search"]), [
    "filesystem.edit",
    "shell.bash",
    "web.search",
  ]);
  assert.deepEqual(
    ids([
      "read",
      "write",
      "edit",
      "grep",
      "web_search",
      "web_fetch",
      "spawn_agent",
      "list_agents",
      "collect_agent",
    ]),
    [
      "filesystem.inspect",
      "filesystem.edit",
      "filesystem.write",
      "filesystem.prefer-edit",
      "web.search",
      "web.fetch",
      "web.search-fetch",
      "subagents.delegation",
      "subagents.lifecycle",
    ],
  );

  await root.fiber.dispose();
});

test("System Prompt assembles sections deterministically from final Tool names", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt);
  const owner = root.plugin({
    inject: ["systemPrompt"],
    apply(ctx) {
      ctx.systemPrompt.register({
        id: "tools.read",
        content: "Use read for text files.",
        order: 20,
        requiredTools: ["read"],
      });
      ctx.systemPrompt.register({
        id: "identity",
        content: "You are Wish.",
        authority: "system",
        order: -100,
      });
      ctx.systemPrompt.register({
        id: "tools.edit",
        content: "Edit only after reading.",
        order: 10,
        requiredTools: ["read", "edit"],
      });
    },
  });
  await owner.await();

  assert.deepEqual(
    root.systemPrompt.assemble({ availableTools: ["edit", "read"] }),
    [
      {
        id: "identity",
        content: "You are Wish.",
        authority: "system",
        order: -100,
        requiredTools: [],
        placement: "stable_prefix",
      },
      {
        id: "tools.edit",
        content: "Edit only after reading.",
        authority: "developer",
        order: 10,
        requiredTools: ["read", "edit"],
        placement: "dynamic_tail",
      },
      {
        id: "tools.read",
        content: "Use read for text files.",
        authority: "developer",
        order: 20,
        requiredTools: ["read"],
        placement: "dynamic_tail",
      },
    ],
  );
  assert.deepEqual(
    root.systemPrompt.assembleInstructions({ availableTools: ["edit", "read"] }),
    [{ role: "system", content: "You are Wish." }],
  );
  assert.deepEqual(
    root.systemPrompt.assemble({ availableTools: ["read"] }).map(({ id }) => id),
    ["identity", "tools.read"],
  );

  await owner.dispose();
  assert.deepEqual(root.systemPrompt.assemble({ availableTools: ["read"] }), []);
  await root.fiber.dispose();
});

test("Tool-dependent sections cannot enter the stable prefix", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt);
  assert.throws(
    () => root.systemPrompt.register({
      id: "stale-tool-guidance",
      content: "Use bash.",
      requiredTools: ["bash"],
      placement: "stable_prefix",
    }),
    /must use dynamic_tail/u,
  );
  await root.fiber.dispose();
});

test("Context consumer projects the assembled authority and placement", async () => {
  const root = new Context();
  await root.plugin(SystemPrompt);
  root.systemPrompt.register({
    id: "identity",
    content: "You are Wish.",
    authority: "system",
  });
  root.systemPrompt.register({
    id: "tools.read",
    content: "Use read.",
    requiredTools: ["read"],
  });
  const provider = new SystemPromptContextProvider(root.systemPrompt);
  const base = {
    runId: "run",
    userTurnId: "turn",
    stepId: "step",
    sessionId: "session",
    model: { provider: "mock", model: "mock" },
    workspace: {
      cwd: "/workspace",
      fingerprint: "workspace",
      revision: "revision",
      instructions: [],
    },
    runtime: {
      capturedAt: "2026-09-19T00:00:00.000Z",
      stateVersion: 1,
      userTurnOrdinal: 1,
      stepOrdinal: 1,
    },
  };
  assert.deepEqual(provider.provide(base), []);
  assert.deepEqual(
    provider.provide({
      ...base,
      request: {
        currentMessage: { role: "user", content: "inspect" },
        source: "user",
        availableTools: ["read"],
      },
    }),
    [{
      id: "system-prompt:tools.read",
      kind: "instruction",
      placement: "dynamic_tail",
      message: { role: "developer", content: "Use read." },
    }],
  );
  await root.fiber.dispose();
});
