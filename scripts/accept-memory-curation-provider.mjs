import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { StorageHub } from "../dist/storage/service.js";
import { StorageBackendService } from "../dist/storage/binding.js";
import { FileStorageBackend } from "../dist/storage/providers/file/backend.js";
import StorageMemory from "../dist/memory/providers/storage.js";
import StorageMemoryCuration from "../dist/memory/providers/curation.js";

test("Cordis curation stays manual by default, reloads durable queue, and releases leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-curation-provider-"));
  const root = new Context();
  const backend = new FileStorageBackend({ id: "file", rootDirectory: directory });
  class SelectedBackend extends StorageBackendService {
    static inject = ["storage"];
    id = "file";
  }
  try {
    await root.plugin(StorageHub); root.storage.register(backend);
    await root.plugin(SelectedBackend); await root.plugin(StorageMemory);
    let provider = await root.plugin(StorageMemoryCuration, { intervalMs: 5 });
    const scheduler = root.memoryCuration.scheduler;
    scheduler.registerSource({ id: "fixture", scan: async () => [{ id: "fixture-1", sourceId: "fixture", outcome: "unknown",
      text: "untrusted execution result", appliesTo: "fixture", references: [{ kind: "operator", id: "fixture", revision: "1", digest: "a".repeat(64) }] }] });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await scheduler.state()).jobs.length, 0);
    await scheduler.scan();
    assert.equal((await scheduler.state()).jobs[0].status, "queued");
    await provider.dispose();
    assert.throws(() => scheduler.scan(), /closed/);
    provider = await root.plugin(StorageMemoryCuration);
    assert.equal((await root.memoryCuration.scheduler.state()).jobs.length, 1);
    await root.memoryCuration.scheduler.tick();
    assert.equal((await root.memory.state()).candidates[0].status, "pending");
    assert.deepEqual(await root.memory.query(), []);
    await provider.dispose();
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
