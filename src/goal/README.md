# Goal

Goal owns one durable, Session-scoped long-running objective. Every model or
human mutation uses an exact `(id, revision)` compare-and-set reference. The
durable phases are `active`, `paused`, `blocked`, and `complete`.

Automatic continuation is deliberately separate. `activation` is process
local, is disarmed after provider restart, and is never serialized. This
module exposes `admitRound()` for the later GoalRoundDriver, but installing the
Goal provider alone never schedules a follow-up.
