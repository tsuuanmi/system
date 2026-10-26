---
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-schemas": minor
---

`system roster` lists every tier a tiered Worker offers (T275b): a Worker that offers economy, standard and frontier (ADR-0073, `roles[].runtimes.<rt>.tiers`) no longer prints "serves economy" alone. Its `serves` line names each tier, lowest first, with its model's display label from the live profile (never a model name in the repository), its turn limit (`maxTurns`), and when its model's limit closes it. The JSON keeps its fields and adds a `tiers` array (`mcp-roster@1.10`). The agents source describes each tier's `label` and `maxTurns` (`capability-descriptor@1.11`, additive).
