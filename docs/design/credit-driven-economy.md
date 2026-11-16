# Credit-driven Live markets

Implemented November 16, 2026. This replaces source-following paper execution for **new eligible binary Live markets**. Existing markets with external-simulator fills retain their original model. Friends remains a separate private economy.

## What traders see

A Live market has two prices: **OpenTrader odds**, moved by our credit trades, and the current **provider reference**. The reference continues to refresh; it never resets our outstanding shares, frozen opening prior, liquidity parameter, cash basis, or trade history. No order is submitted to Polymarket or Kalshi.

Before activation, discovery shows a provider opening estimate. A quote uses the latest validated bid/ask midpoint, bounded to 1–99%, and displays opening and estimated post-trade odds. The first accepted order freezes that prior and funds the maker. A quote alone cannot allocate subsidy or move money. If the opening midpoint changes before submission, the client must requote.

Local AMM probability, executed trade prices, and provider history are separate chart series. Preactivation source snapshots are excluded from local charts. Books show owned-share peer orders and the next executable whole-share AMM lot; they do not advertise unlimited quantity at a scalar AMM price. Portfolio liquidation walks local peer/AMM liquidity, accounts for locked shares, and is unavailable as an executable estimate when source confirmation is stale.

## Mathematics and backing

For initial weights `p0` summing to one and fixed `b=500`:

```
C(q) = b * ln(sum_i p0_i * exp(q_i / b))
p_i(q) = p0_i * exp(q_i/b) / sum_j p0_j * exp(q_j/b)
buy(x) = C(q + x*e_i) - C(q)
sell(x) = C(q) - C(q - x*e_i)
reserve = ceil_microcredit(b * ln(1 / min(p0))) + 1 CR
```

Weights are stored as positive integer microprobabilities summing to 1,000,000. The internal cost evaluator omits a constant normalization term, which cancels from every cost difference. `decimal.js` uses 80-digit arithmetic with an independent precision check; buy debits round up and sell credits down. Cash uses integer microcredits; shares use whole contracts. Fees are zero. Liquidity and prior remain fixed after activation.

The reserve follows the nonuniform LMSR loss bound relative to its opening scoring baseline. The additional 1 CR is conservative rounding provision; directional rounding cannot create a favorable immediate AMM buy/undo loop. The tests independently compare integrated costs and settlement solvency against high-precision reference math.

A separately journaled **100,000 CR Live liquidity treasury** is allocated once for this engine version. It is not a user wallet, Friends treasury, or correction fund. Activation moves the full risk reserve into that market's escrow. Reject activation if free sponsor credits are insufficient. An account may activate five unsettled Live markets, while still trading existing funded markets. Admins may explicitly allocate or reclaim **free** sponsor credits; committed market escrow cannot be reclaimed.

At provider-final settlement, winning shares receive exactly 1 CR and losing shares zero. A verified binary void pays 0.50 CR per owned share. Cancel resting orders first, burn settled shares, and return only residual escrow to the Live sponsor treasury. Provider corrections retain the existing explicit, independently reviewed, finitely funded process.

## Matching and transaction rules

Both local economies use one owned-share router: compare the next peer price with integrated whole-lot AMM prices, favor resting peers on equality, and preserve price-time priority. A monotone bounded search finds each AMM slice up to the next peer, price limit, or cash boundary; charge its integrated cost once. P2P transfers preserve AMM `q` and issued supply. Only backed AMM operations mint or burn shares.

Every SQLite command takes `BEGIN IMMEDIATE`, freezes its acceptance timestamp, checks membership/account/model/source state and protections, and commits cash, shares, locks, fills, idempotency receipt, sequence, and journal together. An accepted command uses that one timestamp for GTD eligibility, deadlines, and entries even if wall time advances during matching. A subsequent command processes newly due expiries. The initial activation advances public sequence zero to one, including an order submitted without a prior preview.

Arrival priority uses a durable per-market order counter, including a migration of historical orders in their persisted arrival order. Random UUID ordering cannot win a same-time tie. The resting-book limit is 100 orders per market and 20 per account per market; it applies only when an order leaves a resting remainder. It cannot prevent an immediately filled IOC order. Input orders remain limited to 1–1,000 whole shares and a bounded 0.0001–0.9999 price tick. Matching retains an atomic work cap.

Reconciliation verifies the immutable journal against projections, asset supply against AMM issuance, escrow solvency, exact held resources, and Live curve configuration/reserve funding. A mismatch disables new trading. Committed idempotent receipts remain recoverable.

## Provider and recovery gates

Activation requires exactly two mapped outcomes, an OPEN source, a future deadline, valid whole-contract depth on both sides, bid below ask, spread at most 20 percentage points, and a snapshot no older than five seconds. Opening prior clamping is explicit in confirmation. Trading requests bypass the discovery metadata cache and fetch current provider trading status before obtaining a fresh book. Execution continues to require fresh source confirmation and a supported frozen engine version; local liquidity does not override provider halts or the license gate.

Source refresh preserves immutable outcome order. Changed rule text or outcome mappings halt trading and cancel resting locks. A verified final result matching the original frozen rules/mapping may still settle after a halt; changed meanings are never silently applied to existing holdings. Unresolved provider changes remain halted for investigation. A provider deadline closes local trading and releases locks; the Friends 72-hour neutral-void longstop never settles an external market prematurely. Temporary operator halts cannot block a verified provider-final payout.

`LIVE_COMMUNITY_ENABLED=false` disables activation of additional markets. Already funded curves preserve their original model when the setting changes. The `Store` constructor's explicit opt-in supports legacy tooling/tests; the application enables the new model by default. The provider permission flags remain independent and default off for hosted use.

## Verification and limits

See [current verification](../verification/credit-economy.md). Tests include nonuniform reference math and randomized supply/solvency paths, mixed routing, protections to one microcredit, quote ownership/version/freshness, unchanged source priors, rule/outcome edits, both winning outcomes/void, all-or-nothing rollback, finite-budget exhaustion, multi-process overspend attempts, cross-connection/restart replay, legacy upgrades, and the actual HTTP list/detail/book/chart/order/portfolio paths.

This remains a single-host, binary, whole-share SQLite release. Polling/committed refresh notifications are not a provider exchange connection or guaranteed real-time SLA. The implementation does not prove production capacity, authorize hosted data redistribution, or implement the original specification's future multi-outcome markets, full-set conversion, or distributed matching cluster.

## Primary references

- [Polymarket: Prices and Order Books](https://docs.polymarket.com/market-data/prices-order-books)
- [Kalshi: Orderbook Responses](https://docs.kalshi.com/getting_started/orderbook_responses)
- [Hanson: Logarithmic Market Scoring Rules for Modular Combinatorial Information Aggregation](https://mason.gmu.edu/~rhanson/mktscore.pdf)

The nonuniform reserve/accounting expressions above are our implementation derivation and are checked by independent reference tests; they are not a provider execution claim.
