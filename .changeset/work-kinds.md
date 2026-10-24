---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
---

Route work by its kind (ADR-0056, proposed; the operator's D35):
- A work requirement may name its `kind` (`work-requirement@1.2`), an opaque label such as `code` or `docs`, and a capability descriptor may list the `kinds` the operator gives its Worker (`capability-descriptor@1.6`). A Worker given kinds takes only work that names one of them, never work that names none; a Worker given none takes any work, so nothing changes until the operator gives a Worker kinds. Kinds are compared for equality only (`takesKind`, part of the `capability` check); a refusal says so (`takes code work only; this work is docs work`), and with no Worker left admission fails closed (`no Worker that proves develop takes docs work`).
- An agent Worker, or a role, may list the `kinds` of work the operator gives it (1 to 16 labels; refused at load when malformed, repeated, empty, or on a review member). Its descriptor carries them (`capability-descriptor@1.6`). `system account migrate` keeps them: rows that differ in kinds become different roles (rule `agent-workers.migration` version 2).
