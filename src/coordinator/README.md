# Coordinator

`src/coordinator` owns a Run-scoped coordination mode. It is independent from
Plan and is not a second implementation of Subagents.

## Contract

- `CoordinatorService` is the replaceable Cordis Service Definition.
- `CoordinatorRuntime` owns only `inactive -> active -> inactive` mode state.
- `DomainCoordinatorStateStore` persists one CAS-protected record per parent
  Run through Storage KV.
- `CoordinatorContextProvider` tells the model to delegate, observe, reconcile,
  and avoid overlapping child writes.
- `createCoordinatorPermissionPolicy` narrows active Steps to read/search,
  existing Subagent control Tools, and Coordinator controls. Tightening is
  immediate; loosening takes effect on the next Step.
- Model Tools are Consumers under `src/coordinator/consumers/model-tools`:
  `enter_coordinator_mode`, `read_coordinator`, and `exit_coordinator_mode`.

Subagents still owns child identity, limits, durable records, tmux execution,
input/output observation, cancellation, and completion relay. Coordinator does
not start background Bash and does not hide child processes. Exiting the mode
does not implicitly stop or delete children.

The Provider checks current Subagents availability when entering mode rather than binding its
own lifetime to that transport. Existing Coordinator state and permission policy survive a
Subagent/tmux code replacement; read/exit remain available while child observation recovers.

The completion relay holds and follows up the parent Run only for children
spawned by the current process generation. Durable records and tmux targets
survive restart, but recovery then uses `list_agents` / `collect_agent`; this
module does not claim cross-process continuation reconstruction.

Current child launchers share the workspace. The Context contract therefore
forbids concurrent write-capable children from touching overlapping files; true
worktree isolation is not claimed here.

## Operations

- Set `WISH_COORDINATOR_ENABLED=0` to disable Coordinator.
- Set `WISH_COORDINATOR_TOOLS_ENABLED=0` to retain host state while hiding its
  model control surface.
- Coordinator is also disabled when `WISH_SUBAGENTS_ENABLED=0` because its
  delegated execution capability is unavailable.
- Run `npm run test:coordinator` for focused state, persistence, Context, Tool,
  and hard-policy acceptance.
