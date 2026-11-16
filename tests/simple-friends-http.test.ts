import { expect, it } from "vitest";
import { Store } from "../server/store";
import { createApp } from "../server/app";
import { units, money } from "../server/math";
it("applies admin credits across wallet views and settles a casual bet without sources or reasons", async () => {
  const s = new Store({
    path: ":memory:",
    now: () => new Date("2030-01-01T00:00:00Z"),
  });
  const a = s.register("alice", "correct horse battery"),
    b = s.register("bobby", "correct horse battery"),
    admin = s.createAdmin("operator", "correct horse battery");
  const g = s.groups(a.user.id)[0]!;
  s.redeem(b.user.id, s.invite(a.user.id, g.id, {}).token);
  const extraGroup = s.createGroup(a.user.id, {
    name: "Other group",
    description: "",
  });
  const app = await createApp({
    store: s,
    liveEnabled: false,
    serveStatic: false,
  });
  const alice = { cookie: `session=${a.token}` },
    bob = { cookie: `session=${b.token}` },
    operator = { cookie: `session=${admin.token}` };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/markets",
      headers: alice,
      payload: {
        groupId: g.id,
        question: "Pizza tonight?",
        closeAt: "2030-01-02T00:00:00Z",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const m = created.json();
    expect(m.status).toBe("OPEN");
    const order = {
      marketId: m.id,
      outcomeId: "yes",
      side: "BUY",
      quantity: 25,
      limitPrice: "0.9999",
      timeInForce: "IOC",
    };
    const bought = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { ...alice, "idempotency-key": "simple-http-buy" },
      payload: order,
    });
    expect(bought.statusCode, bought.body).toBe(200);
    const before = s.wallets(a.user.id),
      target = before.find((w) => w.groupId === g.id)!,
      pnl = s
        .leaderboard(a.user.id, "FRIENDS", g.id)
        .find((r) => r.userId === a.user.id)?.pnl;
    expect(pnl).toMatch(/^-?\d+\.\d{6}$/);
    const adjustment = {
      type: "WALLET_ADJUSTMENT",
      targetId: target.id,
      amount: "250.123456",
    };
    for (let i = 0; i < 2; i++) {
      const adjusted = await app.inject({
        method: "POST",
        url: "/api/admin/actions",
        headers: { ...operator, "idempotency-key": "simple-http-adjustment" },
        payload: adjustment,
      });
      expect(adjusted.statusCode, adjusted.body).toBe(200);
    }
    const expected = money(units(target.available) + units("250.123456"));
    for (const path of ["/api/bootstrap", "/api/wallets"]) {
      const r = await app.inject({ url: path, headers: alice });
      expect(r.statusCode, r.body).toBe(200);
      const wallets = path.endsWith("bootstrap") ? r.json().wallets : r.json();
      expect(
        wallets.find((w: { id: string }) => w.id === target.id).available,
      ).toBe(expected);
      for (const other of before.filter((w) => w.id !== target.id))
        expect(wallets.find((w: { id: string }) => w.id === other.id)).toEqual(
          other,
        );
    }
    expect(
      s.wallets(a.user.id).find((w) => w.groupId === extraGroup.id)!.available,
    ).toBe("10000.000000");
    expect(
      s
        .leaderboard(a.user.id, "FRIENDS", g.id)
        .find((r) => r.userId === a.user.id)?.pnl,
    ).toBe(pnl);
    const denied = await app.inject({
      method: "POST",
      url: `/api/markets/${m.id}/resolve`,
      headers: bob,
      payload: { outcomeId: "no" },
    });
    expect(denied.statusCode).toBe(403);
    const settled = await app.inject({
      method: "POST",
      url: `/api/markets/${m.id}/resolve`,
      headers: alice,
      payload: { outcomeId: "yes" },
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().status).toBe("RESOLVED");
    const current = await app.inject({ url: "/api/bootstrap", headers: alice });
    expect(
      current.json().wallets.find((w: { id: string }) => w.id === target.id)
        .available,
    ).toBe(money(units(expected) + 25_000_000n));
    const positions = await app.inject({
      url: `/api/positions?exchange=FRIENDS&groupId=${g.id}`,
      headers: alice,
    });
    expect(positions.json()[0]).toMatchObject({
      quantity: 0,
      locked: 0,
      markPrice: 1,
    });
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    await app.close();
    s.close();
  }
});
