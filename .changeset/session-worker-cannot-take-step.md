---
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-workers": patch
---

A run no longer fails only because its session's Worker cannot take a step (T230; seen on T229, run_a3ca739177f0a7e6):

- A step on the run's session routes only to the Workers the session stays on. When every one of them is refused for a reason no wait can change (its input bound, a capability it does not prove, its tier, where it runs), the step now runs once off the session on another admissible Worker. It runs without the session when its brief already quotes every earlier turn of it (`sessionless`), and otherwise through a handoff: its brief carries the results of the session's earlier turns it does not quote (`handoff`). The session keeps its Worker; a later step back on it is handed the results of the steps that ran off it. The choice is a `route` decision by `workflow.session-move`, with a `workflow.node.session-moved` event. Before this, a research run whose session stayed on a website that takes 30,000 characters failed on its 56,350-character evidence step (`invalid_input`, not retried).
- A Worker of the session that is busy, at its limit, or signed out is still a wait, and a team member's session still never moves. A step no Worker takes off the session either still fails, naming both refusals.
- Every route decision now reports the input against the bound: on the chosen Worker, `input N characters, within its bound of M` (or that it declares none), and how many other Workers that could take the step were refused for their bound alone, with the largest of those bounds.
