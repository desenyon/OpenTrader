import { afterEach, expect, it } from "vitest";
import { Store } from "../server/store";
import { units, money } from "../server/math";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function fixture() {
  let time = new Date("2030-01-01T00:00:00Z");
  const s = new Store({ path: ":memory:", now: () => time });
  stores.push(s);
  const users = ["operator", "alice", "bob", "carol", "david", "edith"].map(
    (name, i) =>
      i
        ? s.register(name, "correct horse battery")
        : s.createAdmin(name, "correct horse battery"),
  );
  const [admin, a, b, c, d, e] = users as [
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
    (typeof users)[number],
  ];
  const group = s.groups(a.user.id)[0]!,
    invite = s.invite(a.user.id, group.id, { uses: 10 }).token;
  [b, c, d, e].forEach((u) => s.redeem(u.user.id, invite));
  s.changeMember(a.user.id, group.id, b.user.id, { role: "MODERATOR" });
  const m = s.createMarket(a.user.id, {
    groupId: group.id,
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
  const buy = () =>
    s.execute(
      a.user.id,
      {
        marketId: m.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 100,
        limitPrice: "0.9999",
        timeInForce: "IOC",
      },
      crypto.randomUUID(),
    );
  return {
    s,
    admin,
    a,
    b,
    c,
    group,
    m,
    buy,
    setTime: (value: string) => {
      time = new Date(value);
    },
  };
}
it("detects a balanced but underfunded settlement escrow using microcredit liability", () => {
  const { s, a, m, buy, group } = fixture();
  buy();
  const state = JSON.parse(
    (s.db.prepare("SELECT data FROM state").get() as { data: string }).data,
  );
  const amount = BigInt(state.accounts["escrow:" + m.id]) - units("1");
  // Simulate an engine defect with a balanced journal movement, not projection corruption.
  s.atomic(() =>
    (
      s as unknown as {
        transfer: (
          a: string,
          b: string,
          c: bigint,
          d: string,
          e: string,
          f: string,
        ) => void;
      }
    ).transfer(
      "escrow:" + m.id,
      "treasury:" + group.id,
      amount,
      "cash",
      "FIXTURE_DRAIN",
      m.id,
    ),
  );
  expect(s.reconcileSystem()).toMatchObject({
    journalBalanced: true,
    projectionsMatch: true,
    inventoryMatches: true,
    escrowsSolvent: false,
    balanced: false,
  });
});
it("sell preview and execution agree when requested quantity exceeds unlocked holdings", () => {
  const { s, a, m, buy } = fixture();
  buy();
  const quote = s.quote(a.user.id, m.id, {
    outcomeId: "yes",
    side: "SELL",
    quantity: 101,
    limitPrice: "0.0001",
  });
  expect(quote.executable).toBe(false);
  expect(quote.reason).toMatch(/unlocked shares/i);
  expect(() =>
    s.execute(
      a.user.id,
      {
        marketId: m.id,
        outcomeId: "yes",
        side: "SELL",
        quantity: 101,
        limitPrice: "0.0001",
        timeInForce: "IOC",
      },
      "too-many",
    ),
  ).toThrow(/shares/i);
});
it("suspension releases resting locks, blocks sessions and still pays owned winning shares", () => {
  const { s, admin, a, c, group, m, buy, setTime } = fixture();
  buy();
  const before = s.wallets(a.user.id),
    wallet = before.find((w) => w.groupId === group.id)!;
  const resting = s.execute(
    a.user.id,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY",
      quantity: 100,
      limitPrice: "0.1",
      timeInForce: "GTC",
    },
    "resting",
  );
  expect(s.wallets(a.user.id).find((w) => w.id === wallet.id)!.locked).toBe(
    "10.000000",
  );
  s.adminAction(
    admin.user.id,
    {
      type: "ACCOUNT_STATUS",
      targetId: a.user.id,
      status: "SUSPENDED",
      reason: "Review account activity",
    },
    "suspend",
  );
  expect(s.bootstrap(a.user.id)).toMatchObject({
    user: { status: "SUSPENDED" },
    wallets: [],
    groups: [],
  });
  expect(
    s
      .adminReport(admin.user.id, "bets")
      .rows.find((r) => r.id === resting.order.id)?.status,
  ).toBe("CANCELLED");
  expect(() =>
    s.quote(a.user.id, m.id, { outcomeId: "yes", side: "BUY", quantity: 1 }),
  ).toThrow();
  setTime("2030-01-03T01:00:00Z");
  s.tick();
  s.propose(c.user.id, m.id, {
    outcomeId: "yes",
    evidence: "https://example.com/result",
    rationale: "Official measured value is 6",
  });
  setTime("2030-01-04T02:00:00Z");
  s.tick();
  const receipt = s
    .adminReport(admin.user.id, "settlements")
    .rows.find((r) => r.primary === "alice")!;
  expect(receipt.amount).toBe("100.000000");
  s.adminAction(
    admin.user.id,
    {
      type: "ACCOUNT_STATUS",
      targetId: a.user.id,
      status: "APPROVED",
      reason: "Account review completed",
    },
    "reactivate",
  );
  expect(s.wallets(a.user.id).find((w) => w.id === wallet.id)!.available).toBe(
    money(units(wallet.available) + units("100")),
  );
  expect(s.wallets(a.user.id).filter((w) => w.exchange === "LIVE")).toEqual(
    before.filter((w) => w.exchange === "LIVE"),
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("treasury reclaim cannot spend reserved market subsidy and pause cannot execute direct orders", () => {
  const { s, admin, a, group, m } = fixture();
  const free = s.groups(a.user.id).find((g) => g.id === group.id)!.treasury;
  expect(() =>
    s.adminAction(
      admin.user.id,
      {
        type: "TREASURY_ADJUSTMENT",
        targetId: group.id,
        amount: "-" + money(units(free) + 1n),
        reason: "Excessive reclaim attempt",
      },
      "too-much",
    ),
  ).toThrow();
  s.adminAction(
    admin.user.id,
    { type: "TRADING_PAUSE", paused: true, reason: "Maintenance and audit" },
    "pause",
  );
  expect(() =>
    s.execute(
      a.user.id,
      {
        marketId: m.id,
        outcomeId: "yes",
        side: "BUY",
        quantity: 1,
        limitPrice: "0.9",
        timeInForce: "IOC",
      },
      "paused-order",
    ),
  ).toThrow(/paused/i);
  s.adminAction(
    admin.user.id,
    { type: "TRADING_PAUSE", paused: false, reason: "Maintenance completed" },
    "resume",
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});

it("a platform admin outside a group can halt its market, release share locks and resume without changing supply", () => {
  const { s, admin, a, group, m, buy } = fixture();
  buy();
  expect(s.groups(admin.user.id).some((g) => g.id === group.id)).toBe(false);
  const sell = s.execute(
    a.user.id,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "SELL",
      quantity: 50,
      limitPrice: "0.95",
      timeInForce: "GTC",
    },
    "resting-sale",
  );
  expect(
    s.quote(a.user.id, m.id, {
      outcomeId: "yes",
      side: "SELL",
      quantity: 100,
      limitPrice: "0.0001",
    }).executable,
  ).toBe(false);
  s.adminAction(
    admin.user.id,
    {
      type: "HALT_MARKET",
      targetId: m.id,
      reason: "Review market content report",
    },
    "halt",
  );
  expect(
    s
      .adminReport(admin.user.id, "bets")
      .rows.find((r) => r.id === sell.order.id)!.status,
  ).toBe("CANCELLED");
  expect(
    s.adminReport(admin.user.id, "markets").rows.find((r) => r.id === m.id),
  ).toMatchObject({ exchange: "FRIENDS", status: "HALTED" });
  s.adminAction(
    admin.user.id,
    {
      type: "RESUME_MARKET",
      targetId: m.id,
      reason: "Content review completed",
    },
    "resume-market",
  );
  expect(
    s.quote(a.user.id, m.id, {
      outcomeId: "yes",
      side: "SELL",
      quantity: 100,
      limitPrice: "0.0001",
    }).executable,
  ).toBe(true);
  expect(s.reconcileSystem()).toMatchObject({
    balanced: true,
    locksMatch: true,
    inventoryMatches: true,
  });
});
it("operator order cancellation remains available during platform pause and preserves other wallets", () => {
  const { s, admin, a, group, m } = fixture();
  const before = s.wallets(a.user.id);
  const resting = s.execute(
    a.user.id,
    {
      marketId: m.id,
      outcomeId: "no",
      side: "BUY",
      quantity: 200,
      limitPrice: "0.1",
      timeInForce: "GTC",
    },
    "cash-lock",
  );
  s.adminAction(
    admin.user.id,
    {
      type: "TRADING_PAUSE",
      paused: true,
      reason: "Scheduled exchange maintenance",
    },
    "pause",
  );
  s.adminAction(
    admin.user.id,
    {
      type: "CANCEL_ORDER",
      targetId: resting.order.id,
      reason: "Release order during maintenance",
    },
    "cancel-order",
  );
  expect(s.wallets(a.user.id)).toEqual(before);
  expect(s.reconcileSystem().balanced).toBe(true);
});
