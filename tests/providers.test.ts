import { describe, it, expect } from "vitest";
import {
  MarketDataService,
  normalizePolymarketMarket,
  normalizePolymarketBook,
  normalizeKalshiBook,
  normalizeKalshiMarket,
  historyToCandles,
} from "../server/providers.js";
const now = new Date("2026-11-13T12:00:00Z");
const poly = {
  id: "42",
  question: "Will it happen?",
  slug: "will-it",
  outcomes: '["No","Yes"]',
  outcomePrices: '["0.4","0.6"]',
  clobTokenIds: '["100","200"]',
  positionIds: ["900", "901"],
  version: "v1",
  endDate: "2027-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: now.toISOString(),
  active: true,
  closed: false,
  events: [{ slug: "event-name", tags: [{ label: "Politics" }] }],
};
describe("provider normalization", () => {
  it("maps token IDs to the actual outcome identity and explicitly selects protocol version", () => {
    const market = normalizePolymarketMarket(poly);
    expect(market.id).toBe("poly:42");
    expect(market.outcomes).toEqual([
      { id: "no", label: "No", probability: 0.4, assetId: "100" },
      { id: "yes", label: "Yes", probability: 0.6, assetId: "200" },
    ]);
    expect(
      normalizePolymarketMarket({ ...poly, version: "v2" }).outcomes[0].assetId,
    ).toBe("900");
    expect(market.category).toBe("Politics");
    expect(market.sourceUrl).toBe("https://polymarket.com/event/event-name");
    expect(() =>
      normalizePolymarketMarket({ ...poly, version: "v99" }),
    ).toThrow(/version/i);
    expect(() =>
      normalizePolymarketMarket({ ...poly, clobTokenIds: '["100"]' }),
    ).toThrow(/mapping/i);
    expect(() =>
      normalizePolymarketMarket({ ...poly, clobTokenIds: '["100","100"]' }),
    ).toThrow(/mapping/i);
  });
  it("rejects malformed outcome prices, IDs, events and source slugs", () => {
    expect(() =>
      normalizePolymarketMarket({ ...poly, id: "../../no" }),
    ).toThrow();
    expect(() =>
      normalizePolymarketMarket({ ...poly, outcomePrices: '["bad","0.4"]' }),
    ).toThrow();
    expect(() =>
      normalizePolymarketMarket({
        ...poly,
        slug: "https://evil.example/",
        events: [],
      }),
    ).toThrow();
    expect(() =>
      normalizePolymarketMarket({ id: "event", markets: [poly] }),
    ).toThrow();
  });
  it("sorts depth, preserves quantity, rejects invalid levels, and checks provider freshness", () => {
    const raw = {
      timestamp: String(now.getTime()),
      bids: [
        { price: "0.4", size: "2.5" },
        { price: "0.5", size: "10" },
      ],
      asks: [
        { price: "0.7", size: "4" },
        { price: "0.6", size: "3" },
      ],
    };
    const book = normalizePolymarketBook(raw, "poly:42", "yes", now);
    expect(book.bids.map((x) => x.price)).toEqual([0.5, 0.4]);
    expect(book.asks.map((x) => x.price)).toEqual([0.6, 0.7]);
    expect(book.bids[1].quantity).toBe(2.5);
    expect(book.stale).toBe(false);
    expect(
      normalizePolymarketBook(
        { ...raw, timestamp: String(now.getTime() - 5001) },
        "poly:42",
        "yes",
        now,
      ).stale,
    ).toBe(true);
    expect(
      normalizePolymarketBook(
        { ...raw, timestamp: undefined },
        "poly:42",
        "yes",
        now,
      ).stale,
    ).toBe(true);
    expect(() =>
      normalizePolymarketBook(
        { ...raw, asks: [{ price: "NaN", size: "3" }] },
        "poly:42",
        "yes",
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizePolymarketBook(
        { ...raw, bids: [{ price: "0.9", size: "3" }] },
        "poly:42",
        "yes",
        now,
      ),
    ).toThrow(/cross/i);
  });
  it("derives YES asks from NO fixed point bids with exact complement prices", () => {
    const raw = {
      orderbook_fp: {
        yes_dollars: [
          ["0.1201", "12.50"],
          ["0.2000", "2.00"],
        ],
        no_dollars: [
          ["0.7000", "9.25"],
          ["0.6000", "100.00"],
        ],
      },
    };
    const yes = normalizeKalshiBook(raw, "kalshi:ABC", "yes", now);
    expect(yes.bids.map((x) => [x.price, x.quantity])).toEqual([
      [0.2, 2],
      [0.1201, 12.5],
    ]);
    expect(yes.asks.map((x) => [x.price, x.quantity])).toEqual([
      [0.3, 9.25],
      [0.4, 100],
    ]);
    expect(yes.stale).toBe(true);
    expect(yes.timestamp).toBe("");
    const no = normalizeKalshiBook(
      { ...raw, timestamp: now.toISOString() },
      "kalshi:ABC",
      "no",
      now,
    );
    expect(no.asks[0]).toEqual({ price: 0.8, quantity: 2, source: "EXTERNAL" });
    expect(no.stale).toBe(false);
    expect(() =>
      normalizeKalshiBook(raw, "kalshi:ABC", "maybe", now),
    ).toThrow();
  });
  it("normalizes real Kalshi fixed point metadata without inventing liquidity", () => {
    const market = normalizeKalshiMarket({
      ticker: "KXTEST-26-YES",
      event_ticker: "KXTEST-26",
      title: "Test?",
      yes_bid_dollars: "0.2500",
      yes_ask_dollars: "0.3500",
      last_price_dollars: "0.3000",
      volume_fp: "123.50",
      status: "active",
      close_time: "2027-01-01T00:00:00Z",
      created_time: now.toISOString(),
      updated_time: now.toISOString(),
    });
    expect(market.outcomes.map((x) => x.probability)).toEqual([0.3, 0.7]);
    expect(market.volume).toBe(123.5);
    expect(market.liquidity).toBe(0);
    expect(market.sourceUrl).toMatch(/^https:\/\/external-api.kalshi.com\//);
  });
  it("keeps Kalshi yes/no outcomes distinct when source subtitles are identical", () => {
    const market = normalizeKalshiMarket({
      ticker: "KXMARS-99",
      event_ticker: "KXMARS",
      title: "Will a human visit Mars?",
      yes_sub_title: "Mars",
      no_sub_title: "Mars",
      last_price_dollars: "0.1200",
      status: "active",
      close_time: "2099-08-01T00:00:00Z",
    });
    expect(market.outcomes.map((x) => x.label)).toEqual(["Yes · Mars", "No · Mars"]);
    expect(market.outcomes.map((x) => x.id)).toEqual(["yes", "no"]);
  });
  it("aggregates actual observations into OHLC without synthetic volume or filler", () => {
    expect(
      historyToCandles(
        [
          { t: 120, p: 0.2 },
          { t: 125, p: 0.4 },
          { t: 180, p: 0.3 },
        ],
        60,
      ),
    ).toEqual([
      { time: 120, open: 0.2, high: 0.4, low: 0.2, close: 0.4 },
      { time: 180, open: 0.3, high: 0.3, low: 0.3, close: 0.3 },
    ]);
    expect(() => historyToCandles([{ t: 120, p: 99 }], 60)).toThrow();
  });
});
describe("public data service", () => {
  it("fails closed before any network request when disabled", async () => {
    const service = new MarketDataService({
      enabled: false,
      fetcher: async () => {
        throw Error("unexpected network");
      },
    });
    await expect(service.listMarkets()).rejects.toThrow(/disabled/i);
    expect(service.isEnabled).toBe(false);
  });
  it("requires both production acknowledgements and prevents explicit enable bypass", async () => {
    const old = { ...process.env };
    process.env.NODE_ENV = "production";
    delete process.env.LIVE_DATA_ENABLED;
    delete process.env.DATA_USE_ACKNOWLEDGED;
    try {
      expect(new MarketDataService({ enabled: true }).isEnabled).toBe(false);
      process.env.LIVE_DATA_ENABLED = "true";
      process.env.DATA_USE_ACKNOWLEDGED = "true";
      expect(new MarketDataService().isEnabled).toBe(true);
    } finally {
      process.env = old;
    }
  });
  it("shares in-flight discovery, applies search and fetches current books on demand", async () => {
    let calls = 0;
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) => {
        calls++;
        const url = String(input);
        return new Response(
          JSON.stringify(
            url.includes("/book?")
              ? {
                  asset_id: "200",
                  timestamp: String(now.getTime()),
                  bids: [],
                  asks: [{ price: "0.65", size: "5" }],
                }
              : [poly],
          ),
        );
      },
    });
    const [a, b] = await Promise.all([
      service.listMarkets("polymarket"),
      service.listMarkets("polymarket"),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect(await service.listMarkets("polymarket", "does not exist")).toEqual(
      [],
    );
    const book = await service.getBook("poly:42", "yes");
    expect(book.asks[0].quantity).toBe(5);
    await service.getBook("poly:42", "yes");
    expect(calls).toBe(2);
    await service.getBook("poly:42", "yes", { fresh: true });
    expect(calls).toBe(3);
    await expect(service.getBook("poly:42", "unknown")).rejects.toThrow(
      /outcome/i,
    );
  });
  it("reconstructs stable market IDs without requiring discovery first", async () => {
    const service = new MarketDataService({
      enabled: true,
      fetcher: async (input) => {
        expect(String(input)).toContain("/markets/42");
        return new Response(JSON.stringify(poly));
      },
    });
    expect((await service.getMarket("poly:42")).question).toBe(
      "Will it happen?",
    );
    await expect(service.getMarket("poly:../../bad")).rejects.toThrow();
  });
  it("never substitutes fabricated or previously cached data after a failed provider request", async () => {
    const service = new MarketDataService({
      enabled: true,
      fetcher: async () => new Response("{}", { status: 403 }),
    });
    await expect(service.listMarkets("polymarket")).rejects.toThrow(/403/);
    expect(service.status().providers.polymarket.state).toBe("unavailable");
  });
  it("returns actual provider history and empty Kalshi history when public access unavailable", async () => {
    const service = new MarketDataService({
      enabled: true,
      fetcher: async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("prices-history")
              ? {
                  history: [
                    { t: 120, p: 0.2 },
                    { t: 180, p: 0.3 },
                  ],
                }
              : poly,
          ),
        ),
    });
    expect(
      (await service.getHistory("poly:42", "yes", "1h")).length,
    ).toBeGreaterThan(0);
  });
});

