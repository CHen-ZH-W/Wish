import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ToolExecutor, ToolRegistry } from
  "../dist/core/tools/scheduler.js";
import { bootstrap } from "../dist/boot/bootstrap.js";
import Tools from "../dist/tools/service.js";
import {
  WebFetchTool,
  WebSearchTool,
  createWebFetchTool,
  renderWebFetchToolResult,
} from "../dist/web/tools.js";
import { WebSearchService } from "../dist/web/search-service.js";
import HttpWebFetch, {
  HttpWebFetchBackend,
} from "../dist/web/providers/http-fetch.js";

const PUBLIC_ADDRESS = Object.freeze({ address: "93.184.216.34", family: 4 });
const workspace = Object.freeze({
  requestedRoot: process.cwd(),
  root: process.cwd(),
  fingerprint: "workspace-web-1",
  revision: "workspace-web-revision-1",
  instructions: Object.freeze([]),
});

function toolContext(availableTools = ["web_fetch"]) {
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
      availableTools: Object.freeze(availableTools),
      ceiling: Object.freeze({
        allowedCapabilities: Object.freeze(["web.fetch", "web.search"]),
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

function response(statusCode, body, headers = { "content-type": "text/plain; charset=utf-8" }) {
  return Object.freeze({
    statusCode,
    headers: Object.freeze(headers),
    body: new TextEncoder().encode(body),
  });
}

async function executeFetch(backend, url, hooks = {}) {
  const registry = new ToolRegistry();
  registry.register(createWebFetchTool({ fetch: backend }));
  const parsed = registry.parseCall({
    id: "call-web-fetch",
    name: "web_fetch",
    argumentsJson: JSON.stringify({ url }),
  });
  assert.equal(parsed.ok, true);
  const authorization = {
    authorize(input) {
      hooks.authorize?.(input);
      return { status: "allowed", policyVersion: "permission-1" };
    },
    revalidate() {
      return { status: "valid", policyVersion: "permission-1" };
    },
  };
  return await new ToolExecutor({ registry, authorization }).execute({
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

test("Web Fetch resolves public authority before approval and renders untrusted content", async () => {
  const order = [];
  const backend = new HttpWebFetchBackend({
    resolver: {
      async resolve(hostname) {
        order.push(`resolve:${hostname}`);
        return [PUBLIC_ADDRESS];
      },
    },
    transport: {
      async request(input) {
        order.push(`request:${input.address.address}`);
        return response(200, "public page", {
          "content-type": "text/html; charset=utf-8",
        });
      },
    },
  });
  const result = await executeFetch(backend, "https://example.com/docs?q=wish", {
    authorize(input) {
      order.push("authorize");
      assert.deepEqual(input.capabilities, {
        requirements: [{
          capability: "web.fetch",
          providers: ["http-public"],
          origins: ["https://example.com"],
        }],
        effects: { openWorld: true },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(order, [
    "resolve:example.com",
    "authorize",
    "resolve:example.com",
    `request:${PUBLIC_ADDRESS.address}`,
  ]);
  assert.equal(result.output.finalUrl, "https://example.com/docs?q=wish");
  assert.equal(result.output.content.text, "public page");
  assert.match(result.output.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result.output), true);
  assert.match(renderWebFetchToolResult(result).content, /UNTRUSTED WEB CONTENT/u);
});

test("Web Fetch rejects private and mixed DNS answers before approval", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }],
    [PUBLIC_ADDRESS, { address: "10.0.0.7", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }],
  ]) {
    let approvals = 0;
    const backend = new HttpWebFetchBackend({
      resolver: { async resolve() { return addresses; } },
      transport: { async request() { throw new Error("must not run"); } },
    });
    const result = await executeFetch(backend, "https://example.com/", {
      authorize() { approvals += 1; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "permission_denied");
    assert.match(result.error.message, /non-public/u);
    assert.equal(approvals, 0);
  }
});

test("Web Fetch rejects unsafe URL forms before DNS", async () => {
  const cases = [
    "file:///tmp/secret",
    "https://user:password@example.com/",
    "http://localhost/",
    "http://metadata/",
    "https://example.com/#fragment",
  ];
  for (const url of cases) {
    let resolutions = 0;
    const backend = new HttpWebFetchBackend({
      resolver: {
        async resolve() {
          resolutions += 1;
          return [PUBLIC_ADDRESS];
        },
      },
      transport: { async request() { throw new Error("must not run"); } },
    });
    const result = await executeFetch(backend, url);
    assert.equal(result.ok, false);
    assert.equal(["permission_denied", "invalid_input"].includes(result.error.code), true);
    assert.equal(resolutions, 0);
  }
});

test("Web Fetch follows only same-origin redirects and re-resolves every hop", async () => {
  const requested = [];
  const backend = new HttpWebFetchBackend({
    resolver: {
      async resolve(hostname) {
        requested.push(`dns:${hostname}`);
        return [PUBLIC_ADDRESS];
      },
    },
    transport: {
      async request(input) {
        requested.push(input.url);
        return input.url.endsWith("/start")
          ? response(302, "", {
              location: "/final",
              "content-type": "text/plain",
            })
          : response(200, "done");
      },
    },
  });
  const followed = await executeFetch(backend, "https://example.com/start");
  assert.equal(followed.ok, true);
  assert.equal(followed.output.finalUrl, "https://example.com/final");
  assert.deepEqual(requested, [
    "dns:example.com",
    "dns:example.com",
    "https://example.com/start",
    "dns:example.com",
    "https://example.com/final",
  ]);

  const crossOrigin = new HttpWebFetchBackend({
    resolver: { async resolve() { return [PUBLIC_ADDRESS]; } },
    transport: {
      async request() {
        return response(302, "", {
          location: "https://other.example/",
          "content-type": "text/plain",
        });
      },
    },
  });
  const denied = await executeFetch(crossOrigin, "https://example.com/start");
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "permission_denied");
  assert.match(denied.error.message, /cross-origin redirect/u);
});

test("Web Fetch enforces response size, content type, encoding, and abort", async () => {
  const variants = [
    {
      options: { maxResponseBytes: 3 },
      value: response(200, "four"),
      pattern: /byte limit/u,
    },
    {
      options: {},
      value: response(200, "png", { "content-type": "image/png" }),
      pattern: /not supported/u,
    },
    {
      options: {},
      value: response(200, "gzip", {
        "content-type": "text/plain",
        "content-encoding": "gzip",
      }),
      pattern: /not supported/u,
    },
  ];
  for (const variant of variants) {
    const backend = new HttpWebFetchBackend({
      ...variant.options,
      resolver: { async resolve() { return [PUBLIC_ADDRESS]; } },
      transport: { async request() { return variant.value; } },
    });
    const result = await executeFetch(backend, "https://example.com/");
    assert.equal(result.ok, false);
    assert.match(result.error.message, variant.pattern);
  }

  const controller = new AbortController();
  controller.abort(new Error("stop fetch"));
  const backend = new HttpWebFetchBackend({
    resolver: { async resolve() { throw new Error("must not run"); } },
  });
  await assert.rejects(
    backend.resolve({ url: "https://example.com/", signal: controller.signal }),
    /stop fetch/u,
  );
});

test("Web Tool consumers follow their independent Cordis Provider lifecycles", async () => {
  const root = new Context();
  await root.plugin(Tools);
  const fetchTool = root.plugin(WebFetchTool);
  const searchTool = root.plugin(WebSearchTool);
  assert.equal(fetchTool.state, 0);
  assert.equal(searchTool.state, 0);

  class MemorySearch extends WebSearchService {
    policy = Object.freeze({
      schemaVersion: 1,
      version: "search-memory-1",
      providerId: "memory-search",
      maxQueryLength: 100,
      maxResults: 5,
    });
    async resolve(request) {
      return Object.freeze({
        schemaVersion: 1,
        providerId: this.policy.providerId,
        policyVersion: this.policy.version,
        query: request.query,
        maxResults: 5,
      });
    }
    async search(request) {
      return Object.freeze({
        providerId: this.policy.providerId,
        query: request.spec.query,
        sources: Object.freeze([]),
        truncated: false,
      });
    }
  }

  const fetchProvider = await root.plugin(HttpWebFetch);
  await fetchTool.await();
  assert.deepEqual(root.tools.registry.list().map((item) => item.name), ["web_fetch"]);
  const searchProvider = await root.plugin(MemorySearch);
  await searchTool.await();
  assert.deepEqual(root.tools.registry.list().map((item) => item.name), [
    "web_fetch",
    "web_search",
  ]);

  await fetchProvider.dispose();
  assert.equal(fetchTool.state, 0);
  assert.deepEqual(root.tools.registry.list().map((item) => item.name), ["web_search"]);
  await searchProvider.dispose();
  assert.equal(searchTool.state, 0);
  assert.deepEqual(root.tools.registry.list(), []);
  await root.fiber.dispose();
});

test("the built-in profile controls Web Fetch Provider and Tool independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-web-fetch-profile-"));
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
    assert.equal(disabled.surfaceContext.get("webFetch"), undefined);
    assert.equal(
      disabled.surfaceContext.get("tools").registry.has("web_fetch"),
      false,
    );
    await disabled.dispose();

    providerOnly = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      homeDirectory: directory,
      environment: {
        WISH_DATA_DIR: join(directory, "provider-only"),
        WISH_WEB_FETCH_ENABLED: "1",
        WISH_WEB_FETCH_TOOLS_ENABLED: "0",
      },
    });
    assert.equal(await providerOnly.completion, 0);
    assert.notEqual(providerOnly.surfaceContext.get("webFetch"), undefined);
    assert.equal(
      providerOnly.surfaceContext.get("tools").registry.has("web_fetch"),
      false,
    );
    await providerOnly.dispose();

    enabled = await bootstrap({
      surface: "cli",
      argv: ["--version"],
      homeDirectory: directory,
      environment: {
        WISH_DATA_DIR: join(directory, "enabled"),
        WISH_WEB_FETCH_ENABLED: "1",
      },
    });
    assert.equal(await enabled.completion, 0);
    assert.notEqual(enabled.surfaceContext.get("webFetch"), undefined);
    assert.equal(
      enabled.surfaceContext.get("tools").registry.has("web_fetch"),
      true,
    );
  } finally {
    await enabled?.dispose();
    await providerOnly?.dispose();
    await disabled?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
