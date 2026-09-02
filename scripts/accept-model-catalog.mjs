import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelCatalog } from "../dist/models/catalog.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { FileCatalogStore } from "../dist/storage/models/file-catalog-store.js";

function configuration() {
  return loadModelsConfiguration({
    json: {
      schemaVersion: 1,
      defaultModel: "provider-a/configured",
      providers: [
        {
          id: "provider-a",
          protocol: "openai-chat-completions",
          baseUrl: "https://a.example.test/v1",
          auth: { type: "none" },
          catalog: { enabled: true, endpoint: "/models" },
          models: [{
            id: "configured",
            status: "active",
            contextWindowTokens: 1000,
            toolCalling: true,
          }],
        },
        {
          id: "provider-b",
          protocol: "anthropic-messages",
          baseUrl: "https://b.example.test/v1",
          auth: { type: "none" },
          developerRoleMode: "system-fallback",
          catalog: { enabled: true },
          models: [{ id: "stable" }],
        },
      ],
    },
  });
}

test("Catalog diff is read-only and sync atomically preserves failed Provider LKG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-catalog-"));
  try {
    const path = join(directory, "catalog.json");
    let temporary = 0;
    const store = new FileCatalogStore({
      path,
      temporaryId: () => `fixture-${++temporary}`,
    });
    await store.save({
      schemaVersion: 1,
      updatedAt: "2026-09-01T00:00:00Z",
      providers: [
        {
          providerId: "provider-a",
          fetchedAt: "2026-09-01T00:00:00Z",
          checkedAt: "2026-09-01T00:00:00Z",
          models: [
            { id: "configured", contextWindowTokens: 900 },
            { id: "removed" },
          ],
        },
        {
          providerId: "provider-b",
          fetchedAt: "2026-09-01T00:00:00Z",
          checkedAt: "2026-09-01T00:00:00Z",
          models: [{ id: "stable", name: "Last known good" }],
        },
      ],
    });
    let checkCalls = 0;
    const catalog = new ModelCatalog({
      configuration: configuration(),
      store,
      clients: [
        {
          providerId: "provider-a",
          async fetchModels() {
            return [
              { id: "configured", contextWindowTokens: 1200 },
              { id: "new-model", reasoning: true },
            ];
          },
          async checkModel(input) {
            checkCalls += 1;
            assert.equal(input.model.model, "configured");
            return "available";
          },
        },
        {
          providerId: "provider-b",
          async fetchModels() {
            throw new Error("provider unavailable");
          },
        },
      ],
      now: () => "2026-09-02T00:00:00Z",
    });

    const beforeDiff = await store.load();
    const diff = await catalog.diff();
    const afterDiff = await store.load();
    assert.deepEqual(afterDiff, beforeDiff);
    assert.deepEqual(diff.providers[0], {
      providerId: "provider-a",
      status: "ok",
      added: [{ provider: "provider-a", model: "new-model" }],
      removed: [{ provider: "provider-a", model: "removed" }],
      changed: [{ provider: "provider-a", model: "configured" }],
    });
    assert.equal(diff.providers[1].status, "failed");

    const check = await catalog.check("provider-a/configured");
    assert.equal(check.status, "available");
    assert.equal(checkCalls, 1);
    const unknownCheck = await catalog.check("provider-b/stable");
    assert.equal(unknownCheck.status, "unknown");

    const synced = await catalog.sync();
    const stored = await store.load();
    assert.deepEqual(stored, synced.snapshot);
    const providerA = stored.providers.find((provider) => provider.providerId === "provider-a");
    const providerB = stored.providers.find((provider) => provider.providerId === "provider-b");
    assert.deepEqual(providerA.models.map((model) => model.id), ["configured", "new-model"]);
    assert.equal(providerA.fetchedAt, "2026-09-02T00:00:00Z");
    assert.deepEqual(providerB.models, [{ id: "stable", name: "Last known good" }]);
    assert.equal(providerB.fetchedAt, "2026-09-01T00:00:00Z");
    assert.equal(providerB.checkedAt, "2026-09-02T00:00:00Z");
    assert.equal(providerB.lastError, "Provider catalog synchronization failed");

    const listed = await catalog.list();
    const configured = listed.find((model) => model.ref.model === "configured");
    const discovered = listed.find((model) => model.ref.model === "new-model");
    assert.equal(configured.source, "both");
    assert.equal(configured.contextWindowTokens, 1000);
    assert.equal(configured.capabilities.toolCalling, true);
    assert.equal(configured.verification, "unverified");
    assert.equal(configured.callability, "unknown");
    assert.equal(discovered.source, "discovered");
    assert.equal(discovered.capabilities.reasoning, true);
    assert.equal(discovered.capabilities.imageInput, "unknown");

    assert.deepEqual(await readdir(directory), ["catalog.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("File Catalog Store rejects malformed persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-catalog-invalid-"));
  try {
    const path = join(directory, "catalog.json");
    const store = new FileCatalogStore({ path, temporaryId: () => "fixture" });
    await assert.rejects(
      () => store.save({ schemaVersion: 2, updatedAt: "invalid", providers: [] }),
      /schemaVersion/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
