import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../server/store";
import { createReconciliationGuard } from "../server/reconciliation";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("checks an empty store at startup without authentication or writing economic state", () => {
  const store = new Store({ path: ":memory:" });
  const before = store.db.prepare("SELECT total_changes() AS changes").get();
  const health = store.reconcileSystem();
  expect(health).toMatchObject({
    balanced: true,
    journalBalanced: true,
    projectionsMatch: true,
    nonnegative: true,
    inventoryMatches: true,
    escrowsSolvent: true,
    locksMatch: true,
  });
  const guard = createReconciliationGuard(store);
  expect(guard.status()).toMatchObject({
    tradingEnabled: true,
    checkedAt: expect.any(String),
    diagnostics: { balanced: true },
  });
  expect(store.db.prepare("SELECT total_changes() AS changes").get()).toEqual(
    before,
  );
  guard.close();
  store.close();
});

it("detects real projection corruption on the minimum interval and stays latched after repair", () => {
  vi.useFakeTimers();
  vi.stubEnv("TRADING_PAUSED", "false");
  const store = new Store({ path: ":memory:" });
  const user = store.register("reconcileuser", "correct horse battery");
  const original = (
    store.db.prepare("SELECT data FROM state WHERE id=1").get() as {
      data: string;
    }
  ).data;
  const failures: unknown[] = [];
  const guard = createReconciliationGuard(store, {
    intervalMs: 1,
    onFailure: (status) => failures.push(status),
  });
  const wallet = store.wallets(user.user.id)[0]!;
  store.db
    .prepare("UPDATE state SET data=json_set(data,?,?) WHERE id=1")
    .run(`$.accounts."cash:${wallet.id}"`, "1");
  vi.advanceTimersByTime(59_999);
  expect(guard.status().tradingEnabled).toBe(true);
  vi.advanceTimersByTime(1);
  expect(guard.status()).toMatchObject({
    tradingEnabled: false,
    reason: "RECONCILIATION_MISMATCH",
    diagnostics: { balanced: false, projectionsMatch: false },
  });
  expect(failures).toHaveLength(1);
  store.db.prepare("UPDATE state SET data=? WHERE id=1").run(original);
  guard.check();
  expect(guard.status()).toMatchObject({
    tradingEnabled: false,
    reason: "RECONCILIATION_MISMATCH",
    diagnostics: { balanced: true },
  });
  vi.advanceTimersByTime(60_000);
  expect(failures).toHaveLength(1);
  const checked = guard.status().checkedAt;
  guard.close();
  store.close();
  vi.advanceTimersByTime(3_600_000);
  expect(guard.status().checkedAt).toBe(checked);
});

it("latches closed on a thrown check with compact sanitized diagnostics", () => {
  const store = new Store({ path: ":memory:" });
  const guard = createReconciliationGuard(store);
  store.close();
  expect(() => guard.check()).not.toThrow();
  expect(guard.status()).toMatchObject({
    tradingEnabled: false,
    reason: "RECONCILIATION_ERROR",
    diagnostics: { error: "RECONCILIATION_ERROR" },
  });
  expect(JSON.stringify(guard.status())).not.toMatch(
    /SELECT|sqlite|stack|database/i,
  );
  guard.close();
});

it("honors operator pause at startup even when accounting is healthy", () => {
  vi.stubEnv("TRADING_PAUSED", "true");
  const store = new Store({ path: ":memory:" });
  const guard = createReconciliationGuard(store);
  expect(guard.status()).toMatchObject({
    tradingEnabled: false,
    reason: "TRADING_PAUSED",
    diagnostics: { balanced: true },
  });
  vi.stubEnv("TRADING_PAUSED", "false");
  guard.check();
  expect(guard.status().tradingEnabled).toBe(false);
  guard.close();
  store.close();
});

it("uses an hourly default and isolates an exception from the failure callback", () => {
  vi.useFakeTimers();
  vi.stubEnv("RECONCILIATION_INTERVAL_MS", "");
  const store = new Store({ path: ":memory:" });
  const guard = createReconciliationGuard(store, {
    onFailure: () => {
      throw new Error("logging unavailable");
    },
  });
  store.close();
  vi.advanceTimersByTime(3_599_999);
  expect(guard.status().tradingEnabled).toBe(true);
  expect(() => vi.advanceTimersByTime(1)).not.toThrow();
  expect(guard.status().tradingEnabled).toBe(false);
  guard.close();
});
