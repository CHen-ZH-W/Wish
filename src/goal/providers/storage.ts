import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { StorageBackendLease } from "../../storage/backend.js";
import { GoalRuntime } from "../runtime.js";
import { GoalService } from "../service.js";
import { DomainGoalStateStore } from "../store.js";
import type { Goal } from "../types.js";

export interface Config { readonly backendId?: string; readonly defaultMaxGoalRounds?: number }
export const Config: s<Config> = s.object({ backendId: s.string(), defaultMaxGoalRounds: s.number().step(1).min(1) });
export default class StorageGoalService extends GoalService {
  static readonly inject = ["storageBackend"]; static readonly Config = Config;
  private readonly lease: StorageBackendLease; private readonly runtime: GoalRuntime; private readonly work: PluginWorkOwner;
  readonly get: Goal["get"]; readonly create: Goal["create"]; readonly edit: Goal["edit"]; readonly pause: Goal["pause"];
  readonly resume: Goal["resume"]; readonly complete: Goal["complete"]; readonly block: Goal["block"]; readonly clear: Goal["clear"];
  readonly disarm: Goal["disarm"]; readonly admitRound: Goal["admitRound"]; readonly close: Goal["close"];
  constructor(ctx: Context, config: Config = {}) {
    super(ctx); const backendId = config.backendId ?? ctx.storageBackend.id;
    this.lease = ctx.storageBackend.acquire(backendId, { kv: { list: false } });
    this.runtime = new GoalRuntime({ store: new DomainGoalStateStore({ storage: this.lease, backendId }), ...(config.defaultMaxGoalRounds === undefined ? {} : { defaultMaxGoalRounds: config.defaultMaxGoalRounds }) });
    this.work = new PluginWorkOwner(ctx, { code: "goal", codeReload: true, close: () => this.runtime.close().finally(() => this.lease.release()) });
    this.get = request => this.work.run(() => this.runtime.get(request)); this.create = request => this.work.run(() => this.runtime.create(request));
    this.edit = request => this.work.run(() => this.runtime.edit(request)); this.pause = request => this.work.run(() => this.runtime.pause(request));
    this.resume = request => this.work.run(() => this.runtime.resume(request)); this.complete = request => this.work.run(() => this.runtime.complete(request));
    this.block = request => this.work.run(() => this.runtime.block(request)); this.clear = request => this.work.run(() => this.runtime.clear(request));
    this.disarm = request => this.work.run(() => this.runtime.disarm(request)); this.admitRound = request => this.work.run(() => this.runtime.admitRound(request));
    this.close = () => this.work.close();
  }
}
