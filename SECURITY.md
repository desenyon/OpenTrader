# Security

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting](https://github.com/desenyon/OpenTrader/security/advisories/new) for authentication bypasses, cross-group data access, identity leaks, duplicated fills, broken locks, ledger inconsistencies, or unsafe evidence handling.

Include the commit/version, affected exchange or role, minimal reproduction using synthetic accounts, expected and actual behavior, and relevant redacted logs. Never send passwords, session/invite tokens, credential receipts, application databases, or identifiable private-group records.

If a report suggests an accounting mismatch, preserve the journal and halt new trading while investigating. Do not erase transactions to make a projection balance.

## Deployment boundaries

The current application uses one durable SQLite host, server-side sessions, group-scoped access, exact accounting and source-data gates. Keep persistent storage and consistent backups, use HTTPS with secure cookies when hosted, and review provider rights before enabling redistributed data.

Only the current `main` branch receives fixes. There is no published support SLA or production-availability guarantee. See the [verification records](docs/verification/trading-privacy.md) for actual test coverage and operating limits.
