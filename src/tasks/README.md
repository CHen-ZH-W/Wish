# Tasks

`src/tasks` owns versioned task definitions, dependency validation, graph freezing and
task execution-state transitions. It does not launch processes, schedule retries or own
Workflow Attempts. Tools are optional Consumers, not the capability implementation.

## Contract

- Each Session has a CAS-protected collection of graph versions. Editing appends a new
  draft; previous definitions and results are retained. New versions start pending.
- Graphs contain up to 100 tasks, with unique ids, existing dependencies and no cycles.
  Every task declares role, read-only intent and timeout (1 ms–24 hours).
- `freeze` checks the exact version/digest and approval reference. Frozen definitions
  cannot be rewritten. Runtime transitions reject unmet dependencies and stale Attempts.
- Workflow owns the canonical Attempt ledger. Its scheduler idempotently projects
  Attempt outcomes into Tasks; a crash between these writes is repaired from Workflow.
  Tasks without an Attempt retain pending status; consult Workflow for graph-level
  blocking/cancellation and never interpret a pending task as permission to dispatch.
- `tasks_read` is an independent Consumer of Tasks state and remains available without Plan.
  `tasks_update` is a separate Plan adapter that replaces a draft only during active Plan mode,
  invalidates any pending review and attaches the exact graph to a saved Plan. It cannot
  assign execution statuses. The cross-module writes are not one transaction: an
  unattached draft after interruption cannot execute through approved-graph admission.
- Session Feature projection displays the exact graph attached to the Plan, including
  execution constraints, before approval.

## Operations

Default Storage domain: `tasks/sessions` (KV, process-local writer). Collection capacity
is 100 retained graph versions per Session; capacity exhaustion fails closed, with no
automatic deletion. CLI and WebUI must not share a writable data directory concurrently.

`WISH_TASKS_ENABLED=0` disables the capability. `WISH_TASK_TOOLS_ENABLED=0` hides only
the model controls. Disabling Plan removes `tasks_update` but retains `tasks_read`.
The Storage Provider accepts `backendId`; default profile uses file.
Run `npm run test:tasks` and `npm run test:workflow` for state and projection acceptance.
