# Memory Providers

`storage.ts` is the authoritative parent library backed by the selected Storage Journal.
Its durable changes retain candidate, document and audit state. The Host curation pipeline
automatically consolidates extracted learning into searchable documents in one audited
Journal commit. The curation Provider maintains a recoverable Markdown workspace and runs an internal
AgentLoop to maintain its handbook, summary, source summaries and Skills. The model write Tool records
append-only notes for automatic consolidation. Human review remains a legacy Host API only.

`child-snapshot.ts` is the internal child alternative. It reads only the Host-pinned
`wish.memory.snapshot` attachment from the child's private resource directory. The manifest
binds parent owner and child Session/Run. For file memory, a version 2 attachment pins the
digest of a complete, immutable snapshot stored inside the child's private data directory.
It carries the summary, handbook, rollout summaries, Skills and resources together, without
a fixed document quota or the inline resource transport size limit. The child cannot choose
a different file path or change the digest. The snapshot retires with the child's data.
Version 1 task-filtered inline snapshots remain readable for legacy Host integrations.

The shipped child profile exposes read Tools only; it does not expose the root note Tool or curation.
The proposal exchange described below remains a compatibility contract for explicitly integrated Hosts.
Accepted documents never change in this Provider. `decide`, `changeStatus` and `consolidate`
are denied even if the caller claims a human or curation actor. Authorized `propose` operations use the same Memory
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
summary injection, reading a Skill by path, absence of a child write Tool, and persistence
after reopening the parent library.
It requires the supported Node version and loopback/tmux access, and does not prove
external model behavior or browser interaction.
