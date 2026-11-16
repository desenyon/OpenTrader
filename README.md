# OpenTrader

A self-hosted prediction market with two separate play-credit economies. Start with a searchable market grid, open a question, choose an outcome, and review a protected quote before confirming. Live and Friends have distinct balances. Desktop/mobile layouts, light/dark themes, and keyboard-accessible dialogs are included.

## Run locally

Requires Node.js 24 or newer; verification used Node 26.11.1. No API key, paid model, hosted database, or cloud account is required.

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**. Request an account with a handle and a password of at least 12 characters. A platform administrator must approve it before trading or joining groups. First approval creates independent 10,000-credit Live and Friends wallets and a private group; repeat approvals and reactivations never reissue credits. Existing accounts remain approved users. There is no guest trading account, hidden demo balance, or generated source history. During signup, **Appear anonymous when trading** hides your name in trade history and rankings behind a stable alias for each economy. Admins can still attribute activity; memberships, comments and creator/resolver roles remain named.

For a private market, invite friends from **Friends → Manage group → Invite**. Appoint an independent moderator in **Manage group → Members**, select a separate nontrading resolver in the creation form, and have the moderator approve the draft. New markets have funded LMSR liquidity even without peer orders.

## Platform administration

Provision an administrator locally against the same database used by the server:

```sh
npm run admin:create -- --handle admin
```

The CLI loads `.env`, respects `DATABASE_PATH`, and accepts explicit `--database` and `--credentials` paths. It generates a strong password and saves it to `data/admin-credentials.txt` with owner-only permissions; it never prints the password or overwrites an existing receipt. Keep this ignored file private. For a production installation without development dependencies, run `node dist-server/create-admin.js --handle admin` after building. There is no public admin registration or first-user elevation.

Sign in, then choose **More options → Admin dashboard**, or open **http://localhost:3000/#/admin**. The dashboard has five sections—Accounts, Activity, Economy, Markets and History—with compact subviews. It includes:

- Account requests, approval/rejection, suspension/reactivation, and last-admin protection.
- All placed orders, individual fills, current/closed positions, gross settlement payouts, realized P&L, and exact wallet cash journals. Search and paginate across users and scopes; export the current report page.
- Signed credit allocations/reclaims to a specific wallet or a group's free sponsor budget. Actions use repeat-safe request keys and are recorded automatically; no reason is required. Reclaims cannot spend locked cash, shares or market escrow. Initial season allocations remain visible and unchanged; admin allocations/reclaims are excluded from trading returns.
- Trading pause/resume across both exchanges; individual order cancellation; Friends market halt/resume. Published market rules, frozen deadlines and independent settlement review still apply. Source-controlled Live markets retain provider governance.
- Read-only reconciliation status and immutable operator history with actor, action, target and previous state. A reconciliation circuit-breaker latch requires repair and a server restart; the dashboard cannot override it.

Suspension immediately blocks authenticated trading and group data, cancels open orders and releases their locks. Owned positions remain recorded and settle normally; reactivation restores access without a new allocation. Pending or rejected accounts receive no wallets or group data. Platform administrators can inspect trading activity across groups; the registration screen discloses this supervision. Admin creation does not silently promote a group owner.

## Two exchanges

**Live** reads current Polymarket/Kalshi discovery, depth, and genuine source history. Protected immediate paper orders walk available levels; no order reaches either provider. Books missing a valid source timestamp, older than five seconds, or otherwise invalid cannot execute. Point-only history is drawn as a line rather than inventing candle ranges or volume. Final payouts require explicit provider-final evidence, with a recorded correction path for later reversals.

**Friends** is invitation-only and independently priced. Binary markets use a fixed-liquidity LMSR maker plus price-time peer limits. Immediate orders, GTC/GTD limits, expiry, cancellation, cash/share locks, partial fills, and protected execution are implemented. Only owned shares can be sold. Independent creator approval, evidence-based resolution, a 24-hour challenge window, two-reviewer disputes, neutral void, moderator halt/resume, reporting and comment removal are included.

All credits are fictional, free and nonredeemable. Funds and positions never transfer across exchanges or groups. There are no deposits, withdrawals, prizes, leverage, brokerage connections, cryptocurrency wallets or real order submission.

## Included tools

