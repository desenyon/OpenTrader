# Simple Friends bets and fresh balances

Implemented November 16, 2026, following the user's explicit request to remove formal Friends resolution paperwork. This supersedes the previous default Friends approval/resolver workflow. Live provider resolution remains separate.

## User flow

1. Choose **Create bet**, enter a question and closing time, and submit. Description is optional. No categories, sources, evidence, resolver selection, liquidity configuration, or approval are needed.
2. The bet opens at 50/50 immediately. The group treasury funds its fixed `b=100` maker reserve; personal balances are spent only when trading. The creator can trade too.
3. The creator or an active group owner/moderator can choose **Resolve bet → Yes / No / Cancel** whenever the result is known, including before the scheduled close. Payouts and released order locks commit together. No source, reason, or 24-hour wait is required.
4. Winning shares receive exactly 1 CR; losing shares receive zero. Cancel pays 0.50 CR per contract, as explained in confirmation; it does not promise purchase-price refunds after shares have traded.

Existing drafts have an **Open bet** action that the creator can use without a separate approver. Existing open/reviewed Friends markets can also use direct creator/admin settlement; the preceding mode, resolver and resolution are retained in the audit event. Final results cannot be changed through another settle request. Same-result retries cannot pay twice. Creator-controlled bets wait for their decider after closing instead of automatically voiding at the old review longstop.

The detailed legacy create/approve/review APIs remain compatible for prior clients. The normal UI uses the casual flow. Unauthorized members, removed members and other groups cannot resolve a bet. A Live market cannot be settled with the Friends endpoint. Actor, result and ledger movements are saved automatically; privacy and exact-accounting controls remain in force.

## Balance fixes

- A completed mutation now invalidates an older in-flight resource fetch and schedules one current follow-up. Old responses or failures cannot replace the new balance. Multiple invalidations coalesce without dropping the follow-up.
- Completion clears the pending request synchronously, fixing a second race where an invalidation in the finalization microtask gap was lost.
- Background realtime and polling requests still coalesce without starving slow responses. Returning to a visible tab forces a current read.
- Wallet and position reads process due order expiries immediately; they do not wait for the periodic maintenance timer to release cash or shares.
- Settled position marks show final 1/0 prices, or 0.50 on cancel, rather than the reset AMM's 50/50 price.
- Admin adjustment confirmation identifies the wallet's scope. Tests verify an exact six-decimal grant reaches bootstrap, wallet and admin accounting views once, remains excluded from trading profit, and leaves Live/other-group balances unchanged.
- A settlement confirmation is keyed to its market, so navigation cannot carry a pending choice onto a different bet.

Credits remain in their selected economy. This change makes admin adjustments apply and refresh correctly; it does not add user-to-user gifts or cross-economy transfers.

## Verification

- Full local rerun: **201 tests passed in 25 files**, 39.93 seconds.
- Production build and packaged production smoke passed, including account approval, anonymous identity, scoped wallets, admin reports and reconciliation.
- New tests cover one-member creation, backed opening, creator trading, early settlement, released cash/share locks, repeat settlement, forbidden final-result replacement, cancellation payouts, creator/moderator/group permissions, old draft opening, truthful legacy conversion metadata, source-free HTTP creation/resolution, correct credit adjustment propagation, and refresh races.
- Fresh read-only review found the finalization refresh race and market confirmation state reuse. Both were corrected; the refresh race was reproduced by a failing regression first.
- One earlier full run timed out in `returns validation errors for exponential monetary order fields without committing any order`. The isolated rerun passed in 243 ms and the subsequent complete suite passed. The test and timeout were not loosened.
- Database backed up before restart. Hashes of existing users, wallets, accounts, orders, positions and fills matched exactly afterward. The running server reported healthy and served the new Friends UI bundle. Test trades used disposable databases only.
- `git diff --check` passed. The current UI received type/build and HTTP-flow verification; no new browser walkthrough was performed.

Prior benchmark records remain measurements of their recorded source versions; this change does not establish new production capacity or a browser-performance guarantee.
