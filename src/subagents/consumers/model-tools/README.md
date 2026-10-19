# Subagent Model Tool Consumer

This module exposes the semantic `SubagentsService` to the model as six narrow
Tools: `spawn_agent`, `list_agents`, `capture_agent`, `send_agent`,
`stop_agent`, and `collect_agent`.

One stable Consumer owns all six registrations. `spawn_agent` dispatches through
`subagentToolDispatch`: an opt-in Workflow adapter (`WISH_SUBAGENT_WORKFLOW_ENABLED=1`)
may contribute durable scheduling,
while removing that adapter immediately falls back to direct `Subagents.spawn` without
replacing the Tool Consumer or changing the model-visible Tool set.

It is a Consumer owned by the Subagents domain, not part of `src/tools`.
`WISH_SUBAGENT_TOOLS_ENABLED=0` independently unloads it. Disabling or deleting
this Consumer leaves the Subagents capability intact.

The model supplies a task, role, optional configured model, permission profile,
and Tool allow-list; it cannot choose an executable, tmux socket, data root,
execution Provider, data root, parent identity, or workspace root. Those values come from the host launcher
and the immutable Step context. Without an explicit model, the child inherits
the current Step's effective model and credential-free Models configuration.

Before either direct dispatch or Workflow scheduling starts a child, the Host
assembles its Tool set from the parent's delegation ceiling, currently registered
Tools, delegated capabilities, and the selected child runtime's features. Tool Consumers may declare
runtime and capability requirements with their registration. Resource Providers
advertise the features that their child resource makes available. An omitted Tool selection leaves
out contributions whose requirements are unavailable; an explicit request for
one fails before launch with the missing feature names. The current CLI child is
one-shot and supplies no Plan review or Session-resume feature, so Plan controls
are absent from its assembled Tool set. The resolved Tool set is passed as the
child's explicit allow-list and remains subject to normal execution authorization.

Read operations require `runtime.read`. Spawn, send, and stop require
`runtime.control`, pass through the normal Permissions decision, and assert the
active one-shot Grant immediately before dispatch. Starting a child is not a
background mode of Bash: the lifecycle is owned by `SubagentsService`, while
the actual process remains independently visible through its returned terminal target.

Every operation passes the current Agent, Session, Run, and Workspace identity
to `SubagentsService`. The domain Runtime performs the ownership check and
reports a foreign id as not found instead of leaking its existence.

`spawn_agent` acquires a UserTurn completion hold through the generic Core `RunContinuation` Port
before launch. The domain Runtime monitors its execution Provider and publishes
structured lifecycle events; the `subagents/adapters` result bridge subscribes to them. On
completion, failure, retained exit without a result, or timeout it submits one
internal next-Step continuation and releases the hold. The parent does not make
another model request or finish its current UserTurn while an awaited child is
pending. Multiple children may run in parallel; their accepted results enter
the same UserTurn. Session provenance and WebUI keep that Host-owned data
distinct from visible user input. A relay shutdown
releases its hold but does not kill the independently observable terminal execution.
The relay subscribes before re-reading the child record, so a child that finishes
between dispatch and subscription is still observed.

## Verification

```bash
npm run test:subagent-tools
npm run test:runtime
npm run test:subagent:runtime-real
```
