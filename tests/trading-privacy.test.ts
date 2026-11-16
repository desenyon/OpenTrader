import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "../server/store";
import { createApp } from "../server/app";
const stores: Store[] = [];
const password = "correct horse battery staple";
const make = () => {
  const s = new Store({
    path: ":memory:",
    now: () => new Date("2030-01-01T00:00:00Z"),
  });
  stores.push(s);
  return s;
};
afterEach(() =>
  stores.splice(0).forEach((s) => {
    try {
      s.close();
    } catch {}
  }),
);
it("accepts reason-free operator actions while preserving audit, repeat safety and authorization", async () => {
  const s = make(),
    admin = s.createAdmin("operator", password),
    member = s.register("member", password);
  const app = await createApp({
    store: s,
    liveEnabled: false,
    serveStatic: false,
  });
  try {
    const headers = {
      cookie: `session=${admin.token}`,
      "idempotency-key": "no-reason",
    };
    const payload = {
      type: "WALLET_ADJUSTMENT",
      targetId: s.wallets(member.user.id)[0]!.id,
      amount: "12.000001",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers,
      payload,
    });
    expect(replay.json()).toEqual(first.json());
    expect(s.wallets(member.user.id)[0]!.available).toBe("10012.000001");
    const audit = s
      .adminReport(admin.user.id, "audit")
      .rows.find((r) => r.status === "WALLET_ADJUSTMENT")!;
    expect(audit.primary).toBe("operator");
    expect(audit.secondary).toBeTruthy();
    expect(audit.detail).toContain(payload.targetId);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/actions",
          headers: { ...headers, cookie: `session=${member.token}` },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    await app.close();
  }
});
it("persists an opt-in anonymous trading preference through registration, approval and login", async () => {
  const s = make(),
    admin = s.createAdmin("operator", password),
    app = await createApp({ store: s, liveEnabled: false, serveStatic: false });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "quietmember", password, anonymousTrading: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().user).toMatchObject({
      handle: "quietmember",
      anonymousTrading: true,
      status: "PENDING",
    });
    expect(JSON.stringify(response.json()).includes("anonymitySeed")).toBe(
      false,
    );
    s.adminAction(
      admin.user.id,
      {
        type: "ACCOUNT_STATUS",
        targetId: response.json().user.id,
        status: "APPROVED",
      },
      "approve",
    );
    expect(s.login("quietmember", password).user).toMatchObject({
      anonymousTrading: true,
      status: "APPROVED",
    });
    expect(
      s
        .adminReport(admin.user.id, "users")
        .rows.find((r) => r.id === response.json().user.id)?.primary,
    ).toBe("quietmember");
  } finally {
    await app.close();
  }
});
it("hides trading identity and account IDs from peers while admin reports retain attribution", () => {
  const s = make(),
    admin = s.createAdmin("operator", password),
    owner = s.register("owner", password),
    anon = s.register("quiettrader", password, { anonymousTrading: true });
  const [moderator, resolver, reviewer1, reviewer2] = [
    "moderator",
    "resolver",
    "reviewerone",
    "reviewertwo",
  ].map((handle) => s.register(handle, password));
  const group = s.groups(owner.user.id)[0]!,
    token = s.invite(owner.user.id, group.id, { uses: 10 }).token;
  for (const u of [anon, moderator!, resolver!, reviewer1!, reviewer2!])
    s.redeem(u.user.id, token);
  s.changeMember(owner.user.id, group.id, moderator!.user.id, {
    role: "MODERATOR",
  });
  const m = s.createMarket(owner.user.id, {
    groupId: group.id,
    question: "Will the measured value exceed five?",
    category: "Science",
    b: 500,
    closeAt: "2030-01-03T00:00:00Z",
    rules: {
      condition: "Published measured value above 5",
      source: "https://example.com/result",
      evidence: "Official measured value",
      observationAt: "2030-01-03T00:00:00Z",
      voidPolicy: "Neutral 0.5 if unresolvable",
      disputeHours: 24,
      resolverId: resolver!.user.id,
      reviewerIds: [reviewer1!.user.id, reviewer2!.user.id],
    },
  });
  s.approveMarket(moderator!.user.id, m.id);
  const order = s.execute(
    anon.user.id,
    {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY",
      quantity: 10,
      limitPrice: "0.9999",
      timeInForce: "IOC",
    },
    "anonymous-order",
  );
  const publicFill = s.fills(owner.user.id, m.id)[0]!;
  expect(publicFill.handle).toMatch(/^Anonymous-/);
  expect(JSON.stringify(publicFill)).not.toContain("quiettrader");
  const rank = s
    .leaderboard(owner.user.id, "FRIENDS", group.id)
    .find((r) => r.tradeCount === 1)!;
  expect(rank.handle).toBe(publicFill.handle);
  expect(rank.userId).not.toBe(anon.user.id);
  expect(rank.joinedAt).toBeUndefined();
  expect(
    s
      .leaderboard(owner.user.id, "FRIENDS", group.id)
      .find((r) => r.handle === "owner")!.userId,
  ).toBe(owner.user.id);
  const secondGroup = s.groups(anon.user.id)[0]!,
    secondAlias = s.leaderboard(anon.user.id, "FRIENDS", secondGroup.id)[0]!
      .handle;
  expect(secondAlias).toMatch(/^Anonymous-/);
  expect(secondAlias).not.toBe(publicFill.handle);
  expect(
    s
      .adminReport(admin.user.id, "bets")
      .rows.find((r) => r.id === order.order.id)!.primary,
  ).toBe("quiettrader");
  expect(s.fills(owner.user.id, m.id)[0]!.handle).toBe(publicFill.handle);
  expect(s.reconcileSystem().balanced).toBe(true);
});

