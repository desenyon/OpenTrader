import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/store.js";
import { friendsHistory } from "../server/friends-history.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  let clock = new Date("2030-01-01T00:00:00Z");
  const store = new Store({ path: ":memory:", now: () => clock });
  stores.push(store);
  const owner = store.register("chartowner", "correct horse battery").user;
  const moderator = store.register(
    "chartmoderator",
    "correct horse battery",
  ).user;
  const resolver = store.register(
    "chartresolver",
    "correct horse battery",
  ).user;
  const group = store.groups(owner.id)[0]!;
  const invite = store.invite(owner.id, group.id, { uses: 2 }).token;
  store.redeem(moderator.id, invite);
  store.redeem(resolver.id, invite);
  store.changeMember(owner.id, group.id, moderator.id, { role: "MODERATOR" });
  const market = store.createMarket(owner.id, {
    groupId: group.id,
    question: "Will the published chart be correct?",
    category: "Science",
    closeAt: "2040-02-01T00:00:00Z",
    b: 500,
    rules: {
      condition: "Published result is true",
      source: "https://example.com/result",
      evidence: "Official result",
      observationAt: "2040-02-01T00:00:00Z",
      voidPolicy: "Neutral binary void",
      disputeHours: 24,
      resolverId: resolver.id,
      reviewerIds: [],
    },
  });
  store.approveMarket(moderator.id, market.id);
  const buy = (quantity = 100) =>
    store.execute(
      owner.id,
      {
        marketId: market.id,
        outcomeId: "yes",
        side: "BUY",
        quantity,
        limitPrice: "0.9999",
        timeInForce: "IOC",
      },
      crypto.randomUUID(),
    );
  return {
    store,
    owner,
    moderator,
    resolver,
    group,
    market,
    buy,
    setTime: (value: string) => {
      clock = new Date(value);
    },
  };
}

describe("authorized Friends chart history", () => {
  it("plots actual AMM state separately from executed average trade prices", () => {
    const { store, owner, market, buy, setTime } = fixture();
    expect(
      friendsHistory(store, owner.id, market.id, "yes", "1d", "amm"),
    ).toEqual([
      { time: 1893456000, open: 0.5, high: 0.5, low: 0.5, close: 0.5 },
    ]);
    expect(
      friendsHistory(store, owner.id, market.id, "yes", "1d", "trades"),
    ).toEqual([]);
    setTime("2030-01-01T00:01:30Z");
    buy();
    const amm = friendsHistory(store, owner.id, market.id, "yes", "1d", "amm");
    expect(amm).toHaveLength(2);
    expect(amm[1]!.close).toBeCloseTo(0.549833997312478, 12);
    expect(amm.every((candle) => candle.volume === undefined)).toBe(true);
    const trades = friendsHistory(
      store,
      owner.id,
      market.id,
      "yes",
      "1d",
      "trades",
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ time: 1893456060, volume: 100 });
    for (const key of ["open", "high", "low", "close"] as const)
      expect(trades[0]![key]).toBeCloseTo(0.52495845, 14);
    const no = friendsHistory(store, owner.id, market.id, "no", "1d", "amm");
    expect(no[1]!.close).toBeCloseTo(1 - amm[1]!.close, 12);
  });

  it("enforces the real group ACL before querying either chart series", () => {
    const { store, owner, moderator, group, market } = fixture();
    store.changeMember(owner.id, group.id, moderator.id, { status: "REMOVED" });
    for (const series of ["amm", "trades"] as const) {
      expect(() =>
        friendsHistory(store, moderator.id, market.id, "yes", "1d", series),
      ).toThrow("Active group membership");
    }
    expect(() =>
      friendsHistory(store, moderator.id, market.id, "yes", "invalid", "amm"),
    ).toThrow("Active group membership");
  });

  it("uses visible windows, excludes old observations and leaves gaps unfilled", () => {
    const { store, owner, market, buy, setTime } = fixture();
    setTime("2030-01-01T00:10:00Z");
    buy(10);
    setTime("2030-01-01T01:05:00Z");
    buy(10);
    setTime("2030-01-01T02:00:00Z");
    const hour = friendsHistory(store, owner.id, market.id, "yes", "1h", "amm");
    expect(hour.map((candle) => candle.time)).toEqual([1893459900]);
    expect(
      friendsHistory(store, owner.id, market.id, "yes", "6h", "amm"),
    ).toHaveLength(3);
    const week = friendsHistory(store, owner.id, market.id, "yes", "1w", "amm");
    expect(week.map((candle) => candle.time)).toEqual([1893456000, 1893459600]);
    const all = friendsHistory(store, owner.id, market.id, "yes", "max", "amm");
    expect(all.map((candle) => candle.time)).toEqual([1893456000, 1893459600]);
    expect(all[0]!.open).toBe(0.5);
    expect(all[0]!.high).toBeGreaterThan(0.5);
    expect(all.every((candle) => candle.volume === undefined)).toBe(true);
  });

  it("counts one executed peer lot once rather than duplicating its sell leg", () => {
    const { store, owner, moderator, market, buy, setTime } = fixture();
    buy(10);
    setTime("2030-01-01T00:02:00Z");
    store.execute(
      owner.id,
      {
        marketId: market.id,
        outcomeId: "yes",
        side: "SELL",
        quantity: 2,
        limitPrice: "0.5051",
        timeInForce: "GTC",
      },
      crypto.randomUUID(),
    );
    const receipt = store.execute(
      moderator.id,
      {
        marketId: market.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 2,
        limitPrice: "0.9999",
        timeInForce: "IOC",
      },
      crypto.randomUUID(),
    );
    expect(receipt.fills.some((fill) => fill.source === "PEER")).toBe(true);
    const candles = friendsHistory(
      store,
      owner.id,
      market.id,
      "yes",
      "1d",
      "trades",
    );
    expect(candles.reduce((sum, candle) => sum + (candle.volume ?? 0), 0)).toBe(
      12,
    );
  });

  it("rejects unknown outcome and timeframe values", () => {
    const { store, owner, market } = fixture();
    expect(() =>
      friendsHistory(store, owner.id, market.id, "wrong", "1d", "amm"),
    ).toThrow("outcome");
    for (const interval of ["wrong", "toString", "__proto__"])
      expect(() =>
        friendsHistory(store, owner.id, market.id, "yes", interval, "amm"),
      ).toThrow("window");
  });
});

