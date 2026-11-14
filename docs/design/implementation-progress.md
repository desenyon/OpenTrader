# OpenTrader implementation progress

Scope: user authorized the complete local app, using the supplied dense terminal reference, real provider data where permitted, and isolated fictional-credit economies. Continue through implementation, verification, browser QA and fixes without approval pauses.

## Decisions

- Build a self-hostable React/Vite terminal and durable Fastify/Node service using SQLite WAL transactions. All dependencies are free/open source. No cloud account, paid database, external execution or API key is necessary for localhost operation. SQLite is a deliberate single-host choice; multi-host PostgreSQL deployment remains a documented migration boundary.
- Preserve all prior design files as historical proposals. New UI follows the attached reference: compact top nav/ticker/stat strip, dominant chart, slim right order ticket, lower activity/book/positions tables. No sidebar/cards from rejected mockups.
- Use whole-share lots, integer microcredit journals, decimal LMSR, funded reserves, protected orders, and authenticated invite-only group data. Both live simulator and Friends work in this release.
- Live external reads are a personal localhost preview; hosted use requires explicit data-use acknowledgement. Never invent prices, market history, volume or feed freshness.
- Fresh project has no Git repository or code to isolate. Initialize a feature branch in the supplied target directory; no existing checkout is moved.

## Tasks

- [ ] 1. Tooling, typed interfaces, application/server integration
- [ ] 2. Persistent authenticated exchange engine, groups, matching, governance and accounting tests
- [ ] 3. Real provider adapters, live depth simulation, staleness tests
- [ ] 4. Reference-matched responsive terminal and all supporting screens
- [ ] 5. Integration, performance and security review; browser walkthrough and iterative fixes
- [ ] 6. Production build, operational documentation, verified local handoff

## Pre-flight shared-interface scan

| Tasks | Shared contract | Resolution |
| --- | --- | --- |
| 1/2/3/4 | shared/types.ts | Single canonical transport contract; amounts are strings, UI floats are display only |
| 2/3 | server live gateway / simulator accounting | Provider module owns snapshots; engine owns economic transactions; API fetches current book before synchronous fill |
| 2/4 | /api REST schemas | Endpoint contract delivered to both implementers; integration root owns final reconciliation |
| 1/4 | Vite entry / frontend | UI implementer owns src; root owns build config and server entry |
| 2/3 | SQLite / exact amounts | No provider writes to ledger; no async work inside SQLite transaction |

## Verification record

Initial workspace contains planning documents only. Node 26.11.1 supports node:sqlite. Package versions verified with npm registry before selection. Browser research and current adapter verification are in progress.
