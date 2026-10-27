---
"@tsuuanmi/system-digest-core": patch
"@tsuuanmi/system-digest": patch
"@tsuuanmi/system-digest-extractive": patch
---

Clean-up (PROP-0018 T4), no behaviour change: the two digest providers share one request engine, `DigestEngine` in digest-core (durable requests, lease-driven serving, routing, the quote check, the one escalation, settling). Each provider keeps its migration and table, its preamble and brief, and how it reads an answer. Tables, request ids, decisions, events and tools are unchanged.
