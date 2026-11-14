import { describe, expect, it } from "vitest";
import { Store } from "../server/store.js";
import type { Market, OrderBook, OrderInput } from "../shared/types.js";

function setup() {
  const now = new Date("2030-01-01T00:00:00Z");
  const store = new Store({ path: ":memory:", now: () => now });
  const alice = store.register("auditalice", "correct horse battery").user;
  const bob = store.register("auditbob", "correct horse battery").user;
  const market: Market = {
    id: "poly:123",
    exchange: "LIVE",
    provider: "polymarket",
    groupId: null,
    question: "Provider outcome audit?",
    description: "",
    category: "Test",
    outcomes: [
      { id: "yes", label: "Yes", probability: 0.5 },
      { id: "no", label: "No", probability: 0.5 },
    ],
    status: "OPEN",
    volume: 0,
    liquidity: 0,
    closeAt: "2030-02-01T00:00:00Z",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sequence: 0,
  };
  const book: OrderBook = {
    marketId: market.id,
    outcomeId: "yes",
    timestamp: now.toISOString(),
    stale: false,
    source: "provider",
    bids: [
      { price: 0.48, quantity: 4, source: "EXTERNAL" },
      { price: 0.49, quantity: 6, source: "EXTERNAL" },
    ],
    asks: [
      { price: 0.52, quantity: 4, source: "EXTERNAL" },
      { price: 0.51, quantity: 6, source: "EXTERNAL" },
    ],
  };
  const input: OrderInput = {
    marketId: market.id,
    outcomeId: "yes",
    side: "BUY",
    quantity: 10,
    limitPrice: "0.5200",
    timeInForce: "IOC",
  };
  return { store, alice, bob, market, book, input };
}

describe("adversarial external accounting protections", () => {
  it("rolls back every cash and share entry when a multi-level purchase exceeds its cap by one microcredit", () => {
    const { store, alice, market, book, input } = setup();
    const before = store.wallets(alice.id);
    expect(() =>
      store.executeLive(
        alice.id,
        market,
        book,
        { ...input, maxTotalCost: "5.139999" },
        "audit-cap-fail",
      ),
    ).toThrow("maximum");
    expect(store.wallets(alice.id)).toEqual(before);
    expect(store.positions(alice.id)).toEqual([]);
    expect(
      store
        .audit(alice.id)
        .filter((row) =>
          (row as { reason?: string }).reason?.startsWith("EXTERNAL"),
        ),
    ).toEqual([]);
    const result = store.executeLive(
      alice.id,
      market,
      book,
      { ...input, maxTotalCost: "5.140000" },
      "audit-cap-pass",
    );
    expect(result.spent).toBe("5.140000");
    expect(result.fills.reduce((sum, fill) => sum + fill.quantity, 0)).toBe(10);
    expect(store.reconcile(alice.id).balanced).toBe(true);
    store.close();
  });

  it("preserves holdings and moving cost basis when a sale misses minimum proceeds by one microcredit", () => {
    const { store, alice, market, book, input } = setup();
    store.executeLive(alice.id, market, book, input, "audit-seed-buy");
    const wallets = store.wallets(alice.id);
    const positions = store.positions(alice.id);
    expect(() =>
      store.executeLive(
        alice.id,
        market,
        book,
        {
          ...input,
          side: "SELL",
          limitPrice: "0.4800",
          minTotalProceeds: "4.860001",
        },
        "audit-sell-fail",
      ),
    ).toThrow("minimum");
    expect(store.wallets(alice.id)).toEqual(wallets);
    expect(store.positions(alice.id)).toEqual(positions);
    const sale = store.executeLive(
      alice.id,
      market,
      book,
      {
        ...input,
        side: "SELL",
        limitPrice: "0.4800",
        minTotalProceeds: "4.860000",
      },
      "audit-sell-pass",
    );
    expect(sale.received).toBe("4.860000");
    expect(store.positions(alice.id)[0]).toMatchObject({
      quantity: 0,
      costBasis: "0.000000",
      realizedPnl: "-0.280000",
    });
    expect(store.reconcile(alice.id).balanced).toBe(true);
    store.close();
  });

  it("binds quote ownership and rechecks current depth against the submitted price limit", () => {
    const { store, alice, bob, market, book, input } = setup();
    const quote = store.quoteLive(alice.id, market, book, input);
    const before = store.wallets(bob.id);
    expect(() =>
      store.executeLive(
        bob.id,
        market,
        book,
        { ...input, quoteId: quote.id },
        "audit-foreign-quote",
      ),
    ).toThrow("Quote");
    expect(store.wallets(bob.id)).toEqual(before);
    const moved = {
      ...book,
      asks: [{ price: 0.53, quantity: 100, source: "EXTERNAL" as const }],
    };
    expect(() =>
      store.executeLive(
        alice.id,
        market,
        moved,
        { ...input, quoteId: quote.id, minFillQuantity: 10 },
        "audit-moved-book",
      ),
    ).toThrow("minimum");
    expect(store.positions(alice.id)).toEqual([]);
    expect(store.reconcile(alice.id).balanced).toBe(true);
    store.close();
  });
});
