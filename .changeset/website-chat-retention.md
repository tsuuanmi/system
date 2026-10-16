---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-turns": minor
---

Retention now deletes the website chats `system` created: every conversation is recorded, and when the run that owns it is deleted or expires, it is deleted on its site (`system conversations` lists them). Finished runs now expire after 30 days by default (`retainRunsDays`, was 0: never). Existing runs older than 30 days are expired at the first sweep after the update, with the chats only they used; set `retainRunsDays: 0` on the `workflow` row before updating to keep them.
