import { afterEach, describe, it, expect, vi } from "vitest";
afterEach(() => vi.unstubAllEnvs());
import { Store } from "../server/store";
import { ammCost, reserve, money, units } from "../server/math";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(path = ":memory:") {
  let time = new Date("2030-01-01T00:00:00Z");
  const s = new Store({ path, now: () => time });
  const a = s.register("alice", "correct horse battery");
  const b = s.register("bob", "correct horse battery");
  const c = s.register("carol", "correct horse battery");
  const d = s.register("david", "correct horse battery");
  const e = s.register("edith", "correct horse battery");
  const g = s.groups(a.user.id)[0]!;
  const token = s.invite(a.user.id, g.id, { uses: 10 }).token;
  for (const u of [b, c, d, e]) s.redeem(u.user.id, token);
  s.changeMember(a.user.id, g.id, b.user.id, { role: "MODERATOR" });
  const m = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will the measured value exceed 5?",
    category: "Science",
    closeAt: "2030-01-03T00:00:00Z",
    b: 500,
    rules: {
      condition: "Measured value above 5",
      source: "https://example.com/result",
      evidence: "Official published value",
      observationAt: "2030-01-03T00:00:00Z",
      voidPolicy: "Neutral 0.5 if unresolvable",
      disputeHours: 24,
      resolverId: c.user.id,
      reviewerIds: [d.user.id, e.user.id],
    },
  });
  s.approveMarket(b.user.id, m.id);
  const order = (
    userId = a.user.id,
    side: "BUY" | "SELL" = "BUY",
    quantity = 10,
    limitPrice = "0.9999",
    extra = {},
  ) =>
    s.execute(
      userId,
      {
        marketId: m.id,
        outcomeId: m.outcomes[0]!.id,
        side,
        quantity,
        limitPrice,
        timeInForce: "IOC",
        ...extra,
      },
      crypto.randomUUID(),
    );
  return {
    s,
    a,
    b,
    c,
    d,
    e,
    g,
    m,
    order,
    setTime: (v: string) => {
      time = new Date(v);
    },
  };
}

