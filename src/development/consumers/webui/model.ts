import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import type { SessionClientModel } from "../../../apps/webui/client/model/session.js";
import { RefreshQueue, SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { DevelopmentProject } from "../../types.js";

export const DEVELOPMENT_CONTROL = "wish-development";
export interface DevelopmentClientSnapshot {
  readonly projects: readonly DevelopmentProject[];
  readonly sessionProjectId: string | null;
  readonly sessionId: string | null;
  readonly available: boolean;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}
type SessionModel = Pick<SessionClientModel, "getSnapshot" | "subscribe" | "refresh">;

/** Projects follow the selected conversation's workspace; the browser owns no product mode or project registry. */
export class DevelopmentClientModel extends SnapshotStore<DevelopmentClientSnapshot> {
  private readonly queue: RefreshQueue;
  private readonly removeSession: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private mutationVersion = 0;
  private observedWorking: boolean;
  private actionError: string | null = null;
  constructor(private readonly connection: Pick<ClientConnection, "request">, private readonly sessions: SessionModel) {
    super({ projects: [], sessionProjectId: null, sessionId: sessions.getSnapshot().selectedId, available: false, pending: false, loading: true, error: null });
    this.observedWorking = sessions.getSnapshot().working;
    this.queue = new RefreshQueue(async current => {
      const selected = sessions.getSnapshot();
      if (!selected.available) { this.publish({ ...this.getSnapshot(), available: false, loading: false }); return; }
      // A same-Session mutation temporarily blocks actions, while its last
      // verified project stays readable until the Session settles and refreshes.
      if (selected.working) { this.publish({ ...this.getSnapshot(), available: false, loading: false }); return; }
      const mutation = this.mutationVersion;
      const sessionId = selected.selectedId;
      const [list, session] = await Promise.allSettled([
        connection.request<{ value: { projects: readonly DevelopmentProject[] } }>(`/api/controls/${DEVELOPMENT_CONTROL}/default`),
        sessionId ? connection.request<{ value: { project: DevelopmentProject | null } }>(sessionPath(sessionId)) : Promise.resolve(null),
      ]);
      if (!current() || this.closed || mutation !== this.mutationVersion || sessions.getSnapshot().selectedId !== selected.selectedId || sessions.getSnapshot().working !== selected.working || !sessions.getSnapshot().available) return;
      if (list.status === "rejected") { this.publish({ ...this.getSnapshot(), available: false, loading: false, error: message(list.reason) }); return; }
      const projects = list.value.value.projects;
      if (!Array.isArray(projects)) { this.publish({ ...this.getSnapshot(), available: false, loading: false, error: "development_invalid_response" }); return; }
      const workspaceRoot = selected.sessions.find(item => item.sessionId === sessionId)?.scope;
      const bound = session.status === "fulfilled" ? session.value?.value.project ?? null : null;
      const project = workspaceRoot ? (bound?.workspaceRoot === workspaceRoot ? bound : projects.find(item => item.workspaceRoot === workspaceRoot)) : undefined;
      const before = this.getSnapshot();
      this.publish({ ...before, projects, sessionProjectId: project?.id ?? null, sessionId: selected.selectedId, available: true, loading: false, error: this.actionError });
    });
    this.removeSession = sessions.subscribe(() => {
      const session = sessions.getSnapshot();
      if (session.working !== this.observedWorking) {
        this.observedWorking = session.working;
        this.mutationVersion++;
        if (session.working) this.publish({ ...this.getSnapshot(), available: false });
      }
      if (session.selectedId !== this.getSnapshot().sessionId || !session.available) {
        if (session.selectedId !== this.getSnapshot().sessionId) this.actionError = null;
        this.mutationVersion++;
        this.publish({ ...this.getSnapshot(), sessionId: session.selectedId, sessionProjectId: null, available: session.available && this.getSnapshot().available });
      }
      void this.refresh();
    });
    this.timer = setInterval(() => { void this.refresh(); }, 3000);
    void this.refresh();
  }
  refresh = (): Promise<void> => this.queue.request();
  canAct(project?: DevelopmentProject): boolean {
    const state = this.getSnapshot(), session = this.sessions.getSnapshot();
    const selected = session.sessions.find(item => item.sessionId === session.selectedId);
    const change = project?.changes.find(item => item.id === project.activeChangeId) ?? project?.changes.at(-1);
    return !this.closed && state.available && !state.pending && session.available && !session.working && !!selected && selected.status === "active"
      && state.sessionId === selected.sessionId && (!project || selected.scope === project.workspaceRoot && (!change || change.sessionId === selected.sessionId));
  }
  hasActiveRun(): boolean { return this.sessions.getSnapshot().runs.some(run => run.status === "running"); }
  act = async (action: string, project: DevelopmentProject, data: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    const before = this.getSnapshot(), sessionId = this.sessions.getSnapshot().selectedId;
    if (!sessionId || !this.canAct(project)) throw new Error("development_session_changed");
    if (before.sessionProjectId !== project.id || !before.projects.some(item => item.id === project.id && item.revision === project.revision)) throw new Error("development_revision_conflict");
    const mutation = ++this.mutationVersion;
    this.actionError = null;
    this.publish({ ...before, pending: true, error: null });
    try {
      const { value } = await this.connection.request<{ value: { project: DevelopmentProject | null; runId?: string } }>(sessionPath(sessionId), {
        action, requestId: globalThis.crypto.randomUUID(), projectId: project.id, expectedRevision: project.revision, data,
      });
      if (!this.closed && mutation === this.mutationVersion && this.sessions.getSnapshot().selectedId === sessionId && !this.sessions.getSnapshot().working && value.project) {
        this.mutationVersion++;
        const updated = value.project;
        const projects = [...this.getSnapshot().projects.filter(item => item.id !== updated.id), updated];
        this.publish({ ...this.getSnapshot(), projects, sessionProjectId: updated.id });
      }
      await this.sessions.refresh();
    } catch (error) {
      if (!this.closed && this.sessions.getSnapshot().selectedId === sessionId) { this.actionError = message(error); this.publish({ ...this.getSnapshot(), error: this.actionError }); }
      throw error;
    } finally {
      if (!this.closed) { this.mutationVersion++; this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); }
    }
  };
  close(): void { this.closed = true; this.mutationVersion++; clearInterval(this.timer); this.queue.close(); this.removeSession(); }
}

function sessionPath(sessionId: string): string { return `/api/sessions/${encodeURIComponent(sessionId)}/controls/${DEVELOPMENT_CONTROL}`; }
function message(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}
