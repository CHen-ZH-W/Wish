# Subagents

`src/subagents` owns child identity, parent ownership, concurrency limits, durable records,
execution reconciliation and completion events. It does not own a concrete App or terminal
implementation.

```text
CLI launcher adapter ─> SubagentLauncher Service ─┐
                                                  ├─> Subagents Runtime ─> Subagents Service
tmux adapter ────────> SubagentExecution Service ─┤          │
Storage Backend ──────────────────────────────────┘          └─> lifecycle events
```

## Contracts

- `SubagentRuntime` is the concrete domain implementation. It owns record transitions,
  global/per-parent limits, reconciliation monitors and event publication.
- `SubagentsRuntimeService` owns the Storage lease and composes the currently selected
  `SubagentExecution` and `SubagentLauncher` Providers.
- `SubagentExecutionTarget` is provider-neutral and serializable. It always exposes a visible
  target plus copyable attach/capture commands; Provider-specific reconstruction facts live in
  its opaque `locator`.
- `providers/tmux-execution.ts` is a narrow adapter only. Parent/child ids, limits, records and
  result files never enter `src/tmux`.
- `apps/cli/subagent-launcher.ts` owns Wish CLI arguments, private task/config exchange files
  and child-process environment. The domain imports only `SubagentLauncher`.
- Each read/control request carries parent Agent, Session, Run and Workspace identity. The
  Runtime checks all four and reports a foreign child as not found; model Tools do not reproduce
  this policy.
- Structured child results are read through the Launcher Service. Terminal output remains an
  operator diagnostic and is never parsed as a result.
- The Runtime monitors live executions and emits `subagent.updated`. The Runtime continuation
  adapter subscribes to these events; it does not own another polling loop.
- Closing or replacing the domain service leaves the independently hosted terminal alive.
  Explicit `stop` is the child execution termination boundary.
- Host `idempotencyKey` requests derive a stable child address and return an existing
  matching record before checking capacity. A conflicting task/owner/authority is rejected;
  a lost or failed record is never silently relaunched under the same key. Workflow owns
  the Attempt ↔ child binding and uses this address to repair dispatch/binding crash cuts.
- The optional Tool dispatch port can use Workflow scheduling without replacing this
  domain capability. The default product selects that Consumer when its prerequisites
  are available; other host callers can still use Subagents directly.

## Configuration

The domain's `lifecycleSnapshot(signal)` reads stored record counts without refreshing
process state, updating records, or starting monitors. It reports pending serialized
operations, monitors, recorded live children and unresolved records; these are observed
record facts, not proof that every external process is alive or stopped.
Failed launches remain unresolved even when no execution target was recorded; absence of
a target is not proof that launch had no side effects. The service's
optional Host lifecycle query also tracks all in-flight public requests and reports
unsettled work as blocked. Query registration belongs to that exact service Fiber and is
revoked on unload; it neither calls `stop` nor changes the existing `close` contract.
Counts contain no parent/child identities, task text, locator or workspace path.

The separate optional stop guard synchronously closes service admission, including stale
references and subscriptions. It rechecks these counts before allowing cleanup; live,
unresolved or in-flight work rejects the operation and releases the preflight fence.
Allowed cleanup reuses the service's close Promise and lease release. It never calls
execution `stop` or kills an independently hosted terminal to satisfy administrative cleanup.

All operations that may refresh a record (`list`, `inspect`, `capture`, `send`, `collect`,
`resume`) share the Runtime's mutation queue with spawn, stop and monitor reconciliation.
A late inspection cannot overwrite a newer explicit stop. Session/lifecycle observations
remain read-only and do not count themselves as execution work, but their reads are drained
before storage is released. `close()` synchronously rejects new work, removes listeners,
stops monitor admission and returns one shared drain Promise for all callers. Previously
accepted operations finish before the record store and Provider lease close; stale service
references cannot acquire the successor's authority. Closing does not cancel an already
accepted explicit stop or interpret an unknown launch as safe to repeat.

Reactivation reads the original durable records and reconciles the saved execution target;
it does not call spawn to recreate an existing child. A failed observation startup leaves
the dependent scheduler unavailable, preserving the record and independently hosted pane.
The Runtime and tmux execution adapter declare code-reload participation: after Step and
upstream scheduler drain, the Runtime seals admission and lets existing monitor reads finish
without aborting commands. New instances reconcile saved targets. Workflow-owned parent
relationships survive this replacement; the independent model Consumer's legacy result relay
is not yet reloadable and therefore blocks a batch when present. Managed disable continues
to refuse live/unresolved records. See `npm run test:stateful-code-reload:real` for real
parent Run/child PID/Attempt continuity and failed activation/receipt coverage.

`WISH_SUBAGENTS_ENABLED=0` unloads the tmux execution adapter, CLI launcher and domain Runtime,
without disabling tmux itself. `WISH_SUBAGENT_TOOLS_ENABLED=0` independently removes only the
model-facing Consumer.

The CLI child uses a separate data directory and Storage root under
`<parent-data>/subagents/children/<id-hash>/`. Recursive Subagents are disabled in child mode;
permission profile and available Tool ceiling are inherited or narrowed explicitly.
An explicit host capability ceiling is also passed to the child environment. Empty
explicit Tool/capability scopes fail closed rather than becoming unrestricted defaults.

## Host resource exchange

`SubagentLauncherService.registerResourceProvider()` accepts optional Host-owned resource
contributions. Registrations follow the Consumer's Cordis lifecycle. Model Tools cannot
choose resource files, roots or providers. Resources are bounded JSON envelopes with a
type, schema version, complete parent/child identity and digest; they do not execute code
or confer permission by themselves.

The CLI launcher writes an immutable input manifest under the child's private
`resources/input.json`. Before starting execution, Runtime commits its
`resourceManifestDigest` into the durable child record. Consumers compare that Host
binding before accepting output; a child cannot redefine its scope by rewriting and
re-hashing an input file. Resource files are size-limited, reject symlink traversal and
use fixed derived addresses. Output resources are separately and atomically committed
under `resources/output/<resource-type>.json`, bound to the exact input digest.

`WISH_CHILD_RESOURCES_FILE` and `WISH_CHILD_RESOURCES_DIGEST` are launcher-owned bootstrap
facts. The launcher also fixes `WISH_CHILD_ID`, `WISH_CHILD_SESSION_ID`, `WISH_CHILD_RUN_ID`
and `WISH_CHILD_EXCHANGE_DATA_DIR`; empty resource settings explicitly prevent inheriting
an ancestor's attachments. Session and Storage directories remain isolated. This protocol
is not an OS boundary between mutually hostile processes running under the same account.

Memory is an optional resource Consumer outside this module. It may provide a task-filtered
read-only snapshot and a private proposal outbox. Only the parent imports proposals from a
completed, exited child after identity, scope and committed Session evidence checks. A
proposal never means accepted knowledge; failed/cancelled child output is retained for
reconciliation. Neither shared resource files nor tmux upgrade File Storage's process-local
writer guarantee to multi-process safety.

## Verification

```bash
npm run test:subagents
npm run test:subagent-tools
npm run test:subagent-child
npm run test:subagent:real
npm run test:subagent:runtime-real
npm run test:state-handoff
npm run test:state-handoff:real
node scripts/accept-subagent-resources.mjs
node scripts/accept-memory-child-resources.mjs
node scripts/accept-memory-child-real.mjs
```