describe("provider protocol and freshness boundaries", () => {
  it("uses explicitly selected v2 position IDs on the same public CLOB endpoint", async () => {
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("/book?")) {
          expect(url).toContain("token_id=901");
          return new Response(
            JSON.stringify({
              asset_id: "901",
              timestamp: now.getTime(),
              bids: [],
              asks: [],
            }),
          );
        }
        return new Response(JSON.stringify({ ...poly, version: "v2" }));
      },
    });
    expect((await service.getBook("poly:42", "yes")).stale).toBe(false);
  });
  it("accepts a fresh upstream HTTP Date and rejects missing, old, or future dates", () => {
    const raw = { orderbook_fp: { yes_dollars: [], no_dollars: [] } };
    expect(
      normalizeKalshiBook(raw, "kalshi:ABC", "yes", now, now.toUTCString())
        .stale,
    ).toBe(false);
    expect(
      normalizeKalshiBook(
        raw,
        "kalshi:ABC",
        "yes",
        now,
        new Date(now.getTime() - 6000).toUTCString(),
      ).stale,
    ).toBe(true);
    expect(
      normalizeKalshiBook(
        raw,
        "kalshi:ABC",
        "yes",
        now,
        new Date(now.getTime() + 6000).toUTCString(),
      ).stale,
    ).toBe(true);
    expect(normalizeKalshiBook(raw, "kalshi:ABC", "yes", now).stale).toBe(true);
  });
  it("refreshes market status metadata after the discovery TTL", async () => {
    let clock = now.getTime();
    let closed = false;
    const service = new MarketDataService({
      enabled: true,
      now: () => new Date(clock),
      fetcher: async () => new Response(JSON.stringify({ ...poly, closed })),
    });
    expect((await service.getMarket("poly:42")).status).toBe("OPEN");
    clock += 15001;
    closed = true;
    expect((await service.getMarket("poly:42")).status).toBe("CLOSED");
  });
  it("reads fixed point Kalshi historical OHLC and complements NO candle extremes", async () => {
    const market = {
      ticker: "KXTEST-26-YES",
      event_ticker: "KXTEST-26",
      title: "Test?",
      last_price_dollars: "0.3000",
      status: "active",
      close_time: "2027-01-01T00:00:00Z",
    };
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("candlesticks")
              ? {
                  candlesticks: [
                    {
                      end_period_ts: 180,
                      price: {
                        open_dollars: "0.2",
                        high_dollars: "0.5",
                        low_dollars: "0.1",
                        close_dollars: "0.4",
                      },
                      volume_fp: "20.50",
                    },
                  ],
                }
              : { market },
          ),
        ),
    });
    expect(
      await service.getHistory("kalshi:KXTEST-26-YES", "no", "1m"),
    ).toEqual([
      { time: 120, open: 0.8, high: 0.9, low: 0.5, close: 0.6, volume: 20.5 },
    ]);
  });
});

