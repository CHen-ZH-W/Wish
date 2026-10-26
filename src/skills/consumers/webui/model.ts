import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { SkillImportCapabilities, SkillImportFile } from "../../import-types.js";
export type { SkillImportFile } from "../../import-types.js";
import type { SkillFeatureData, SkillFeatureEntry } from "../../presentation.js";
import type { SkillDocumentView, SkillsLibraryView, SkillImportView } from "../webui-types.js";

export interface SkillsClientSnapshot {
  readonly catalog: SkillsLibraryView | null;
  readonly skills: readonly SkillFeatureEntry[];
  readonly issues: SkillFeatureData["issues"];
  readonly selected: SkillDocumentView | null;
  readonly selectedName: string | null;
  readonly selectionChanged: boolean;
  readonly available: boolean;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly reading: boolean;
  readonly importing: boolean;
  readonly error: string | null;
}
type SkillsConnection = Pick<ClientConnection, "getSnapshot" | "subscribe" | "onInvalidation" | "request">;
const CONTROL_PATH = "/api/controls/skills/default";

/** A Host-owned Skill library, independent of the selected conversation. */
export class SkillsClientModel extends SnapshotStore<SkillsClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removeConnection: () => void;
  private readonly removeInvalidation: () => void;
  private closed = false;
  private version = 0;
  private selectionVersion = 0;
  private observedScope: string;
  private observedInstance: string | null;
  private refreshAfterImport = false;

  constructor(private readonly connection: SkillsConnection) {
    super({ catalog: null, skills: [], issues: [], selected: null, selectedName: null, selectionChanged: false,
      available: false, pending: false, loading: false, reading: false, importing: false, error: null });
    this.observedScope = this.scope();
    this.observedInstance = connection.getSnapshot().instanceId;
    this.queue = new RefreshQueue(async current => {
      if (!this.connected()) return;
      if (this.getSnapshot().importing) { this.refreshAfterImport = true; return; }
      const version = this.version, scope = this.scope();
      this.publish({ ...this.getSnapshot(), loading: true, pending: true });
      const fresh = () => current() && this.current(version, scope);
      try {
        const response = await connection.request<{ value: unknown }>(CONTROL_PATH);
        if (!fresh()) return;
        const catalog = parseSkillsLibrary(response.value);
        if (!catalog) throw new Error("skills_invalid_response");
        this.adoptCatalog(catalog);
      } catch (error) {
        if (fresh()) this.publish({ ...this.getSnapshot(), available: false, error: message(error) });
      } finally {
        if (fresh()) this.publish({ ...this.getSnapshot(), loading: false, pending: this.getSnapshot().importing });
      }
    });
    this.removeConnection = connection.subscribe(() => {
      const scope = this.scope();
      if (scope === this.observedScope || this.closed) return;
      this.observedScope = scope;
      const instanceChanged = this.observedInstance !== connection.getSnapshot().instanceId;
      this.observedInstance = connection.getSnapshot().instanceId;
      this.version++; this.selectionVersion++;
      this.refreshAfterImport = false;
      this.publish({ ...this.getSnapshot(), ...(instanceChanged ? { catalog: null, skills: [], issues: [], selected: null, selectedName: null, selectionChanged: false } : {}), available: false, loading: false, pending: false, reading: false, importing: false,
        error: this.connected() ? null : connection.getSnapshot().error });
      if (this.connected()) void this.refresh();
    });
    this.removeInvalidation = connection.onInvalidation(() => { void this.refresh(); });
    if (this.connected()) void this.refresh();
  }

  refresh = (): Promise<void> => {
    if (this.closed) return Promise.resolve();
    if (!this.connected()) {
      this.publish({ ...this.getSnapshot(), available: false, error: this.connection.getSnapshot().error });
      return Promise.resolve();
    }
    if (this.getSnapshot().importing) { this.refreshAfterImport = true; return Promise.resolve(); }
    return this.queue.request();
  };

  select = (name: string): Promise<void> => this.read(name);

  private read = async (name: string, allowDuringImport = false): Promise<void> => {
    const state = this.getSnapshot(), entry = state.skills.find(skill => skill.name === name);
    if (this.closed || !this.connected() || !state.available || (state.importing && !allowDuringImport) || !entry) return;
    const version = this.version, scope = this.scope(), selection = ++this.selectionVersion;
    this.publish({ ...state, selectedName: name, reading: true, error: null, selectionChanged: false });
    const fresh = () => this.current(version, scope) && selection === this.selectionVersion
      && this.getSnapshot().skills.some(skill => sameEntry(skill, entry));
    try {
      const response = await this.connection.request<{ value: unknown }>("/api/queries/skills/default", {
        name, expectedDigest: entry.digest, expectedPackageId: entry.packageId,
      });
      if (!fresh()) return;
      const selected = parseSkillDocument(response.value);
      if (!selected || !sameEntry(selected.entry, entry)) throw new Error("skills_invalid_response");
      this.publish({ ...this.getSnapshot(), selected, reading: false, selectionChanged: false, error: null });
    } catch (error) {
      if (fresh()) this.publish({ ...this.getSnapshot(), available: false, selectedName: this.getSnapshot().selected?.entry.name ?? null, reading: false, error: message(error) });
    } finally {
      if (this.current(version, scope) && selection === this.selectionVersion && this.getSnapshot().reading) {
        this.publish({ ...this.getSnapshot(), reading: false });
      }
    }
  };

  importPackage = async (files: readonly SkillImportFile[], overwrite = false): Promise<SkillFeatureEntry> => {
    const state = this.getSnapshot();
    if (this.closed || !this.connected() || !state.available || state.importing || !state.catalog?.import) throw new Error("skills_import_unavailable");
    const frozenFiles = Object.freeze(files.map(file => Object.freeze({ path: file.path, content: file.content })));
    const body = { files: frozenFiles, expectedCatalogDigest: state.catalog.catalogDigest, overwrite };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 1_048_576) throw new Error("skills_import_request_too_large");
    const version = ++this.version, scope = this.scope(); this.selectionVersion++;
    this.publish({ ...state, importing: true, loading: false, reading: false, pending: true, error: null });
    try {
      const response = await this.connection.request<{ value: unknown }>(CONTROL_PATH, body);
      if (!this.current(version, scope)) throw new Error("skills_import_state_changed");
      const value = parseSkillImport(response.value);
      if (!value) throw new Error("skills_invalid_response");
      this.adoptCatalog(value.catalog);
      this.publish({ ...this.getSnapshot(), selected: null, selectedName: value.imported.name, selectionChanged: false });
      await this.read(value.imported.name, true);
      if (!this.current(version, scope)) throw new Error("skills_import_state_changed");
      return value.imported;
    } catch (error) {
      if (this.current(version, scope)) this.publish({ ...this.getSnapshot(), available: false, error: message(error) });
      throw error;
    } finally {
      if (this.current(version, scope)) {
        this.publish({ ...this.getSnapshot(), importing: false, loading: false, pending: false });
        if (this.refreshAfterImport) { this.refreshAfterImport = false; void this.refresh(); }
      }
    }
  };

  clearSelection = (): void => {
    if (this.closed) return;
    this.selectionVersion++;
    this.publish({ ...this.getSnapshot(), selected: null, selectedName: null, reading: false, selectionChanged: false });
  };

  close(): void {
    this.closed = true; this.version++; this.selectionVersion++;
    this.queue.close(); this.removeConnection(); this.removeInvalidation();
  }

  private adoptCatalog(catalog: SkillsLibraryView): void {
    const before = this.getSnapshot(), selected = before.selected;
    const retained = selected && catalog.skills.some(entry => sameEntry(entry, selected.entry)) ? selected : null;
    if (selected && !retained) this.selectionVersion++;
    this.publish({ ...before, catalog, skills: catalog.skills, issues: catalog.issues, selected: retained,
      selectionChanged: !!selected && !retained, selectedName: !(selected && !retained) && before.selectedName && catalog.skills.some(entry => entry.name === before.selectedName) ? before.selectedName : null, available: true, error: null,
      reading: selected && !retained ? false : before.reading });
  }
  private connected(): boolean { const state = this.connection.getSnapshot(); return state.online && state.businessAvailable && !!state.instanceId; }
  private scope(): string { const state = this.connection.getSnapshot(); return JSON.stringify([state.instanceId, state.online, state.businessAvailable]); }
  private current(version: number, scope: string): boolean { return !this.closed && this.connected() && version === this.version && scope === this.scope(); }
}

