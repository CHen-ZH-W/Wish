import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgentProfileError, identifier, record } from "./validation.js";

/** Process incarnation, plus a local lease token for same-process Loader restarts. */
export interface ProcessOwner { readonly pid: number; readonly birth: string; readonly token: string }
const local = new Set<string>();

async function incarnation(pid: number): Promise<{ birth: string; zombie: boolean } | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { birth: `${boot.trim()}:${fields[19]}`, zombie: fields[0] === "Z" || fields[0] === "X" };
  } catch { return undefined; }
}
export async function createProcessOwner(): Promise<{ owner: ProcessOwner; release(): void }> {
  const owner = Object.freeze({ pid: process.pid, birth: (await incarnation(process.pid))?.birth ?? "unknown", token: randomUUID() });
  local.add(owner.token);
  return { owner, release: () => { local.delete(owner.token); } };
}
/** Unknown liveness is preserved. A second CLI must never interrupt a live Host's Run. */
export async function ownerIsDead(owner: ProcessOwner): Promise<boolean> {
  if (owner.pid === process.pid) return !local.has(owner.token);
  const current = await incarnation(owner.pid);
  if (current) return current.zombie || (owner.birth !== "unknown" && current.birth !== owner.birth);
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export function validateProcessOwner(value: unknown): ProcessOwner {
  const input = record(value);
  if (!Number.isSafeInteger(input.pid) || Number(input.pid) <= 0 || typeof input.birth !== "string" || !input.birth) throw new AgentProfileError("profile_invalid_owner");
  identifier(input.token);
  return input as unknown as ProcessOwner;
}
