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
- `runtime-service.ts` also owns the live `UserTurnContinuationPolicy` registry. Each Core Runtime
  generation receives one composite policy; domain plugins own their state and unregister through
  their Fiber lifecycle. The first policy follow-up decision wins at a UserTurn boundary.
- `step-execution.ts`: per-Runtime Step acquisition/replacement barrier. It owns only
  in-flight lease counts and replacement admission, not Run state, queues, plugin loading,
  permissions, persistence or retries.
- `agent-service.ts`: owns the default Wish Agent definition and facade.
- `agent-scope.ts` and `agent-preset.ts`: own Agent-local visibility, parent inheritance,
  resource cleanup and the serializable child role contract.
- `tool-context.ts`: immutable Wish product facts fixed for one Tool execution Step, including
  Runtime-authenticated UserTurn provenance and an exact Goal-round identity only for trusted
  GoalRoundDriver follow-ups.
- `coding-tools.ts`: explicit standalone composition of the default Coding Tool Consumers.

Core state machines and transition rules remain under `src/core/`; this directory must not become
the canonical owner of Session, Run, Step, Tool or Subagent state. Cordis is used here only for
composition, injection, replacement and lifecycle cleanup.

## Per-Agent Scope

Application registrations are visible to every Agent. `AgentScope` adds ordered parent and
child layers; a child may replace a Tool, Prompt section, Context Provider or Compaction
strategy by name without changing its parent or sibling. `Agents.scope` is the active
process Agent's identity. A scoped registration takes the contributing Cordis `ctx` as its
first argument, for example `ctx.systemPrompt.registerScoped(ctx, ctx.agents.scope, section)`.
That Fiber's disposal and the Agent Scope's disposal both remove the contribution. The
AgentLoop generation holds a Scope lease until its resources are released. Scope disposal
signals Agent-local background work before waiting for leases, so a Step awaiting that
work can finish. Agent unload starts Scope disposal and Run retirement together before
waiting for either drain. `scope.listen(unsubscribe)` and `scope.run(operation)` own listeners and
abortable work. Scoped Tool and Compaction calls admitted before a Fiber unload are
drained before that Fiber is disposed; retained callbacks reject new calls after removal.
Tool result renderers resolve the currently visible contribution, including a child's
override without a renderer, which uses the fallback.

The CLI child is a separate process. `WISH_AGENT_PRESETS_JSON` defines Host-selected role
presets; the Launcher resolves one before the Subagent record is created, intersects its
Tool list with the delegated parent ceiling, checks registered Tools, runtime features and
capabilities, and commits the resulting Tool list to the child record. The child receives
the resolved preset as `WISH_AGENT_SCOPE_PRESET`, creates its own Scope and installs its
Prompt and Compaction settings. Its Memory mode selects whether the Host sends a snapshot;
`none` also disables child Memory plugins. The record retains a digest of the selected
preset. A role with no configured preset still receives the normal compatibility-filtered
Tool set.

Example deployment setting:

```json
[
  {"role":"coder","availableTools":["read","grep","write","edit","bash"],"permissionProfile":"workspace-write","prompt":"Implement the assigned change.","compaction":{"keepRecentTokens":3000},"memory":"snapshot"},
  {"role":"reviewer","availableTools":["read","grep"],"permissionProfile":"read-only","allowedCapabilities":["filesystem.read"],"prompt":"Review the assigned change and report findings.","compaction":{"keepRecentTokens":1500},"memory":"none"}
]
```

Set this JSON as `WISH_AGENT_PRESETS_JSON`. The named Tools must be registered in the
Application; a missing Tool or unmet child runtime feature rejects launch. A preset permission
profile and capability list may narrow the parent grant; a broader profile is rejected.
The selected profile and available review surface also narrow the stored capability ceiling
to operations the child can actually execute.
Child-specific
plugins can inspect `ctx.agents.scopePreset?.role` and register their Tool, Prompt, Context
Provider or Compaction strategy against `ctx.agents.scope` using the scoped APIs. These
registrations live only in that child process. To add a Tool that does not exist in the
parent Application, declare it in the role's `localTools` with its `name`, `requires` and
optional `requiredCapabilities`, and include its name in `availableTools`. The parent
validates that contract before launch; the child refuses to open its Agent if its plugin
did not actually register the Tool. Tool visibility is not execution authority:
Permissions, approval and filesystem/Shell sandbox checks still run for every Tool call.
The child composer also removes Tools whose declared capabilities would require an
unavailable human review surface under the selected permission profile. For example,
`bash` is omitted from a read-only CLI child when it could only run after approval;
Plan controls require Plan state, human review and Session resume features, so a normal
execution child cannot enter a Plan state it cannot finish.

The continuation registry is a narrow product adapter rather than a second scheduler. Policies
cannot mutate Core queues directly; Core validates their decisions, creates the follow-up and owns
human-input preemption. Likewise, Tool consumers may use `tool-context.userTurn` as authenticated
identity but must still request and validate the relevant Permission Grant.

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
