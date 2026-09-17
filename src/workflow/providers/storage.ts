import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { WorkflowService } from "../service.js";
import { WorkflowRuntime } from "../runtime.js";
import { DomainWorkflowStore } from "../store.js";
import type {} from "../../boot/plugin-control/code-reload.js";
export interface Config { readonly backendId?: string }
export const Config: s<Config> = s.object({ backendId: s.string() });

export default class StorageWorkflow extends WorkflowService {
  static readonly inject = ["storageBackend"];
  static readonly Config = Config;
  readonly state: WorkflowRuntime;
  private ready = false;
  constructor(ctx: Context, config: Config = {}) {
    super(ctx);
    const lease = ctx.storageBackend.acquire(config.backendId ?? ctx.storageBackend.id, { kv: { list: false } });
    this.state = new WorkflowRuntime(new DomainWorkflowStore(lease, lease.id));
    ctx.root.get("codeReload")?.register(ctx, { prepare: () => this.state.prepareReload() });
    let closing: Promise<void> | undefined;
    ctx.effect(() => () => closing ??= this.state.close().finally(() => lease.release()), "workflow.close");
  }
  [Service.check]() { return this.ready; }
  async [Service.init]() { await this.state.recoverInterrupted(); this.ready = true; this.ctx.reflect.notify(["workflow"]); }
}
