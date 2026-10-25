---
"@tsuuanmi/system-web-ui": minor
---

UI wording (T191), from T172's rules: one wording per concept on every button, its consequence in its accessible description.
- Approvals are **Approve** / **Deny** everywhere: a request's card on Home and on the policy page, a Board card, a start awaiting approval, and a run's plan (was *Approve plan* / *Reject plan*); a batch keeps **Approve all N** / **Deny all N**. Labels such as *Approve: merge change* or *Deny: keep branch only* are now **Approve** and **Deny**, described by *merges the change* and *keeps the branch only*.
- Reviews are **Accept** / **Send back** (was *Accept: mark it done* / *Reject: send it back*); the report says *Sent back:*, and a task a review sent back waits as *Input needed — sent back*.
- Every confirmation is **Confirm** / **Cancel** (was *Confirm stop*, *Confirm start*, *Confirm pause*, *Confirm close*): stopping a run, a project's **Pause…**, **Resume…**, and **Close…**, and a ready task's **Start…**.
- Every such button, with **Stop run**, **Retry failed step**, **Show change**, **Propose**, and a project's moves, carries what it does as its accessible description (`aria-describedby`), said beside it in words too, by one helper on every page.
