# Plan

`src/plan` owns Session-scoped planning state and its mode boundary. It is a
business capability, not a folder under `src/tools` and not a Workflow alias.

## Contract

- `PlanService` is the replaceable Cordis Service Definition.
- `PlanRuntime` owns Session mode, document revisions and durable human review.
- `DomainPlanStateStore` persists one CAS-protected record per Session through
  Storage KV; Plan data is not encoded as a fake chat message.
- The Storage Provider owns only durable Plan state. A separate mode-adapter plugin
  contributes Context and Permissions projections, so replacing either infrastructure
  service does not replace Plan state.
- `PlanContextProvider` projects active-mode instructions on every Step.
- `createPlanPermissionPolicy` can only narrow Permissions. Entering Plan mode
  therefore blocks stale write/bash calls immediately, while leaving Plan mode
  restores broader Tools only on the next Step.
- Model Tools are Consumers under `src/plan/consumers/model-tools`:
  `enter_plan_mode`, `read_plan`, `update_plan`, and `exit_plan_mode`.

`exit_plan_mode` requests review of the exact saved document; it does **not** approve
or exit the mode. The request persists `reviewId`, document version and digest and
returns immediately. The model should end its response and wait for human feedback.
Ordinary subsequent human messages invalidate a pending review and continue planning.
The user can also choose `keep-planning` or `cancel`; both retain Plan mode. A revised
document is required before resubmission. Only a matching human `approve` decision
exits Plan, and broader Tool authority takes effect on the next Step.

CLI `/review` displays documents, artifact references and exact-token actions. WebUI
uses the same host-only `decide` port through a generic Session Feature adapter.
Human decisions cannot be sent through a model Tool. The legacy host `approve` method
accepts only unsubmitted documents; it cannot bypass an existing review.

Plan stores opaque versioned artifact references, not TaskGraph definitions or execution
state. A Task Consumer attaches its immutable graph version to the document; changing
the attachment creates a new document revision. Approval starts no work. Independent
Workflow admission validates the approval and graph reference before execution.
`registerModeControl` lets optional Consumers contribute narrow planning controls
without adding their implementation to Plan or Core.

## Operations

- Set `WISH_PLAN_ENABLED=0` to disable both the Provider and its normal product
  wiring.
- Set `WISH_PLAN_TOOLS_ENABLED=0` to retain the host capability while hiding its
  model control surface.
- Run `npm run test:plan` for the focused state, persistence, Context, Tool, and
  hard-policy acceptance suite.
