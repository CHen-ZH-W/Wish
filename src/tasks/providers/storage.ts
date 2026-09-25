import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { TasksService } from "../service.js";
import { TaskRuntime } from "../runtime.js";
import { DomainTaskStore } from "../store.js";
import type { Tasks } from "../types.js";
export interface Config { readonly backendId?: string }
export const Config: s<Config> = s.object({ backendId: s.string() });
export default class StorageTasks extends TasksService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;
  readonly get: Tasks["get"];
  readonly replace: Tasks["replace"];
  readonly freeze: Tasks["freeze"];
  readonly transition: Tasks["transition"];
  readonly close: Tasks["close"];
  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const lease = ctx.storageBackend.acquire(config.backendId ?? ctx.storageBackend.id, { kv: { list: false } });
    const runtime = new TaskRuntime(new DomainTaskStore(lease, lease.id));
    const work = new PluginWorkOwner(ctx, { code: "tasks", codeReload: true,
      close: () => runtime.close().finally(() => lease.release()) });
    this.get = (...args) => work.run(() => runtime.get(...args));
    this.replace = (...args) => work.run(() => runtime.replace(...args));
    this.freeze = (...args) => work.run(() => runtime.freeze(...args));
    this.transition = (...args) => work.run(() => runtime.transition(...args));
    this.close = () => work.close();
  }
}
