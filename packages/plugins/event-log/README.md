# @tsuuanmi/system-event-log

**`ctx.eventLog`**: the append-only observability trail (QA-7). It is named
`eventLog` because Cordis itself owns `ctx.events`.

- **Owns:**
  - `append`: assigns `seq` and `at`, validates against
    [`event@1.0`](../../../schemas/event.v1.json), bounds the `data` size, and
    emits `system/event` (mode `emit`) **only after the outermost commit**. A
    listener can neither veto the append nor make it fail.
  - `query`: reads after a cursor, with filters (type, run, node, session,
    turn, and `since`, a time normalized to UTC; an invalid one is refused).
  - `trim`: deletes entries older than `retainDays` in batches, at start and
    daily (INV-9); a failed pass is logged and retried. With the default 0,
    every entry is kept. Freed space is reused, not returned to the disk.
- **Rule:** an entry references artifacts or decisions. It never carries secrets
  or private content.
- **Used by:** `workflow`, `turns`, and `provider-chatgpt-web` append;
  `profile-scientific-research` listens to `system/event`.
- **Injects:** `store`.
- **Config:** `maxDataBytes`, `retainDays` (default 0: keep every entry).
