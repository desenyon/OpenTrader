> Historical November 13 release record. The [November 15 redesign](redesign.md) supersedes the terminal UI and its screenshots.

# Final local verification

Verified November 13, 2026, on Apple Silicon macOS with Node 26.11.1. This record covers the implemented self-hosted release, not every future capability in the original specification.

## Automated checks

- `npm test -- --reporter=dot`: **124 tests passed in 14 files**, 24.88 seconds on the final source tree.
- `npm run build`: TypeScript, production client and Node executable passed. Client JS 498.48 kB raw / 155.08 kB gzip; CSS 60.91 kB raw / 11.67 kB gzip. Brotli and gzip artifacts were produced.
- `npm run test:production`: actual bundled executable passed health, HTML, Brotli assets, immutable caching, hosted data gate, registration, cookie/session and isolated-wallet checks.
- `npm run benchmark`: 100 users / 1,000 open markets; every order/request succeeded and all seven reconciliation flags passed. [Results and limits](../design/performance-results.md), [raw evidence](benchmark.json).
- `git diff --check`: clean.

Coverage includes exact LMSR integration, 4,000 seeded math actions with 4,000 inverse checks, bounded maker loss, balance and supply conservation, cash/share locks, mixed peer/AMM routing, self-match prevention, partial-fill average-price limits, 100 repeat HTTP submissions with one committed receipt, restart persistence, cancel/expiry/close races, sequence replay, privacy boundaries, and governance conflicts.

Regression checks cover rate-limit cookie rotation, exact mutation origins, oversized/exponent numeric input, removed-group history leakage, stale/malformed provider snapshots, identifier versions, explicit source finalization and two-reviewer corrections, observation deadlines, abandoned-resolution longstops, request refresh starvation, and active-SSE graceful shutdown. Accounting reconciliation runs at startup and periodically; a failure latches new trading off while existing committed receipts remain recoverable.

## Actual browser walkthrough

Aside Browser exercised the production build against an isolated QA database. No application user database was populated with test accounts.

- Registration established independent 10,000-credit Live and Friends wallets and a private group.
- Real Polymarket/Kalshi discovery, order books and history loaded through their unsigned public APIs. No synthetic source prices, candles or volume were inserted. Explicit YES/NO prefixes distinguish identical Kalshi subtitles.
- A fresh Polymarket quote bought 10 Hawks shares for 6.90 CR in the simulator; Friends credits stayed at 10,000. A later source-final outcome settled this position and preserved the realized loss in the journal. Stale books visibly disabled execution.
- Invite generation/join, independent moderator appointment and draft approval established a private Friends market. The creator and resolver were different users.
- Buying 100 YES at `b=500` debited **52.495845 CR**, yielding 54.9834% indicative probability. A resting 10-share bid at 0.40 locked 4 CR; cancellation released it and history showed CANCELLED.
- AMM versus executed-price chart controls displayed distinct actual recorded series. Chart timestamps explicitly say UTC.
- A 66% independent forecast saved without spending credits. A discussion comment appeared in the group feed.
- A restricted market report reached the moderator queue. Halt disabled the order ticket; a recorded resume rationale reopened trading, preserving holdings.
- Member removal and re-admission preserved economic records without a second allocation. Invite revocation succeeded.
- Journal download produced an actual 3,914-byte CSV.
- Desktop and narrow-phone layouts, sticky mobile trade action, order-ticket navigation and theme switching were inspected. A discovered header overflow was fixed and rechecked at 390 and 340 pixels. Light-theme inherited text color was corrected, with readable primary text and stronger secondary contrast. External font imports were removed; local/system fallbacks avoid a network dependency.

Dispute deadlines, neutral void, source corrections and settlement edge cases use automated clock-controlled tests; this browser run did not wait real 24/48/72-hour windows. Provider calls succeeded during this session; ongoing availability is not guaranteed.

## Screenshots

These are screenshots of the functioning application with synthetic private QA participants and genuine external source data, not generated mockups.

- [Friends desktop](screenshots/friends-desktop.png)
- [Friends mobile](screenshots/friends-mobile.png)
- [Mobile order ticket](screenshots/mobile-ticket.png)
- [Live desktop](screenshots/live-desktop.png)
- [Light theme](screenshots/light-theme.png)

## Release boundary

Binary whole-contract Friends markets and one-host SQLite/WAL are implemented. Arbitrary N-way markets, hosted evidence uploads, outbound notification delivery, multi-host PostgreSQL, staffed dispute escalation, production SLA and backup restoration drills are not verified release features. Privacy requests are recorded for operator fulfillment. Docker and remote CI configurations are supplied; neither Docker image execution nor a remote CI run is claimed.

Live market reads require no API key or paid service in this localhost preview. Public API access does not grant third-party redistribution rights; hosted external feeds remain permission-gated. Friends operates independently. All credits remain fictional and nonredeemable.
