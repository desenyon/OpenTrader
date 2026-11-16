# Credit economy verification — November 16, 2026

This record covers the source-seeded Live economy upgrade and Friends engine fixes. [Published engine rules](../design/credit-driven-economy.md). Earlier screenshot and performance records describe their original release dates.

## Final checks

- `npm test`: **187 tests passed in 23 files**, 36.31 seconds.
- `npm run build`: TypeScript, production client, precompression, server and admin CLI passed. Main client 324.98 kB raw / 99.17 kB gzip; chart and admin remain separate lazy chunks.
- `npm run test:production`: executable server, health, HTML/Brotli assets, immutable caching, hosted provider gate, anonymous signup, admin CLI login, approval without a reason, isolated wallets, admin reports, and reconciliation passed.
- `git diff --check`: clean.
- Fresh read-only economic review reproduced two bugs in memory: source observations contaminated the local chart, and an immutable-rule halt prevented subsequent valid final settlement. Each regression failed before its fix and passed afterward. Additional red/green checks cover weighted math, FIFO priority, full-book IOC denial, per-command timestamps, initial activation sequence, exact deadline formatting, malformed price precision, and trading-status cache bypass.

## Economic and integration coverage

- Independent high-precision weighted LMSR cost/reserve checks, uniform compatibility, random buy/sell paths, and both winning/neutral-void settlement cases.
- Quotes leave the journal untouched. Accepted orders reserve finite backing atomically. An order whose cap misses by one microcredit rolls back activation and every fill.
- Provider refresh changes the reference without resetting local inventory, prior, basis or price. Reordered outcomes preserve canonical identity; changed rules/assets halt matching and cancel locks. A provider-final result matching frozen original rules can settle a halted curve.
- Stale source confirmation and malformed precision cannot trade. Trade routes bypass the discovery status cache before fetching a fresh book. Local deadlines release locks without applying the Friends longstop to provider markets.
- Local AMM plus peer fills preserve cash/asset conservation and AMM issuance. Books, listing/detail prices, chart series, resting limit orders, cancellation and portfolio marks agree through real HTTP handlers.
- Three separate Node processes compete over one disk-backed wallet with only 1 CR. Thirty submissions yield one unique committed trade: three identical successful receipts for its shared idempotency key, and 27 bounded rejections. No negative wallet or duplicate reserve issuance occurs.
- Two connections and a restart preserve local state and return the original receipt. Starting with the feature disabled does not reinterpret a previously funded curve. A database containing legacy external fills retains its external-simulator model when upgraded.
- Sponsor exhaustion rejects new activation but permits existing funded markets to trade. Admin adjustments can access only the free pool. Reconciliation detects changed prior/reserve configuration even when cash and supply projections otherwise balance.
- Equal-price/equal-time peer orders use arrival sequence rather than random IDs. A full resting book does not block an IOC fill. One user cannot consume more than 20 resting slots per market. All entries from one accepted command share its timestamp.

## Final disk-backed benchmark

Run `npm run benchmark`. [Raw JSON with source hashes](credit-economy-benchmark.json). Every source fingerprint matched before/after this run. The benchmark uses its own temporary SQLite database and removes only that directory.

Friends fixture: 100 users, 1,000 approved OPEN markets, WAL/FULL, five 20-request bursts, then a 100-user burst. HTTP is local Fastify injection including event-loop waiting; no actual network/TLS/browser/upstream-provider time.

| Workload                                | p95 latency | Result          |
| --------------------------------------- | ----------: | --------------- |
| 20 concurrent Friends requests, round 1 |  171.652 ms | 20/20 success   |
| Round 2                                 |  180.385 ms | 20/20 success   |
| Round 3                                 |  183.293 ms | 20/20 success   |
| Round 4                                 |  196.044 ms | 20/20 success   |
| Round 5                                 |  190.436 ms | 20/20 success   |
| 100 simultaneous users                  |  957.434 ms | 100/100 success |

The Live measurements use the same populated disk database and **synthetic source fixtures**, separately from HTTP bursts. They call the actual weighted engine directly: five previews plus one buy/undo per size, prior 63%, b=500. They include journal/projection writes but exclude provider fetches. No synthetic market or user was inserted into the application's database.

| Live size    |    Quote p50 / p95 |       Buy |      Sell |
| ------------ | -----------------: | --------: | --------: |
| 10 shares    | 13.955 / 18.246 ms | 24.155 ms | 13.203 ms |
| 100 shares   | 27.040 / 28.370 ms | 38.358 ms | 21.954 ms |
| 1,000 shares | 40.839 / 46.951 ms | 69.977 ms | 23.480 ms |

All accounting flags passed, including the new risk-reserve check. Full reconciliation took 414.6 ms. The typical finite 20-request samples meet the proposed 400 ms target; the 100-user burst still exceeds it. SQLite commits, whole-state serialization, math and request handling share one event loop. This is a measured single-host release, not a sustained throughput, availability, production capacity or browser-rendering claim.

## Local application and retained limits

The user's SQLite database was backed up before restart, with a separate integrity snapshot of existing users, wallets, positions, orders, fills and non-liquidity accounts. New engine backing is a distinct, explicit issuance; existing wallet balances/positions are not migrated into a new pricing model. After restart, hashes of all six retained state sets matched exactly, health reported `ok`, and trading was enabled. Real upstream discovery returned 464 markets (100 Polymarket, 364 Kalshi). Fresh local-book previews succeeded for sampled Polymarket and Kalshi markets. Other sampled books remained stale or failed the opening-liquidity eligibility rule; freshness and backing gates were kept intact. No verification trades were placed in the user database.

The current UI changes received TypeScript/build and HTTP-flow checks, without a new browser walkthrough. Existing README screenshots are from the previous recorded UI session. Provider redistribution permission remains an independent hosted-deployment gate. Multi-outcome markets, full-set conversion, and a distributed engine remain future work.
