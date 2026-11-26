import { isAbsolute, resolve } from "node:path";
import type { Launch } from "../boot/launch.js";
import { FileSubagentExchange } from "../subagents/files.js";
import { snapshotResourceManifest, type SubagentResourceManifest } from "../subagents/resources.js";
import type { MemoryLibraryLocation } from "./types.js";
import { identity } from "./validation.js";

export const MEMORY_LIBRARY_RESOURCE = "wish.memory.library";

/** The library location and delegated Skill scope are fixed; its contents remain live. */
export interface ChildMemoryLibrary extends MemoryLibraryLocation {
  readonly allowedSkills: readonly string[];
}

export function childMemoryLibrary(raw: SubagentResourceManifest): ChildMemoryLibrary {
  const manifest = snapshotResourceManifest(raw);
  const resource = manifest.resources.find(item => item.type === MEMORY_LIBRARY_RESOURCE);
  const value = resource?.payload as ChildMemoryLibrary | undefined;
  if (resource?.schemaVersion !== 1 || !value ||
      Object.keys(value).some(key => !["libraryId", "directory", "journalRoot", "allowedSkills"].includes(key)) ||
      !Array.isArray(value.allowedSkills) || value.allowedSkills.some(name => typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) ||
      new Set(value.allowedSkills).size !== value.allowedSkills.length) throw new Error("Invalid child Memory library resource");
  for (const path of [value.directory, value.journalRoot]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path !== resolve(path)) throw new Error("Invalid child Memory library path");
  }
  return Object.freeze({ libraryId: identity(value.libraryId), directory: value.directory, journalRoot: value.journalRoot,
    allowedSkills: Object.freeze([...value.allowedSkills]) });
}

export async function readChildMemoryLibrary(launch: Launch): Promise<ChildMemoryLibrary> {
  const environment = launch.environment;
  const id = environment.WISH_CHILD_ID, childSessionId = environment.WISH_CHILD_SESSION_ID, childRunId = environment.WISH_CHILD_RUN_ID;
  const dataDirectory = environment.WISH_DATA_DIR, exchangeDirectory = environment.WISH_CHILD_EXCHANGE_DATA_DIR;
  if (launch.surface !== "cli" || launch.argv[0] !== "child" || !id || !childSessionId || !childRunId || !exchangeDirectory || !dataDirectory) {
    throw new Error("Child Memory library requires Host-owned child identity");
  }
  const exchange = new FileSubagentExchange(resolve(launch.cwd, exchangeDirectory));
  if (resolve(launch.cwd, dataDirectory) !== exchange.childDataDirectory(id) || environment.WISH_CHILD_RESOURCES_FILE !== exchange.inputResourcesPath(id)) {
    throw new Error("Child Memory resource path does not match its isolated data directory");
  }
  const manifest = await exchange.readInputResources({ id, childSessionId, childRunId });
  if (!manifest || manifest.digest !== environment.WISH_CHILD_RESOURCES_DIGEST || manifest.owner.workspaceRoot !== launch.cwd) {
    throw new Error("Child Memory library does not match its Host grant");
  }
  return childMemoryLibrary(manifest);
}
