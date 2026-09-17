# Workflow

`src/workflow` owns durable execution Runs, Steps, Attempts, budgets, failure summaries,
recovery decisions and both schedulers. Coordinator remains a mode/policy capability;
Subagents owns child identities, process state, tmux targets and retained output. Core
Runtime continues to own generic conversation Run/Turn/Step execution.

## Execution and state

`WorkflowRuntime` commits a complete Run snapshot and append-only audit-event prefix in
one Storage CAS. Run creation and child dispatch use stable idempotency keys. A completed
Attempt cannot be overwritten by a late result from an older Attempt. Frozen graphs are
admitted only after an exact human Plan Review approval; approval itself starts nothing.

`TaskGraphScheduler` validates the approved graph reference, freezes its definitions and
submits it to `ChildWorkflowScheduler`. The latter dispatches ready Steps through the
Subagents port, binds Attempt ↔ child ids, observes structured results, projects Tasks
states and delivers results through Core's generic RunContinuation port. It never parses
terminal output as authoritative completion. Subagent output remains untrusted task data.

Scheduler concurrency defaults to 4. For the same canonical workspace, any write task
excludes other scheduled tasks; read-only tasks may run together. These are scheduler
admission constraints, not filesystem locks against humans or independent host callers.
Subagents' own global/per-parent limits still apply. Child Tool lists, permission profile
and capability ceilings can only narrow the Host-derived delegation scope. Permissions
separately snapshots direct-work and delegated scopes: Coordinator restricts its own
direct work while retaining delegation within the Host ceiling. Other policies inherit
their direct restrictions into delegation unless they explicitly provide a narrower
Host-bounded delegation projection. A read-only Host cannot delegate write authority.
Dispatch rechecks current Agent configuration, Workspace and Permissions; configuration
changes can block it.

Budgets default to 200 total Attempts, 2 per Step, 2 calls per edge and an aggregate circuit
threshold of 3 failed Attempts. Retries are explicit and require a changed strategy;
repeating the same error/strategy is rejected. Retry strategy is included in the child
task prompt. An unchanged title does not erase attempt counters. No automatic LLM retry
loop is used. Ordinary child submissions have a 30-minute deadline; graph tasks declare
their deadline duration. Same-Attempt recovery never resets it.

## Recovery and cancellation

- Startup marks active Attempts interrupted before exposing the Storage service.
- Prepared work can resume the same Attempt. A surviving child is reconnected by its
  durable binding or stable dispatch address, preserving Attempt id/ordinal/deadline.
- A dispatched operation with unknown outcome, a lost child or a timeout without a
  structured result requires reconciliation. It is never blindly replayed.
- Human reconciliation records actor and evidence: confirmed completed, confirmed safe
  to retry, or unknown/terminally blocked. Model Tools cannot call this decision port.
- Cancellation is persisted before stopping children. Restart retries child cleanup by
  the stable dispatch address. Disposing the scheduler leaves tmux processes observable;
  restarting the host reconnects them. Parent Run abort releases result waiting but does
  not implicitly cancel a durable Workflow; use `workflow_cancel` for that operation.
- Workflow continuity is distinct from rebuilding the old conversation Run. After a
  process restart, `workflow_read` with an id in the same Agent/Session reconnects result
  delivery to the new Run. It does not automatically reconstruct the old LLM turn.

Scheduler shutdown seals both child and graph admission synchronously and awaits accepted
submit/retry/cancel requests, active ticks, graph lookups and pending result reads. A graph
lookup completing after close cannot newly freeze or submit work. An already-started freeze
may finish durably, but no late graph submission is allowed; approved frozen graphs can be
explicitly started again. A submission already committing a Workflow may leave prepared work
for the next scheduler, not dispatch it from a closed instance. Timers and subscriptions
are released; late results cannot follow up through the old scheduler.
The domain Runtime also closes read entrypoints and drains reads/writes before storage release.

Rebuilding the Workflow storage Provider marks active Attempts interrupted; the replacement
scheduler reconnects the saved child, retaining Attempt id, ordinal, dispatch key and deadline.
Failure to reactivate child observation leaves scheduling unavailable rather than relaunching
the child. `WorkflowContinuations` owns process-local parent holds and result recipients in
the independent, isolated `workflow-continuations` Entry. Scheduler replacement does not
release these holds: a successor publishes reconciled durable results to the same parent,
without a second `watch()`. Enqueue precedes hold release; rejected delivery keeps the hold.
Explicit parent cancellation or closing the continuation owner releases it. Standalone
schedulers without an injected continuation owner retain their own close/release behavior.

