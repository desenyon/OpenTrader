# Credit-driven Live economy and Friends hardening

User goal: licensed/authorized external odds initialize a real OpenTrader play-credit market whose price responds to local trading; strengthen accounting and Friends execution. No real-provider execution or money capability.

Architecture decision: fixed-b weighted LMSR for new eligible binary Live markets, initialized from a validated two-sided source book. External odds remain a live reference, not an automatic repricing operation. Fixed prior, immutable engine/rules version, q and b survive source refreshes and restart. Local AMM and owned-share peer orders share one scoped transactional router. Quotes perform no credit allocation/reserve movement. First accepted order reserves bounded worst-case sponsor loss from a finite, separately audited Live liquidity treasury. Existing traded EXTERNAL_SIM markets preserve their original model and positions.

Math: normalized weighted cost C(q)=b ln(sum p0_i exp(q_i/b)); buy/sell use integrated differences with safe microcredit rounding. Reserve >= b ln(1/min p0) + provisioned rounding allowance. Integer initial probabilities are clamped to [0.01,0.99], with disclosed source snapshot and frozen prior. Source state/mapping/freshness gates continue; provider final outcomes settle escrow-backed local shares. Corrections retain two-reviewer finite funding.

Global constraints: separate Live and per-group wallets; no negative available cash, double locks, naked shorts, silent outcome/rule changes, unbacked issuance or ledger rewrites. No paid dependency. Preserve all existing account/admin/anonymity controls. Old committed histories stay intact. Per-file commits for only changed/new files.

- [x] Regress weighted costs/probabilities/loss bound and reference against high-precision independent math; implement optional exact priors without changing uniform Friends results.
- [x] Implement finite Live sponsor budget, pending quote previews, atomic market activation, shared routing and idempotency, stale/version/mapping handling and legacy preservation.
- [x] Project source and OpenTrader prices separately through listing/detail/book/history; portfolio liquidation uses the actual local curve/book; settle backed shares and return residual subsidy.
- [x] Extend reconciliation/reserve audits and admin visibility; prevent repeated activation from exhausting budget (five active market activations per account by default).
- [x] Reproduce and fix important Friends audit findings; strengthen equal-time priority, boundary and replay tests as findings warrant.
- [x] Full tests, production build/smoke, concurrent multi-Store/restart/replay/adversarial tests and benchmark; fresh whole-change review; document actual limits, back up/restart preview, and prepare individual-file commits for push.

Review focus: source refresh losing local inventory; nonuniform rounding or subsidy underfunding; source finalization while locks exist; stale/deadline/mapping gates; same-key retries and legacy markets; direct-store paths bypassing activation policy; peer fills preserving AMM issuance.

Sources checked: Polymarket official Prices and Order Books; Kalshi Orderbook Responses; Robin Hanson, Logarithmic Market Scoring Rules for Modular Combinatorial Information Aggregation. Mathematical reserve/cost expressions are implementation derivations tested independently, not provider execution claims.

Implemented and verified: 187 tests, production build/smoke, three-process contention, restart/legacy preservation, and disk-backed Friends/Live benchmarks. Review findings fixed with regressions. Published rules and verification record document measured single-host limits and provider gates.
