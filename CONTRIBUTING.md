# Contributing to OpenTrader

OpenTrader combines public-data practice trading with private group markets. A change must preserve the boundaries between Live, each Friends group, and their respective wallets.

## Set up

Use Node.js 24+ and npm. CI uses Node 26.

```sh
git clone https://github.com/desenyon/OpenTrader.git
cd OpenTrader
npm ci
npm run admin:create -- --handle admin
npm run dev
```

Open `http://localhost:3000`. Generated admin credentials stay in the ignored `data/` directory. Additional accounts require admin approval. To configure the server, copy `.env.example` to `.env` and use `vim .env`.

## Make a change

Create a focused branch from `main`, follow the existing TypeScript/React conventions, and keep unrelated formatting out of the diff. UI work should use the existing graphite surfaces, restrained semantic colors, and accessible controls. Include a screenshot for a visible change when possible.

For an execution, authorization, privacy, or accounting change, add a meaningful regression that fails for the defect or missing behavior. Run:

```sh
npm test
npm run build
npm run test:production
```

Run `npm run benchmark` when changing matching, serialization, or request-path performance. The benchmark creates its own temporary database. Distinguish automated, browser, and load-test evidence in the pull request.

## Economic invariants

- Keep authoritative amounts exact. Prices shown in the browser are previews; server validation decides execution.
- Cash and share movements must balance and replay from the journal. Do not patch cached balances directly.
- Preserve owned-share checks, order locks, protected limits, scope authorization, and idempotency.
- Never silently alter open-market rules, liquidity parameters, settlement history, or correction events.
- Anonymous trading masks display identity; it must preserve ownership, conflict checks, and admin attribution.
- Provider permission and freshness gates remain enforced. A successful HTTP read is not a redistribution license.

Never commit application databases, credential receipts, `.env`, session cookies, private-group evidence, or real participant records. Use synthetic fixtures and redact logs when reporting a problem.

## Propose or report

Use the repository's issue forms for reproducible bugs and feature proposals. For a security issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Keep dependency additions purposeful and preserve upstream attribution in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