describe("provider depth boundary checks", () => {
  it("rejects ambiguous normalized outcome IDs", () => {
    expect(() =>
      normalizePolymarketMarket({ ...poly, outcomes: '["Yes","YES"]' }),
    ).toThrow(/mapping/i);
  });
  it("does not report source timestamps as fresh when replayed from a cached book", async () => {
    let clock = now.getTime();
    let fail = false;
    const service = new MarketDataService({
      enabled: true,
      now: () => new Date(clock),
      fetcher: async (input) =>
        String(input).includes("/book?")
          ? fail
            ? new Response("{}", { status: 403 })
            : new Response(
                JSON.stringify({
                  asset_id: "200",
                  timestamp: now.getTime(),
                  bids: [],
                  asks: [],
                }),
              )
          : new Response(JSON.stringify(poly)),
    });
    expect((await service.getBook("poly:42", "yes")).stale).toBe(false);
    clock += 6000;
    fail = true;
    await expect(service.getBook("poly:42", "yes")).rejects.toThrow(/403/);
  });
  it("aggregates actual Kalshi minute candles to the requested five minute interval", async () => {
    const market = {
      ticker: "KXTEST-26-YES",
      event_ticker: "KXTEST-26",
      title: "Test?",
      last_price_dollars: "0.3000",
      status: "active",
      close_time: "2027-01-01T00:00:00Z",
    };
    const candle = (
      end_period_ts: number,
      open: string,
      high: string,
      low: string,
      close: string,
    ) => ({
      end_period_ts,
      price: {
        open_dollars: open,
        high_dollars: high,
        low_dollars: low,
        close_dollars: close,
      },
      volume_fp: "2.00",
    });
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("candlesticks")
              ? {
                  candlesticks: [
                    candle(60, "0.2", "0.5", "0.1", "0.4"),
                    candle(120, "0.4", "0.6", "0.3", "0.5"),
                  ],
                }
              : { market },
          ),
        ),
    });
    expect(
      await service.getHistory("kalshi:KXTEST-26-YES", "yes", "5m"),
    ).toEqual([
      { time: 0, open: 0.2, high: 0.6, low: 0.1, close: 0.5, volume: 4 },
    ]);
  });
});

