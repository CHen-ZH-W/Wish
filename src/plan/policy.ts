import type { CapabilityKind } from "../permissions/authorization.js";
import type {
  PermissionPolicyContribution,
  PermissionPolicySnapshot,
} from "../permissions/index.js";
import type { Plan, PlanState, PlanModeControl } from "./types.js";

export const PLAN_PERMISSION_POLICY_ID = "plan-mode";

export const PLAN_TOOL_NAMES = Object.freeze([
  "enter_plan_mode",
  "read_plan",
  "update_plan",
  "exit_plan_mode",
] as const);

export const ACTIVE_PLAN_TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "web_fetch",
  "web_search",
  "read_plan",
  "update_plan",
  "exit_plan_mode",
] as const);

export const ACTIVE_PLAN_CAPABILITIES = Object.freeze([
  "filesystem.read",
  "web.search",
  "web.fetch",
  "runtime.read",
  "runtime.control",
] as const satisfies readonly CapabilityKind[]);

interface PlanPolicyFacts {
  readonly active: boolean;
  readonly stateVersion: number;
}

export function createPlanPermissionPolicy(
  plan: Plan,
  controls: () => readonly PlanModeControl[] = () => [],
): PermissionPolicyContribution {
  const allowedTool = (name: string) => (ACTIVE_PLAN_TOOL_NAMES as readonly string[]).includes(name) || controls().some((item) => item.toolName === name);
  const contribution: PermissionPolicyContribution = {
    id: PLAN_PERMISSION_POLICY_ID,
    async project(input, signal): Promise<PermissionPolicySnapshot> {
      const state = await plan.get({
        sessionId: input.request.subject.sessionId,
        ...(signal === undefined ? {} : { signal }),
      });
      const facts = policyFacts(state);
      return Object.freeze({
        id: PLAN_PERMISSION_POLICY_ID,
        revision: revision(facts),
        ...(facts.active
          ? {
              availableTools: Object.freeze(input.availableTools.filter((name) =>
                allowedTool(name)
              )),
              allowedCapabilities: Object.freeze(
                input.allowedCapabilities.filter((capability) =>
                  (ACTIVE_PLAN_CAPABILITIES as readonly CapabilityKind[])
                    .includes(capability)
                ),
              ),
            }
          : {}),
        metadata: Object.freeze(facts),
      });
    },
    async authorize(input, snapshot, signal) {
      signal?.throwIfAborted();
      const projected = snapshotFacts(snapshot);
      const current = policyFacts(await plan.get({
        sessionId: input.context.permissions.subject.sessionId,
        ...(signal === undefined ? {} : { signal }),
      }));
      const toolName = input.call.name;
      if ((PLAN_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return authorizePlanTool(toolName, input, projected, current);
      }
      const restrictive = projected.active || current.active ||
        projected.stateVersion !== current.stateVersion;
      if (!restrictive) return allowed();
      if (!allowedTool(toolName)) {
        return denied(`Plan mode does not allow Tool ${JSON.stringify(toolName)}`);
      }
      if (input.capabilities.requirements.some((requirement) =>
        !(ACTIVE_PLAN_CAPABILITIES as readonly CapabilityKind[])
          .includes(requirement.capability) ||
        (requirement.capability === "runtime.control" &&
          !(requirement.resources ?? []).every((resource) => resource.startsWith("plan.") || controls().some((item) => item.toolName === toolName && resource.startsWith(item.resourcePrefix))))
      )) {
        return denied("Plan mode does not allow this Tool capability");
      }
      return allowed();
    },
  };
  return Object.freeze(contribution);
}

function authorizePlanTool(
  toolName: string,
  input: Parameters<PermissionPolicyContribution["authorize"]>[0],
  projected: PlanPolicyFacts,
  current: PlanPolicyFacts,
) {
  const sessionId = input.context.permissions.subject.sessionId;
  const expected = toolCapability(toolName, sessionId);
  if (
    input.capabilities.requirements.length !== 1 ||
    input.capabilities.requirements[0]?.capability !== expected.capability ||
    input.capabilities.requirements[0]?.resources?.length !== 1 ||
    input.capabilities.requirements[0]?.resources?.[0] !== expected.resource
  ) return denied(`Plan Tool ${JSON.stringify(toolName)} requested invalid authority`);

  if (toolName === "read_plan") return allowed();
  if (toolName === "enter_plan_mode") {
    return !projected.active && !current.active &&
      projected.stateVersion === current.stateVersion
      ? allowed()
      : denied("Plan mode can only be entered once from an unchanged inactive Step");
  }
  return current.active
    ? allowed()
    : denied(`Plan mode is not active for Tool ${JSON.stringify(toolName)}`);
}

function toolCapability(toolName: string, sessionId: string): {
  readonly capability: "runtime.read" | "runtime.control";
  readonly resource: string;
} {
  if (toolName === "read_plan") {
    return { capability: "runtime.read", resource: `plan.read:${sessionId}` };
  }
  const action = toolName === "enter_plan_mode"
    ? "enter"
    : toolName === "update_plan"
      ? "update"
      : "approve";
  return { capability: "runtime.control", resource: `plan.${action}:${sessionId}` };
}

function policyFacts(state: PlanState | undefined): PlanPolicyFacts {
  return Object.freeze({
    active: state?.active ?? false,
    stateVersion: state?.version ?? 0,
  });
}

function snapshotFacts(snapshot: PermissionPolicySnapshot): PlanPolicyFacts {
  const active = snapshot.metadata?.active;
  const stateVersion = snapshot.metadata?.stateVersion;
  if (typeof active !== "boolean" || !Number.isSafeInteger(stateVersion) || (stateVersion as number) < 0) {
    throw new TypeError("Plan permission snapshot metadata is invalid");
  }
  return Object.freeze({ active, stateVersion: stateVersion as number });
}

function revision(facts: PlanPolicyFacts): string {
  return `plan-v1:${facts.stateVersion}:${facts.active ? "active" : "inactive"}`;
}

function allowed() {
  return Object.freeze({ status: "allowed" as const });
}

function denied(reason: string) {
  return Object.freeze({ status: "denied" as const, reason });
}
