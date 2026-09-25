import { Service, type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
import { WorkflowService } from "../service.js";
import { WorkflowRuntime } from "../runtime.js";
import { DomainWorkflowStore } from "../store.js";
import { registerPluginOwner } from "../../boot/plugin-control/owner-registry.js";
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
    let closing: Promise<void> | undefined;
    const close = () => closing ??= this.state.close().finally(() => lease.release());
    ctx.effect(() => close, "workflow.close");
    registerPluginOwner(ctx, {
      replacement: "drain",
      status: () => ({
        disposition: closing ? "blocked" : "drain",
        code: closing ? "workflow_closed" : "workflow_state_draining",
      }),
      prepare: () => {
        const prepared = this.state.prepareReload();
        return {
          drained: prepared.drained,
          deactivate: close,
          release: () => { if (!closing) prepared.release(); },
        };
      },
    });
  }
  [Service.check]() { return this.ready; }
  async [Service.init]() { await this.state.recoverInterrupted(); this.ready = true; this.ctx.reflect.notify(["workflow"]); }
}