describe("bounded event archive reads", () => {
  it("selects outcome identity from snapshots even when archived outcome ordering differs", () => {
    const { store, owner, market, setTime } = fixture();
    const snapshot = store.market(owner.id, market.id);
    snapshot.outcomes = [
      { id: "no", label: "NO", probability: 0.3 },
      { id: "yes", label: "YES", probability: 0.7 },
    ];
    store.db
      .prepare(
        "INSERT INTO market_events(market_id,sequence,transaction_id,type,data,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        market.id,
        100,
        "archive-fixture",
        "MARKET_BATCH",
        JSON.stringify(snapshot),
        "2030-01-01T00:01:00.000Z",
      );
    setTime("2030-01-01T00:02:00Z");
    expect(
      friendsHistory(store, owner.id, market.id, "yes", "1d", "amm")[1]!.close,
    ).toBe(0.7);
    expect(
      friendsHistory(store, owner.id, market.id, "no", "1d", "amm")[1]!.close,
    ).toBe(0.3);
  });

  it("returns at most the most recent 5000 real observed buckets from a large archive", () => {
    const { store, owner, market, setTime } = fixture();
    const snapshot = JSON.stringify(store.market(owner.id, market.id));
    const start = Date.parse("2030-01-01T00:00:00Z");
    const insert = store.db.prepare(
      "INSERT INTO market_events(market_id,sequence,transaction_id,type,data,created_at) VALUES(?,?,?,?,?,?)",
    );
    store.db.exec("BEGIN");
    for (let index = 0; index < 10_020; index++)
      insert.run(
        market.id,
        index + 100,
        "archive-fixture",
        "MARKET_BATCH",
        snapshot,
        new Date(start + index * 3_600_000).toISOString(),
      );
    store.db.exec("COMMIT");
    setTime(new Date(start + 10_020 * 3_600_000).toISOString());
    const result = friendsHistory(
      store,
      owner.id,
      market.id,
      "yes",
      "max",
      "amm",
    );
    expect(result).toHaveLength(5_000);
    expect(result[0]!.time).toBe(start / 1_000 + 5_020 * 3_600);
    expect(result.at(-1)!.time).toBe(start / 1_000 + 10_019 * 3_600);
    expect(result.every((candle) => candle.volume === undefined)).toBe(true);
  });
});
