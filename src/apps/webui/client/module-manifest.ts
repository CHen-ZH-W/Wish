export interface UiModuleEntry {
  readonly id: string; readonly url: string; readonly exportName: string; readonly entryIds: readonly string[];
}
export interface UiModuleManifest { readonly schemaVersion: 1; readonly core: string; readonly modules: readonly UiModuleEntry[] }
const asset = (value: unknown, directory: string): value is string => typeof value === "string" && new RegExp(`^/assets/${directory}/[A-Za-z0-9_-]+-[A-Z0-9]{8}\\.js$`).test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
/** Only a local build manifest can supply executable module URLs. Validate the whole batch first. */
export function parseUiModuleManifest(value: unknown): UiModuleManifest {
  if (!value || typeof value !== "object") throw new Error("invalid_ui_manifest");
  const manifest = value as Partial<UiModuleManifest>;
  if (manifest.schemaVersion !== 1 || !asset(manifest.core, "core") || !Array.isArray(manifest.modules) || manifest.modules.length > 100) throw new Error("invalid_ui_manifest");
  const seen = new Set<string>();
  const modules = manifest.modules.map((entry: UiModuleEntry) => {
    if (!entry || !identifier(entry.id) || !identifier(entry.exportName) || !asset(entry.url, "modules") || seen.has(entry.id)
      || !Array.isArray(entry.entryIds) || !entry.entryIds.length || entry.entryIds.length > 32
      || entry.entryIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(id))) throw new Error("invalid_ui_manifest");
    seen.add(entry.id);
    return Object.freeze({ id: entry.id, url: entry.url, exportName: entry.exportName, entryIds: Object.freeze([...entry.entryIds]) });
  });
  return Object.freeze({ schemaVersion: 1, core: manifest.core, modules: Object.freeze(modules) });
}
