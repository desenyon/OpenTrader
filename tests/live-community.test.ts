import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Store } from "../server/store";
import { friendsHistory } from "../server/friends-history";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerRoutes } from "../server/routes";
import { probability } from "../server/math";
import type { Market, OrderBook, OrderInput } from "../shared/types";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup(options: { path?: string; liveCommunity?: boolean } = {}) {
  let time = Date.parse("2030-01-01T00:00:00Z");
  const s = new Store({
    path: ":memory:",
    now: () => new Date(time),
    liveCommunity: true,
    ...options,
  });
  stores.push(s);
  const a = s.register("alice", "correct horse battery").user,
    b = s.register("bravo", "correct horse battery").user;
  const market: Market = {
    id: "poly:community",
    exchange: "LIVE",
    provider: "polymarket",
    groupId: null,
    question: "Will the observed measurement exceed five?",
    description:
      "Official measured value above five at the observation deadline.",
    category: "Science",
    outcomes: [
      { id: "yes", label: "Yes", probability: 0.63 },
      { id: "no", label: "No", probability: 0.37 },
    ],
    status: "OPEN",
    volume: 10000,
    liquidity: 10000,
    closeAt: "2030-01-02T00:00:00Z",
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(time).toISOString(),
    sequence: 0,
  };
  const book: OrderBook = {
    marketId: market.id,
    outcomeId: "yes",
    timestamp: new Date(time).toISOString(),
    stale: false,
    source: "provider",
    hash: "source-1",
    bids: [{ price: 0.62, quantity: 1000, source: "EXTERNAL" }],
    asks: [{ price: 0.64, quantity: 1000, source: "EXTERNAL" }],
  };
  const order: OrderInput = {
    marketId: market.id,
    outcomeId: "yes",
    side: "BUY",
    quantity: 100,
    limitPrice: "0.9999",
    timeInForce: "IOC",
    engineVersion: 2,
  };
  return {
    s,
    a,
    b,
    market,
    book,
    order,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
it("uses source opening odds, makes credit buys move our price and leaves quote previews financially read-only", () => {
  const { s, a, market, book, order } = setup();
  const journal = s.db.prepare("SELECT count(*) AS n FROM journal").get();
  const q = s.quoteLive(a.id, market, book, { ...order });
  expect(q.afterProbability).toBeGreaterThan(0.63);
  expect(s.db.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    journal,
  );
  const result = s.executeLive(a.id, market, book, order, "first-credit-buy");
  expect(result.fills.every((f) => f.source === "AMM")).toBe(true);
  expect(s.market(a.id, market.id).executionModel).toBe("SOURCE_SEEDED_LMSR");
  expect(s.market(a.id, market.id).outcomes[0]!.probability).toBeCloseTo(
    probability([100, 0], 500, 0, [630000, 370000]),
    12,
  );
  expect(s.wallets(a.id).find((w) => w.exchange === "FRIENDS")!.available).toBe(
    "10000.000000",
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("keeps local inventory and its frozen prior when source odds refresh", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "impact-before-refresh");
  const p = s.market(a.id, market.id).outcomes[0]!.probability;
  s.syncLiveMarket({
    ...market,
    outcomes: [
      { ...market.outcomes[0]!, probability: 0.25 },
      { ...market.outcomes[1]!, probability: 0.75 },
    ],
  });
  const actual = s.market(a.id, market.id);
  expect(actual.outcomes[0]!.probability).toBe(p);
  expect(actual.reference!.outcomes[0]!.probability).toBe(0.25);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("routes peer transfers and AMM fills together without issuing shares for peer transfers", () => {
  const { s, a, b, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "initial-shares");
  s.executeLive(
    a.id,
    market,
    book,
    {
      ...order,
      side: "SELL",
      quantity: 10,
      limitPrice: "0.70",
      timeInForce: "GTC",
    },
    "resting-peer-sale",
  );
  const result = s.executeLive(b.id, market, book, order, "mixed-liquidity");
  expect(
    result.fills
      .filter((f) => f.source === "PEER")
      .reduce((sum, f) => sum + f.quantity, 0),
  ).toBe(10);
  expect(s.market(a.id, market.id).outcomes[0]!.probability).toBeCloseTo(
    probability([190, 0], 500, 0, [630000, 370000]),
    12,
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("settles winning shares from backed escrow and releases resting locks at the source final result", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "settled-purchase");
  s.executeLive(
    a.id,
    market,
    book,
    { ...order, quantity: 20, limitPrice: "0.1", timeInForce: "GTC" },
    "locked-before-final",
  );
  const before = s.wallets(a.id).find((w) => w.exchange === "LIVE")!;
  s.syncLiveMarket({
    ...market,
    status: "RESOLVED",
    resolution: {
      id: "source-final",
      outcomeId: "yes",
      evidence: "https://example.com/final",
      rationale: "Verified final source result",
      proposedBy: "polymarket",
      proposedAt: market.updatedAt,
      disputeUntil: market.updatedAt,
      state: "FINAL",
      disputes: [],
      reviews: [],
    },
  });
  const after = s.wallets(a.id).find((w) => w.exchange === "LIVE")!;
  expect(after.locked).toBe("0.000000");
  expect(Number(after.available)).toBeCloseTo(
    Number(before.available) + Number(before.locked) + 100,
    6,
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("rejects stale source data without moving funds or opening an unbacked market", () => {
  const { s, a, market, book, order, advance } = setup();
  const before = s.wallets(a.id);
  advance(6000);
  expect(() =>
    s.executeLive(a.id, market, book, order, "stale-credit-buy"),
  ).toThrow(/five seconds|stale/i);
  expect(s.wallets(a.id)).toEqual(before);
  expect(s.reconcileSystem().balanced).toBe(true);
});

it("halts trading after source rules change but permits a verified final result against the original rules", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "rules-original-buy");
  s.executeLive(
    a.id,
    market,
    book,
    { ...order, quantity: 2, limitPrice: "0.1", timeInForce: "GTC" },
    "rules-resting-buy",
  );
  s.syncLiveMarket({
    ...market,
    description: "A changed observation condition",
  });
  expect(s.market(a.id, market.id).status).toBe("HALTED");
  expect(s.orders(a.id).every((o) => o.status !== "OPEN")).toBe(true);
  s.syncLiveMarket({
    ...market,
    status: "RESOLVED",
    resolution: {
      id: "final-original",
      outcomeId: "yes",
      evidence: "https://example.com/final",
      rationale: "Final under original rules",
      proposedBy: "polymarket",
      proposedAt: market.updatedAt,
      disputeUntil: market.updatedAt,
      state: "FINAL",
      disputes: [],
      reviews: [],
    },
  });
  expect(s.market(a.id, market.id).status).toBe("RESOLVED");
  expect(s.positions(a.id)[0]!.quantity).toBe(0);
  expect(s.reconcileSystem().balanced).toBe(true);
});

it("records only the frozen starting prior and local prices in the OpenTrader AMM chart", () => {
  const { s, a, market, book, order } = setup();
  market.outcomes[0]!.probability = 0.8;
  market.outcomes[1]!.probability = 0.2;
  s.quoteLive(a.id, market, book, order);
  s.executeLive(a.id, market, book, order, "chart-activation");
  const chart = friendsHistory(s, a.id, market.id, "yes", "1d", "amm");
  expect(chart).toHaveLength(1);
  expect(chart[0]!.open).toBeCloseTo(0.63, 12);
  expect(chart[0]!.high).toBeLessThan(0.7);
});

it("atomically rolls back reserve activation and all fills when a protected order cannot be honored", () => {
  const { s, a, market, book, order } = setup();
  const q = s.quoteLive(a.id, market, book, order);
  const wallet = s.wallets(a.id),
    journal = s.db.prepare("SELECT count(*) AS n FROM journal").get();
  expect(() =>
    s.executeLive(
      a.id,
      market,
      book,
      {
        ...order,
        maxTotalCost: (Number(q.estimatedCash) - 0.000001).toFixed(6),
      },
      "under-by-one-micro",
    ),
  ).toThrow(/maximum/);
  expect(s.wallets(a.id)).toEqual(wallet);
  expect(s.db.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    journal,
  );
  expect(s.market(a.id, market.id).pricing).toBeUndefined();
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("binds initial quotes to the source prior and rejects changed opening odds before allocating reserves", () => {
  const { s, a, market, book, order } = setup();
  const q = s.quoteLive(a.id, market, book, order);
  const changed = {
    ...book,
    bids: [{ price: 0.42, quantity: 1000, source: "EXTERNAL" as const }],
    asks: [{ price: 0.44, quantity: 1000, source: "EXTERNAL" as const }],
  };
  expect(() =>
    s.executeLive(
      a.id,
      market,
      changed,
      { ...order, quoteId: q.id },
      "changed-prior",
    ),
  ).toThrow(/opening odds changed/);
  expect(s.positions(a.id)).toEqual([]);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("does not reopen a locally closed market or run Friends longstop voids on pending provider results", () => {
  const { s, a, market, book, order, advance } = setup();
  s.executeLive(a.id, market, book, order, "before-close");
  s.executeLive(
    a.id,
    market,
    book,
    { ...order, quantity: 10, limitPrice: "0.1", timeInForce: "GTC" },
    "deadline-lock",
  );
  advance(5 * 24 * 3600_000);
  s.tick();
  expect(s.market(a.id, market.id).status).toBe("CLOSED");
  expect(s.wallets(a.id).find((w) => w.exchange === "LIVE")!.locked).toBe(
    "0.000000",
  );
  s.syncLiveMarket(market);
  expect(s.market(a.id, market.id).status).toBe("CLOSED");
  expect(s.positions(a.id)[0]!.quantity).toBe(100);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("preserves outcome order across source reorderings and halts changed outcome identifiers", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "ordered-outcomes");
  const p = s.market(a.id, market.id).outcomes[0]!.probability;
  s.syncLiveMarket({ ...market, outcomes: [...market.outcomes].reverse() });
  expect(s.market(a.id, market.id).outcomes[0]!.id).toBe("yes");
  expect(s.market(a.id, market.id).outcomes[0]!.probability).toBe(p);
  s.syncLiveMarket({
    ...market,
    outcomes: [
      { ...market.outcomes[0]!, assetId: "different-position" },
      market.outcomes[1]!,
    ],
  });
  expect(s.market(a.id, market.id).status).toBe("HALTED");
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("limits per-account activations without preventing trades in an existing market", () => {
  const { s, a, b, market, book, order } = setup();
  for (let i = 0; i < 5; i++) {
    const m = { ...market, id: market.id + i };
    s.executeLive(
      a.id,
      m,
      { ...book, marketId: m.id },
      { ...order, marketId: m.id, quantity: 1 },
      "activate-" + i,
    );
  }
  const m = { ...market, id: market.id + "six" };
  expect(() =>
    s.executeLive(
      a.id,
      m,
      { ...book, marketId: m.id },
      { ...order, marketId: m.id, quantity: 1 },
      "sixth-activation",
    ),
  ).toThrow(/five unsettled/);
  const existing = { ...market, id: market.id + "0" };
  expect(
    s.executeLive(
      b.id,
      existing,
      { ...book, marketId: existing.id },
      { ...order, marketId: existing.id, quantity: 1 },
      "other-account-existing",
    ).fills[0]!.source,
  ).toBe("AMM");
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("marks stale curve liquidation unavailable even while its indicative price remains visible", () => {
  const { s, a, market, book, order, advance } = setup();
  s.executeLive(a.id, market, book, order, "stale-position");
  advance(6000);
  expect(s.positions(a.id)[0]).toMatchObject({
    quantity: 100,
    liquidationAvailable: false,
    valuationNote: expect.stringMatching(/stale/),
  });
});
it("shares aggregate local trade history while preserving anonymous trading identities", () => {
  const { s, a, b, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "shared-history");
  expect(friendsHistory(s, a.id, market.id, "yes", "1d", "trades")).toEqual(
    friendsHistory(s, b.id, market.id, "yes", "1d", "trades"),
  );
  expect(s.fills(b.id, market.id)).toHaveLength(1);
  expect(JSON.stringify(s.fills(b.id, market.id))).not.toContain(a.id);
});
it("exposes finite Live sponsor budget to admins without permitting reclaim of funded market escrow", () => {
  const { s, a, market, book, order } = setup(),
    admin = s.createAdmin("operator", "correct horse battery").user;
  s.executeLive(a.id, market, book, order, "funded-escrow");
  const pool = s
    .adminReport(admin.id, "treasuries")
    .rows.find((r) => r.scope === "Live")!;
  expect(pool).toBeDefined();
  s.adminAction(
    admin.id,
    {
      type: "TREASURY_ADJUSTMENT",
      targetId: pool.id,
      amount: "-" + pool.amount,
    },
    "drain-free-pool",
  );
  expect(s.reconcileSystem().balanced).toBe(true);
  const next = { ...market, id: "poly:no-free-budget" };
  expect(() =>
    s.executeLive(
      a.id,
      next,
      { ...book, marketId: next.id },
      { ...order, marketId: next.id },
      "unfunded-new-market",
    ),
  ).toThrow(/budget/);
  expect(
    s.executeLive(
      a.id,
      market,
      book,
      { ...order, quantity: 1 },
      "existing-funded-market",
    ).order.filledQuantity,
  ).toBe(1);
});

it("preserves traded legacy markets through an upgrade while new markets use the funded engine", () => {
  const { s, a, market, book, order } = setup({ liveCommunity: false });
  s.executeLive(
    a.id,
    market,
    book,
    { ...order, engineVersion: 1 },
    "legacy-buy",
  );
  const directory = mkdtempSync(join(tmpdir(), "opentrader-legacy-")),
    path = join(directory, "test.sqlite");
  try {
    // SQLite's backup API retains the actual immutable journal and projections.
    s.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const upgraded = new Store({
      path,
      now: () => new Date(market.createdAt),
      liveCommunity: true,
    });
    stores.push(upgraded);
    expect(upgraded.market(a.id, market.id).executionModel).toBe(
      "EXTERNAL_SIM",
    );
    const result = upgraded.executeLive(
      a.id,
      market,
      book,
      { ...order, engineVersion: 1 },
      "legacy-after-upgrade",
    );
    expect(result.fills.every((f) => f.source === "EXTERNAL")).toBe(true);
    expect(upgraded.positions(a.id)[0]!.quantity).toBe(200);
    expect(upgraded.reconcileSystem().balanced).toBe(true);
    upgraded.close();
    stores.splice(stores.indexOf(upgraded), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("persists local inventory, frozen prior, budget issuance and receipt replay across two connections and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentrader-curve-")),
    path = join(directory, "test.sqlite");
  const { s, a, market, book, order } = setup({ path });
  let other: Store | undefined;
  try {
    const first = s.executeLive(a.id, market, book, order, "durable-receipt"),
      p = s.market(a.id, market.id).outcomes[0]!.probability;
    other = new Store({
      path,
      now: () => new Date(market.createdAt),
      liveCommunity: false,
    });
    expect(other.market(a.id, market.id).outcomes[0]!.probability).toBe(p);
    expect(
      other.executeLive(a.id, market, book, order, "durable-receipt"),
    ).toEqual(first);
    other.close();
    other = new Store({
      path,
      now: () => new Date(market.createdAt),
      liveCommunity: true,
    });
    expect(
      (
        other.db
          .prepare(
            "SELECT count(*) AS n FROM journal WHERE account=? AND reason='FINITE_LIVE_LIQUIDITY_BUDGET'",
          )
          .get("treasury:live-liquidity:live-1") as { n: number }
      ).n,
    ).toBe(1);
    other.executeLive(
      a.id,
      market,
      book,
      { ...order, quantity: 1 },
      "second-connection",
    );
    expect(s.positions(a.id)[0]!.quantity).toBe(101);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    other?.close();
    s.close();
    stores.splice(stores.indexOf(s), 1);
    rmSync(directory, { recursive: true, force: true });
  }
});
it("serializes competing processes without overspending, duplicate reserve funding or duplicate idempotent trades", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opentrader-concurrency-")),
    path = join(directory, "test.sqlite");
  const { s, a, market, book, order } = setup({ path });
  const admin = s.createAdmin("operator", "correct horse battery").user;
  const wallet = s.wallets(a.id).find((w) => w.exchange === "LIVE")!;
  s.adminAction(
    admin.id,
    { type: "WALLET_ADJUSTMENT", targetId: wallet.id, amount: "-9999" },
    "only-one-credit",
  );
  const fixture = join(directory, "fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      path,
      userId: a.id,
      market,
      book,
      order: { ...order, quantity: 1, minFillQuantity: 1 },
    }),
  );
  const code = `import {readFileSync} from 'node:fs'; import {Store} from ${JSON.stringify(pathToFileURL(resolve("server/store.ts")).href)};
 const f=JSON.parse(readFileSync(process.argv[1],'utf8')); const s=new Store({path:f.path,liveCommunity:true,now:()=>new Date(f.market.createdAt)});
 console.log('ready'); process.stdin.once('data',()=>{const results=[];for(let i=0;i<10;i++){try{results.push({id:s.executeLive(f.userId,f.market,f.book,f.order,i===0?'shared-racing-key':process.pid+'-race-'+i).order.id})}catch(e){results.push({error:e.code})}}s.close();console.log(JSON.stringify(results));process.stdin.destroy();});`;
  const children = Array.from({ length: 3 }, () =>
    spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code, fixture],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  try {
    const ready: Promise<void>[] = [],
      finished: Promise<{ id?: string; error?: string }[]>[] = [];
    for (const child of children) {
      let stderr = "",
        output: { id?: string; error?: string }[] = [];
      let markReady!: () => void;
      ready.push(
        new Promise((r) => {
          markReady = r;
        }),
      );
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (line === "ready") markReady();
        else output = JSON.parse(line);
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      finished.push(
        new Promise((res, rej) => {
          child.on("error", rej);
          child.on("exit", (status) =>
            status === 0 ? res(output) : rej(new Error(stderr)),
          );
        }),
      );
    }
    await Promise.all(ready);
    children.forEach((child) => child.stdin.write("run\n"));
    const results = (await Promise.all(finished)).flat();
    expect(new Set(results.flatMap((r) => (r.id ? [r.id] : []))).size).toBe(1);
    expect(results.filter((r) => r.id)).toHaveLength(3);
    expect(results.filter((r) => r.error)).toHaveLength(27);
    expect(s.positions(a.id)[0]!.quantity).toBe(1);
    expect(
      Number(s.wallets(a.id).find((w) => w.exchange === "LIVE")!.available),
    ).toBeGreaterThanOrEqual(0);
    expect(
      (
        s.db
          .prepare(
            "SELECT count(*) AS n FROM journal WHERE reason='LIVE_MARKET_RESERVE'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(2);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    children.forEach((c) => c.kill());
    s.close();
    stores.splice(stores.indexOf(s), 1);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps the list, detail, local book, charts, limit orders and positions on the same HTTP execution model", async () => {
  const { s, a, market, book, order } = setup();
  const app = Fastify();
  await app.register(cookie);
  const sourceHistory = [
    { time: 1893456000, open: 0.2, high: 0.2, low: 0.2, close: 0.2 },
  ];
  await registerRoutes(app, s, {
    liveEnabled: true,
    providers: {
      listMarkets: async () => [market],
      getMarket: async () => market,
      getBook: async () => book,
      getHistory: async () => sourceHistory,
    },
  });
  try {
    const headers = {
      cookie: `session=${s.login(a.handle, "correct horse battery").token}`,
    };
    const preview = await app.inject({
      method: "POST",
      url: `/api/markets/${market.id}/quote`,
      headers,
      payload: order,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const q = preview.json();
    expect(q.engineVersion).toBe(2);
    const body = {
      ...order,
      quoteId: q.id,
      expectedSequence: q.sequence,
      maxTotalCost: q.estimatedCash,
    };
    const filled = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { ...headers, "idempotency-key": "http-curve-fill" },
      payload: body,
    });
    expect(filled.statusCode, filled.body).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { ...headers, "idempotency-key": "http-curve-fill" },
      payload: body,
    });
    expect(replay.json()).toEqual(filled.json());
    const listing = await app.inject("/api/markets?exchange=LIVE"),
      detail = await app.inject(`/api/markets/${market.id}`);
    expect(listing.json()[0].outcomes).toEqual(detail.json().outcomes);
    expect(detail.json().outcomes[0].probability).toBeGreaterThan(0.63);
    expect(detail.json().reference.outcomes[0].probability).toBe(0.63);
    expect(detail.json().q).toBeUndefined();
    expect(detail.json().curve).toBeUndefined();
    const depth = await app.inject(
      `/api/markets/${market.id}/book?outcomeId=yes`,
    );
    expect(depth.statusCode, depth.body).toBe(200);
    expect(depth.json().asks[0].source).toBe("AMM");
    expect(depth.json().timestamp).toBe(book.timestamp);
    const history = await app.inject({
      url: `/api/markets/${market.id}/history?outcomeId=yes&series=amm`,
      headers,
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json()[0].open).toBe(0.63);
    const reference = await app.inject({
      url: `/api/markets/${market.id}/history?outcomeId=yes&series=reference`,
      headers,
    });
    expect(reference.json()).toEqual(sourceHistory);
    const resting = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { ...headers, "idempotency-key": "http-resting" },
      payload: {
        ...order,
        side: "SELL",
        quantity: 10,
        limitPrice: "0.7",
        timeInForce: "GTC",
      },
    });
    expect(resting.statusCode, resting.body).toBe(200);
    expect(resting.json().order.status).toBe("OPEN");
    const positions = await app.inject({
      url: "/api/positions?exchange=LIVE",
      headers,
    });
    expect(positions.statusCode, positions.body).toBe(200);
    expect(positions.json()[0]).toMatchObject({
      quantity: 100,
      locked: 10,
      markPrice: detail.json().outcomes[0].probability,
    });
    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/orders/${resting.json().order.id}`,
      headers,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    await app.close();
  }
});
it("detects a corrupted prior even when cash, share supply and escrow projections still balance", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "integrity-baseline");
  const raw = JSON.parse(
    (s.db.prepare("SELECT data FROM state").get() as { data: string }).data,
  );
  raw.markets[market.id].curve.prior = [500000, 500000];
  s.db.prepare("UPDATE state SET data=? WHERE id=1").run(JSON.stringify(raw));
  expect(s.reconcileSystem()).toMatchObject({
    balanced: false,
    riskReservesMatch: false,
    journalBalanced: true,
    projectionsMatch: true,
    inventoryMatches: true,
    escrowsSolvent: true,
  });
});
it.each(["yes", "no", null])(
  "settles both outcome supplies with exactly the published winning/void payout (%s)",
  (outcomeId) => {
    const { s, a, market, book, order } = setup();
    s.executeLive(a.id, market, book, order, "two-outcome-yes");
    s.executeLive(
      a.id,
      market,
      {
        ...book,
        outcomeId: "no",
        bids: [{ price: 0.36, quantity: 1000, source: "EXTERNAL" }],
        asks: [{ price: 0.38, quantity: 1000, source: "EXTERNAL" }],
      },
      { ...order, outcomeId: "no" },
      "two-outcome-no",
    );
    const before = s.wallets(a.id).find((w) => w.exchange === "LIVE")!;
    s.syncLiveMarket({
      ...market,
      status: outcomeId === null ? "VOID" : "RESOLVED",
      resolution: {
        id: "final-both",
        outcomeId,
        evidence: "https://example.com/final",
        rationale: "Published final outcome",
        proposedBy: "polymarket",
        proposedAt: market.updatedAt,
        disputeUntil: market.updatedAt,
        state: "FINAL",
        disputes: [],
        reviews: [],
      },
    });
    expect(
      Number(s.wallets(a.id).find((w) => w.exchange === "LIVE")!.available) -
        Number(before.available),
    ).toBeCloseTo(100, 8);
    expect(s.positions(a.id).every((p) => p.quantity === 0)).toBe(true);
    expect(s.reconcileSystem()).toMatchObject({
      balanced: true,
      riskReservesMatch: true,
    });
    expect(
      (
        s.db
          .prepare("SELECT delta FROM journal WHERE account=?")
          .all("escrow:" + market.id) as unknown as { delta: string }[]
      ).reduce((sum, r) => sum + BigInt(r.delta), 0n),
    ).toBe(0n);
  },
);
it("advances the initial public sequence even when the first order activates an unseen market", () => {
  const { s, a, market, book, order } = setup();
  const first = s.executeLive(
    a.id,
    market,
    book,
    { ...order, expectedSequence: 0 },
    "initial-sequence",
  );
  expect(first.sequence).toBe(1);
  expect(() =>
    s.executeLive(
      a.id,
      market,
      book,
      { ...order, expectedSequence: 0 },
      "stale-initial-sequence",
    ),
  ).toThrow(/Market changed/);
  expect(s.positions(a.id)[0]!.quantity).toBe(100);
});
it("rejects execution at the exact source deadline regardless of ISO fractional-second formatting", () => {
  const { s, a, market, book, order, advance } = setup();
  advance(24 * 3600_000);
  expect(() =>
    s.executeLive(
      a.id,
      market,
      { ...book, timestamp: s.now() },
      order,
      "at-source-deadline",
    ),
  ).toThrow(/deadline|closed|not open/);
  expect(s.positions(a.id)).toEqual([]);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("rejects malformed source-price precision after activation without touching credits", () => {
  const { s, a, market, book, order } = setup();
  s.executeLive(a.id, market, book, order, "precision-seed");
  const before = s.wallets(a.id);
  expect(() =>
    s.executeLive(
      a.id,
      market,
      {
        ...book,
        bids: [{ price: 0.1234567, quantity: 100, source: "EXTERNAL" }],
      },
      order,
      "bad-source-precision",
    ),
  ).toThrow(/precision|decimal/);
  expect(s.wallets(a.id)).toEqual(before);
  expect(s.reconcileSystem().balanced).toBe(true);
});
