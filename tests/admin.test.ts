import { afterEach, expect, it } from "vitest";
import { Store } from "../server/store";
import { createApp } from "../server/app";
const stores: Store[] = [];
const make = () => {
  const s = new Store({ path: ":memory:" });
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
const password = "correct horse battery staple";
it("public requests receive no economy until approval, and cannot self-promote", async () => {
  const s = make(),
    admin = s.createAdmin("operator", password);
  const app = await createApp({
    store: s,
    liveEnabled: false,
    serveStatic: false,
  });
  try {
    const request = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "newmember", password, platformRole: "ADMIN" },
    });
    expect(request.json().user).toMatchObject({
      status: "PENDING",
      platformRole: "USER",
    });
    expect(request.json().wallets).toEqual([]);
    const cookie = request.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    expect(
      (await app.inject({ url: "/api/wallets", headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/admin/report", headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    const userId = request.json().user.id;
    s.adminAction(
      admin.user.id,
      {
        type: "ACCOUNT_STATUS",
        targetId: userId,
        status: "APPROVED",
        reason: "Known friend",
      },
      "approve-one",
    );
    expect(s.wallets(userId)).toHaveLength(2);
    const before = s.audit(userId).length;
    s.adminAction(
      admin.user.id,
      {
        type: "ACCOUNT_STATUS",
        targetId: userId,
        status: "APPROVED",
        reason: "Repeated approval",
      },
      "approve-two",
    );
    expect(s.audit(userId)).toHaveLength(before);
    expect(s.reconcileSystem().balanced).toBe(true);
  } finally {
    await app.close();
  }
});
it("operator changes are scoped, balanced, idempotent and excluded from returns", () => {
  const s = make(),
    admin = s.createAdmin("operator", password),
    member = s.register("member", password);
  const [live, friend] = s.wallets(member.user.id);
  const action = {
    type: "WALLET_ADJUSTMENT" as const,
    targetId: live!.id,
    amount: "100.123456",
    reason: "Approved practice allocation",
  };
  s.adminAction(admin.user.id, action, "grant");
  s.adminAction(admin.user.id, action, "grant");
  expect(s.wallets(member.user.id)[0]!.available).toBe("10100.123456");
  expect(s.wallets(member.user.id)[1]).toEqual(friend);
  expect(s.leaderboard(member.user.id, "LIVE")[0]!.pnl).toBe("0.000000");
  expect(() =>
    s.adminAction(admin.user.id, { ...action, amount: "2" }, "grant"),
  ).toThrow();
  expect(() => s.adminAction(member.user.id, action, "not-admin")).toThrow();
  expect(() =>
    s.adminAction(admin.user.id, { ...action, amount: "-20000" }, "overdraw"),
  ).toThrow();
  expect(s.reconcileSystem().balanced).toBe(true);
  expect(() => s.db.prepare("DELETE FROM admin_events").run()).toThrow();
});
it("last approved admin cannot be suspended and pending requests cannot access group data directly", () => {
  const s = make(),
    a = s.createAdmin("operator", password),
    p = s.requestRegistration("pending", password);
  expect(() =>
    s.adminAction(
      a.user.id,
      {
        type: "ACCOUNT_STATUS",
        targetId: a.user.id,
        status: "SUSPENDED",
        reason: "Test lockout",
      },
      "lockout",
    ),
  ).toThrow();
  expect(() =>
    s.createGroup(p.user.id, { name: "Unauthorized", description: "" }),
  ).toThrow();
  expect(() => s.groups(p.user.id)).toThrow();
  s.adminAction(
    a.user.id,
    { type: "TRADING_PAUSE", paused: true, reason: "Maintenance window" },
    "pause",
  );
  expect(s.tradingPaused()).toBe(true);
  expect(s.adminReport(a.user.id, "users").total).toBe(2);
});

it("rejects operator APIs for ordinary sessions and validates all mutations on the server", async () => {
  const s = make(),
    admin = s.createAdmin("operator", password),
    user = s.register("ordinary", password);
  const app = await createApp({
    store: s,
    liveEnabled: false,
    serveStatic: false,
  });
  try {
    const normal = { cookie: `session=${user.token}` },
      operator = {
        cookie: `session=${admin.token}`,
        "idempotency-key": "http-action",
      };
    for (const path of [
      "/api/admin/report",
      "/api/admin/reconciliation",
      `/api/admin/wallets/${s.wallets(admin.user.id)[0]!.id}/ledger`,
    ]) {
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: path, headers: normal })).statusCode,
      ).toBe(403);
    }
    const payload = {
      type: "WALLET_ADJUSTMENT",
      targetId: s.wallets(user.user.id)[0]!.id,
      amount: "125",
      reason: "Approved supplemental practice credits",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/actions",
          headers: normal,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/actions",
          headers: { cookie: `session=${admin.token}` },
          payload,
        })
      ).statusCode,
    ).toBe(422);
    for (const amount of ["NaN", "1e6", "0.0000001", "-10001", "1000001"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/actions",
        headers: { ...operator, "idempotency-key": amount },
        payload: { ...payload, amount },
      });
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    }
    const a = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: operator,
      payload,
    });
    const retry = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: operator,
      payload,
    });
    expect(a.statusCode, a.body).toBe(200);
    expect(retry.json()).toEqual(a.json());
    expect(s.wallets(user.user.id)[0]!.available).toBe("10125.000000");
    const report = await app.inject({
      url: "/api/admin/report?section=audit&limit=1",
      headers: operator,
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().rows).toHaveLength(1);
    expect(JSON.stringify(report.json())).not.toMatch(
      /salt|password|session|request_hash/,
    );
    const suspend = await app.inject({
      method: "POST",
      url: "/api/admin/actions",
      headers: { ...operator, "idempotency-key": "suspend" },
      payload: {
        type: "ACCOUNT_STATUS",
        targetId: user.user.id,
        status: "SUSPENDED",
        reason: "Account review needed",
      },
    });
    expect(suspend.statusCode, suspend.body).toBe(200);
    expect(
      (await app.inject({ url: "/api/wallets", headers: normal })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/bootstrap", headers: normal })).json()
        .wallets,
    ).toEqual([]);
  } finally {
    await app.close();
  }
});
