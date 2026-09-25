# Tmux

Tmux is Wish's transparent execution plane for long-lived processes. Bash remains synchronous and does not expose background jobs; a short Bash call may create or control a tmux session, while tmux owns the persistent terminal that models and operators can list, capture, attach, steer, and stop.

## Roles

```text
private TmuxCommandRunner <- Local Tmux Provider -> Tmux Service <- Consumers
```

The Service owns provider-neutral session, target, terminal metadata, capture, input, and stop operations. The Local Provider invokes the tmux CLI through a private synchronous `TmuxCommandRunner` Port and stores discovery metadata as tmux user options. Parent/child Agent identity belongs only to Subagents records; tmux does not know it.

## Transparency

Every started workload returns its real tmux target plus copyable attach and capture commands. `list()` reconstructs live and dead-pane snapshots from tmux rather than a process-local job registry. A caller may retain semantic Session events and final results, but it must not hide the terminal address.

The Provider enables `remain-on-exit` so a completed pane stays inspectable until explicitly stopped. Captured output is bounded; tmux scrollback is not a durable substitute for Wish Session history.

`TmuxCommandRunner` accepts only an executable plus argv and waits for completion. It exists for
local Provider injection and tests; it is not a Cordis Service and never returns a background
process handle. If another real Host capability later needs the same contract, it can be promoted
only then.

Each workload is launched as an executable plus argv, cwd, and validated
environment additions; no shell string is accepted by the Service. On startup
the Local Provider writes Wish discovery fields into tmux user options. On a
later process generation, `list()` reconstructs the same semantic identity
directly from the configured tmux server.

The Cordis Provider owns admission and in-flight CLI requests, not the terminal process.
Disposal seals its API synchronously and waits for admitted commands without killing sessions.
Old Provider references remain closed after reactivation; a new Provider reconstructs the
existing target from the same socket. Optional Host lifecycle reporting exposes only command
counts and a stop guard, never Agent identities or task text. An admitted CLI command reports
`drain`: managed disable fences new commands, waits for that command, unloads the old Fiber,
and can re-enable a fresh Provider in the same Host. Live dependent capabilities
still have their own stop requirements; a transport reporting idle does not authorize stopping
an active Subagent or Workflow. Code replacement uses a separate Host protocol: reviewed
Consumers drain before this Provider fences and drains its commands, then the new Provider
rediscovers the same socket. Any unreviewed dependent still rejects the batch. Real in-flight
capture and parent/child continuity are covered by `npm run test:stateful-code-reload:real`;
this does not authorize administrative shutdown of live children.

`exitCode` is optional because tmux 3.2 exposes dead-pane state but not a portable dead-status format value. Consumers that require a structured outcome, including Subagents, must obtain it from their own result protocol rather than screen scraping.

## Limits

- Session and window names are normalized to portable tmux identifiers.
- One configured socket selects one tmux server and authority domain.
- A tmux server must never be shared across incompatible Sandbox or permission ceilings.
- Local Provider availability and a real attach walkthrough are deployment checks, separate from typecheck and fake-runner acceptance.

## Configuration and verification

The default product graph uses `WISH_TMUX_SOCKET`; otherwise it chooses
`<WISH_DATA_DIR>/tmux.sock` or `~/.wish/tmux.sock`. `WISH_TMUX_ENABLED=0`
unloads only the tmux Provider. Subagents and their model Tool Consumer have
separate switches and do not own tmux availability.

```bash
npm run test:tmux
npm run test:tmux:real
npm run test:shell:tmux-real
npm run test:state-handoff
npm run test:state-handoff:real
```
