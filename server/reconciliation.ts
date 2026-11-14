import type { Store } from "./store.js";

type AccountingFlags = Omit<ReturnType<Store["reconcileSystem"]>, "checkedAt">;
export type ReconciliationReason =
  "TRADING_PAUSED" | "RECONCILIATION_MISMATCH" | "RECONCILIATION_ERROR";
export interface ReconciliationStatus {
  tradingEnabled: boolean;
  checkedAt: string;
  reason?: ReconciliationReason;
  diagnostics: AccountingFlags | { error: "RECONCILIATION_ERROR" };
}
export interface ReconciliationOptions {
  intervalMs?: number;
  onFailure?: (status: ReconciliationStatus) => void;
}

/** Synchronous, observational accounting guard. A failure requires an operator restart. */
export function createReconciliationGuard(
  store: Store,
  options: ReconciliationOptions = {},
) {
  const configured =
    options.intervalMs ??
    (process.env.RECONCILIATION_INTERVAL_MS?.trim()
      ? Number(process.env.RECONCILIATION_INTERVAL_MS)
      : 3_600_000);
  // Node clamps overflowing timers to 1 ms, so cap at its supported maximum too.
  const intervalMs = Number.isFinite(configured)
    ? Math.min(2_147_483_647, Math.max(60_000, Math.floor(configured)))
    : 3_600_000;
  const paused = process.env.TRADING_PAUSED === "true";
  let closed = false,
    failureReported = false;
  let state: ReconciliationStatus = {
    tradingEnabled: !paused,
    checkedAt: new Date().toISOString(),
    ...(paused ? { reason: "TRADING_PAUSED" as const } : {}),
    diagnostics: { error: "RECONCILIATION_ERROR" },
  };
  const status = () => structuredClone(state);
  const latch = (reason: ReconciliationReason) => {
    state.tradingEnabled = false;
    if (!state.reason || state.reason === "TRADING_PAUSED")
      state.reason = reason;
    if (!failureReported) {
      failureReported = true;
      try {
        options.onFailure?.(status());
      } catch {
        /* A failing diagnostic sink must not reopen trading or crash the timer. */
      }
    }
  };
  const check = () => {
    if (closed) return status();
    try {
      const { checkedAt, ...diagnostics } = store.reconcileSystem();
      state = { ...state, checkedAt, diagnostics };
      if (!diagnostics.balanced) latch("RECONCILIATION_MISMATCH");
    } catch {
      // Database errors can contain paths, queries and private identifiers.
      state = {
        ...state,
        checkedAt: new Date().toISOString(),
        diagnostics: { error: "RECONCILIATION_ERROR" },
      };
      latch("RECONCILIATION_ERROR");
    }
    return status();
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return {
    status,
    check,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
