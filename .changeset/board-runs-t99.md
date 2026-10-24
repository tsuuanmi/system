---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-notify": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-profile-software-development": patch
"@tsuuanmi/system-cli": patch
"@tsuuanmi/system-web-ui": patch
---

What T99's board runs showed (T102b):
- `board_update`'s description and schema name an answer's shape, `{question, answer}`, with an example (D7).
- `explain` lists the decisions a board task's run makes that no step holds (its admission, subject, acceptance, report, funding gate, digest) first, as `decisions`; `system explain` prints them under `run (decisions no step holds)` (D9).
- A board task's step waits on its Worker's tool call that the policy asked about, instead of failing the attempt: the node is `BLOCKED` until the request is decided or expires (`gateTimeoutHours`), the task stays running with its attempt unspent, and an approval continues the session once; a rejection or an expiry fails the step `USER_ACTION`. A run that ends any other way withdraws the requests its gates left open (D2).
- algorithm-development's validator reads the board task's criteria and their checks, never the develop step's input; `brief@1.3` adds an acceptance item's optional `check` (D4).
- A Worker source whose first describe has not landed reads `describing` (`mcp-roster@1.5`, an optional field of a source read): health, the roster, and `/ui` count its Workers as heard so far (D8).
- `board_propose` takes `maxAttempts` (1 to 10, `mcp-board@1.2`), and the board's `templateAttempts` names a default per template. A review held for the operator is recorded as `board.review.held` and `board.review.ended`, and the notifier tells it as `review.expiring` (`notification@1.1`) `expiryLeadMinutes` before it expires (D6).
