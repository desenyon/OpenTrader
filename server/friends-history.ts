import type { Candle } from "../shared/types.js";
import { fail, type Store } from "./store.js";

const WINDOWS: Record<string, { duration: number | null; bucket: number }> = {
  "1h": { duration: 3_600, bucket: 60 },
  "6h": { duration: 21_600, bucket: 60 },
  "1d": { duration: 86_400, bucket: 60 },
  "1w": { duration: 604_800, bucket: 900 },
  max: { duration: null, bucket: 3_600 },
};
interface Observation {
  time: number;
  price: number;
  quantity?: number;
}

function candles(observations: Observation[], bucket: number): Candle[] {
  const result = new Map<number, Candle>();
  // Stable ordering preserves source sequence when observations share a timestamp.
  observations.sort((left, right) => left.time - right.time);
  for (const observation of observations) {
    const time = Math.floor(observation.time / bucket) * bucket;
    const previous = result.get(time);
    if (previous) {
      previous.high = Math.max(previous.high, observation.price);
      previous.low = Math.min(previous.low, observation.price);
      previous.close = observation.price;
      if (observation.quantity !== undefined)
        previous.volume = (previous.volume ?? 0) + observation.quantity;
    } else {
      result.set(time, {
        time,
        open: observation.price,
        high: observation.price,
        low: observation.price,
        close: observation.price,
        ...(observation.quantity === undefined
          ? {}
          : { volume: observation.quantity }),
      });
    }
  }
  return [...result.values()].slice(-5_000);
}

/** Actual Friends AMM observations and executed trades are distinct chart series.
 * Windows describe visible history, while buckets determine the OHLC resolution.
 * No missing observation, volume, or carry-forward point is synthesized. */
export function friendsHistory(
  store: Store,
  userId: string,
  marketId: string,
  outcomeId: string,
  interval: string,
  series: "amm" | "trades",
): Candle[] {
  const market = store.market(userId, marketId); // Enforce the current group ACL before any other read.
  if (market.exchange !== "FRIENDS")
    fail(422, "INVALID_EXCHANGE", "Friends history requires a Friends market");
  if (!market.outcomes.some((outcome) => outcome.id === outcomeId))
    fail(422, "INVALID_OUTCOME", "Unknown chart outcome");
  const window = Object.hasOwn(WINDOWS, interval)
    ? WINDOWS[interval]
    : undefined;
  if (!window) fail(422, "INVALID_INTERVAL", "Unknown chart window");
  if (series !== "amm" && series !== "trades")
    fail(422, "INVALID_SERIES", "Choose AMM or trades");
  const end = store.clock().getTime() / 1_000;
  const start = window.duration === null ? 0 : end - window.duration;
  const observations: Observation[] = [];
  if (series === "trades") {
    // Store.fills independently rechecks access and limits the real fill history to 500 rows.
    const fills = store.fills(userId, marketId).reverse();
    for (const fill of fills) {
      if (
        fill.outcomeId !== outcomeId ||
        (fill.source === "PEER" && fill.side === "SELL")
      )
        continue;
      const time = Date.parse(fill.createdAt) / 1_000;
      if (time < start || time > end || !Number.isFinite(time)) continue;
      if (
        !Number.isFinite(fill.price) ||
        fill.price < 0 ||
        fill.price > 1 ||
        !Number.isFinite(fill.quantity) ||
        fill.quantity <= 0
      )
        continue;
      observations.push({ time, price: fill.price, quantity: fill.quantity });
    }
  } else {
    const rows = store.db
      .prepare(
        "SELECT data,created_at FROM market_events WHERE market_id=? AND created_at>=? AND created_at<=? ORDER BY created_at DESC,sequence DESC,event_index DESC LIMIT 10000",
      )
      .all(
        marketId,
        new Date(start * 1_000).toISOString(),
        new Date(end * 1_000).toISOString(),
      ) as unknown as { data: string; created_at: string }[];
    for (const row of rows.reverse()) {
      const time = Date.parse(row.created_at) / 1_000;
      if (!Number.isFinite(time) || time < start || time > end) continue;
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!snapshot || typeof snapshot !== "object") continue;
      const value = snapshot as {
        id?: unknown;
        exchange?: unknown;
        status?: unknown;
        outcomes?: unknown;
      };
      if (
        value.id !== marketId ||
        value.exchange !== "FRIENDS" ||
        !Array.isArray(value.outcomes)
      )
        continue;
      // Settlement retires inventory and resets q; that administrative reset is not an AMM quote.
      if (value.status === "RESOLVED" || value.status === "VOID") continue;
      const outcome = value.outcomes.find(
        (item: unknown) =>
          item &&
          typeof item === "object" &&
          (item as { id?: unknown }).id === outcomeId,
      ) as { probability?: unknown } | undefined;
      const price = outcome?.probability;
      if (
        typeof price !== "number" ||
        !Number.isFinite(price) ||
        price < 0 ||
        price > 1
      )
        continue;
      observations.push({ time, price });
    }
  }
  return candles(observations, window.bucket);
}
