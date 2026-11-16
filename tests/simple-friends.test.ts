import { afterEach, expect, it } from "vitest";
import { Store } from "../server/store";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup(join = true) {
  let time = Date.parse("2030-01-01T00:00:00Z");
  const s = new Store({ path: ":memory:", now: () => new Date(time) });
  stores.push(s);
  const a = s.register("alice", "correct horse battery"),
    b = s.register("bobby", "correct horse battery"),
    c = s.register("carol", "correct horse battery");
  const g = s.groups(a.user.id)[0]!;
  const token = s.invite(a.user.id, g.id, { uses: 2 }).token;
  if (join) s.redeem(b.user.id, token);
  return {
    s,
    a,
    b,
    c,
    g,
    advance: (ms: number) => {
      time += ms;
    },
    create: () =>
      s.createMarket(a.user.id, {
        groupId: g.id,
        question: "Pizza tonight?",
        closeAt: "2030-01-02T00:00:00Z",
      }),
    buy: (userId: string, marketId: string, extra = {}) =>
      s.execute(
        userId,
        {
          marketId,
          outcomeId: "yes",
          side: "BUY",
          quantity: 10,
          limitPrice: "0.9999",
          timeInForce: "IOC",
          ...extra,
        },
        crypto.randomUUID(),
      ),
  };
}
it("opens a simple private bet immediately without another member or resolution paperwork", () => {
  const { s, a, g, create, buy } = setup(false);
  const market = create();
  expect(market).toMatchObject({
    status: "OPEN",
    creatorId: a.user.id,
    resolverId: a.user.id,
    resolutionMode: "CREATOR",
    b: 100,
  });
  expect(buy(a.user.id, market.id).order.filledQuantity).toBe(10);
  expect(
    Number(s.groups(a.user.id).find((group) => group.id === g.id)!.treasury),
  ).toBeLessThan(100000);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("lets the creator settle their traded bet immediately and releases every cash/share lock exactly once", () => {
  const { s, a, b, create, buy } = setup(),
    m = create();
  buy(a.user.id, m.id);
  buy(b.user.id, m.id, { limitPrice: "0.1", timeInForce: "GTC" });
  s.execute(
    a.user.id,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "SELL",
      quantity: 3,
      limitPrice: "0.9",
      timeInForce: "GTC",
    },
    "locked-sale",
  );
  const before = s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!;
  const result = s.resolveFriendsBet(a.user.id, m.id, "yes");
  expect(result.status).toBe("RESOLVED");
  expect(result.resolution?.proposedBy).toBe(a.user.id);
  expect(
    s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.available,
  ).toBe((Number(before.available) + 10).toFixed(6));
  expect(s.orders(b.user.id).every((o) => o.status !== "OPEN")).toBe(true);
  expect(
    s.wallets(b.user.id).find((w) => w.groupId === m.groupId)!.locked,
  ).toBe("0.000000");
  const journal = s.db.prepare("SELECT count(*) AS n FROM journal").get();
  expect(s.resolveFriendsBet(a.user.id, m.id, "yes")).toEqual(result);
  expect(s.db.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    journal,
  );
  expect(() => s.resolveFriendsBet(a.user.id, m.id, "no")).toThrow(
    /settled|final/,
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("blocks ordinary members and nonmembers from settling but permits a group moderator", () => {
  const { s, a, b, c, g, create } = setup(),
    m = create();
  expect(() => s.resolveFriendsBet(b.user.id, m.id, "yes")).toThrow(
    /creator|owner|moderator/,
  );
  expect(() => s.resolveFriendsBet(c.user.id, m.id, "yes")).toThrow(
    /membership/,
  );
  s.changeMember(a.user.id, g.id, b.user.id, { role: "MODERATOR" });
  expect(s.resolveFriendsBet(b.user.id, m.id, "no").status).toBe("RESOLVED");
});
it("cancels with the published neutral payout without asking for evidence or a reason", () => {
  const { s, a, create, buy } = setup(),
    m = create();
  buy(a.user.id, m.id);
  const before = s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!;
  expect(s.resolveFriendsBet(a.user.id, m.id, null).status).toBe("VOID");
  expect(
    Number(
      s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.available,
    ) - Number(before.available),
  ).toBeCloseTo(5, 8);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("releases expired cash holds when reading a wallet without waiting for maintenance", () => {
  const { s, a, create, buy, advance } = setup(),
    m = create();
  buy(a.user.id, m.id, {
    limitPrice: "0.1",
    timeInForce: "GTD",
    expiresAt: "2030-01-01T00:00:01Z",
  });
  expect(
    s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.locked,
  ).toBe("1.000000");
  advance(2000);
  expect(
    s.wallets(a.user.id).find((w) => w.groupId === m.groupId)!.locked,
  ).toBe("0.000000");
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("keeps a simple bet available for the creator to resolve after the old review longstop", () => {
  const { s, a, create, buy, advance } = setup(),
    m = create();
  buy(a.user.id, m.id);
  advance(7 * 24 * 3600_000);
  s.tick();
  expect(s.market(a.user.id, m.id).status).toBe("CLOSED");
  expect(s.resolveFriendsBet(a.user.id, m.id, "yes").status).toBe("RESOLVED");
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("releases expired share holds when reading positions directly", () => {
  const { s, a, create, buy, advance } = setup(),
    m = create();
  buy(a.user.id, m.id);
  s.execute(
    a.user.id,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "SELL",
      quantity: 4,
      limitPrice: "0.9",
      timeInForce: "GTD",
      expiresAt: "2030-01-01T00:00:01Z",
    },
    "expiring-shares",
  );
  advance(1000);
  expect(s.positions(a.user.id)[0]).toMatchObject({ quantity: 10, locked: 0 });
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("rejects simple market creation atomically when its sponsor budget cannot fund the maker", () => {
  const { s, a, g, create } = setup();
  const admin = s.createAdmin("operator", "correct horse battery");
  s.adminAction(
    admin.user.id,
    { type: "TREASURY_ADJUSTMENT", targetId: g.id, amount: "-100000" },
    "empty-sponsor",
  );
  const before = s.db.prepare("SELECT count(*) AS n FROM journal").get();
  expect(create).toThrow(/fund|balance|credit/i);
  expect(s.markets(a.user.id, g.id)).toEqual([]);
  expect(s.db.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    before,
  );
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("lets a creator open an existing draft without requiring another approver and never funds it twice", () => {
  const { s, a, b, g, buy } = setup();
  const m = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will our team win tonight?",
    closeAt: "2030-01-02T00:00:00Z",
    rules: {
      condition: "Our team wins",
      source: "Old source",
      evidence: "Old evidence",
      observationAt: "2030-01-02T00:00:00Z",
      voidPolicy: "Neutral",
      disputeHours: 24,
      resolverId: b.user.id,
      reviewerIds: [],
    },
  });
  expect(m.status).toBe("DRAFT");
  const opened = s.openFriendsBet(a.user.id, m.id);
  expect(opened).toMatchObject({
    status: "OPEN",
    resolutionMode: "CREATOR",
    resolverId: a.user.id,
  });
  const entries = s.db.prepare("SELECT count(*) AS n FROM journal").get();
  s.openFriendsBet(a.user.id, m.id);
  expect(s.db.prepare("SELECT count(*) AS n FROM journal").get()).toEqual(
    entries,
  );
  expect(buy(a.user.id, m.id).order.filledQuantity).toBe(10);
  expect(s.reconcileSystem().balanced).toBe(true);
});
it("records creator control explicitly when settling an older reviewed bet", () => {
  const { s, a, b, g } = setup();
  const m = s.createMarket(a.user.id, {
    groupId: g.id,
    question: "Will our team win tonight?",
    closeAt: "2030-01-02T00:00:00Z",
    rules: {
      condition: "Our team wins",
      source: "Old source",
      evidence: "Old evidence",
      observationAt: "2030-01-02T00:00:00Z",
      voidPolicy: "Neutral",
      disputeHours: 24,
      resolverId: b.user.id,
      reviewerIds: [],
    },
  });
  s.changeMember(a.user.id, g.id, b.user.id, { role: "MODERATOR" });
  s.approveMarket(b.user.id, m.id);
  expect(s.resolveFriendsBet(a.user.id, m.id, "yes")).toMatchObject({
    resolutionMode: "CREATOR",
    resolverId: a.user.id,
  });
  const audit = s
    .moderationAudit(a.user.id, g.id)
    .find((row) => row.action === "RESOLVE_BET")!;
  expect(JSON.parse(audit.data).previous).toMatchObject({
    mode: "REVIEWED",
    resolverId: b.user.id,
  });
});
