import { createHash } from "node:crypto";
import type { Market, OrderBook } from "../shared/types.js";
import { units, reserve, type Prior } from "./math.js";
export const LIVE_LIQUIDITY_ACCOUNT = "treasury:live-liquidity:live-1";
export const LIVE_INITIAL_SUBSIDY = 100_000_000_000n;
export const LIVE_LIQUIDITY_B = 500;
export const LIVE_ACTIVATION_LIMIT = 5;
export interface LiveCurve {
  version: 2;
  prior: Prior;
  openedBy: string;
  openedAt: string;
  anchorAt: string;
  anchorHash: string;
  rulesHash: string;
  operatorHalted?: boolean;
  mappingHalted?: boolean;
}
export function sourceRulesHash(m: Market) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: m.provider,
        question: m.question.trim(),
        description: m.description.trim(),
        outcomes: [...m.outcomes]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((o) => ({
            id: o.id,
            label: o.label,
            assetId: o.assetId ?? null,
          })),
      }),
    )
    .digest("hex");
}
export function seedLiveCurve(
  m: Market,
  book: OrderBook,
  userId: string,
  now: string,
): LiveCurve {
  if (
    m.outcomes.length !== 2 ||
    new Set(m.outcomes.map((o) => o.id)).size !== 2
  )
    throw new Error(
      "Credit-driven Live trading requires exactly two exhaustive outcomes",
    );
  if (
    !Number.isFinite(Date.parse(m.closeAt)) ||
    Date.parse(m.closeAt) <= Date.parse(now)
  )
    throw new Error("Source trading deadline has passed");
  const bids = book.bids
      .filter((l) => l.quantity >= 1)
      .map((l) => units(l.price)),
    asks = book.asks.filter((l) => l.quantity >= 1).map((l) => units(l.price));
  if (!bids.length || !asks.length)
    throw new Error(
      "A two-sided source book with whole-contract depth is required to open a market",
    );
  const bid = bids.reduce((a, b) => (a > b ? a : b)),
    ask = asks.reduce((a, b) => (a < b ? a : b));
  if (bid >= ask || ask - bid > 200_000n)
    throw new Error(
      "Source spread is crossed or wider than 20 percentage points",
    );
  let first = (bid + ask) / 2n;
  if (book.outcomeId !== m.outcomes[0]!.id) first = 1_000_000n - first;
  first = first < 10_000n ? 10_000n : first > 990_000n ? 990_000n : first;
  return {
    version: 2,
    prior: [Number(first), Number(1_000_000n - first)],
    openedBy: userId,
    openedAt: now,
    anchorAt: book.timestamp,
    anchorHash:
      book.hash ??
      createHash("sha256")
        .update(
          JSON.stringify({
            marketId: m.id,
            outcomeId: book.outcomeId,
            timestamp: book.timestamp,
            bids: book.bids,
            asks: book.asks,
          }),
        )
        .digest("hex"),
    rulesHash: sourceRulesHash(m),
  };
}
export const curveReserve = (curve: LiveCurve) =>
  reserve(LIVE_LIQUIDITY_B, curve.prior);