it("does not reveal anonymous ranking identities through membership enumeration order", () => {
  const s = make(),
    owner = s.register("owner", password),
    a = s.register("quietalpha", password, { anonymousTrading: true }),
    b = s.register("quietbravo", password, { anonymousTrading: true });
  const group = s.groups(owner.user.id)[0]!,
    token = s.invite(owner.user.id, group.id, { uses: 5 }).token;
  s.redeem(a.user.id, token);
  s.redeem(b.user.id, token);
  const aliases = () =>
    s
      .leaderboard(owner.user.id, "FRIENDS", group.id)
      .filter((r) => r.userId.startsWith("anonymous:"))
      .map((r) => r.userId);
  const before = aliases();
  expect(before).toHaveLength(2);
  // Reorder only the fixture's membership enumeration; balances, identities and join dates are unchanged.
  const state = JSON.parse(
    (
      s.db.prepare("SELECT data FROM state WHERE id=1").get() as {
        data: string;
      }
    ).data,
  );
  state.members.reverse();
  s.db.prepare("UPDATE state SET data=? WHERE id=1").run(JSON.stringify(state));
  expect(s.reconcileSystem().balanced).toBe(true);
  expect(aliases()).toEqual(before);
});

it("keeps anonymous aliases stable after a database restart without exposing the private seed", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentrader-privacy-")),
    path = join(directory, "test.sqlite");
  let s: Store | undefined;
  try {
    s = new Store({ path });
    const user = s.register("quietmember", password, {
        anonymousTrading: true,
      }),
      group = s.groups(user.user.id)[0]!;
    const before = s.leaderboard(user.user.id, "FRIENDS", group.id);
    s.close();
    s = new Store({ path });
    expect(s.login("quietmember", password).user.anonymousTrading).toBe(true);
    expect(s.leaderboard(user.user.id, "FRIENDS", group.id)).toEqual(before);
    const bootstrap = s.bootstrap(user.user.id);
    expect(bootstrap.user!.id).toBe(user.user.id);
    expect(JSON.stringify(bootstrap).includes("anonymitySeed")).toBe(false);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    s?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("filters pending account approvals exactly, independent of words in account names", async () => {
  const s = make(),
    admin = s.createAdmin("operator", password);
  s.register("pending_named", password);
  const pending = s.requestRegistration("waiting", password);
  const app = await createApp({
    store: s,
    liveEnabled: false,
    serveStatic: false,
  });
  try {
    const response = await app.inject({
      url: "/api/admin/report?section=users&status=PENDING",
      headers: { cookie: `session=${admin.token}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rows.map((r: { id: string }) => r.id)).toEqual([
      pending.user.id,
    ]);
    expect(response.json().total).toBe(1);
    expect(s.login("pending_named", password).user.anonymousTrading).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});
