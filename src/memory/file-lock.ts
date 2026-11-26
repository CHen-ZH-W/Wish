import { spawn } from "node:child_process";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** OS-owned advisory locks: exclusive across Hosts and released when the owning pipe/process exits. */
export async function tryMemoryLock<T>(directory: string, name: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<{ acquired: false } | { acquired: true; value: T }> {
  if (!/^[a-z][a-z-]*$/u.test(name)) throw new Error("Invalid memory lock identity");
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Memory lock root cannot be a symlink");
  const path = join(directory, `.${name}.lock`);
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Memory lock cannot be a symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const worker = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", path, "/bin/sh", "-c",
    'printf "locked\\n"; cat >/dev/null'], { stdio: ["pipe", "pipe", "pipe"] });
  let detail = "";
  worker.stdin.on("error", () => { /* A busy flock process can close its unused input immediately. */ });
  worker.stderr.on("data", chunk => { detail += String(chunk); });
  const closed = new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("close", resolve); });
  // Observe close failures even when spawn failed before the readiness race completed.
  void closed.catch(() => {});
  const ready = new Promise<boolean>((resolve, reject) => {
    worker.once("error", reject);
    worker.stdout.once("data", chunk => { if (String(chunk).startsWith("locked\n")) resolve(true); else reject(new Error("Invalid memory lock worker response")); });
    worker.once("close", code => { if (code === 1) resolve(false); else reject(new Error(`Memory lock worker exited before readiness (${code}): ${detail}`)); });
  });
  const abort = () => { worker.stdin.end(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const acquired = await ready;
    signal?.throwIfAborted();
    if (!acquired) return { acquired: false };
    signal?.removeEventListener("abort", abort);
    return { acquired: true, value: await operation() };
  } finally {
    signal?.removeEventListener("abort", abort);
    worker.stdin.end();
    await closed;
  }
}

export async function withMemoryLock<T>(directory: string, name: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    const result = await tryMemoryLock(directory, name, operation, signal);
    if (result.acquired) return result.value;
    await delay(100, undefined, signal ? { signal } : undefined);
  }
}
