# Todo

Todo is a process-local, whole-list-replacement progress view for one active
UserTurn. It is not the durable Tasks DAG and does not schedule work.

`TodoService` resets the list from the Runtime's authenticated
`openUserTurn` boundary. Writes must carry the exact Run/UserTurn identity from
the immutable Tool context, so a late Step cannot overwrite the next turn's
list. The last list remains inspectable after a turn ends, then resets when the
next turn opens.
