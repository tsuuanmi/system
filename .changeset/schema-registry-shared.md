---
"@tsuuanmi/system-libs": patch
---

Schema validation loads the schema files once per process. Every plugin that validates records used to load and compile its own copy of them. The profile now starts with less CPU, and `system check` checks an autonomy policy set faster.
