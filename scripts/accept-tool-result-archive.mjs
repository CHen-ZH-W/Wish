import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileToolResultArchive,
} from "../dist/storage/tool-results/file-tool-result-archive.js";

async function withArchive(execute) {
  const root = await mkdtemp(join(tmpdir(), "wish-tool-result-archive-"));
  try {
    const directory = join(root, "tool-results");
    const archive = new FileToolResultArchive({
      directory,
      locatorRoot: root,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      temporaryId: () => "temporary-1",
    });
    await execute({ archive, root, directory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function archiveInput(result, signal) {
  return {
    sessionId: "session-1",
    runId: "run-1",
    userTurnId: "turn-1",
    stepId: "step-1",
    result,
    ...(signal === undefined ? {} : { signal }),
  };
}

test("archives the complete pre-render Tool Result as a durable snapshot", async () => {
  await withArchive(async ({ archive, root }) => {
    const result = {
      ok: true,
      callId: "call-1",
      toolName: "read",
      output: {
        content: "complete output",
        nested: { values: [1, 2, 3] },
      },
      phase: "completed",
      artifact: {
        kind: "file",
        locator: "/tmp/full-output.txt",
        metadata: { bytes: 15 },
      },
    };

    const pending = archive.archive(archiveInput(result));
    result.output.content = "mutated after archive started";
    result.output.nested.values.push(4);
    const reference = await pending;

    assert.match(reference.locator, /^tool-results\/session-[a-f0-9]{64}\/[a-f0-9]{64}-[a-f0-9]{64}\.json$/u);
    assert.match(reference.hash, /^[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(reference), true);

    const path = join(root, reference.locator);
    const record = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(record, {
      schemaVersion: 1,
      type: "tool_result_archive",
      sessionId: "session-1",
      runId: "run-1",
      userTurnId: "turn-1",
      stepId: "step-1",
      result: {
        artifact: {
          kind: "file",
          locator: "/tmp/full-output.txt",
          metadata: { bytes: 15 },
        },
        callId: "call-1",
        ok: true,
        output: {
          content: "complete output",
          nested: { values: [1, 2, 3] },
        },
        phase: "completed",
        toolName: "read",
      },
      resultSha256: reference.hash,
      createdAt: "2026-09-03T12:00:00.000Z",
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("replays the same archive identity without creating another record", async () => {
  await withArchive(async ({ archive, directory }) => {
    const input = archiveInput({
      ok: false,
      callId: "call-2",
      toolName: "bash",
      error: {
        code: "execution_failed",
        message: "exit 1",
        retryable: false,
        details: { stderr: "complete stderr" },
      },
      phase: "completed",
    });

    const first = await archive.archive(input);
    const second = await archive.archive(input);
    assert.deepEqual(second, first);

    const sessionDirectories = await readdir(directory);
    assert.equal(sessionDirectories.length, 1);
    assert.deepEqual(await readdir(join(directory, sessionDirectories[0])), [
      first.locator.split("/").at(-1),
    ]);
  });
});

test("fails closed when an existing archive is corrupted", async () => {
  await withArchive(async ({ archive, root }) => {
    const input = archiveInput({
      ok: true,
      callId: "call-3",
      toolName: "grep",
      output: { content: "match" },
      phase: "completed",
    });
    const reference = await archive.archive(input);
    await writeFile(join(root, reference.locator), "not json\n", "utf8");

    await assert.rejects(
      archive.archive(input),
      /Existing Tool Result archive is corrupted/u,
    );
  });
});

test("honors abort before creating an archive", async () => {
  await withArchive(async ({ archive, directory }) => {
    const controller = new AbortController();
    const reason = new Error("stop archive");
    controller.abort(reason);

    await assert.rejects(archive.archive(archiveInput({
      ok: true,
      callId: "call-4",
      toolName: "read",
      output: { content: "never stored" },
      phase: "completed",
    }, controller.signal)), reason);
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  });
});
