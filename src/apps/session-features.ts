import type { RunInputSource } from "../core/agent/agent.js";
import type { ModelRef } from "../core/model/model.js";
import type { Session } from "../sessions/types.js";
import type { WishApplication, WishRunHandle } from "./types.js";

export interface SessionFeatureInputContext {
  readonly kind: "start" | "steer" | "follow_up";
  readonly runId?: string;
  readonly inputSource?: RunInputSource;
}

/** Accepted initial input, supplied only after Runtime admission succeeds. */
export interface SessionFeatureRunContext {
  readonly text: string;
  readonly inputSource?: RunInputSource;
  readonly model?: ModelRef;
}

/** Product capabilities expose human controls through this transport-neutral port. */
export interface SessionFeatureView {
  readonly key: string;
  readonly title: string;
  readonly titleEn?: string;
  readonly text: string;
  /** Optional owner-authored English explanation; never machine-translate user content. */
  readonly textEn?: string;
  /** Optional module-owned read projection; generic transports do not interpret it. */
  readonly data?: unknown;
  readonly actions: readonly { readonly name: string; readonly label: string; readonly labelEn?: string; readonly feedback?: boolean }[];
  readonly token: Readonly<Record<string, unknown>>;
}

export interface SessionFeature {
  /** Bind a consumer to the exact Session graph it owns; other graphs skip its hooks. */
  readonly sessionGraph?: object;
  /** Durable work owners retain cleanup guards when unloaded. Optional observers may opt out. */
  readonly retainOwnershipOnUnload?: boolean;
  /** Lower numbers release child execution before parent projections. */
  readonly purgeOrder?: number;
  inspect(sessionId: string): Promise<SessionFeatureView | undefined>;
  act(sessionId: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void>;
  beforeInput?(sessionId: string, text: string, context?: SessionFeatureInputContext): Promise<void>;
  /** Observe the admitted handle, whose completion includes Application cleanup.
   * Register observation only; awaiting this Run's completion would block admission. */
  runStarted?(application: WishApplication, handle: WishRunHandle, context?: SessionFeatureRunContext): Promise<void>;
  /** Observe committed metadata. Observers cannot roll back its successful write. */
  metadataUpdated?(session: Session): Promise<void>;
  /** Check/fence related work before archiving or deletion. */
  beforeRemoval?(sessionId: string, operation?: "archive" | "delete"): Promise<void>;
  /** Idempotent cleanup after an aborted Run has drained. */
  purgeRun?(sessionId: string, runId: string): Promise<void>;
  /** Idempotent cleanup before the owning Session is physically deleted. */
  purgeSession?(sessionId: string): Promise<void>;
}

export interface SessionFeatures {
  inspect(sessionId: string): Promise<readonly SessionFeatureView[]>;
  act(sessionId: string, key: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void>;
  beforeInput(sessionId: string, text: string, context?: SessionFeatureInputContext): Promise<void>;
  runStarted?(application: WishApplication, handle: WishRunHandle, context?: SessionFeatureRunContext): Promise<void>;
  metadataUpdated?(session: Session): Promise<void>;
  beforeRemoval?(sessionId: string, operation?: "archive" | "delete"): Promise<void>;
  purgeRun?(sessionId: string, runId: string): Promise<void>;
  purgeSession?(sessionId: string): Promise<void>;
}

/** Only registrations live here. Domain state stays with each feature. */
export class SessionFeatureRegistry implements SessionFeatures {
  private readonly features: Map<string, SessionFeature>;
  private readonly removalOwners: Set<string>;
  private readonly cleanupOwners: Map<string, number>;
  private readonly featureGraphs: Map<string, object | undefined>;
  constructor(parent?: SessionFeatureRegistry, private readonly graph?: object) {
    this.features = parent?.features ?? new Map();
    this.removalOwners = parent?.removalOwners ?? new Set();
    this.cleanupOwners = parent?.cleanupOwners ?? new Map();
    this.featureGraphs = parent?.featureGraphs ?? new Map();
  }
  /** A live view of the same registrations, restricted to one persistence graph. */
  forGraph(identity: object): SessionFeatures { return new SessionFeatureRegistry(this, identity); }
  private applies(key: string): boolean {
    const bound = this.featureGraphs.get(key);
    return this.graph === undefined || bound === undefined || bound === this.graph;
  }
  private entries(): [string, SessionFeature][] { return [...this.features].filter(([key]) => this.applies(key)); }
  register(key: string, feature: SessionFeature): () => void {
    if (this.features.has(key)) throw new Error(`Session feature already registered: ${key}`);
    this.features.set(key, feature);
    this.featureGraphs.set(key, feature.sessionGraph);
    if (feature.beforeRemoval) this.removalOwners.add(key);
    if (feature.purgeRun || feature.purgeSession) this.cleanupOwners.set(key, feature.purgeOrder ?? 100);
    return () => {
      if (this.features.get(key) !== feature) return;
      this.features.delete(key);
      if (feature.retainOwnershipOnUnload === false) {
        this.removalOwners.delete(key);
        this.cleanupOwners.delete(key);
        this.featureGraphs.delete(key);
      }
    };
  }
  async inspect(sessionId: string): Promise<readonly SessionFeatureView[]> {
    const views = await Promise.all(this.entries().map(async ([key, feature]) => {
      try { const view = await feature.inspect(sessionId); return this.features.get(key) === feature ? view : undefined; }
      catch { return this.features.get(key) === feature ? { key, title: "模块信息暂不可用", titleEn: "Module information unavailable", text: "此模块的观察请求失败。请检查其插件与资源状态后刷新；其他模块不受影响。", textEn: "This module's inspection failed. Check its plugin and resource status, then refresh; other modules are unaffected.", token: {}, actions: [] } satisfies SessionFeatureView : undefined; }
    }));
    return views.filter((view): view is SessionFeatureView => view !== undefined);
  }
  async act(sessionId: string, key: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void> {
    const feature = this.applies(key) ? this.features.get(key) : undefined;
    if (!feature) throw new Error(`Session feature unavailable: ${key}`);
    await feature.act(sessionId, action, token, feedback);
  }
  async beforeInput(sessionId: string, text: string, context?: SessionFeatureInputContext): Promise<void> {
    for (const [, feature] of this.entries()) await feature.beforeInput?.(sessionId, text, context);
  }
  async runStarted(application: WishApplication, handle: WishRunHandle, context?: SessionFeatureRunContext): Promise<void> {
    for (const [, feature] of this.entries()) if (feature.runStarted) await feature.runStarted(application, handle, context);
  }
  async metadataUpdated(session: Session): Promise<void> {
    await Promise.allSettled(this.entries().map(([, feature]) => feature.metadataUpdated?.(session)));
  }
  async beforeRemoval(sessionId: string, operation: "archive" | "delete" = "archive"): Promise<void> {
    for (const key of this.removalOwners) {
      if (!this.applies(key)) continue;
      const feature = this.features.get(key);
      try {
        if (!feature?.beforeRemoval) throw new Error(`请先启用 ${key}，核对关联工作状态。`);
        await feature.beforeRemoval(sessionId, operation);
        if (this.features.get(key) !== feature) throw new Error(`${key} 状态已变化，请刷新后重试。`);
      } catch (cause) {
        throw Object.assign(new Error(cause instanceof Error ? cause.message : "关联工作状态无法确认"), { code: "session_busy" });
      }
    }
  }
  async purgeRun(sessionId: string, runId: string): Promise<void> {
    for (const [key, feature] of this.purgeOwners()) {
      if (!feature.purgeRun) continue;
      await feature.purgeRun(sessionId, runId);
      if (this.features.get(key) !== feature) throw new Error(`${key} changed during Run cleanup`);
    }
  }
  async purgeSession(sessionId: string): Promise<void> {
    for (const [key, feature] of this.purgeOwners()) {
      if (!feature.purgeSession) continue;
      await feature.purgeSession(sessionId);
      if (this.features.get(key) !== feature) throw new Error(`${key} changed during Session cleanup`);
    }
  }
  private purgeOwners(): [string, SessionFeature][] {
    return [...this.cleanupOwners].filter(([key]) => this.applies(key)).sort((a, b) => a[1] - b[1]).map(([key]) => {
      const feature = this.features.get(key);
      if (!feature) throw new Error(`Cleanup owner ${key} is unavailable`);
      return [key, feature];
    });
  }
}