- A browse-first market grid, topic/search/source filters, watchlists, shareable market URLs, focused probability histories, and depth views.
- Dedicated portfolio navigation, a simple prediction form, advanced limit options, and mobile navigation with a sticky prediction action.
- Quote review with exact credit caps, average-price bounds, minimum fill, expiry, win/loss/void payout explanation and repeat-safe confirmation.
- Portfolio, cost basis, indicative versus executable liquidation values, open orders, fills and CSV journal export.
- Group rankings, separate forecast calibration, participation counts, and personal Live performance. Live balances are not silently published globally.
- Discussion, in-app notifications/preferences, scoped moderation reports, private evidence, immutable decisions, and privacy-request recording.
- Durable SQLite/WAL accounting, hashed passwords/sessions/invites, exact microcredits, journal replay/reconciliation, committed market sequences and authorized realtime refresh/snapshot recovery.

## Verify

```sh
npm test
npm run build
npm run test:production
npm run benchmark
```

The production smoke starts the bundled executable against a temporary database, checks HTML and compressed assets, verifies the hosted data gate, and exercises pending registration, the built admin CLI/login, approval, isolated wallets and admin reconciliation. Tests and benchmarks do not use the configured application database. The benchmark creates 1,000 open markets and 100 active users, then removes its own temporary database.

[Latest measured performance](docs/verification/admin-economy.md): typical 20-concurrent-order bursts had p95 approximately **165–221 ms**; a 100-user burst had p95 approximately **1,234 ms**. Every request succeeded and all reconciliation flags passed. These local Fastify-inject measurements exclude network/TLS, browser rendering and upstream latency; they do not establish production capacity. The [earlier benchmark](docs/design/performance-results.md) remains historical evidence.

## Production and data permissions

```sh
npm run build
npm start
```

Production serves http://localhost:3000 by default, with precompressed Brotli/gzip assets and immutable asset caching. SQLite data defaults to `data/opentrader.sqlite`. Use one application instance with a persistent local volume and a consistent SQLite backup; do not copy only the database file while uncheckpointed WAL writes are active.

An optional container setup is included:

```sh
docker compose up --build
```

Docker packaging is supplied; an image build is not claimed tested unless recorded in the verification report. Compose binds to localhost and persists data in a named volume.

Copy `.env.example` to `.env` and edit with `vim .env`. For HTTPS hosting, set `PUBLIC_ORIGIN` to the exact origin and `COOKIE_SECURE=true`. Keep registration closed when appropriate. The development feed is a personal local preview; **hosted external-data mode defaults off**. Enabling it requires both `LIVE_DATA_ENABLED=true` and `DATA_USE_ACKNOWLEDGED=true`. These flags record an operator decision, not a license grant.

Public API availability does not establish redistribution permission. Review [Polymarket's terms](https://polymarket.com/tos), [Kalshi's Developer Agreement](https://assets.kalshi.com/Kalshi-Developer-Agreement.pdf), and [Kalshi's data terms](https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf) before hosting their feeds. Friends works independently of them.

Live source corrections require two operator-appointed, historically nontrading reviewers. Set existing account UUIDs in `PLATFORM_REVIEWER_IDS`; registration does not grant that duty. Corrections use a finite reserve and cannot create negative wallets. Account-deletion requests are recorded for operator review and integrity-preserving anonymization; submitting one does not claim instant deletion of shared records.

## Scope and operating limits

This implementation uses whole contracts and binary Friends markets. Arbitrary exhaustive N-way markets need a published rational void-payout/residual policy before activation. Full-set conversions, margin, stop orders, provider queue-position simulation and real-world execution are excluded.

SQLite transactions, the durable journal, and derived projections run on one host. The 100-user burst shows event-loop queuing under heavy simultaneous load. Multi-host deployment, production availability commitments, recovery drills, staffed escalation and provider rights require separate operational verification. Do not run stateless replicas against independent database copies.

See the [anonymous trading and admin cleanup verification](docs/verification/trading-privacy.md), [admin and economy audit verification](docs/verification/admin-economy.md), [redesign verification](docs/verification/redesign.md) and [original engine verification record](docs/verification/README.md) for tested flows and remaining operating limits.

The original proposals and generated concepts remain under [docs/design](docs/design/) as historical work. The November 15 browse-first redesign supersedes the terminal interface and earlier concepts. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licenses, chart attribution and UI refinement skill credit.