/** Read all chosen files before replacing a valid draft; undecodable files never reach the Host. */
export async function readSkillImportFiles(files: readonly File[], limits: SkillImportCapabilities): Promise<readonly SkillImportFile[]> {
  if (!files.length || files.length > limits.maxFiles) throw new Error("skills_import_file_count");
  let total = 0;
  for (const file of files) {
    if (file.size > limits.maxFileBytes) throw new Error("skills_import_file_too_large");
    total += file.size;
    if (total > limits.maxPackageBytes) throw new Error("skills_import_package_too_large");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result: SkillImportFile[] = [];
  for (const file of files) {
    let content: string;
    try { content = decoder.decode(await file.arrayBuffer()); }
    catch { throw new Error("skills_import_invalid_utf8"); }
    if (content.includes("\0")) throw new Error("skills_import_invalid_utf8");
    result.push(Object.freeze({ path: file.webkitRelativePath || file.name, content }));
  }
  return Object.freeze(result);
}

export function parseSkillsLibrary(value: unknown): SkillsLibraryView | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.workspace) || !text(value.workspace.root, 4096)
    || !text(value.workspace.fingerprint, 256) || !text(value.workspace.revision, 256) || !text(value.catalogDigest, 256)) return undefined;
  const skills = parseEntries(value.skills), issues = parseIssues(value.issues);
  if (!skills || !issues) return undefined;
  let capabilities: SkillImportCapabilities | undefined;
  if (value.import !== undefined) {
    if (!record(value.import) || !positiveInteger(value.import.maxFiles) || !positiveInteger(value.import.maxFileBytes) || !positiveInteger(value.import.maxPackageBytes)) return undefined;
    capabilities = Object.freeze({ maxFiles: value.import.maxFiles, maxFileBytes: value.import.maxFileBytes, maxPackageBytes: value.import.maxPackageBytes });
  }
  return Object.freeze({ schemaVersion: 1, workspace: Object.freeze({ root: value.workspace.root, fingerprint: value.workspace.fingerprint, revision: value.workspace.revision }),
    catalogDigest: value.catalogDigest, skills, issues, ...(capabilities ? { import: capabilities } : {}) });
}

