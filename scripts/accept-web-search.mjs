import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { ToolExecutor, ToolRegistry } from
  "../dist/core/tools/scheduler.js";
import {
  createWebSearchTool,
  renderWebSearchToolResult,
} from "../dist/web/tools.js";
import { DeepseekSearchBackend } from "../dist/web/providers/deepseek-search.js";

const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "workspace-search-1",
  revision: "workspace-search-revision-1",
  instructions: Object.freeze([]),
});

function toolContext() {
  return Object.freeze({
    cwd: workspace.root,
    workspace,
    permissions: Object.freeze({
      schemaVersion: 1,
      subject: Object.freeze({
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
        userTurnId: "turn-1",
        stepId: "step-1",
      }),
      profile: "approval-required",
      availableTools: Object.freeze(["web_search"]),
      ceiling: Object.freeze({
        allowedCapabilities: Object.freeze(["web.search"]),
      }),
      workspace: Object.freeze({
        fingerprint: workspace.fingerprint,
        revision: workspace.revision,
      }),
      filesystemPolicyVersion: "filesystem-1",
      shellPolicyVersion: "shell-1",
      sandboxPolicyVersion: "sandbox-1",
      policyVersion: "permission-1",
      authorityVersion: "authority-1",
    }),
  });
}

async function executeSearch(backend, input, hooks = {}) {
  const registry = new ToolRegistry();
  registry.register(createWebSearchTool({ search: backend }));
  const parsed = registry.parseCall({
    id: "call-web-search",
    name: "web_search",
    argumentsJson: JSON.stringify(input),
  });
  assert.equal(parsed.ok, true);
  return await new ToolExecutor({
    registry,
    authorization: {
      authorize(value) {
        hooks.authorize?.(value);
        return { status: "allowed", policyVersion: "permission-1" };
      },
      revalidate() {
        return { status: "valid", policyVersion: "permission-1" };
      },
    },
  }).execute({
    call: parsed.call,
    context: toolContext(),
    scope: Object.freeze({
      runId: "run-1",
      userTurnId: "turn-1",
      stepId: "step-1",
    }),
    snapshot: registry.captureSnapshot({ authorityVersion: "authority-1" }),
  });
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("DeepSeek Search queries a search engine after Provider-scoped approval", async () => {
  const order = [];
  let request;
  const backend = new DeepseekSearchBackend({
    credential: () => "search-test-key",
    maxResults: 4,
    fetch: async (url, init) => {
      order.push("fetch");
      request = { url: new URL(url), init };
      return jsonResponse({
        results: [
          {
            url: "https://example.com/a",
            title: "Result A",
            summary: "Excerpt A",
            date: "2026-09-10T00:00:00Z",
          },
          { url: "https://example.com/b", title: "Result B" },
          { url: "https://example.com/a", title: "Duplicate" },
        ],
      });
    },
  });
  const result = await executeSearch(
    backend,
    { query: "Wish agent architecture", maxResults: 1 },
    {
      authorize(input) {
        order.push("authorize");
        assert.deepEqual(input.capabilities, {
          requirements: [{
            capability: "web.search",
            providers: ["deepseek"],
          }],
          effects: { openWorld: true },
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(order, ["authorize", "fetch"]);
  assert.equal(request.url.href, "https://api.deepseek.com/v1/tools/search");
  assert.deepEqual(JSON.parse(request.init.body), { query: "Wish agent architecture", count: 1, need_content: false });
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers["accept-encoding"], "identity");
  assert.deepEqual(result.output.sources, [{
    url: "https://example.com/a",
    title: "Result A",
    snippet: "Excerpt A",
    publishedAt: "2026-09-10T00:00:00Z",
  }]);
  assert.equal(result.output.answer, undefined);
  assert.equal(result.output.usage, undefined);
  assert.equal(result.output.truncated, true);
  assert.equal(Object.isFrozen(result.output.sources), true);
  const rendered = renderWebSearchToolResult(result).content;
  assert.match(rendered, /UNTRUSTED WEB SEARCH/u);
  assert.match(rendered, /\[1\] Result A/u);
});

test("DeepSeek Search rejects unavailable scope before approval", async () => {
  assert.throws(
    () => new DeepseekSearchBackend({ credential: () => "test-key", maxResults: 51 }),
    /limits are invalid/u,
  );
  let approvals = 0;
  let requests = 0;
  const backend = new DeepseekSearchBackend({
    credential: () => "search-test-key",
    maxResults: 3,
    fetch: async () => {
      requests += 1;
      return jsonResponse({ results: [] });
    },
  });
  const result = await executeSearch(
    backend,
    { query: "test", maxResults: 4 },
    { authorize() { approvals += 1; } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_input");
  assert.equal(approvals, 0);
  assert.equal(requests, 0);
});

test("DeepSeek Search accepts only structured HTTP result URLs without credentials", async () => {
  const backend = new DeepseekSearchBackend({
    credential: () => "search-test-key",
    fetch: async () => jsonResponse({ results: [
      { url: "javascript:alert(1)", title: "unsafe" },
      { url: "https://user:secret@valid.example/path" },
      { url: "https://valid.example/path", summary: "safe result" },
      { url: "https://valid.example/path", summary: "duplicate" },
    ] }),
  });
  const result = await executeSearch(backend, { query: "test" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.sources, [{
    url: "https://valid.example/path",
    snippet: "safe result",
  }]);
});

test("DeepSeek Search surfaces HTTP, content, JSON, size, and redirect failures", async () => {
  const cases = [
    {
      fetch: async () => new Response("rate limited", { status: 429 }),
      pattern: /HTTP 429/u,
      retryable: true,
    },
    {
      fetch: async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      pattern: /Expected JSON/u,
    },
    {
      fetch: async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      pattern: /not valid JSON/u,
    },
    {
      options: { maxResponseBytes: 4 },
      fetch: async () => jsonResponse({ results: [] }),
      pattern: /byte limit/u,
    },
    {
      fetch: async (_url, init) => {
        assert.equal(init.redirect, "error");
        throw new TypeError("redirect mode is error");
      },
      pattern: /request failed/u,
    },
  ];
  for (const item of cases) {
    const backend = new DeepseekSearchBackend({
      credential: () => "search-test-key",
      ...item.options,
      fetch: item.fetch,
    });
    const result = await executeSearch(backend, { query: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "execution_failed");
    assert.match(result.error.message, item.pattern);
    if (item.retryable !== undefined) {
      assert.equal(result.error.retryable, item.retryable);
    }
  }
});

test("DeepSeek Search observes caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop search"));
  const backend = new DeepseekSearchBackend({
    credential: () => "search-test-key",
    fetch: async () => { throw new Error("must not run"); },
  });
  await assert.rejects(
    backend.resolve({ query: "test", signal: controller.signal }),
    /stop search/u,
  );
});

test("the built-in profile controls Search Provider and Tool independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-web-search-profile-"));
  let disabled;
  let providerOnly;
  let enabled;
  try {
    disabled = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      homeDirectory: directory,
      environment: { WISH_DATA_DIR: join(directory, "disabled") },
    });
    assert.equal(await disabled.completion, 0);
    assert.equal(disabled.surfaceContext.get("webSearch"), undefined);
    assert.equal(
      disabled.surfaceContext.get("tools").registry.has("web_search"),
      false,
    );
    await disabled.dispose();

    providerOnly = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      homeDirectory: directory,
      environment: {
        WISH_DATA_DIR: join(directory, "provider-only"),
        WISH_WEB_SEARCH_PROVIDER: "deepseek",
        WISH_WEB_SEARCH_TOOLS_ENABLED: "0",
        WISH_DEEPSEEK_SEARCH_API_KEY: "search-test-key",
      },
    });
    assert.equal(await providerOnly.completion, 0);
    assert.notEqual(providerOnly.surfaceContext.get("webSearch"), undefined);
    assert.equal(
      providerOnly.surfaceContext.get("tools").registry.has("web_search"),
      false,
    );
    await providerOnly.dispose();

    enabled = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      homeDirectory: directory,
      environment: {
        WISH_DATA_DIR: join(directory, "enabled"),
        WISH_WEB_SEARCH_PROVIDER: "deepseek",
        WISH_DEEPSEEK_SEARCH_API_KEY: "search-test-key",
      },
    });
    assert.equal(await enabled.completion, 0);
    assert.notEqual(enabled.surfaceContext.get("webSearch"), undefined);
    assert.equal(
      enabled.surfaceContext.get("tools").registry.has("web_search"),
      true,
    );
  } finally {
    await enabled?.dispose();
    await providerOnly?.dispose();
    await disabled?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