The storage/scheduler Providers and reviewed Consumers declare code reload support through
optional Host interfaces. The Host drains Steps, then Consumers before Providers. Activation
reconciles saved Attempts but delays new dispatch until the durable reload receipt; failed
replacement does not release parent holds or restart dispatch. Managed disable is different:
unsettled work still refuses stop. The continuation owner itself is stable and cannot be
code-reloaded; parent Runs are not reconstructed across process restarts. Custom deployment
profiles must include `cordis:workflow-continuations` and isolate `workflowContinuations`;
the default profile supplies both without changing existing Entry IDs.

## Surfaces and configuration

`ChildWorkflowScheduler.lifecycleSnapshot(signal)` reads durable Workflow/Attempt facts
and current request, tick and parent-wait counts without pumping the scheduler or querying
child processes. `TaskGraphScheduler.lifecycleSnapshot()` also counts starts awaiting Plan
or Tasks before a Workflow exists. The scheduler Provider optionally contributes these
read-only counts to Host lifecycle inspection, bound to its exact Fiber. Unsettled work
is blocked, not implicitly cancelled; query cancellation does not cancel a Workflow.
These observations expose no task body, owner identity or raw failure message, and are not
an execution lock or a complete stop protocol.

The separate optional stop guard suspends both scheduler admission paths: new graph starts,
child submit/retry/cancel/watch and new timer/event ticks. Suspension does not cancel or
rewrite already admitted work. A pending graph start, request, tick, parent hold or unsettled
durable record blocks cleanup. Before commitment the fence is reversible; allowed cleanup
closes both schedulers, so old references cannot create work after unload. Admission fences
are local scheduler interfaces, not a second Workflow state authority.

Model Consumers: `workflow_read`, `workflow_start`, `workflow_retry`, `workflow_cancel`.
The default `spawn_agent` Consumer uses the same scheduler for a one-Step child Workflow;
its existing list/capture/send/stop/collect controls remain backed by Subagents. Queueing
returns a durable Workflow id; do not submit another child merely because it is queued.
CLI `/review` and the WebUI Session Features panel expose the execution ledger and exact
Attempt reconciliation controls. Direct host APIs remain usable without model Tools.

`WISH_WORKFLOW_ENABLED=0` disables the capability; `WISH_WORKFLOW_TOOLS_ENABLED=0` hides
Workflow model controls only. Existing Subagent Tool exposure remains controlled by
`WISH_SUBAGENT_TOOLS_ENABLED`. `WISH_WORKFLOW_MAX_CONCURRENT` configures 1–256 scheduler
slots. The default scheduler requires Plan, Tasks and Subagents; disabling a prerequisite
disables this adapter without moving the other modules' capabilities. Child CLIs disable
Tasks/Workflow and recursive Subagents, with isolated data and Storage directories.

Storage domain `workflow/runs` uses one atomic global KV snapshot, bounded to 4096 Runs.
This is process-local writer infrastructure, not a distributed queue. Backend payload
limits still apply; there is no automatic pruning or multi-process leader election.
Separate CLI/WebUI instances must use separate writable data directories.

Verification: `npm run test:workflow`, `npm run test:plan`, `npm run test:tasks`,
`npm run test:module-boundaries`, `npm run test:state-handoff`.
`npm run test:state-handoff:real` uses the default Loader graph, real tmux and Wish CLI children
with a loopback model fixture to verify same-process module disposal/reactivation and failed
observation recovery without duplicate dispatch. It uses dedicated temporary data/socket
paths, does not test forced Host crashes, external Providers, active parent-Run HMR or browser UI.
`npm run test:stateful-code-reload:real` covers native managed code reload with the same real
parent Run and tmux child, single/batched changes, in-flight commands, stable Coordinator mode,
blocked administrative disable, failed activation and failed durable receipts. It verifies
one dispatch/one result and unchanged child PID, Attempt id and deadline. All model calls are
deterministic loopback fixtures, not external Provider or browser acceptance.
