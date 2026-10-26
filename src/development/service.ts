import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../boot/plugin-control/work-owner.js";
import type { StorageBackendLease } from "../storage/backend.js";
import type { WishApplication, WishRunHandle } from "../apps/types.js";
import { DevelopmentController } from "./controller.js";
import { DevelopmentRuntime } from "./runtime.js";
import { DomainDevelopmentStore } from "./store.js";
import { DomainDevelopmentOperations } from "./operations.js";
import type { Development, DevelopmentProject } from "./types.js";

export interface Config { readonly backendId?: string }
export const Config: s<Config> = s.object({ backendId: s.string() });

/** Replaceable product owner. Core execution never depends on this service. */
export class WishDevelopment extends Service {
  static readonly inject = ["storageBackend", "plan", "application"];
  static readonly Config = Config;
  readonly state: Development;
  private readonly raw: DevelopmentRuntime;
  private readonly controller: DevelopmentController;
  private readonly lease: StorageBackendLease;
  private readonly ready: Promise<void>;
  private readonly work: PluginWorkOwner;
  private readonly executionGuards = new Set<symbol>();
  get activeRunCount(): number { return this.controller.activeRunCount; }
  registerExecutionGuard(): () => void {
    this.work.assertAttached();
    const identity = Symbol("wish-development-policy"); this.executionGuards.add(identity);
    return () => { this.executionGuards.delete(identity); };
  }
  private executionAvailable(ctx: Context): boolean {
    const names = new Set(ctx.get("tools")?.registry.list().map(tool => tool.name) ?? []);
    return this.executionGuards.size > 0 && ["wish_read", "wish_verify", "wish_report"].every(name => names.has(name));
  }
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, "wishDevelopment");
    const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: true } });
    try {
      this.raw = new DevelopmentRuntime(new DomainDevelopmentStore(this.lease, backendId));
      this.controller = new DevelopmentController({ state: this.raw, plan: ctx.plan, goal: () => ctx.get("goal"), operations: new DomainDevelopmentOperations(this.lease, backendId), executionAvailable: () => this.executionAvailable(ctx) });
      this.ready = this.raw.recover();
      void this.ready.catch(() => {});
      this.work = new PluginWorkOwner(ctx, { code: "wish_development", codeReload: true,
        blocked: () => this.controller.activeRunCount ? "wish_development_running" : undefined,
        close: async () => {
        try { await this.ready; await this.controller.close(); await this.raw.close(); }
        finally { this.lease.release(); }
      } });
      this.state = new Proxy(this.raw, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? (...args: unknown[]) => this.call(() => Reflect.apply(value, target, args)) : value;
        },
      });
    } catch (error) { this.lease.release(); throw error; }
  }
  private call<T>(action: () => Promise<T>): Promise<T> { return this.work.run(async () => { await this.ready; return action(); }); }
  readonly list = (): Promise<readonly DevelopmentProject[]> => this.call(() => this.controller.list());
  readonly inspect = (sessionId: string) => this.call(() => this.controller.inspect(sessionId));
  readonly observeConversationRun = (application: WishApplication, handle: WishRunHandle) => this.call(async () => { this.controller.observeConversationRun(application, handle); });
  readonly beforeConversationInput = (...input: Parameters<DevelopmentController["beforeConversationInput"]>) => this.call(() => this.controller.beforeConversationInput(...input));
  readonly conversationInput = (sessionId: string, runId: string) => this.call(async () => this.controller.conversationInput(sessionId, runId));
  readonly begin = (input: Parameters<DevelopmentController["begin"]>[0]) => this.call(() => this.controller.begin(input));
  readonly propose: Development["propose"] = input => this.call(() => this.controller.propose(input));
  readonly report: Development["report"] = input => this.call(() => this.controller.report(input));
  readonly recordVerification: Development["recordVerification"] = input => this.call(() => this.controller.recordVerification(input));
  readonly control = (application: WishApplication, sessionId: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
    this.call(() => this.controller.control(application, sessionId, body, signal));
  readonly detachSession = (sessionId: string) => this.call(() => this.controller.detachSession(sessionId));
  readonly drainSession = (sessionId: string) => this.call(() => this.controller.drainSession(sessionId));
}
declare module "@deepseek-ai/cordis" { interface Context { wishDevelopment: WishDevelopment } }
export default WishDevelopment;
