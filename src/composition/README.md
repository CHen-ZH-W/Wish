# Composition

`src/composition/` owns Wish's product-specific Agent execution composition. It adapts the
framework-independent AgentLoop, Runtime, Agent, Context, Models, Tools and capability Ports to
Cordis services and lifecycle generations.

- `agent-loop-service.ts`: builds one Step pipeline from the currently injected capabilities.
- `agent-loop-standalone.ts`: explicit standalone helper with default Basic Tool registration.
  Callers that need implicit default Tools use this entry; the product service requires an
  injected Registry and never imports concrete Tool implementations. Updating one Tool
  therefore does not reload the Runtime through an unused standalone fallback.
- `runtime-service.ts`: owns the process-local Run controller and generation retirement;
  its read-only `lifecycleSnapshot()` aggregates actual generation references without
  copying Run state or exposing Run identities. References are removed after successful
  resource release. Its optional Host lifecycle query reports active/retiring work as
  blocked, and never aborts or retires a generation.
  Its separate controlled-stop guard suspends `open()` and every returned generation's
  `startRun()` together. Rejected preflight releases only that admission fence; approved
  idle shutdown awaits generation retirement/resource release. Active Runs are blocked,
  never implicitly aborted to make an administrative stop pass. Old references remain closed.
- `step-execution.ts`: per-Runtime Step acquisition/replacement barrier. It owns only
  in-flight lease counts and replacement admission, not Run state, queues, plugin loading,
  permissions, persistence or retries.
- `agent-service.ts`: owns the default Wish Agent definition and facade.
- `tool-context.ts`: immutable Wish product facts fixed for one Tool execution Step.
- `coding-tools.ts`: explicit standalone composition of the default Coding Tool Consumers.

Core state machines and transition rules remain under `src/core/`; this directory must not become
the canonical owner of Session, Run, Step, Tool or Subagent state. Cordis is used here only for
composition, injection, replacement and lifecycle cleanup.

## Execution replacement

Runtime depends on the stable `launch`, `sessions`, `models`, and `runtimeLifecycle` owners,
not on the replaceable `agentLoop` service. It pins an Application-facing Session lease and
Models view for its Run generation. A `StepPipelineSource` obtains the current AgentLoop
implementation and its complete execution resources before each Step; Core releases the
lease after Step lifecycle finish. A missing AgentLoop rejects new Run admission and Step
acquisition; the remaining Application surface does not imply execution is available.
Opening a new Application generation waits, with cancellation and a deadline, for the current
AgentLoop to finish activating. Existing generations do not acquire a static AgentLoop dependency,
so coordinated Step replacement can retain Run identity without unloading CLI/WebUI surfaces.

The trusted Host calls `runEngine.execution.replace(update, { signal })` to synchronously
close new Step admission, wait for all Steps of that Runtime (across generations) to finish,
then run an explicitly scoped replacement callback. The callback must await old cleanup and
new activation. Once it succeeds, the same Runs continue using fresh pipelines without
changing their IDs, memory, queues, cancellation or completion promises. This is not a model
Tool or an automatic file watcher; a Tool must not await its own Step's replacement.

Cancellation/deadline before mutation reopens the original implementation. Once mutation
starts, failure fences later acquisitions and new Runs until the owner is explicitly recovered;
no automatic retries, unsafe reopening or side-effect rollback are provided. The signal does
not forcibly interrupt an already-running replacement callback. Runtime's own teardown still
retires generations, aborts active Runs once, and waits for original completions.

Tool Registry generation checks remain intact. The barrier must cover **every** execution
owner sharing a changing Registry; uncoordinated edits still invalidate old Step snapshots,
including unrelated Tool registrations. Permission/Tool revocation is not deferred by a Step
lease. Do not use retained snapshots as an execution permission.

Verified replacement scope is AgentLoop plus Tool contributions in the default isolated
application graph. The native HMR adapter uses the pre-disposal barrier for owners explicitly
declared through the optional Root `codeReload` interface. AgentLoop and the Read Consumer
declare this contract; Runtime registers its boundary but is not itself replaceable.
All Runtime boundaries in the Root are drained conservatively, including isolated scopes.
Other owner/dependent changes are rejected before disposal. Modules use type-only imports
for this seam, so a registration helper cannot connect their implementation dependency graphs.
Managed code HMR additionally holds the management transaction across the whole native batch;
pending intent is saved after draining, and the success receipt lands before Step admission resumes.
Neither code replacement nor a dormant module import alters user enable/disable preferences.
This interface is not permission to wrap arbitrary Loader mutations or security revocations as
code updates. State migration, scheduler takeover and UI code replacement have separate owners.

Validation: `npm run test:step-execution` covers Core leases, durable finish, queues, cancellation,
failure fencing and real bootstrap/AgentLoop/Tool replacements during streaming, approval and
execution, using a local deterministic Model Adapter (no external Provider request).
`npm run test:code-reload` additionally covers native file edits, multi-file batches, same-Run
continuity, self-edit acceptance, stable-owner rejection, activation failure and cleanup deadlines.
