# Subagent Model Tool Consumer

This module exposes the semantic `SubagentsService` to the model as six narrow
Tools: `spawn_agent`, `list_agents`, `capture_agent`, `send_agent`,
`stop_agent`, and `collect_agent`.

It is a Consumer owned by the Subagents domain, not part of `src/tools`.
`WISH_SUBAGENT_TOOLS_ENABLED=0` independently unloads it. Disabling or deleting
this Consumer leaves the Subagents capability intact.

The model supplies a task, role, optional configured model, permission profile,
and Tool allow-list; it cannot choose an executable, tmux socket, data root,
execution Provider, data root, parent identity, or workspace root. Those values come from the host launcher
and the immutable Step context. Without an explicit model, the child inherits
the current Step's effective model and credential-free Models configuration.

Read operations require `runtime.read`. Spawn, send, and stop require
`runtime.control`, pass through the normal Permissions decision, and assert the
active one-shot Grant immediately before dispatch. Starting a child is not a
background mode of Bash: the lifecycle is owned by `SubagentsService`, while
the actual process remains independently visible through its returned terminal target.

Every operation passes the current Agent, Session, Run, and Workspace identity
to `SubagentsService`. The domain Runtime performs the ownership check and
reports a foreign id as not found instead of leaking its existence.

`spawn_agent` acquires a hold through the generic Core `RunContinuation` Port
before launch. The domain Runtime monitors its execution Provider and publishes
structured lifecycle events; the `subagents/adapters` result bridge subscribes to them. On
completion, failure, retained exit without a result, or timeout it submits one
bounded parent follow-up and releases the hold. This gives the parent model a
normal next UserTurn containing the child result without screen scraping. A
relay shutdown releases its hold but does not kill the independently
observable terminal execution.

## Verification

```bash
npm run test:subagent-tools
npm run test:runtime
npm run test:subagent:runtime-real
```
