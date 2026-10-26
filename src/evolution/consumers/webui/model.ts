import type { ClientConnection } from "../../../apps/webui/client/connection.js";
import { SnapshotStore } from "../../../apps/webui/client/model/store.js";
import type { EvolutionCampaign, EvolutionTarget } from "../../types.js";
import type { EvolutionTriggerSuggestion } from "../../triggers.js";
import type { EvolutionCampaignView, EvolutionSourceDetail } from "../../presentation.js";

export interface EvolutionClientSnapshot {
  readonly campaigns: readonly EvolutionCampaignView[];
  readonly traces: readonly { readonly id: string; readonly summary: string; readonly terminalStatus: string; readonly capturedAt: string }[];
  readonly available: boolean; readonly loading: boolean; readonly pending: boolean; readonly error: string | null;
  readonly trigger?: { readonly mode: string; readonly suggestions: readonly EvolutionTriggerSuggestion[] } | null;
}
export class EvolutionClientModel extends SnapshotStore<EvolutionClientSnapshot> {
  private sessionId = "";
  private generation = 0;
  private active = false;
  private flight: Promise<void> | undefined;
  private creation: { key: string; id: string } | undefined;
  private actionError: string | null = null;
  constructor(private readonly connection: Pick<ClientConnection, "request">) {
    super({ campaigns: [], traces: [], available: false, loading: true, pending: false, error: null });
  }
  activate(sessionId: string): () => void {
    this.generation++; this.active = true; this.flight = undefined;
    if (sessionId !== this.sessionId) { this.sessionId = sessionId; this.creation = undefined; this.actionError = null; this.publish({ campaigns: [], traces: [], available: false, loading: true, pending: false, error: null }); }
    void this.refresh();
    const timer = setInterval(() => { void this.refresh(); }, 2500);
    return () => { clearInterval(timer); this.active = false; this.generation++; this.flight = undefined; };
  }
  refresh = (): Promise<void> => {
    if (!this.active || this.getSnapshot().pending || this.flight) return this.flight ?? Promise.resolve();
    const generation = this.generation, sessionId = this.sessionId;
    const task = (async () => {
      try {
        const { value } = await this.connection.request<{ value: Pick<EvolutionClientSnapshot, "campaigns" | "traces" | "available" | "trigger"> }>(path(sessionId));
        if (!this.active || generation !== this.generation) return;
        if (!Array.isArray(value.campaigns) || !Array.isArray(value.traces)) throw new Error("evolution_invalid_response");
        this.publish({ ...this.getSnapshot(), campaigns: value.campaigns, traces: value.traces, available: value.available, trigger: value.trigger ?? null, loading: false, error: this.actionError });
      } catch (error) { if (this.active && generation === this.generation) this.publish({ ...this.getSnapshot(), available: false, loading: false, error: message(error) }); }
    })();
    this.flight = task;
    void task.finally(() => { if (this.flight === task) this.flight = undefined; });
    return task;
  };
  async create(objective: string, target: EvolutionTarget, generator: "structured" | "runtime" = "structured"): Promise<void> {
    const key = JSON.stringify({ sessionId: this.sessionId, objective, target, generator });
    if (this.creation?.key !== key) this.creation = { key, id: crypto.randomUUID() };
    const creation = this.creation;
    await this.mutate({ action: "create", requestId: creation.id, objective, target, generator });
    if (this.creation === creation) this.creation = undefined;
  }
  async act(campaign: Pick<EvolutionCampaign, "id" | "revision">, action: string, feedback?: string): Promise<void> {
    if (!this.getSnapshot().campaigns.some(item => item.id === campaign.id && item.revision === campaign.revision)) throw new Error("evolution_conflict");
    await this.mutate({ action, requestId: crypto.randomUUID(), campaignId: campaign.id, expectedRevision: campaign.revision, ...(feedback ? { feedback } : {}) });
  }
  async source(campaign: Pick<EvolutionCampaign, "id">, attemptId: string, sourceDigest: string): Promise<EvolutionSourceDetail> {
    if (!this.active) throw new Error("evolution_unavailable");
    const sessionId = this.sessionId;
    const { value } = await this.connection.request<{ value: EvolutionSourceDetail }>(`/api/sessions/${encodeURIComponent(sessionId)}/queries/wish-evolution`, { action: "source", campaignId: campaign.id, attemptId, sourceDigest });
    if (!this.active || sessionId !== this.sessionId) throw new Error("evolution_source_view_changed");
    if (value.sourceDigest !== sourceDigest || !value.source?.files || typeof value.source.files !== "object") throw new Error("evolution_invalid_source_response");
    return value;
  }
  private async mutate(body: unknown): Promise<void> {
    const before = this.getSnapshot(); if (!this.active || !before.available || before.pending) throw new Error("evolution_unavailable");
    const sessionId = this.sessionId, generation = ++this.generation;
    this.actionError = null;
    this.flight = undefined; this.publish({ ...before, pending: true, error: null });
    try {
      const { value } = await this.connection.request<{ value: { campaign: EvolutionCampaignView } }>(path(sessionId), body);
      if (!this.active || generation !== this.generation) return;
      const campaign = value.campaign;
      this.publish({ ...this.getSnapshot(), campaigns: [campaign, ...this.getSnapshot().campaigns.filter(item => item.id !== campaign.id)] });
    } catch (error) {
      if (this.active && generation === this.generation) { this.actionError = message(error); this.publish({ ...this.getSnapshot(), error: this.actionError }); }
      throw error;
    } finally {
      if (this.active && generation === this.generation) { this.publish({ ...this.getSnapshot(), pending: false }); await this.refresh(); }
    }
  }
}
function path(sessionId: string) { return `/api/sessions/${encodeURIComponent(sessionId)}/controls/wish-evolution`; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
