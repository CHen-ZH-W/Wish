import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEntryPatches, entryListSchema, type Include } from "@deepseek-ai/cordis-plugin-include";
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string, options: { schema: unknown }): unknown };
const includes = new Set(["cordis:include", "@deepseek-ai/cordis-plugin-include"]);

/** Managed Includes are read-only source composition. One Host owns the resulting
 * native Groups, revision and watches; Include's independent writer never mounts.
 * Entry IDs remain unique across the complete managed profile, as with Groups.
 */
export function readManagedProfile(filename: string): {
  entries: EntryOptions[]; digest: string; files: ReadonlyMap<string, string>; entrySources: ReadonlyMap<string, string>;
} {
  const files = new Map<string, string>(), entrySources = new Map<string, string>(), stack = new Set<string>();
  let count = 0;
  const read = (path: string, patches?: Include.Config["patches"]): EntryOptions[] => {
    const canonical = realpathSync(path);
    if (stack.has(canonical)) throw new Error("management_include_cycle");
    if (stack.size >= 32 || ++count > 128) throw new Error("management_include_limit");
    const content = readFileSync(path, "utf8");
    files.set(path, hash(content));
    const data = yaml.load(content, { schema: entryListSchema });
    if (!Array.isArray(data)) throw new Error("management_profile_invalid");
    stack.add(canonical);
    try {
      const normalize = (items: EntryOptions[]): EntryOptions[] => items.map(raw => {
        if (!raw || typeof raw !== "object" || typeof raw.name !== "string") throw new Error("management_profile_invalid");
        if (typeof raw.id === "string") entrySources.set(raw.id, path);
        if (includes.has(raw.name)) {
          const config = raw.config as Include.Config;
          if (raw.group || !config || Array.isArray(config) || typeof config.path !== "string" || !config.path ||
            (config.patches !== undefined && !Array.isArray(config.patches)) ||
            (config.enableLogs !== undefined && typeof config.enableLogs !== "boolean") ||
            Object.keys(config).some(key => !["path", "patches", "enableLogs"].includes(key))) {
            throw new Error("management_include_invalid");
          }
          const url = new URL(config.path, pathToFileURL(path));
          if (url.protocol !== "file:") throw new Error("management_include_invalid");
          return { ...raw, name: import.meta.resolve("@deepseek-ai/cordis-plugin-group"), group: true,
            config: read(fileURLToPath(url), config.patches) };
        }
        return { ...raw,
          // Preserve root entry identities used by existing saved preferences.
          name: path !== filename && /^(?:\.{1,2}\/|\/|file:)/u.test(raw.name) ? new URL(raw.name, pathToFileURL(path)).href : raw.name,
          ...(raw.group && Array.isArray(raw.config) ? { config: normalize(raw.config) } : {}),
        };
      });
      return normalize(applyEntryPatches(data, patches, () => { throw new Error("management_include_patch_invalid"); }));
    } finally { stack.delete(canonical); }
  };
  const entries = read(filename);
  // Keep the existing digest for single-file profiles and persisted recovery intents.
  const digest = files.size === 1 ? files.get(filename)! : hash(JSON.stringify([...files]));
  return { entries, digest, files, entrySources };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
