---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-gateway-core": patch
---

A website Worker whose quota windows have no reading yet takes work again, one at a time (T294). A pool configured `unknown: available` with no reading at all is admitted by dispatch at a bound (`dispatch.maxRunningUnreadPerAccount`, default 1 run or ask per account), ordered after every account with real headroom whatever its tier, and its choice records "unread, admitted at the unread bound". A reading of any window replaces the bound. `accountQuotaOf` marks such an account `unread`, `quotaScoreOf` takes an optional `unreadBound` per candidate (without it nothing changes), and the roster's capacity says the account is unread. This ends a research task whose first step needs the website Worker waiting forever (T254b).
