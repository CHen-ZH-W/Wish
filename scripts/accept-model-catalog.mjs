import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { ModelCatalog } from "../dist/models/catalog.js";
import { loadModelsConfiguration } from "../dist/models/config.js";
import { StorageHub } from "../dist/storage/index.js";
import { DomainModelCatalogStore } from "../dist/models/persistence/domain-store.js";
import DomainModelCatalogProvider from
  "../dist/models/persistence/storage-provider.js";
import { FileCatalogStore } from "../dist/models/persistence/file-store.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import FileStorageProvider from "../dist/storage/providers/file/plugin.js";

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

const storeVariants = [
  {
    name: "FileCatalogStore",
    async create(directory) {
      const path = join(directory, "catalog.json");
      let temporary = 0;
      return {
        store: new FileCatalogStore({
          path,
          temporaryId: () => `fixture-${++temporary}`,
        }),
        async corrupt() {
          await writeFile(path, "{", "utf8");
        },
        async assertLayout() {
          assert.deepEqual(await readdir(directory), ["catalog.json"]);
        },
        async dispose() {},
      };
    },
  },
  {
    name: "DomainModelCatalogStore",
    async create(directory) {
      const root = new Context();
      await root.plugin(StorageHub);
      let revision = 0;
      const backend = new FileStorageBackend({
        id: "file",
        rootDirectory: directory,
        revision: () => `catalog-revision-${++revision}`,
      });
      root.storage.register(backend);
      return {
        store: new DomainModelCatalogStore({
          storage: root.storage,
          backendId: "file",
        }),
        async corrupt() {
          await backend.kv.put({
            namespace: "models/catalog",
            key: "global",
            value: new TextEncoder().encode("{"),
            precondition: { kind: "any" },
          });
        },
        async assertLayout() {
          assert.equal(
            (await recursiveFiles(directory)).some((path) => path.includes(".tmp-")),
            false,
          );
        },
        async dispose() {
          await root.fiber.dispose();
        },
      };
    },
  },
];

for (const variant of storeVariants) {
  test(`${variant.name}: Catalog diff is read-only and sync atomically preserves failed Provider LKG`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wish-model-catalog-"));
    let fixture;
    try {
      fixture = await variant.create(directory);
      const { store } = fixture;
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

      await fixture.assertLayout();
    } finally {
      await fixture?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${variant.name}: rejects invalid input and malformed persisted state`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wish-model-catalog-invalid-"));
    let fixture;
    try {
      fixture = await variant.create(directory);
      await assert.rejects(
        () => fixture.store.save({
          schemaVersion: 2,
          updatedAt: "invalid",
          providers: [],
        }),
        /schemaVersion/u,
      );
      await fixture.corrupt();
      await assert.rejects(
        () => fixture.store.load(),
        variant.name === "DomainModelCatalogStore"
          ? (error) => error?.code === "storage_corruption"
          : /invalid JSON/u,
      );
    } finally {
      await fixture?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Model Catalog Domain Provider follows selected Backend lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-model-catalog-provider-"));
  const root = new Context();
  root.provide("launch", {
    cwd: directory,
    homeDirectory: directory,
    environment: {},
  });
  await root.plugin(StorageHub);
  const domainProvider = root.plugin(DomainModelCatalogProvider, {
    backendId: "file",
  });
  const generations = [];
  const consumer = root.plugin({
    inject: ["modelCatalogPersistence"],
    apply(ctx) {
      generations.push(ctx.modelCatalogPersistence.open());
    },
  });
  assert.equal(domainProvider.state, 0);
  const firstBackend = await root.plugin(FileStorageProvider, {
    id: "file",
    rootDirectory: "./storage",
  });
  await consumer.await();
  assert.equal(generations.length, 1);
  await generations[0].save({
    schemaVersion: 1,
    updatedAt: "2026-09-11T00:00:00.000Z",
    providers: [],
  });
  const oldStore = generations[0];

  await firstBackend.dispose();
  assert.equal(root.get("modelCatalogPersistence"), undefined);
  assert.equal(consumer.state, 0);
  await assert.rejects(
    oldStore.load(),
    /model_catalog_closed/,
  );

  await root.plugin(FileStorageProvider, {
    id: "file",
    rootDirectory: "./storage",
  });
  await consumer.await();
  assert.equal(generations.length, 2);
  assert.equal(
    (await generations[1].load()).updatedAt,
    "2026-09-11T00:00:00.000Z",
  );
  await root.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
});

async function recursiveFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      result.push(...await recursiveFiles(join(directory, entry.name), relativePath));
    } else {
      result.push(relativePath);
    }
  }
  return result;
}
