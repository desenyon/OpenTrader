# Browse-first UI verification

November 15, 2026. This revision replaces the terminal interface; earlier screenshots remain historical engine-release evidence.

## What changed

- A market grid is the initial destination. Search, available topics, source filters and following lead to individual questions.
- Explicit Live/Friends modes retain separate wallets. Portfolio is a named destination rather than a small terminal tab.
- Market details show the question, a probability-history line and a simple outcome/share form. Protected previews and explicit confirmation remain required.
- Repeated status strips, ticker, letter tiles, OHLC values, chart tool rail, indicators and empty account tables were removed from discovery.
- More advanced market tools remain in named sections; limit controls are behind Order options. Sell appears when holdings exist.
- Hash routes support direct links and browser history. Notifications use the target market’s actual exchange/group; invitation links open their joined group.
- Mobile has named navigation and a sticky prediction action. Theme preferences remain available under More options.

## Automated evidence

`npm test -- --reporter=dot`: **133 passing tests, 15 files**, 29.18 seconds. Nine new tests cover default discovery routes, provider/private-group URLs, malformed links, cross-scope routing, search, topics, saved markets, nonmutating sorting and probability display near zero/one.

`npm run build`: passed TypeScript and both production builds. Initial JS is **320.37 kB raw / 97.68 kB gzip**; chart code is a separate **167.45 kB raw / 54.86 kB gzip** chunk loaded on detail pages. CSS is **37.30 kB raw / 7.60 kB gzip**. No runtime dependency was added. This is a bundle-size measurement, not a new exchange throughput benchmark.

`npm run test:production`: passed executable startup, compressed assets/cache headers, hosted-data gate, registration/session and isolated-wallet checks.

`git diff --check`: passed.

## Browser evidence

The T3 shared browser exercised production assets against a separate ignored `artifacts/ui-redesign-qa.sqlite` database. QA accounts and credentials were not added to the application database or Git.

- Source discovery displayed actual Polymarket/Kalshi questions and source prices. The public Kalshi page was inspected for the browse-first interaction model; no proprietary branding or real-money flows were copied.
- Signed-in private market detail completed quote review and confirmation for 100 YES shares. Friends available balance became **9947.504155**, while Live stayed **10000.000000**.
- A second account bought 100 NO through HTTP. The already-open browser changed from **55% / 54.98¢** to **50% / 50.00¢** automatically, without manual refresh.
- The receipt’s View orders action opened the correct Friends portfolio and displayed the filled order. Positions and indicative/exit values remained separate.
- Light mode used primary text `rgb(28,32,38)` on `rgb(250,250,250)` surfaces, with no document overflow.
- Mobile checks measured document width equal to viewport at **340px and 390px**; named bottom navigation and the detail prediction action were present.
- Shared-browser mobile screenshots repeatedly timed out (`Preview automation snapshot timed out after 15000ms`). The installed Yab launcher referenced a missing app, so Aside was used for final visual capture instead. These tool failures are distinct from the successful functional browser interactions above.

[Desktop market grid](redesign/markets-desktop.png) · [Mobile market grid](redesign/markets-mobile.png). The capture uses genuine provider data; private QA markets are separate synthetic fixtures.

## Limits

This task changes the frontend and navigation, not the published economic rules or deployment architecture. Original binary/single-host and provider-redistribution permission limits remain documented in the project README. External price freshness still controls whether execution is allowed; no stale-price fill was enabled to make the screen look live.
