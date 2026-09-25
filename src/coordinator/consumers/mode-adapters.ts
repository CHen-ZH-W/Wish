import type { Context } from "@deepseek-ai/cordis";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import type { ContextProviderRegistration } from "../../context/service.js";
import type { PermissionPolicyRegistration } from "../../permissions/index.js";
import { CoordinatorContextProvider } from "../context.js";
import { createCoordinatorPermissionPolicy } from "../policy.js";

/** Runtime projections are replaceable without replacing durable Coordinator state. */
export default { name: "coordinator-mode-adapters", inject: ["coordinator", "permissions", "contextEngine"], apply(ctx: Context) {
  let contextRegistration: ContextProviderRegistration | undefined;
  let policyRegistration: PermissionPolicyRegistration | undefined;
  const work = new PluginWorkOwner(ctx, { code: "coordinator_mode_adapters", codeReload: true, close: () => {
    contextRegistration?.unregister();
    policyRegistration?.unregister();
  } });
  const provider = new CoordinatorContextProvider(ctx.coordinator);
  const policy = createCoordinatorPermissionPolicy(ctx.coordinator, () => ctx.coordinator.modeControls());
  policyRegistration = ctx.permissions.registerPolicy({ id: policy.id,
    project: (input, signal) => work.run(() => policy.project(input, signal)),
    authorize: (input, snapshot, signal) => work.run(() => policy.authorize(input, snapshot, signal)),
  });
  try {
    contextRegistration = ctx.contextEngine.registerProvider({ id: provider.id,
      provide: (input, signal) => work.run(() => provider.provide(input, signal)),
    });
  } catch (error) {
    policyRegistration.unregister();
    throw error;
  }
} };
