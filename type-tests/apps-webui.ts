import type { ToolAuthorizationInput } from
  "../src/core/tools/authorization.js";
import type { WishApplication } from "../src/apps/types.js";
import {
  loadWishWebUiConfiguration,
  startWishWebUiServer,
  WebToolApprovalBroker,
  type StartedWishWebUiServer,
  type WishWebApproval,
  type WishWebUiConfiguration,
} from "../src/apps/webui/index.js";
import type { WishToolExecutionContext } from "../src/composition/tool-context.js";

declare const application: WishApplication;
declare const approvalInput: ToolAuthorizationInput<WishToolExecutionContext>;

const approvals = new WebToolApprovalBroker();
const approvalResult = approvals.requestApproval(approvalInput);
const pending: readonly WishWebApproval[] = approvals.listPending();
const configuration: Promise<WishWebUiConfiguration> =
  loadWishWebUiConfiguration({ workspaceRoot: "." });
const started: Promise<StartedWishWebUiServer> = startWishWebUiServer({
  application,
  approvals,
  workspaceRoot: ".",
  port: 0,
});

void approvalResult;
void pending;
void configuration;
void started;
