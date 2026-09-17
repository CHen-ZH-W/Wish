import type { ToolAuthorizationService } from
  "../src/core/tools/authorization.js";
import type {
  AgentPermissionConfiguration,
  PermissionAuthority,
  PermissionExecutionContext,
  PermissionProfile,
  PermissionResolver,
  PermissionSnapshot,
  ResolvePermissionRequest,
} from "../src/permissions/index.js";
import type { ToolApprovalPort } from "../src/approval/index.js";

declare const authority: PermissionAuthority;
declare const approval: ToolApprovalPort<PermissionExecutionContext>;
declare const request: ResolvePermissionRequest;

const resolver: PermissionResolver = authority;
const authorization: ToolAuthorizationService<PermissionExecutionContext> =
  authority;
const snapshot: Promise<PermissionSnapshot> = Promise.resolve(
  resolver.resolve(request),
);
const profile: PermissionProfile = "approval-required";
const agent: AgentPermissionConfiguration = {
  profile,
  availableTools: ["read"],
  allowedCapabilities: ["filesystem.read"],
};

void authorization;
void approval;
void snapshot;
void agent;
