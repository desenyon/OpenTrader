# Administration and economy audit

November 15, 2026 (America/Los_Angeles). Built from browse-first commit `c52b826`.

The later [anonymous trading and admin cleanup update](trading-privacy.md) removes the admin reason requirement and adds signup privacy controls. The checks below describe the original administration release.

## Audit findings and fixes

1. Settlement escrow reconciliation compared integer microcredits with whole shares, missing a factor of 1,000,000. A balanced fixture transfer leaving 1 CR against 100 outstanding YES shares incorrectly passed every check. The guard now measures the full maximum payout liability in microcredits. This was a confirmed false negative in detection; normal trades were not shown to create this shortage.
2. A Friends sale preview of 101 shares while owning 100 advertised an executable partial fill, while the identical order failed ownership validation. The preview now explicitly rejects requests exceeding unlocked holdings, matching execution.

Both regression tests were run against a temporary copy of the original engine and failed for the original symptoms, then passed against the fixed engine. Temporary baseline copies were removed; no user database was used for these fixtures.

## Administrative behavior

- Public HTTP registration requests remain PENDING, with no allocation or private-group access. Approval atomically creates separate 10,000-credit Live/Friends wallets and an initial group once. Existing persisted accounts default to APPROVED USER without reallocation.
- Platform admins are locally provisioned. No HTTP registration payload can grant platform role. The last approved admin cannot be suspended. Ordinary owners and moderators receive no platform privilege.
- Suspension cancels outstanding orders, releases locks and blocks account/group APIs and realtime access. Positions persist and settlement pays them normally; reactivation does not mint another allocation.
- Signed wallet and free-treasury adjustments require a reason and an idempotency key. Double-entry movements use scoped issuance counterparties and explicit ADMIN_ALLOCATION / ADMIN_RECLAIM journal reasons. Negative available balances, locked-fund reclaims and reserved-subsidy reclaims are rejected. Leaderboard returns exclude grants/reclaims.
- Persisted platform pause stops new orders and quotes across both exchanges. Orders remain cancelable and due settlements continue. Friends halt/resume preserves frozen deadlines and cancels resting orders on halt. Live governance stays source-controlled. The dashboard cannot bypass independent resolution rules or the accounting circuit-breaker latch.
- Account, wallet, order, fill, position, settlement, market, group-budget and operator-history tables are searchable and paginated, with current-page JSON export. Wallet cash journals paginate exact movements. Gross settlement entitlement and realized trading P&L are separately labeled; correction movements are visible in journals.
- Operator audit records include actor, action, reason, target and prior state, with SQL update/delete protections. Password hashes, salts, session tokens and invitation secrets are not returned in admin reports.
- The dashboard is a separate lazy JS/CSS chunk. Market discovery, portfolio and realtime polling are disabled while it is open; its report refreshes every 15 seconds and reconciliation every 30 seconds. Existing market navigation remains intact.

## Verification

- `npm test`: **146 tests passed across 19 files**, 34.65 seconds. Includes original math, matching, ledger, source simulation, cross-group permissions and governance suites, plus pending-registration authorization, exactly-once approval, signed adjustment validation/idempotency, immutable audit, active-session suspension, preserved settlement, locked-resource release, scoped returns, legacy data migration, multi-connection/restart persistence and CLI provisioning.
- `npm run build`: TypeScript, Vite and bundled server/admin CLI passed. Initial application JS: **322.58 kB raw / 98.41 kB gzip**; lazy admin JS **14.31 kB raw / 4.76 kB gzip**, admin CSS **6.45 kB raw / 1.60 kB gzip**. Chart remains a separate chunk. No runtime dependency was added.
- `npm run test:production`: passed built CLI provisioning, server startup, HTML/Brotli/cache headers, hosted source permission gate, pending account/session, admin login, approval, independent wallets, report access and reconciliation using a disposable database.
- Fresh independent code review found two integration issues: CLI `.env` database loading and Friends controls shown on Live rows. Both were fixed. The CLI bug has a failing-before/passing-after regression, including mode-0600 credentials, no secret output, and overwrite rejection.
- The local `admin` account was actually provisioned into `data/opentrader.sqlite`, following a consistent SQLite backup. Its mode-0600 credential receipt is ignored by Git. HTTP login, approved platform role, both initial wallets, every admin report section, healthy reconciliation and logout were verified against the restarted production preview at `http://127.0.0.1:3000`.

## Performance sample

`npm run benchmark` used a disposable WAL/FULL SQLite database, 100 users and 1,000 independently approved open markets. Source fingerprints were unchanged throughout the run. Raw output: `artifacts/benchmark-2026-11-16T06-07-42-302Z.json` (ignored local artifact).

| Submitted burst   | Successful orders | p95 response |
| ----------------- | ----------------- | ------------ |
| 20 users, round 1 | 20 / 20           | 165.328 ms   |
| 20 users, round 2 | 20 / 20           | 187.645 ms   |
| 20 users, round 3 | 20 / 20           | 200.410 ms   |
| 20 users, round 4 | 20 / 20           | 205.765 ms   |
| 20 users, round 5 | 20 / 20           | 220.680 ms   |
| 100 users         | 100 / 100         | 1,233.924 ms |

Every reconciliation flag passed; full reconciliation took 417.5 ms. These are finite in-process Fastify injection measurements on one host, excluding network/TLS, browser rendering, source feeds, large-lot matching, same-market contention and sustained throughput. The typical 20-user samples were below the proposed 400 ms target. The 100-user sample shows higher event-loop queueing and does not establish production capacity.

## Limits

The new dashboard was typechecked and packaged; no fresh browser interaction or visual inspection is claimed in this task. Backend security and economic flows have actual integration coverage. Existing binary-market, single-host durability, source-data permissions and staffing/escalation limits remain in the README. Docker image build and hosted production deployment were not performed.