describe("provider identity binding", () => {
  it("rejects books whose response asset ID is missing or belongs to another outcome", async () => {
    for (const asset_id of [undefined, "100"]) {
      const service = new MarketDataService({
        enabled: true,
        now: () => now,
        fetcher: async (input) =>
          new Response(
            JSON.stringify(
              String(input).includes("/book?")
                ? { asset_id, timestamp: now.getTime(), bids: [], asks: [] }
                : poly,
            ),
          ),
      });
      await expect(service.getBook("poly:42", "yes")).rejects.toThrow(
        /mapping/i,
      );
    }
  });
});

describe("history display windows", () => {
  it("requests six hours of real Polymarket observations at one minute fidelity", async () => {
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("prices-history")) {
          expect(new URL(url).searchParams.get("interval")).toBe("6h");
          expect(new URL(url).searchParams.get("fidelity")).toBe("1");
          return new Response(
            JSON.stringify({
              history: [
                { t: 120, p: 0.2 },
                { t: 180, p: 0.3 },
              ],
            }),
          );
        }
        return new Response(JSON.stringify(poly));
      },
    });
    expect(
      (await service.getHistory("poly:42", "yes", "6h")).map((c) => c.time),
    ).toEqual([120, 180]);
  });
  it("requests one day of Kalshi minute candles without daily aggregation", async () => {
    const market = {
      ticker: "KXTEST-26-YES",
      event_ticker: "KXTEST-26",
      title: "Test?",
      last_price_dollars: "0.3",
      status: "active",
      close_time: "2027-01-01T00:00:00Z",
    };
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/candlesticks")) {
          expect(url.searchParams.get("period_interval")).toBe("1");
          expect(
            Number(url.searchParams.get("end_ts")) -
              Number(url.searchParams.get("start_ts")),
          ).toBe(86400);
          return new Response(
            JSON.stringify({
              candlesticks: [
                {
                  end_period_ts: 180,
                  price: {
                    open_dollars: "0.2",
                    high_dollars: "0.2",
                    low_dollars: "0.2",
                    close_dollars: "0.2",
                  },
                },
                {
                  end_period_ts: 240,
                  price: {
                    open_dollars: "0.3",
                    high_dollars: "0.3",
                    low_dollars: "0.3",
                    close_dollars: "0.3",
                  },
                },
              ],
            }),
          );
        }
        return new Response(JSON.stringify({ market }));
      },
    });
    expect(
      (await service.getHistory("kalshi:KXTEST-26-YES", "yes", "1d")).map(
        (c) => c.time,
      ),
    ).toEqual([120, 180]);
  });
});

