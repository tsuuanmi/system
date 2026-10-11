# @tsuuanmi/system-event-log

**`ctx.eventLog`**: the append-only observability trail (QA-7). It is named
`eventLog` because Cordis itself owns `ctx.events`.

- **Owns:**
  - `append`: assigns `seq` and `at`, validates against
    [`event@1.0`](../../../schemas/event.v1.json), bounds the `data` size, and
    emits `system/event` (mode `emit`) **only after the outermost commit**. A
    listener can neither veto the append nor make it fail.
  - `query`: reads after a cursor, with filters.
- **Rule:** an entry references artifacts or decisions. It never carries secrets
  or private content.
- **Injects:** `store`.
- **Config:** `maxDataBytes`.
