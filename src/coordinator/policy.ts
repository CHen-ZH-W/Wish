import type { CapabilityKind } from "../permissions/authorization.js";
import type {
  PermissionPolicyContribution,
  PermissionPolicySnapshot,
} from "../permissions/index.js";
import type { Coordinator, CoordinatorState, CoordinatorModeControl } from "./types.js";

export const COORDINATOR_PERMISSION_POLICY_ID = "coordinator-mode";

export const COORDINATOR_TOOL_NAMES = Object.freeze([
  "enter_coordinator_mode",
  "read_coordinator",
  "exit_coordinator_mode",
] as const);

/** Existing optional model controls backed by the independent Subagents module. */
export const COORDINATOR_DELEGATION_TOOL_NAMES = Object.freeze([
  "spawn_agent",
  "list_agents",
  "capture_agent",
  "send_agent",
  "stop_agent",
  "collect_agent",
] as const);

export const ACTIVE_COORDINATOR_TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "web_fetch",
  "web_search",
  ...COORDINATOR_DELEGATION_TOOL_NAMES,
  "read_coordinator",
  "exit_coordinator_mode",
] as const);

export const ACTIVE_COORDINATOR_CAPABILITIES = Object.freeze([
  "filesystem.read",
  "web.search",
  "web.fetch",
  "runtime.read",
  "runtime.control",
] as const satisfies readonly CapabilityKind[]);

interface CoordinatorPolicyFacts {
  readonly active: boolean;
  readonly stateVersion: number;
}

export function createCoordinatorPermissionPolicy(
  coordinator: Coordinator,
  controls: () => readonly CoordinatorModeControl[] = () => [],
): PermissionPolicyContribution {
  const contribution: PermissionPolicyContribution = {
    id: COORDINATOR_PERMISSION_POLICY_ID,
    async project(input, signal): Promise<PermissionPolicySnapshot> {
      const state = await coordinator.get({
        runId: input.request.subject.runId,
        ...(signal === undefined ? {} : { signal }),
      });
      const facts = policyFacts(state);
      return Object.freeze({
        id: COORDINATOR_PERMISSION_POLICY_ID,
        revision: revision(facts),
        ...(facts.active
          ? {
              delegation: Object.freeze({ availableTools: Object.freeze([...input.availableTools]), allowedCapabilities: Object.freeze([...input.allowedCapabilities]) }),
              availableTools: Object.freeze(input.availableTools.filter((name) =>
                (ACTIVE_COORDINATOR_TOOL_NAMES as readonly string[]).includes(name) || controls().some(control => control.toolName === name)
              )),
              allowedCapabilities: Object.freeze(
                input.allowedCapabilities.filter((capability) =>
                  (ACTIVE_COORDINATOR_CAPABILITIES as readonly CapabilityKind[])
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
      const current = policyFacts(await coordinator.get({
        runId: input.context.permissions.subject.runId,
        ...(signal === undefined ? {} : { signal }),
      }));
      const toolName = input.call.name;
      if ((COORDINATOR_TOOL_NAMES as readonly string[]).includes(toolName)) {
        return authorizeCoordinatorTool(toolName, input, projected, current);
      }
      const restrictive = projected.active || current.active ||
        projected.stateVersion !== current.stateVersion;
      if (!restrictive) return allowed();
      if (!(ACTIVE_COORDINATOR_TOOL_NAMES as readonly string[]).includes(toolName) && !controls().some(control => control.toolName === toolName)) {
        return denied(`Coordinator mode does not allow Tool ${JSON.stringify(toolName)}`);
      }
      if (input.capabilities.requirements.some((requirement) =>
        !(ACTIVE_COORDINATOR_CAPABILITIES as readonly CapabilityKind[])
          .includes(requirement.capability) ||
        (requirement.capability === "runtime.control" &&
          !(requirement.resources ?? []).every((resource) =>
            resource.startsWith("coordinator.") || resource.startsWith("subagents.") || controls().some(control => control.toolName === toolName && resource.startsWith(control.resourcePrefix))
          ))
      )) {
        return denied("Coordinator mode does not allow this Tool capability");
      }
      return allowed();
    },
  };
  return Object.freeze(contribution);
}

function authorizeCoordinatorTool(
  toolName: string,
  input: Parameters<PermissionPolicyContribution["authorize"]>[0],
  projected: CoordinatorPolicyFacts,
  current: CoordinatorPolicyFacts,
) {
  const runId = input.context.permissions.subject.runId;
  const expected = toolCapability(toolName, runId);
  if (
    input.capabilities.requirements.length !== 1 ||
    input.capabilities.requirements[0]?.capability !== expected.capability ||
    input.capabilities.requirements[0]?.resources?.length !== 1 ||
    input.capabilities.requirements[0]?.resources?.[0] !== expected.resource
  ) {
    return denied(
      `Coordinator Tool ${JSON.stringify(toolName)} requested invalid authority`,
    );
  }
  if (toolName === "read_coordinator") return allowed();
  if (toolName === "enter_coordinator_mode") {
    return !projected.active && !current.active &&
      projected.stateVersion === current.stateVersion
      ? allowed()
      : denied(
        "Coordinator mode can only be entered once from an unchanged inactive Step",
      );
  }
  return current.active
    ? allowed()
    : denied(`Coordinator mode is not active for Tool ${JSON.stringify(toolName)}`);
}

function toolCapability(toolName: string, runId: string): {
  readonly capability: "runtime.read" | "runtime.control";
  readonly resource: string;
} {
  if (toolName === "read_coordinator") {
    return { capability: "runtime.read", resource: `coordinator.read:${runId}` };
  }
  const action = toolName === "enter_coordinator_mode" ? "enter" : "exit";
  return { capability: "runtime.control", resource: `coordinator.${action}:${runId}` };
}

function policyFacts(state: CoordinatorState | undefined): CoordinatorPolicyFacts {
  return Object.freeze({
    active: state?.active ?? false,
    stateVersion: state?.version ?? 0,
  });
}

function snapshotFacts(snapshot: PermissionPolicySnapshot): CoordinatorPolicyFacts {
  const active = snapshot.metadata?.active;
  const stateVersion = snapshot.metadata?.stateVersion;
  if (typeof active !== "boolean" || !Number.isSafeInteger(stateVersion) || (stateVersion as number) < 0) {
    throw new TypeError("Coordinator permission snapshot metadata is invalid");
  }
  return Object.freeze({ active, stateVersion: stateVersion as number });
}

function revision(facts: CoordinatorPolicyFacts): string {
  return `coordinator-v1:${facts.stateVersion}:${facts.active ? "active" : "inactive"}`;
}

function allowed() {
  return Object.freeze({ status: "allowed" as const });
}

function denied(reason: string) {
  return Object.freeze({ status: "denied" as const, reason });
}
