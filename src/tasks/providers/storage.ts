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
    this.get = runtime.get.bind(runtime); this.replace = runtime.replace.bind(runtime);
    this.freeze = runtime.freeze.bind(runtime); this.transition = runtime.transition.bind(runtime);
    let closing: Promise<void> | undefined;
    this.close = () => closing ??= runtime.close().finally(() => lease.release());
    ctx.effect(() => () => this.close(), "tasks.close");
  }
}
