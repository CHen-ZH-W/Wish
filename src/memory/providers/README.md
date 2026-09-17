# Memory Providers

`storage.ts` is the authoritative parent library backed by the selected Storage Journal.
Its durable changes retain candidate, document and audit state. A model proposal cannot
publish knowledge; human decisions remain a separate authority.

`child-snapshot.ts` is the internal child alternative. It reads only the Host-pinned
`wish.memory.snapshot` attachment from the child's private resource directory. The manifest
binds parent owner, child Session/Run, library, accepted document versions and delegated
proposal access. Knowledge is selected by the Host from the child task, not by arbitrary
model-supplied filesystem paths.

Accepted documents never change in this Provider. `decide` and `changeStatus` are denied
even if the caller claims to be human. Authorized `propose` operations use the same Memory
domain rules but commit only to the private `wish.memory.candidates` output resource;
the operation returns after its outbox write. The child queue's state revision counts its
own proposal audit, while `snapshot().revision` retains the source library revision.
Restarting the Provider reloads that queue without repeating accepted-memory writes.

The optional parent `consumers/subagent-resources.ts` checks the durable Subagent manifest
binding and imports only exited, completed children. It opens child Session evidence only
after process exit, verifies the referenced committed sequence prefix and digest, and
records the real child actor when submitting a pending candidate to the parent library.
Retries reuse a stable parent operation identity. Scope conflicts, invalid evidence and
failed/cancelled execution retain the outbox for reconciliation rather than publication.

The parent adapter scans durable Run ownership to recover missed completion observations.
Its registration, subscription and scan timer retire with the Consumer and drain in-flight
work before closing. Disabling this adapter leaves both Subagents and Memory independently
usable; no Memory logic belongs to Subagents core.

Verification: `node scripts/accept-subagent-resources.mjs` and
`node scripts/accept-memory-child-resources.mjs` after `npm run build`.
`node scripts/accept-memory-child-real.mjs` uses real tmux with a localhost mock model,
separate temporary data and a durable parent Journal. It verifies snapshot reading,
private proposal output, parent review routing and idempotent import after reopening.
It requires the supported Node version and loopback/tmux access, and does not prove
external model behavior or browser interaction.
