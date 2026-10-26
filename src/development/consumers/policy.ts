import type { Context } from "@deepseek-ai/cordis";
import type { CapabilityKind } from "../../permissions/authorization.js";
import type { PermissionPolicyContribution, PermissionPolicySnapshot } from "../../permissions/types.js";
import type { Development } from "../types.js";
import { PluginWorkOwner } from "../../boot/plugin-control/work-owner.js";
import { DEVELOPMENT_POLICY_ID, currentDevelopment, developmentFacts, sameExecutionBinding, type DevelopmentPermissionFacts } from "./port.js";

const READ_TOOLS = new Set(["read", "grep", "web_search", "web_fetch", "wish_read", "read_plan", "tasks_read", "get_goal", "list_skills", "read_skill", "memory_search", "memory_read", "list_agents", "capture_agent", "collect_agent", "workflow_read"]);
const DRAFT_CONTROLS: Readonly<Record<string, string>> = Object.freeze({ wish_begin: "wish.begin:", wish_propose: "wish.propose:", todo_write: "todo.write:" });
const EXECUTION_CONTROLS: Readonly<Record<string, string>> = Object.freeze({ ...DRAFT_CONTROLS, wish_report: "wish.report:", wish_verify: "wish.verify:", update_goal: "goal.update:" });
const SAFE_CAPABILITIES: readonly CapabilityKind[] = ["filesystem.read", "web.search", "web.fetch", "runtime.read", "runtime.control"];
const FORBIDDEN_TOOLS = new Set(["spawn_agent", "send_agent", "stop_agent", "workflow_start", "workflow_retry", "workflow_reconcile", "workflow_cancel"]);

export function createDevelopmentPermissionPolicy(state: Pick<Development, "forSession" | "list">): PermissionPolicyContribution {
  const facts = async (sessionId: string, runId: string, workspaceRoot: string) => developmentFacts(await currentDevelopment(state, sessionId, workspaceRoot), sessionId, runId, workspaceRoot);
  return {
    id: DEVELOPMENT_POLICY_ID,
    async project(input): Promise<PermissionPolicySnapshot> {
      const current = await facts(input.request.subject.sessionId, input.request.subject.runId, input.request.workspace.root);
      const allowedTools = !current.managed ? input.availableTools : current.executionAllowed
        ? input.availableTools.filter(name => !FORBIDDEN_TOOLS.has(name))
        : input.availableTools.filter(name => READ_TOOLS.has(name) || name in DRAFT_CONTROLS);
      return Object.freeze({ id: DEVELOPMENT_POLICY_ID,
        revision: JSON.stringify(current), metadata: { ...current },
        ...(current.managed ? { availableTools: Object.freeze(allowedTools),
          ...(!current.executionAllowed ? { allowedCapabilities: Object.freeze(input.allowedCapabilities.filter(kind => SAFE_CAPABILITIES.includes(kind))) } : {}),
        } : {}),
      });
    },
    async authorize(input, snapshot) {
      const projected = snapshot.metadata as unknown as DevelopmentPermissionFacts | undefined;
      if (!projected || typeof projected.managed !== "boolean") return denied("Wish development policy snapshot is invalid");
      const subject = input.context.permissions.subject;
      const current = await facts(subject.sessionId, subject.runId, input.context.workspace.root);
      if (!projected.managed && !current.managed) return allowed();
      const executing = sameExecutionBinding(projected, current);
      const name = input.call.name;
      if (FORBIDDEN_TOOLS.has(name)) return denied("This Wish development increment uses a single Agent; child and Workflow mutation are unavailable");
      if (!executing && !READ_TOOLS.has(name) && !(name in DRAFT_CONTROLS)) return denied("Wish development is awaiting confirmation, paused, or this Run has a stale execution binding");
      const controls = executing ? EXECUTION_CONTROLS : DRAFT_CONTROLS;
      for (const requirement of input.capabilities.requirements) {
        if (!executing && !SAFE_CAPABILITIES.includes(requirement.capability)) return denied("Wish discussion permits inspection and scoped drafts only");
        if (requirement.capability === "runtime.control") {
          const prefix = controls[name];
          if (!prefix || !requirement.resources.every(resource => resource === `${prefix}${subject.sessionId}`)) return denied("Wish development does not allow unrelated runtime control");
        }
      }
      return allowed();
    },
  };
}

function allowed() { return { status: "allowed" as const }; }
function denied(reason: string) { return { status: "denied" as const, reason }; }

export default { name: "wish-development-policy", inject: ["wishDevelopment", "permissions"], apply(ctx: Context) {
  let registration: ReturnType<typeof ctx.permissions.registerPolicy> | undefined;
  let releaseGuard: (() => void) | undefined;
  const work = new PluginWorkOwner(ctx, { code: "wish_development_policy", codeReload: true,
    blocked: () => ctx.wishDevelopment.activeRunCount ? "wish_development_running" : undefined,
    close: () => { registration?.unregister(); releaseGuard?.(); } });
  const policy = createDevelopmentPermissionPolicy(ctx.wishDevelopment.state);
  registration = ctx.permissions.registerPolicy({ ...policy,
    project: (...args) => work.run(() => policy.project(...args)),
    authorize: (...args) => work.run(() => policy.authorize(...args)),
  });
  releaseGuard = ctx.wishDevelopment.registerExecutionGuard();
} };