describe("Kalshi maximum history limits", () => {
  it("uses provider daily candles for an all-time window exceeding 5000 hours", async () => {
    const market = {
      ticker: "KXTEST-26-YES",
      event_ticker: "KXTEST-26",
      title: "Test?",
      last_price_dollars: "0.3",
      status: "active",
      created_time: "2025-01-01T00:00:00Z",
      close_time: "2027-01-01T00:00:00Z",
    };
    const service = new MarketDataService({
      enabled: true,
      now: () => now,
      fetcher: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/candlesticks")) {
          expect(url.searchParams.get("period_interval")).toBe("1440");
          return new Response(JSON.stringify({ candlesticks: [] }));
        }
        return new Response(JSON.stringify({ market }));
      },
    });
    expect(
      await service.getHistory("kalshi:KXTEST-26-YES", "yes", "max"),
    ).toEqual([]);
  });
});

describe("provider final-only outcome evidence", () => {
  const kalshi = {
    ticker: "KXTEST-26-YES",
    event_ticker: "KXTEST-26",
    title: "Test?",
    last_price_dollars: "0.3",
    close_time: "2027-01-01T00:00:00Z",
    updated_time: now.toISOString(),
  };
  it("settles Kalshi only on provider final status and an explicit binary result", () => {
    expect(
      normalizeKalshiMarket({ ...kalshi, status: "settled", result: "yes" })
        .resolution,
    ).toMatchObject({ outcomeId: "yes", state: "FINAL", proposedBy: "kalshi" });
    expect(
      normalizeKalshiMarket({ ...kalshi, status: "finalized", result: "no" })
        .resolution,
    ).toMatchObject({ outcomeId: "no", state: "FINAL" });
    for (const status of ["active", "closed", "determined", "disputed"])
      expect(
        normalizeKalshiMarket({ ...kalshi, status, result: "yes" }).resolution,
      ).toBeUndefined();
    expect(
      normalizeKalshiMarket({ ...kalshi, status: "settled", result: "" })
        .resolution,
    ).toBeUndefined();
  });
  const condition = "0x" + "a".repeat(64);
  const finalPoly = {
    ...poly,
    closed: true,
    conditionId: condition,
    umaResolutionStatus: "resolved",
  };
  const clob = {
    condition_id: condition,
    closed: true,
    accepting_orders: false,
    tokens: [
      { token_id: "200", outcome: "Yes", winner: true },
      { token_id: "100", outcome: "No", winner: false },
    ],
  };
  it("maps explicit Polymarket final winner by asset ID even when tokens are reordered", () => {
    expect(normalizePolymarketMarket(finalPoly, clob).resolution).toMatchObject(
      { outcomeId: "yes", state: "FINAL", proposedBy: "polymarket" },
    );
    expect(
      normalizePolymarketMarket(finalPoly, clob).resolution?.evidence,
    ).toBe("https://clob.polymarket.com/markets/" + condition);
  });
  it("never infers a final result from price1, pending/disputed state, or unmapped winners", () => {
    expect(
      normalizePolymarketMarket({ ...finalPoly, outcomePrices: '["0","1"]' })
        .resolution,
    ).toBeUndefined();
    expect(
      normalizePolymarketMarket(
        { ...finalPoly, umaResolutionStatus: "disputed" },
        clob,
      ).resolution,
    ).toBeUndefined();
    expect(() =>
      normalizePolymarketMarket(finalPoly, {
        ...clob,
        tokens: [
          { token_id: "999", outcome: "Yes", winner: true },
          { token_id: "100", outcome: "No", winner: false },
        ],
      }),
    ).toThrow(/mapping/i);
    expect(() =>
      normalizePolymarketMarket(finalPoly, {
        ...clob,
        condition_id: "0x" + "b".repeat(64),
      }),
    ).toThrow(/condition/i);
    expect(
      normalizePolymarketMarket(finalPoly, {
        ...clob,
        tokens: clob.tokens.map((t) => ({ ...t, winner: false })),
      }).resolution,
    ).toBeUndefined();
  });
  it("fetches explicit CLOB winner evidence for resolved Gamma metadata", async () => {
    const service = new MarketDataService({
      enabled: true,
      fetcher: async (input) =>
        new Response(
          JSON.stringify(
            String(input).includes("clob.polymarket.com/markets/")
              ? clob
              : finalPoly,
          ),
        ),
    });
    expect((await service.getMarket("poly:42")).resolution?.outcomeId).toBe(
      "yes",
    );
  });
});