export function parseSkillDocument(value: unknown): SkillDocumentView | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !text(value.content, 1_000_000, true)) return undefined;
  const entry = parseEntry(value.entry);
  return entry ? Object.freeze({ schemaVersion: 1, entry, content: value.content }) : undefined;
}
function parseSkillImport(value: unknown): SkillImportView | undefined {
  if (!record(value) || value.schemaVersion !== 1) return undefined;
  const catalog = parseSkillsLibrary(value.catalog), imported = parseEntry(value.imported);
  if (!catalog || !imported || !catalog.skills.some(entry => sameEntry(entry, imported))) return undefined;
  return Object.freeze({ schemaVersion: 1, catalog, imported });
}

/** Kept for consumers of the older Session-feature wire projection. */
export function parseSkillFeatureData(value: unknown): SkillFeatureData | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.workspace) || !text(value.workspace.fingerprint, 256) || !text(value.workspace.revision, 256)
    || typeof value.selectionChanged !== "boolean") return undefined;
  const skills = parseEntries(value.skills), issues = parseIssues(value.issues);
  if (!skills || !issues) return undefined;
  let selected: SkillFeatureData["selected"];
  if (value.selected !== undefined) {
    if (!record(value.selected) || !text(value.selected.content, 1_000_000, true)) return undefined;
    const parsed = parseEntry(value.selected.entry);
    const entry = parsed && skills.find(skill => sameEntry(skill, parsed));
    if (!entry) return undefined;
    selected = Object.freeze({ entry, content: value.selected.content });
  }
  return Object.freeze({ schemaVersion: 1, workspace: Object.freeze({ fingerprint: value.workspace.fingerprint, revision: value.workspace.revision }),
    skills, issues, ...(selected ? { selected } : {}), selectionChanged: value.selectionChanged });
}
function parseEntries(value: unknown): readonly SkillFeatureEntry[] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const entries: SkillFeatureEntry[] = [];
  const names = new Set<string>();
  for (const item of value) { const entry = parseEntry(item); if (!entry || names.has(entry.name)) return undefined; names.add(entry.name); entries.push(entry); }
  return Object.freeze(entries);
}
function parseEntry(value: unknown): SkillFeatureEntry | undefined {
  if (!record(value) || !text(value.packageId, 256) || !text(value.name, 128) || !text(value.description, 4096, true)
    || (value.source !== "user" && value.source !== "workspace") || !text(value.digest, 256) || typeof value.modelInvocable !== "boolean") return undefined;
  return Object.freeze({ packageId: value.packageId, name: value.name, description: value.description,
    source: value.source, digest: value.digest, modelInvocable: value.modelInvocable });
}
function parseIssues(value: unknown): SkillFeatureData["issues"] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const issues: { location: string; message: string }[] = [];
  for (const issue of value) { if (!record(issue) || !text(issue.location, 4096) || !text(issue.message, 4096)) return undefined; issues.push(Object.freeze({ location: issue.location, message: issue.message })); }
  return Object.freeze(issues);
}
function sameEntry(a: SkillFeatureEntry, b: SkillFeatureEntry): boolean { return a.packageId === b.packageId && a.digest === b.digest && a.name === b.name && a.source === b.source; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && value.length <= max && (empty || value.length > 0); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
