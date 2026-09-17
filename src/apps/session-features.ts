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
  inspect(sessionId: string): Promise<SessionFeatureView | undefined>;
  act(sessionId: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void>;
  beforeInput?(sessionId: string, text: string): Promise<void>;
  /** Domain-owned veto; deletion never implies cancelling or purging another module. */
  beforeRemoval?(sessionId: string): Promise<void>;
}

export interface SessionFeatures {
  inspect(sessionId: string): Promise<readonly SessionFeatureView[]>;
  act(sessionId: string, key: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void>;
  beforeInput(sessionId: string, text: string): Promise<void>;
  beforeRemoval?(sessionId: string): Promise<void>;
}

/** Only registrations live here. Domain state stays with each feature. */
export class SessionFeatureRegistry implements SessionFeatures {
  private readonly features = new Map<string, SessionFeature>();
  private readonly removalOwners = new Set<string>();
  register(key: string, feature: SessionFeature): () => void {
    if (this.features.has(key)) throw new Error(`Session feature already registered: ${key}`);
    this.features.set(key, feature);
    if (feature.beforeRemoval) this.removalOwners.add(key);
    return () => { if (this.features.get(key) === feature) this.features.delete(key); };
  }
  async inspect(sessionId: string): Promise<readonly SessionFeatureView[]> {
    const views = await Promise.all([...this.features.entries()].map(async ([key, feature]) => {
      try { const view = await feature.inspect(sessionId); return this.features.get(key) === feature ? view : undefined; }
      catch { return this.features.get(key) === feature ? { key, title: "模块信息暂不可用", titleEn: "Module information unavailable", text: "此模块的观察请求失败。请检查其插件与资源状态后刷新；其他模块不受影响。", textEn: "This module's inspection failed. Check its plugin and resource status, then refresh; other modules are unaffected.", token: {}, actions: [] } satisfies SessionFeatureView : undefined; }
    }));
    return views.filter((view): view is SessionFeatureView => view !== undefined);
  }
  async act(sessionId: string, key: string, action: string, token: Readonly<Record<string, unknown>>, feedback?: string): Promise<void> {
    const feature = this.features.get(key);
    if (!feature) throw new Error(`Session feature unavailable: ${key}`);
    await feature.act(sessionId, action, token, feedback);
  }
  async beforeInput(sessionId: string, text: string): Promise<void> {
    for (const feature of this.features.values()) await feature.beforeInput?.(sessionId, text);
  }
  async beforeRemoval(sessionId: string): Promise<void> {
    for (const key of this.removalOwners) {
      const feature = this.features.get(key);
      try {
        if (!feature?.beforeRemoval) throw new Error(`请先启用 ${key}，核对关联工作状态。`);
        await feature.beforeRemoval(sessionId);
        if (this.features.get(key) !== feature) throw new Error(`${key} 状态已变化，请刷新后重试。`);
      } catch (cause) {
        throw Object.assign(new Error(cause instanceof Error ? cause.message : "关联工作状态无法确认"), { code: "session_busy" });
      }
    }
  }
}