describe("exact persistent exchange", () => {
  it("matches independent Decimal oracle and rounds against roundtrip profit", () => {
    expect(money(ammCost([0, 0], 500, 0, 100, "BUY"))).toBe("52.495845");
    expect(money(ammCost([100, 0], 500, 0, 100, "SELL"))).toBe("52.495844");
    expect(money(reserve(500))).toBe("347.573591");
  });
  it("issues once per scope and persists auth and transactions", () => {
    const dir = mkdtempSync(join(tmpdir(), "opentrader-"));
    const path = join(dir, "test.db");
    try {
      const { s, a, g, order } = setup(path);
      order();
      const before = s.wallets(a.user.id);
      s.close();
      const next = new Store({ path });
      expect(next.wallets(a.user.id)).toEqual(before);
      expect(next.login("alice", "correct horse battery").user.id).toBe(
        a.user.id,
      );
      expect(next.groups(a.user.id)[0]!.id).toBe(g.id);
      expect(next.reconcile(a.user.id).balanced).toBe(true);
      next.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("protects group scope and resolver independence", () => {
    const { s, a, c, m, order } = setup();
    const stranger = s.register("stranger", "strong password here");
    expect(() => s.market(stranger.user.id, m.id)).toThrow();
    expect(() => order(c.user.id)).toThrow();
    expect(() => s.approveMarket(a.user.id, m.id)).toThrow();
  });
  it("executes shares, immutable balanced journals, exact retry and conflicting keys", () => {
    const { s, a, m } = setup();
    const input = {
      marketId: m.id,
      outcomeId: m.outcomes[0]!.id,
      side: "BUY" as const,
      quantity: 100,
      limitPrice: "0.9999",
      timeInForce: "IOC" as const,
    };
    const first = s.execute(a.user.id, input, "test-key");
    expect(first.spent).toBe("52.495845");
    expect(s.execute(a.user.id, input, "test-key")).toEqual(first);
    expect(() =>
      s.execute(a.user.id, { ...input, quantity: 99 }, "test-key"),
    ).toThrow();
    expect(s.positions(a.user.id)[0]!.quantity).toBe(100);
    expect(s.reconcile(a.user.id).balanced).toBe(true);
  });
  it("rejects uncovered and fractional sales and rolls back minimum-fill/cost caps", () => {
    const { s, a, order } = setup();
    expect(() => order(a.user.id, "SELL", 1, "0.0001")).toThrow();
    expect(() => order(a.user.id, "BUY", 1.5)).toThrow();
    const before = s.wallets(a.user.id);
    expect(() =>
      order(a.user.id, "BUY", 10, "0.9999", { maxTotalCost: "1" }),
    ).toThrow();
    expect(s.wallets(a.user.id)).toEqual(before);
    expect(() =>
      order(a.user.id, "BUY", 10, "0.49", { minFillQuantity: 1 }),
    ).toThrow();
  });
  it("locks cash, cancels and expires without minting", () => {
    const { s, a, order, setTime } = setup();
    const initial = s.wallets(a.user.id);
    const r = order(a.user.id, "BUY", 10, "0.4", {
      timeInForce: "GTD",
      expiresAt: "2030-01-02T00:00:00Z",
    });
    expect(r.order.status).toBe("OPEN");
    expect(r.wallet.locked).toBe("4.000000");
    setTime("2030-01-02T01:00:00Z");
    s.tick();
    expect(s.orders(a.user.id)[0]!.status).toBe("EXPIRED");
    expect(s.wallets(a.user.id)).toEqual(initial);
  });
  it("routes a lot to peer when its integrated price beats AMM and preserves basis", () => {
    const { s, a, b, m, order } = setup();
    order(a.user.id, "BUY", 10);
    const ask = order(a.user.id, "SELL", 2, "0.5051", { timeInForce: "GTC" });
    expect(ask.order.status).toBe("OPEN");
    const buy = order(b.user.id, "BUY", 2);
    expect(buy.fills.some((x) => x.source === "PEER")).toBe(true);
    expect(
      s.positions(a.user.id).find((x) => x.marketId === m.id)!.locked,
    ).toBe(0);
    expect(s.reconcile(a.user.id).balanced).toBe(true);
  });
  it("removal cancels orders, blocks reads and rejoin does not allocate again", () => {
    const { s, a, b, g, order } = setup();
    order(b.user.id, "BUY", 10, "0.4", { timeInForce: "GTC" });
    const before = s.wallets(b.user.id).find((x) => x.groupId === g.id)!.total;
    s.changeMember(a.user.id, g.id, b.user.id, { status: "REMOVED" });
    expect(() => s.markets(b.user.id, g.id)).toThrow();
    s.redeem(b.user.id, s.invite(a.user.id, g.id, {}).token);
    expect(s.wallets(b.user.id).find((x) => x.groupId === g.id)!.total).toBe(
      before,
    );
  });
  it("settles once after challenge and scores only eligible forecasts", () => {
    const { s, a, c, m, order, setTime } = setup();
    s.forecast(a.user.id, m.id, 0.7);
    order();
    setTime("2030-01-03T00:00:00Z");
    s.propose(c.user.id, m.id, {
      outcomeId: m.outcomes[0]!.id,
      evidence: "https://example.com/result",
      rationale: "Confirmed published result",
      determinedAt: "2030-01-03T00:00:00Z",
    });
    expect(s.market(a.user.id, m.id).status).toBe("RESOLVING");
    setTime("2030-01-04T00:00:01Z");
    s.tick();
    expect(s.market(a.user.id, m.id).status).toBe("RESOLVED");
    const wallets = s.wallets(a.user.id);
    s.tick();
    expect(s.wallets(a.user.id)).toEqual(wallets);
    expect(
      s
        .leaderboard(a.user.id, "FRIENDS", m.groupId!)
        .find((x) => x.userId === a.user.id)!.brierScore,
    ).toBeCloseTo(0.09);
    expect(s.reconcile(a.user.id).balanced).toBe(true);
  });
  it("disputes need two impartial reviews; historical traders remain ineligible", () => {
    const { s, a, b, c, d, e, m, order, setTime } = setup();
    order(b.user.id);
    order(b.user.id, "SELL", 10, "0.0001");
    setTime("2030-01-03T00:00:00Z");
    s.propose(c.user.id, m.id, {
      outcomeId: m.outcomes[0]!.id,
      evidence: "published evidence",
      rationale: "result",
    });
    s.dispute(a.user.id, m.id, "The observation is disputed");
    expect(() =>
      s.review(b.user.id, m.id, { decision: "CONFIRM", rationale: "yes" }),
    ).toThrow();
    s.review(d.user.id, m.id, { decision: "CONFIRM", rationale: "checked" });
    s.review(e.user.id, m.id, {
      decision: "CONFIRM",
      rationale: "checked independently",
    });
    expect(s.market(a.user.id, m.id).status).toBe("RESOLVING");
    setTime("2030-01-04T00:00:01Z");
    s.tick();
    expect(s.market(a.user.id, m.id).status).toBe("RESOLVED");
  });
  it("unresolved closed markets neutral void at longstop", () => {
    const { s, a, m, order, setTime } = setup();
    order();
    setTime("2030-01-06T00:00:01Z");
    s.tick();
    expect(s.market(a.user.id, m.id).status).toBe("VOID");
    expect(s.positions(a.user.id)[0]!.quantity).toBe(0);
  });
});

describe("protection and governance regressions", () => {
  it("replays one committed request one hundred times without another fill", () => {
    const { s, a, m } = setup();
    const input = {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY" as const,
      quantity: 3,
      limitPrice: "0.9999",
      timeInForce: "IOC" as const,
    };
    const original = s.execute(a.user.id, input, "retry-hundred");
    for (let i = 0; i < 100; i++)
      expect(s.execute(a.user.id, input, "retry-hundred")).toEqual(original);
    expect(s.fills(a.user.id, m.id)).toHaveLength(1);
    expect(s.positions(a.user.id)[0]!.quantity).toBe(3);
  });
  it("rejects edits/deletes to posted journal rows", () => {
    const { s } = setup();
    expect(() => s.db.exec("UPDATE journal SET delta='1' WHERE id=1")).toThrow(
      "immutable",
    );
    expect(() => s.db.exec("DELETE FROM journal WHERE id=1")).toThrow(
      "immutable",
    );
  });
  it("requires the full resting-order cash commitment to fit a hard spend cap", () => {
    const { s, a, order } = setup();
    expect(() =>
      order(a.user.id, "BUY", 10, "0.4", {
        timeInForce: "GTC",
        maxTotalCost: "1",
      }),
    ).toThrow("maximum");
    expect(s.orders(a.user.id)).toHaveLength(0);
  });
  it("issues no repeat allocation after a second invite redemption", () => {
    const { s, a, b, g } = setup();
    const before = s.wallets(b.user.id);
    const token = s.invite(a.user.id, g.id, { uses: 1 }).token;
    s.redeem(b.user.id, token);
    s.redeem(b.user.id, token);
    expect(s.wallets(b.user.id)).toEqual(before);
  });
  it("invalidates sessions at logout and rejects incorrect passwords", () => {
    const s = new Store({ path: ":memory:" });
    const user = s.register("passwordtest", "a long password here");
    expect(s.authenticate(user.token)?.id).toBe(user.user.id);
    expect(() => s.login("passwordtest", "incorrect password")).toThrow();
    s.logout(user.token);
    expect(s.authenticate(user.token)).toBeNull();
  });
  it("freezes early public-answer cutoff and excludes unevidenced calibration", () => {
    const { s, a, c, m, g, setTime } = setup();
    s.forecast(a.user.id, m.id, 0.2);
    setTime("2030-01-02T00:00:00Z");
    s.forecast(a.user.id, m.id, 0.9);
    setTime("2030-01-03T00:00:00Z");
    s.propose(c.user.id, m.id, {
      outcomeId: "yes",
      evidence: "report",
      rationale: "result",
      determinedAt: "2030-01-01T12:00:00Z",
    });
    setTime("2030-01-04T00:00:01Z");
    s.tick();
    expect(
      s
        .leaderboard(a.user.id, "FRIENDS", g.id)
        .find((r) => r.userId === a.user.id)!.brierScore,
    ).toBeCloseTo(0.64);
  });
  it("funds correction only with two impartial approvals and no negative wallets", () => {
    const { s, a, c, d, e, m, order, setTime } = setup();
    order();
    setTime("2030-01-03T00:00:00Z");
    s.propose(c.user.id, m.id, {
      outcomeId: "no",
      evidence: "first",
      rationale: "initial",
    });
    setTime("2030-01-04T00:00:01Z");
    s.tick();
    const before = s
      .wallets(a.user.id)
      .find((w) => w.groupId === m.groupId)!.total;
    const correction = s.correction(c.user.id, m.id, {
      outcomeId: "yes",
      evidence: "official correction",
      rationale: "corrected",
    });
    s.approveCorrection(d.user.id, correction.id);
    expect(
      s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.total,
    ).toBe(before);
    s.approveCorrection(e.user.id, correction.id);
    expect(
      Number(s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.total) -
        Number(before),
    ).toBeCloseTo(10);
    expect(s.reconcile(a.user.id).balanced).toBe(true);
  });
});

describe("external snapshot execution", () => {
  function live() {
    const now = new Date("2030-01-01T00:00:00Z"),
      s = new Store({ path: ":memory:", now: () => now }),
      u = s.register("liveuser", "a long password here");
    const market = {
      id: "poly:123",
      exchange: "LIVE" as const,
      provider: "polymarket" as const,
      groupId: null,
      question: "Real provider question",
      description: "",
      category: "Test",
      outcomes: [
        { id: "yes", label: "YES", probability: 0.5 },
        { id: "no", label: "NO", probability: 0.5 },
      ],
      status: "OPEN",
      volume: 0,
      liquidity: 10,
      closeAt: "2030-02-01T00:00:00Z",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sequence: 0,
    };
    const book = {
      marketId: market.id,
      outcomeId: "yes",
      bids: [{ price: 0.49, quantity: 5, source: "EXTERNAL" as const }],
      asks: [
        { price: 0.51, quantity: 5, source: "EXTERNAL" as const },
        { price: 0.52, quantity: 5, source: "EXTERNAL" as const },
      ],
      timestamp: now.toISOString(),
      stale: false,
      source: "provider",
    };
    const input = {
      marketId: market.id,
      outcomeId: "yes",
      side: "BUY" as const,
      quantity: 10,
      limitPrice: "0.5200",
      timeInForce: "IOC" as const,
      maxTotalCost: "5.15",
      minFillQuantity: 10,
    };
    return { s, u, market, book, input };
  }
  it("walks actual depth within hard limits and isolates Live wallet", () => {
    const { s, u, market, book, input } = live(),
      before = s.wallets(u.user.id).find((w) => w.exchange === "FRIENDS");
    const r = s.executeLive(u.user.id, market, book, input, "live-retry");
    expect(r.spent).toBe("5.150000");
    expect(r.fills).toHaveLength(2);
    expect(s.wallets(u.user.id).find((w) => w.exchange === "FRIENDS")).toEqual(
      before,
    );
    expect(
      s.executeLive(
        u.user.id,
        market,
        { ...book, stale: true },
        input,
        "live-retry",
      ),
    ).toEqual(r);
    expect(s.reconcile(u.user.id).balanced).toBe(true);
  });
  it("fails closed on stale/missing/mismatched snapshots and does not debit", () => {
    const { s, u, market, book, input } = live(),
      before = s.wallets(u.user.id);
    for (const bad of [
      { ...book, stale: true },
      { ...book, timestamp: "" },
      { ...book, timestamp: "2029-12-31T23:59:54Z" },
      { ...book, outcomeId: "no" },
    ])
      expect(() =>
        s.executeLive(u.user.id, market, bad, input, crypto.randomUUID()),
      ).toThrow();
    expect(s.wallets(u.user.id)).toEqual(before);
  });
  it("rejects uncovered external sales and atomic minimum fills", () => {
    const { s, u, market, book, input } = live();
    expect(() =>
      s.executeLive(
        u.user.id,
        market,
        book,
        { ...input, side: "SELL", limitPrice: "0.0001" },
        "sell-unowned",
      ),
    ).toThrow();
    expect(() =>
      s.executeLive(
        u.user.id,
        market,
        book,
        { ...input, limitPrice: "0.5100" },
        "min-fill-fail",
      ),
    ).toThrow();
    expect(s.positions(u.user.id)).toEqual([]);
  });
  it("rejects worse average partial buys and expanded sells even when total cash protections pass", () => {
    const { s, u, market, book, input } = live();
    const cheap = {
      ...book,
      asks: [{ price: 0.5, quantity: 10, source: "EXTERNAL" as const }],
    };
    const quote = s.quoteLive(u.user.id, market, cheap, {
      outcomeId: "yes",
      side: "BUY",
      quantity: 10,
    });
    expect(quote.averagePrice).toBe(0.5);
    const worseBuy = {
      ...book,
      asks: [{ price: 0.99, quantity: 5, source: "EXTERNAL" as const }],
    };
    expect(() =>
      s.executeLive(
        u.user.id,
        market,
        worseBuy,
        {
          ...input,
          limitPrice: "0.9999",
          maxTotalCost: "5.05",
          minFillQuantity: 0,
          maxAveragePrice: "0.505",
        },
        "average-buy",
      ),
    ).toThrow("average");
    expect(s.positions(u.user.id)).toEqual([]);
    s.executeLive(
      u.user.id,
      market,
      cheap,
      { ...input, maxTotalCost: "5" },
      "establish-shares",
    );
    const before = s.wallets(u.user.id);
    const sellQuote = s.quoteLive(
      u.user.id,
      market,
      {
        ...book,
        bids: [{ price: 0.5, quantity: 5, source: "EXTERNAL" as const }],
      },
      { outcomeId: "yes", side: "SELL", quantity: 10 },
    );
    expect(sellQuote.filledQuantity).toBe(5);
    expect(() =>
      s.executeLive(
        u.user.id,
        market,
        {
          ...book,
          bids: [{ price: 0.25, quantity: 10, source: "EXTERNAL" as const }],
        },
        {
          marketId: market.id,
          outcomeId: "yes",
          side: "SELL",
          quantity: 10,
          limitPrice: "0.0001",
          timeInForce: "IOC",
          minTotalProceeds: "2.475",
          minAveragePrice: "0.495",
        },
        "average-sell",
      ),
    ).toThrow("average");
    expect(s.wallets(u.user.id)).toEqual(before);
    expect(s.positions(u.user.id)[0]!.quantity).toBe(10);
  });
});

it("rejects exponent-form and oversized monetary inputs before expanding decimal values", () => {
  for (const value of [
    "1e1000000",
    "Infinity",
    "9".repeat(1000),
    "1000000000001",
    "0.1234567",
  ])
    expect(() => units(value)).toThrow();
  expect(units("-0.000001")).toBe(-1n);
  expect(units(0.000001)).toBe(1n);
});

it("fails closed outside bounded LMSR log-odds instead of issuing free shares", () => {
  expect(() => ammCost([1000000, 0], 10, 1, 1, "BUY")).toThrow();
  expect(() => ammCost([1000000, 0], 10, 0, 1, "SELL")).toThrow();
});

it("settles Live positions only from final provider evidence and marks fresh liquidation depth", () => {
  let time = new Date("2030-01-01T00:00:00Z");
  const s = new Store({ path: ":memory:", now: () => time }),
    u = s.register("settletest", "a long password here");
  const m = {
    id: "kalshi:FINAL",
    exchange: "LIVE" as const,
    provider: "kalshi" as const,
    groupId: null,
    question: "Provider result?",
    description: "",
    category: "Test",
    outcomes: [
      { id: "yes", label: "YES", probability: 0.6 },
      { id: "no", label: "NO", probability: 0.4 },
    ],
    status: "OPEN",
    volume: 1,
    liquidity: 1,
    closeAt: "2030-01-02T00:00:00Z",
    createdAt: time.toISOString(),
    updatedAt: time.toISOString(),
    sequence: 0,
  };
  const book = {
    marketId: m.id,
    outcomeId: "yes",
    bids: [{ price: 0.59, quantity: 20, source: "EXTERNAL" as const }],
    asks: [{ price: 0.61, quantity: 20, source: "EXTERNAL" as const }],
    timestamp: time.toISOString(),
    stale: false,
    source: "provider",
  };
  s.executeLive(
    u.user.id,
    m,
    book,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY",
      quantity: 10,
      limitPrice: "0.6200",
      timeInForce: "IOC",
    },
    "settle-live",
  );
  s.syncLiveMarket(m, book);
  expect(s.positions(u.user.id, "LIVE")[0]!.liquidationValue).toBe("5.900000");
  time = new Date("2030-01-03T00:00:00Z");
  s.syncLiveMarket({ ...m, status: "CLOSED" });
  expect(s.positions(u.user.id, "LIVE")[0]!.quantity).toBe(10);
  const final = {
    ...m,
    status: "RESOLVED",
    resolution: {
      id: "provider-final",
      outcomeId: "yes",
      evidence: "https://example.com/official",
      rationale: "Final provider outcome",
      proposedBy: "kalshi",
      proposedAt: time.toISOString(),
      disputeUntil: time.toISOString(),
      state: "FINAL",
      disputes: [],
      reviews: [],
    },
  };
  s.syncLiveMarket(final);
  expect(s.positions(u.user.id, "LIVE")[0]!.quantity).toBe(0);
  const total = s.wallets(u.user.id).find((w) => w.exchange === "LIVE")!.total;
  expect(total).toBe("10003.900000");
  const revised = {
    ...final,
    resolution: {
      ...final.resolution,
      outcomeId: "no",
      evidence: "https://example.com/corrected",
    },
  };
  s.syncLiveMarket(revised);
  const correction = s.corrections(u.user.id, m.id)[0]!;
  expect(s.wallets(u.user.id).find((w) => w.exchange === "LIVE")!.total).toBe(
    total,
  );
  expect(() => s.approveCorrection(u.user.id, correction.id)).toThrow();
  const reviewer1 = s.register("livereviewerone", "a long password here"),
    reviewer2 = s.register("livereviewertwo", "a long password here");
  expect(() => s.approveCorrection(reviewer1.user.id, correction.id)).toThrow(
    "appointed",
  );
  vi.stubEnv(
    "PLATFORM_REVIEWER_IDS",
    `${reviewer1.user.id},${reviewer2.user.id}`,
  );
  s.approveCorrection(reviewer1.user.id, correction.id);
  expect(s.wallets(u.user.id).find((w) => w.exchange === "LIVE")!.total).toBe(
    total,
  );
  s.approveCorrection(reviewer2.user.id, correction.id);
  s.syncLiveMarket(final);
  const reversal = s
    .corrections(u.user.id, m.id)
    .find((item) => item.state === "PENDING")!;
  s.syncLiveMarket(revised);
  expect(() => s.approveCorrection(reviewer1.user.id, reversal.id)).toThrow(
    "reviewed",
  );

  expect(s.wallets(u.user.id).find((w) => w.exchange === "LIVE")!.total).toBe(
    "9993.900000",
  );

  s.syncLiveMarket(revised);
  expect(s.wallets(u.user.id).find((w) => w.exchange === "LIVE")!.total).toBe(
    "9993.900000",
  );
  expect(s.reconcile(u.user.id).balanced).toBe(true);
});

it("uses the external accepting-orders status for LIVE scheduled dates, while Friends deadlines remain frozen", () => {
  const time = new Date("2030-01-02T00:00:00Z"),
    s = new Store({ path: ":memory:", now: () => time }),
    u = s.register("inplayuser", "a long password here");
  const market = {
    id: "poly:INPLAY",
    exchange: "LIVE" as const,
    provider: "polymarket" as const,
    groupId: null,
    question: "In-play provider market",
    description: "",
    category: "Test",
    outcomes: [
      { id: "yes", label: "YES", probability: 0.5 },
      { id: "no", label: "NO", probability: 0.5 },
    ],
    status: "OPEN",
    volume: 0,
    liquidity: 10,
    closeAt: "2030-01-01T00:00:00Z",
    createdAt: time.toISOString(),
    updatedAt: time.toISOString(),
    sequence: 0,
  };
  const book = {
    marketId: market.id,
    outcomeId: "yes",
    bids: [],
    asks: [{ price: 0.5, quantity: 5, source: "EXTERNAL" as const }],
    timestamp: time.toISOString(),
    stale: false,
    source: "provider",
  };
  expect(
    s.executeLive(
      u.user.id,
      market,
      book,
      {
        marketId: market.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 1,
        limitPrice: "0.5100",
        timeInForce: "IOC",
      },
      "in-play",
    ).spent,
  ).toBe("0.500000");
});

it("looks up a committed Live receipt before any provider dependency and rejects changed retry payload", () => {
  const s = new Store({ path: ":memory:" }),
    u = s.register("replaytest", "a long password here");
  const m = {
      id: "poly:REPLAY",
      exchange: "LIVE" as const,
      provider: "polymarket" as const,
      groupId: null,
      question: "Real provider",
      description: "",
      category: "Test",
      outcomes: [
        { id: "yes", label: "YES", probability: 0.5 },
        { id: "no", label: "NO", probability: 0.5 },
      ],
      status: "OPEN",
      volume: 0,
      liquidity: 1,
      closeAt: "2030-01-01T00:00:00Z",
      createdAt: s.now(),
      updatedAt: s.now(),
      sequence: 0,
    },
    book = {
      marketId: m.id,
      outcomeId: "yes",
      bids: [],
      asks: [{ price: 0.5, quantity: 3, source: "EXTERNAL" as const }],
      timestamp: s.now(),
      stale: false,
      source: "provider",
    },
    input = {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY" as const,
      quantity: 1,
      limitPrice: "0.5000",
      timeInForce: "IOC" as const,
    };
  expect(s.replayOrder(u.user.id, input, "replay-key")).toBeNull();
  const receipt = s.executeLive(u.user.id, m, book, input, "replay-key");
  expect(s.replayOrder(u.user.id, input, "replay-key")).toEqual(receipt);
  expect(() =>
    s.replayOrder(u.user.id, { ...input, quantity: 2 }, "replay-key"),
  ).toThrow("different");
});

it("removal revokes unscoped private order, position and notification reads", () => {
  const { s, a, b, g, order } = setup();
  order(b.user.id);
  expect(s.positions(b.user.id)).toHaveLength(1);
  expect(s.orders(b.user.id)).toHaveLength(1);
  expect(s.notifications(b.user.id)).toHaveLength(1);
  s.changeMember(a.user.id, g.id, b.user.id, { status: "REMOVED" });
  expect(s.positions(b.user.id)).toEqual([]);
  expect(s.orders(b.user.id)).toEqual([]);
  expect(s.notifications(b.user.id)).toEqual([]);
  expect(s.audit(b.user.id).length).toBeGreaterThan(0);
});

it("observes commits across two SQLite connections and does not write on an idle tick", () => {
  const dir = mkdtempSync(join(tmpdir(), "opentrader-connections-"));
  try {
    const path = join(dir, "shared.db"),
      first = new Store({ path }),
      second = new Store({ path });
    const a = first.register("connectiona", "a long password here");
    expect(second.login("connectiona", "a long password here").user.id).toBe(
      a.user.id,
    );
    const token = first.invite(a.user.id, first.groups(a.user.id)[0]!.id, {
      uses: 1,
    }).token;
    const b = second.register("connectionb", "a long password here");
    second.redeem(b.user.id, token);
    expect(
      first.members(a.user.id, first.groups(a.user.id)[0]!.id),
    ).toHaveLength(2);
    const changes = first.db.prepare("SELECT total_changes() AS total").get();
    const before = second.db.prepare("PRAGMA data_version").get();
    first.tick();
    expect(first.db.prepare("SELECT total_changes() AS total").get()).toEqual(
      changes,
    );
    expect(second.db.prepare("PRAGMA data_version").get()).toEqual(before);
    first.close();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("commits one durable market sequence batch per atomic order and preserves immutable history", () => {
  const { s, a, m, order } = setup();
  const before = s.market(a.user.id, m.id).sequence;
  order();
  const after = s.market(a.user.id, m.id).sequence;
  expect(after).toBe(before + 1);
  const events = s.events(a.user.id, m.id, before);
  expect(events).toHaveLength(1);
  expect(events[0]!.sequence).toBe(after);
  expect(() => s.db.exec("DELETE FROM market_events")).toThrow("immutable");
});

it("moderator halt cancels holds, preserves shares, resumes before the deadline and audits content removal", () => {
  const { s, a, b, m, order, setTime } = setup();
  order(a.user.id);
  order(a.user.id, "BUY", 10, "0.4", { timeInForce: "GTC" });
  const before = s.positions(a.user.id)[0]!.quantity;
  const comment = s.comment(a.user.id, m.id, "Reported comment text");
  s.hideComment(b.user.id, comment.id);
  expect(s.comments(a.user.id, m.id)[0]!.body).toBe("[Removed by a moderator]");
  expect(s.moderationAudit(b.user.id, m.groupId!)[0]!.data).toContain(
    "Reported comment text",
  );
  s.haltMarket(b.user.id, m.id, "Reported problematic market content");
  expect(s.market(a.user.id, m.id).status).toBe("HALTED");
  expect(
    s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.locked,
  ).toBe("0.000000");
  expect(s.positions(a.user.id)[0]!.quantity).toBe(before);
  expect(() => order()).toThrow();
  s.resumeMarket(
    b.user.id,
    m.id,
    "Reviewed objective question, resume accepted",
  );
  expect(s.market(a.user.id, m.id).status).toBe("OPEN");
  s.haltMarket(b.user.id, m.id, "Awaiting further review");
  setTime("2030-01-03T00:00:00Z");
  s.tick();
  expect(s.market(a.user.id, m.id).status).toBe("CLOSED");
  expect(() =>
    s.resumeMarket(b.user.id, m.id, "Cannot change frozen deadline"),
  ).toThrow();
});

it("rejects prohibited sensitive private outcomes before creating a draft", () => {
  const { s, a, m } = setup();
  expect(() =>
    s.createMarket(a.user.id, {
      groupId: m.groupId!,
      question: "Will Alice disclose a private medical condition?",
      category: "Other",
      closeAt: "2030-02-01T00:00:00Z",
      b: 100,
      rules: m.rules!,
    }),
  ).toThrow("sensitive");
});

it("enforces the numerical domain on both sides of a trade and preserves exact symmetric costs", () => {
  expect(() => ammCost([1000000, 1000000], 500, 0, 1, "BUY")).toThrow("domain");
  expect(money(ammCost([1000, 999], 500, 1, 2, "BUY"))).toBe("1.000000");
  expect(money(ammCost([1000, 1001], 500, 1, 2, "SELL"))).toBe("1.000000");
});

it("rejects an underfunded correction atomically instead of minting funds or negative wallets", () => {
  const { s, a, b, c, d, e, g, m, order, setTime } = setup();
  order();
  setTime("2030-01-03T00:00:00Z");
  s.propose(c.user.id, m.id, {
    outcomeId: "no",
    evidence: "initial result",
    rationale: "initial",
  });
  setTime("2030-01-04T00:00:01Z");
  s.tick();
  for (let i = 0; i < 20; i++) {
    const treasury = Number(
        s.groups(a.user.id).find((group) => group.id === g.id)!.treasury,
      ),
      bValue = Math.min(10000, Math.floor((treasury - 1) / Math.log(2)));
    if (bValue < 10) break;
    const draft = s.createMarket(a.user.id, {
      groupId: g.id,
      question: `Reserve market ${i} for a measurable value`,
      category: "Science",
      closeAt: "2030-02-01T00:00:00Z",
      b: bValue,
      rules: { ...m.rules!, observationAt: "2030-02-01T00:00:00Z" },
    });
    s.approveMarket(b.user.id, draft.id);
  }
  expect(
    Number(s.groups(a.user.id).find((group) => group.id === g.id)!.treasury),
  ).toBeLessThan(10);
  const correction = s.correction(c.user.id, m.id, {
    outcomeId: "yes",
    evidence: "corrected official result",
    rationale: "corrected",
  });
  s.approveCorrection(d.user.id, correction.id);
  const before = s.wallets(a.user.id);
  expect(() => s.approveCorrection(e.user.id, correction.id)).toThrow(
    "reserve",
  );
  expect(s.wallets(a.user.id)).toEqual(before);
  expect(s.corrections(c.user.id, m.id)[0]!.approvals).toHaveLength(1);
  expect(s.reconcile(a.user.id).balanced).toBe(true);
});

it("rejects asynchronous work inside an atomic SQLite command", () => {
  const s = new Store({ path: ":memory:" });
  expect(() => s.atomic(() => Promise.resolve({ ok: true }))).toThrow(
    "synchronous",
  );
});

it("returns detached immutable rule snapshots to server callers", () => {
  const { s, a, m } = setup();
  const snapshot = s.market(a.user.id, m.id);
  snapshot.rules!.condition = "changed outside transaction";
  snapshot.outcomes[0]!.label = "changed";
  expect(s.market(a.user.id, m.id).rules!.condition).toBe(
    "Measured value above 5",
  );
  expect(s.market(a.user.id, m.id).outcomes[0]!.label).toBe("YES");
});

it("shows final outcome probabilities after settlement rather than resetting the market to 50/50", () => {
  const { s, a, c, m, setTime } = setup();
  setTime("2030-01-03T00:00:00Z");
  s.propose(c.user.id, m.id, {
    outcomeId: "yes",
    evidence: "official result",
    rationale: "confirmed",
  });
  setTime("2030-01-04T00:00:01Z");
  s.tick();
  expect(s.market(a.user.id, m.id).outcomes.map((o) => o.probability)).toEqual([
    1, 0,
  ]);
});

it("detects inventory projection corruption even when every journal transaction is balanced", () => {
  const { s, a, m, order } = setup();
  order();
  s.db
    .prepare("UPDATE state SET data=json_set(data, ?, 999) WHERE id=1")
    .run(`$.markets.\"${m.id}\".q[0]`);
  expect(s.reconcile(a.user.id).balanced).toBe(false);
});

it("cannot resurrect an abandoned market by proposing after its frozen longstop before the worker runs", () => {
  const { s, a, c, m, order, setTime } = setup();
  order();
  setTime("2030-01-10T00:00:00Z");
  expect(() =>
    s.propose(c.user.id, m.id, {
      outcomeId: "yes",
      evidence: "late report",
      rationale: "late proposal",
    }),
  ).toThrow();
  expect(s.market(a.user.id, m.id).status).toBe("VOID");
  expect(s.positions(a.user.id)[0]!.quantity).toBe(0);
  expect(s.reconcile(a.user.id).balanced).toBe(true);
});

it("enforces average protections for Friends AMM execution atomically", () => {
  const { s, a, m } = setup(),
    before = s.wallets(a.user.id);
  expect(() =>
    s.execute(
      a.user.id,
      {
        marketId: m.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 100,
        limitPrice: "0.9999",
        timeInForce: "IOC",
        maxTotalCost: "100",
        maxAveragePrice: "0.50",
      },
      "friends-average",
    ),
  ).toThrow("average");
  expect(s.wallets(a.user.id)).toEqual(before);
  expect(s.positions(a.user.id)).toEqual([]);
});

it("returns validation errors for exponential monetary order fields without committing any order", () => {
  const { s, a, m } = setup();
  const input = {
    marketId: m.id,
    outcomeId: "yes",
    side: "BUY" as const,
    quantity: 1,
    limitPrice: "0.9999",
    timeInForce: "IOC" as const,
  };
  for (const field of [
    "limitPrice",
    "maxTotalCost",
    "minTotalProceeds",
    "maxAveragePrice",
    "minAveragePrice",
  ]) {
    let failure;
    try {
      s.execute(
        a.user.id,
        { ...input, [field]: "1e1000000" },
        "exponent-" + field,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ statusCode: 422 });
  }
  expect(s.orders(a.user.id)).toEqual([]);
  expect(s.positions(a.user.id)).toEqual([]);
});

it("rejects resting average promises that contradict their frozen per-share limit", () => {
  const { s, a, order } = setup();
  expect(() =>
    order(a.user.id, "BUY", 10, "0.4", {
      timeInForce: "GTC",
      maxAveragePrice: "0.39",
    }),
  ).toThrow("resting");
  order(a.user.id, "BUY", 10);
  expect(() =>
    order(a.user.id, "SELL", 2, "0.6", {
      timeInForce: "GTD",
      expiresAt: "2030-01-02T00:00:00Z",
      minAveragePrice: "0.61",
    }),
  ).toThrow("resting");
  expect(
    order(a.user.id, "BUY", 10, "0.4", {
      timeInForce: "GTC",
      maxAveragePrice: "0.40",
    }).order.status,
  ).toBe("OPEN");
});

it("waits for the frozen observation deadline and starts the abandoned longstop afterward", () => {
  const { s, a, b, c, g, m, setTime } = setup();
  const rules = { ...m.rules!, observationAt: "2030-01-05T00:00:00Z" };
  const delayed = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will the later official observation exceed 5?",
    category: "Science",
    closeAt: "2030-01-02T00:00:00Z",
    b: 500,
    rules,
  });
  const resolved = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will another later official observation exceed 5?",
    category: "Science",
    closeAt: "2030-01-02T00:00:00Z",
    b: 500,
    rules,
  });
  s.approveMarket(b.user.id, delayed.id);
  s.approveMarket(b.user.id, resolved.id);
  s.execute(
    a.user.id,
    {
      marketId: delayed.id,
      outcomeId: "yes",
      side: "BUY",
      quantity: 10,
      limitPrice: "0.9999",
      timeInForce: "IOC",
    },
    "delayed-observation-buy",
  );
  setTime("2030-01-02T01:00:00Z");
  expect(() =>
    s.propose(c.user.id, delayed.id, {
      outcomeId: "no",
      evidence: "early report",
      rationale: "observation still pending",
    }),
  ).toThrow("observation");
  expect(s.market(a.user.id, delayed.id).status).toBe("CLOSED");
  setTime("2030-01-05T01:00:00Z");
  s.tick();
  expect(s.market(a.user.id, delayed.id).status).toBe("CLOSED");
  expect(
    s.propose(c.user.id, resolved.id, {
      outcomeId: "yes",
      evidence: "final observed value",
      rationale: "observed after deadline",
    }).status,
  ).toBe("RESOLVING");
  setTime("2030-01-08T00:00:01Z");
  s.tick();
  expect(s.market(a.user.id, delayed.id).status).toBe("VOID");
  expect(s.market(a.user.id, resolved.id).status).toBe("RESOLVED");
  expect(
    s.positions(a.user.id).find((p) => p.marketId === delayed.id)!.quantity,
  ).toBe(0);
  expect(s.reconcile(a.user.id).balanced).toBe(true);
});

it("rejects an observation deadline before trading close", () => {
  const { s, a, g, m } = setup();
  expect(() =>
    s.createMarket(a.user.id, {
      groupId: g.id,
      question: "Will a value be observed before this market closes?",
      category: "Science",
      closeAt: "2030-01-03T00:00:00Z",
      b: 500,
      rules: { ...m.rules!, observationAt: "2030-01-02T00:00:00Z" },
    }),
  ).toThrow("observation");
});

it("normalizes authored refund promises into the fixed binary void policy before approval", () => {
  const { s, a, b, g, m } = setup();
  const draft = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will the published measurement exceed 10?",
    category: "Science",
    closeAt: "2030-01-03T00:00:00Z",
    b: 500,
    rules: {
      ...m.rules!,
      voidPolicy: "Refund each holder their original purchase cost.",
    },
  });
  expect(draft.rules!.voidPolicy).toContain("0.5 play credits per share");
  expect(draft.rules!.voidPolicy).toContain(
    "72 hours after the observation deadline",
  );
  expect(draft.rules!.voidPolicy).toContain(
    "48 hours after the challenge window ends",
  );
  const frozen = draft.rules!.voidPolicy;
  expect(s.approveMarket(b.user.id, draft.id).rules!.voidPolicy).toBe(frozen);
});
