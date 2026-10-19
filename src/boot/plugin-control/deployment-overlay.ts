import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DeploymentOverlayEntry { readonly parentId: string; readonly entry: Readonly<Record<string, unknown>> }
export interface DeploymentOverlay { readonly schemaVersion: 1; readonly entries: readonly DeploymentOverlayEntry[] }
export const EMPTY_DEPLOYMENT_OVERLAY = serializeDeploymentOverlay([]);
/** Storage records may reorder JSON keys. Deployment identity must survive it. */
export function serializeDeploymentOverlay(entries: readonly DeploymentOverlayEntry[]): string {
  return JSON.stringify({ schemaVersion: 1, entries }, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value) + "\n";
}
export function overlayHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
export function parseDeploymentOverlay(content: string): DeploymentOverlay {
  const data = JSON.parse(content) as DeploymentOverlay;
  if (data?.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > 128 || Object.keys(data).some(key => !["schemaVersion", "entries"].includes(key))) throw new Error("management_overlay_invalid");
  const ids = new Set<string>();
  for (const row of data.entries) {
    if (!row || typeof row !== "object" || Object.keys(row).some(key => !["parentId", "entry"].includes(key)) ||
      !/^[a-zA-Z0-9_-]{1,100}$/u.test(row.parentId) || !row.entry || typeof row.entry !== "object" ||
      typeof row.entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/u.test(row.entry.id) || ids.has(row.entry.id) ||
      typeof row.entry.name !== "string" || row.entry.group !== undefined || Object.keys(row.entry).some(key => !["id", "name", "config", "management", "disabled"].includes(key))) throw new Error("management_overlay_invalid");
    ids.add(row.entry.id);
  }
  return data;
}
export async function writeDeploymentOverlay(filename: string, content: string): Promise<void> {
  parseDeploymentOverlay(content); await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(dirname(filename), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
export async function initializeDeploymentOverlay(filename: string): Promise<void> {
  try { parseDeploymentOverlay(await readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await writeDeploymentOverlay(filename, EMPTY_DEPLOYMENT_OVERLAY); }
}
