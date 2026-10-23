---
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-board-core": patch
"@tsuuanmi/system-approvals-core": patch
---

After an autonomy policy change, a board task or charter waiting on a request the queue withdrew is put to the new policy on the board's next sweep, instead of waiting until it expired and was rejected:
- A task waiting for approval becomes ready when the new policy lets its class run (`auto` or `notify`), waits on one new request on the same subject when it still asks, and is cancelled (`forbidden`) when it is forbidden. A spent budget or a lost run is asked about again, or waits for input when no request can be opened.
- A charter is asked about again; when the new policy forbids charters, a first charter abandons its project and an amendment is dropped.
- Each of these moves records a `board` decision that names the withdrawal. A request the board withdrew itself still changes nothing.
