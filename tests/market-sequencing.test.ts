import { afterEach, expect, it, vi } from "vitest";
const ids = vi.hoisted(() => ({ next: 281474976710655 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: () =>
    `ffffffff-ffff-4fff-8fff-${(ids.next--).toString(16).padStart(12, "0")}`,
}));
import { Store } from "../server/store";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  let time = Date.parse("2030-01-01T00:00:00Z"),
    drift = false;
  const s = new Store({
    path: ":memory:",
    now: () => new Date(drift ? ++time : time),
  });
  stores.push(s);
  const users = ["alice", "bob", "carol", "david", "edith", "frank"].map(
    (n) => s.register(n, "correct horse battery").user,
  );
  const g = s.groups(users[0]!.id)[0]!,
    token = s.invite(users[0]!.id, g.id, { uses: 10 }).token;
  users.slice(1).forEach((u) => s.redeem(u.id, token));
  s.changeMember(users[0]!.id, g.id, users[1]!.id, { role: "MODERATOR" });
  const m = s.createMarket(users[0]!.id, {
    groupId: g.id,
    question: "Will the measured value exceed five?",
    category: "Science",
    b: 500,
    closeAt: "2030-01-03T00:00:00Z",
    rules: {
      condition: "Measured value exceeds five",
      source: "https://example.com/result",
      evidence: "Official measured value",
      observationAt: "2030-01-03T00:00:00Z",
      voidPolicy: "Neutral 0.5",
      disputeHours: 24,
      resolverId: users[2]!.id,
      reviewerIds: [users[3]!.id, users[4]!.id],
    },
  });
  s.approveMarket(users[1]!.id, m.id);
  const order = (
    who: number,
    side: "BUY" | "SELL",
    quantity: number,
    limitPrice = "0.9999",
    timeInForce: "IOC" | "GTC" = "IOC",
  ) =>
    s.execute(
      users[who]!.id,
      {
        marketId: m.id,
        outcomeId: "yes",
        side,
        quantity,
        limitPrice,
        timeInForce,
      },
      crypto.randomUUID(),
    );
  return {
    s,
    users,
    g,
    m,
    order,
    drift: () => {
      drift = true;
    },
  };
}
it("fills equal-time, equal-price peers by arrival rather than random identifier", () => {
  const { s, users, order } = setup();
  order(0, "BUY", 10);
  order(1, "BUY", 10);
  const first = order(0, "SELL", 10, "0.6", "GTC").order,
    second = order(1, "SELL", 10, "0.6", "GTC").order;
  expect(first.createdAt).toBe(second.createdAt);
  expect(second.id < first.id).toBe(true);
  order(5, "BUY", 190);
  expect(
    s.orders(users[0]!.id).find((o) => o.id === first.id)!.filledQuantity,
  ).toBeGreaterThan(0);
  expect(
    s.orders(users[1]!.id).find((o) => o.id === second.id)!.filledQuantity,
  ).toBe(0);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("a full resting book does not block protected immediate trading", () => {
  const { s, order } = setup();
  const eligible = [0, 1, 3, 4, 5];
  for (const who of eligible)
    for (let i = 0; i < 20; i++) order(who, "BUY", 1, "0.0001", "GTC");
  const result = order(1, "BUY", 1);
  expect(result.order.filledQuantity).toBe(1);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("limits a single account resting allocation without blocking its immediate trades", () => {
  const { s, users, order } = setup();
  for (let i = 0; i < 20; i++) order(0, "BUY", 1, "0.0001", "GTC");
  const before = s.wallets(users[0]!.id);
  expect(() => order(0, "BUY", 1, "0.0001", "GTC")).toThrow(/20|resting/i);
  expect(s.wallets(users[0]!.id)).toEqual(before);
  expect(order(0, "BUY", 1).order.filledQuantity).toBe(1);
});
it("uses one command timestamp for all journal entries even while wall time advances", () => {
  const { s, order, drift } = setup();
  const before = (
    s.db.prepare("SELECT coalesce(max(id),0) AS id FROM journal").get() as {
      id: number;
    }
  ).id;
  drift();
  order(0, "BUY", 5);
  const rows = s.db
    .prepare("SELECT created_at FROM journal WHERE id>?")
    .all(before) as unknown as { created_at: string }[];
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);
});
