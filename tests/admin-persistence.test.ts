import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
it("preserves legacy accounts, grants, approvals and pause through other connections and restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentrader-admin-")),
    path = join(directory, "test.sqlite");
  let a: Store | undefined, b: Store | undefined;
  try {
    a = new Store({ path });
    const old = a.register("legacy", "correct horse battery");
    const wallets = a.wallets(old.user.id);
    const state = JSON.parse(
      (a.db.prepare("SELECT data FROM state").get() as { data: string }).data,
    );
    delete state.users[old.user.id].status;
    delete state.users[old.user.id].platformRole;
    a.db
      .prepare("UPDATE state SET data=? WHERE id=1")
      .run(JSON.stringify(state));
    a.close();
    a = new Store({ path });
    b = new Store({ path });
    expect(a.user(old.user.id)).toMatchObject({
      platformRole: "USER",
      status: "APPROVED",
    });
    expect(a.wallets(old.user.id)).toEqual(wallets);
    const admin = a.createAdmin("operator", "correct horse battery"),
      p = b.requestRegistration("pending", "correct horse battery");
    a.adminAction(
      admin.user.id,
      {
        type: "ACCOUNT_STATUS",
        targetId: p.user.id,
        status: "APPROVED",
        reason: "Known private group member",
      },
      "approve",
    );
    expect(b.wallets(p.user.id)).toHaveLength(2);
    const wallet = b.wallets(p.user.id)[0]!;
    const grant = {
      type: "WALLET_ADJUSTMENT" as const,
      targetId: wallet.id,
      amount: "15.000001",
      reason: "Versioned practice credit adjustment",
    };
    a.adminAction(admin.user.id, grant, "grant");
    b.adminAction(admin.user.id, grant, "grant");
    b.adminAction(
      admin.user.id,
      {
        type: "TRADING_PAUSE",
        paused: true,
        reason: "Maintenance in progress",
      },
      "pause",
    );
    a.close();
    b.close();
    b = undefined;
    a = new Store({ path });
    expect(a.tradingPaused()).toBe(true);
    expect(a.wallets(p.user.id)[0]!.available).toBe("10015.000001");
    expect(
      a
        .adminReport(admin.user.id, "audit")
        .rows.filter((r) => r.status === "WALLET_ADJUSTMENT"),
    ).toHaveLength(1);
    expect(a.reconcileSystem().balanced).toBe(true);
  } finally {
    a?.close();
    b?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
