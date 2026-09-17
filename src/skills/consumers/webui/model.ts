import type { FeaturesClientModel } from "../../../apps/webui/client/model/features.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { SessionFeatureView } from "../../../apps/session-features.js";
import type { SkillFeatureData, SkillFeatureEntry } from "../../presentation.js";

export interface SkillsClientSnapshot {
  readonly sessionId: string | null;
  readonly skills: readonly SkillFeatureEntry[];
  readonly issues: SkillFeatureData["issues"];
  readonly selected?: SkillFeatureData["selected"];
  readonly selectionChanged: boolean;
  readonly available: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}

/** React-free projection for the Skills panel; canonical catalog state stays on the Host. */
export class SkillsClientModel extends SnapshotStore<SkillsClientSnapshot> {
  private readonly remove: () => void;
  private closed = false;
  private actionError: string | null = null;

  constructor(private readonly features: FeaturesClientModel) {
    super(emptySnapshot(features.getSnapshot().sessionId));
    this.remove = features.subscribe(this.project);
    this.project();
  }

  refresh = (): Promise<void> => this.features.refresh();

  select = async (name: string): Promise<void> => {
    if (this.closed || this.getSnapshot().pending) return;
    const state = this.features.getSnapshot(), view = skillView(state.views), data = view && parseSkillFeatureData(view.data);
    if (!state.sessionId || !state.available || !view || !data || !data.skills.some(skill => skill.name === name) || !view.actions.some(action => action.name === "inspect")) {
      this.actionError = "Skill 目录已变化，请重新打开当前目录。"; this.project(); return;
    }
    this.actionError = null; this.project();
    try { await this.features.act(state.sessionId, view, "inspect", name); }
    catch (error) { this.actionError = error instanceof Error ? error.message : "Skill 读取失败"; this.project(); }
  };

  close(): void { this.closed = true; this.remove(); }

  private project = (): void => {
    if (this.closed) return;
    const state = this.features.getSnapshot();
    if (state.sessionId !== this.getSnapshot().sessionId) this.actionError = null;
    const view = skillView(state.views), data = view && parseSkillFeatureData(view.data);
    if (!state.sessionId) { this.publish(emptySnapshot(null, state.error)); return; }
    if (!data) {
      this.publish({ ...emptySnapshot(state.sessionId, this.actionError ?? state.error ?? (view ? "Skill 目录暂不可用。" : null)), pending: state.pending }); return;
    }
    this.publish(Object.freeze({ sessionId: state.sessionId, skills: data.skills, issues: data.issues,
      ...(data.selected ? { selected: data.selected } : {}), selectionChanged: data.selectionChanged,
      available: state.available, pending: state.pending, error: this.actionError ?? state.error }));
  };
}

function skillView(views: readonly SessionFeatureView[]): SessionFeatureView | undefined {
  return views.find(view => view.key === "skills");
}

function emptySnapshot(sessionId: string | null, error: string | null = null): SkillsClientSnapshot {
  return Object.freeze({ sessionId, skills: Object.freeze([]), issues: Object.freeze([]), selectionChanged: false, available: false, pending: false, error });
}

export function parseSkillFeatureData(value: unknown): SkillFeatureData | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.workspace) || !text(value.workspace.fingerprint, 256) || !text(value.workspace.revision, 256)
    || !Array.isArray(value.skills) || value.skills.length > 1000 || !Array.isArray(value.issues) || value.issues.length > 1000 || typeof value.selectionChanged !== "boolean") return undefined;
  const skills: SkillFeatureEntry[] = [];
  for (const item of value.skills) {
    if (!record(item) || !text(item.packageId, 256) || !text(item.name, 128) || !text(item.description, 4096, true)
      || (item.source !== "user" && item.source !== "workspace") || !text(item.digest, 256) || typeof item.modelInvocable !== "boolean") return undefined;
    skills.push(Object.freeze({ packageId: item.packageId, name: item.name, description: item.description,
      source: item.source, digest: item.digest, modelInvocable: item.modelInvocable }));
  }
  const issues: { location: string; message: string }[] = [];
  for (const issue of value.issues) {
    if (!record(issue) || !text(issue.location, 4096) || !text(issue.message, 4096)) return undefined;
    issues.push(Object.freeze({ location: issue.location, message: issue.message }));
  }
  let selected: SkillFeatureData["selected"];
  if (value.selected !== undefined) {
    const selectedValue = value.selected;
    if (!record(selectedValue) || !text(selectedValue.content, 1_000_000, true)) return undefined;
    const selectedEntry = selectedValue.entry;
    if (!record(selectedEntry)) return undefined;
    const entry = skills.find(skill => skill.packageId === selectedEntry.packageId && skill.digest === selectedEntry.digest && skill.name === selectedEntry.name);
    if (!entry) return undefined;
    selected = Object.freeze({ entry, content: selectedValue.content });
  }
  return Object.freeze({ schemaVersion: 1, workspace: Object.freeze({ fingerprint: value.workspace.fingerprint, revision: value.workspace.revision }),
    skills: Object.freeze(skills), issues: Object.freeze(issues), ...(selected ? { selected } : {}), selectionChanged: value.selectionChanged });
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && value.length <= max && (empty || value.length > 0); }
