import { Decimal } from "decimal.js";
import type {
  Market,
  OrderBook,
  BookLevel,
  Candle,
  Resolution,
} from "../shared/types.js";

type Provider = "polymarket" | "kalshi";
type RecordValue = Record<string, unknown>;
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const MAX_AGE_MS = 5_000;
export class ProviderError extends Error {
  constructor(
    message: string,
    public code = "PROVIDER_UNAVAILABLE",
    public statusCode = 503,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("Malformed provider object");
  return value as RecordValue;
}
function str(value: unknown, required = false): string {
  if (typeof value !== "string" || (required && !value.trim())) {
    if (required) throw new ProviderError("Missing provider text");
    return "";
  }
  return value;
}
function array(value: unknown): unknown[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProviderError("Malformed provider array");
    }
  }
  if (!Array.isArray(parsed)) throw new ProviderError("Missing provider array");
  return parsed;
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if ((typeof value !== "string" && typeof value !== "number") || value === "")
    throw new ProviderError("Invalid numeric provider data");
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > maximum)
    throw new ProviderError("Invalid numeric provider data");
  return result;
}
function optionalNumber(value: unknown): number {
  return value === undefined || value === null || value === ""
    ? 0
    : number(value);
}
function identifier(value: unknown, pattern: RegExp): string {
  const result = str(value, true);
  if (!pattern.test(result))
    throw new ProviderError("Invalid provider identifier");
  return result;
}
function iso(value: unknown, required = false): string {
  const result = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) {
    if (required) throw new ProviderError("Invalid provider date");
    return "";
  }
  return new Date(result).toISOString();
}
function providerTime(value: unknown): string {
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value))
  ) {
    const numeric = Number(value);
    const ms = numeric < 1e12 ? numeric * 1_000 : numeric;
    return Number.isFinite(ms) && ms > 0 && ms < 8.64e15
      ? new Date(ms).toISOString()
      : "";
  }
  return iso(value);
}
function freshness(timestamp: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(timestamp);
  return !Number.isFinite(age) || age > MAX_AGE_MS || age < -1_000;
}
function outcomeIdentifier(label: string, index: number): string {
  return /^[a-z0-9 _-]+$/i.test(label)
    ? label.toLowerCase().replace(/\s+/g, "-")
    : `outcome-${index}`;
}
function sourceSlug(value: unknown): string {
  return identifier(value, /^[a-zA-Z0-9_-]+$/);
}
function externalLevels(
  value: unknown,
  tuple = false,
  cents = false,
): BookLevel[] {
  return array(value).map((item) => {
    const level = tuple ? array(item) : record(item);
    if (tuple && (level as unknown[]).length !== 2)
      throw new ProviderError("Invalid order book level");
    const price =
      number(
        tuple ? (level as unknown[])[0] : (level as RecordValue).price,
        cents ? 100 : 1,
      ) / (cents ? 100 : 1);
    const quantity = number(
      tuple ? (level as unknown[])[1] : (level as RecordValue).size,
    );
    if (price <= 0 || price >= 1 || quantity <= 0)
      throw new ProviderError("Invalid order book level");
    return { price, quantity, source: "EXTERNAL" as const };
  });
}
function finishBook(book: OrderBook): OrderBook {
  book.bids.sort((a, b) => b.price - a.price);
  book.asks.sort((a, b) => a.price - b.price);
  if (
    book.bids.length &&
    book.asks.length &&
    book.bids[0].price > book.asks[0].price
  )
    throw new ProviderError("Crossed provider book");
  return book;
}
/** Canonical market ID: poly:<Gamma market ID>. Each outcome ID is its unique lowercased label;
 * non-ASCII labels use outcome-<index>; ambiguous IDs are rejected. assetId always corresponds to that outcome's index.
 * v1 selects clobTokenIds; v2 selects positionIds. Event IDs are never tradeable market IDs. */
export function normalizePolymarketMarket(
  value: unknown,
  finalEvidence?: unknown,
): Market {
  const raw = record(value);
  const id = identifier(raw.id, /^\d+$/);
  const version = raw.version ?? "v1";
  if (version !== "v1" && version !== "v2")
    throw new ProviderError("Unsupported Polymarket protocol version");
  const outcomes = array(raw.outcomes);
  const prices = array(raw.outcomePrices);
  const assets = array(version === "v1" ? raw.clobTokenIds : raw.positionIds);
  if (
    outcomes.length < 2 ||
    outcomes.length !== prices.length ||
    outcomes.length !== assets.length ||
    new Set(assets).size !== assets.length
  )
    throw new ProviderError("Invalid outcome/asset mapping");
  const labels = outcomes.map((item) => str(item, true));
  if (new Set(labels.map(outcomeIdentifier)).size !== labels.length)
    throw new ProviderError("Ambiguous outcome mapping");
  const events = Array.isArray(raw.events) ? raw.events : [];
  const event = events.length ? record(events[0]) : {};
  const slug = sourceSlug(event.slug || raw.slug);
  const tags = Array.isArray(event.tags)
    ? event.tags
    : Array.isArray(raw.tags)
      ? raw.tags
      : [];
  const category =
    str(raw.category) ||
    (tags.length ? str(record(tags[0]).label) : "") ||
    (raw.sportsMarketType ? "Sports" : "Other");
  const market: Market = {
    id: `poly:${id}`,
    exchange: "LIVE",
    provider: "polymarket",
    groupId: null,
    question: str(raw.question, true),
    description: str(raw.description),
    category,
    outcomes: labels.map((label, index) => ({
      id: outcomeIdentifier(label, index),
      label,
      probability: number(prices[index], 1),
      assetId: identifier(assets[index], /^\d+$/),
    })),
    status:
      raw.closed === true
        ? "CLOSED"
        : raw.active === true && raw.acceptingOrders !== false
          ? "OPEN"
          : "PAUSED",
    volume: optionalNumber(raw.volumeNum ?? raw.volume),
    liquidity: optionalNumber(raw.liquidityNum ?? raw.liquidity),
    closeAt: iso(raw.endDate, true),
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
    sourceUrl: `https://polymarket.com/event/${slug}`,
    sequence: 0,
    ...(typeof raw.image === "string" &&
    /^https:\/\/(?:polymarket-upload\.s3\.[a-z0-9-]+\.amazonaws\.com|images\.polymarket\.com)\//.test(
      raw.image,
    )
      ? { image: raw.image }
      : {}),
  };
  if (
    raw.closed === true &&
    raw.umaResolutionStatus === "resolved" &&
    finalEvidence !== undefined
  ) {
    const evidence = record(finalEvidence);
    const condition = identifier(raw.conditionId, /^0x[a-fA-F0-9]{64}$/);
    if (evidence.condition_id !== condition)
      throw new ProviderError("Polymarket final condition mismatch");
    if (evidence.closed === true && evidence.accepting_orders === false) {
      const tokens = array(evidence.tokens).map(record);
      if (
        tokens.length !== market.outcomes.length ||
        new Set(tokens.map((t) => t.token_id)).size !== tokens.length ||
        tokens.some(
          (t) =>
            typeof t.winner !== "boolean" ||
            !market.outcomes.some(
              (o) => o.assetId === t.token_id && o.label === t.outcome,
            ),
        )
      )
        throw new ProviderError("Invalid final outcome mapping");
      const winners = tokens.filter((t) => t.winner === true);
      if (winners.length === 1) {
        const outcome = market.outcomes.find(
          (o) => o.assetId === winners[0].token_id,
        )!;
        market.resolution = providerResolution(
          market,
          outcome.id,
          `${CLOB}/markets/${condition}`,
          iso(raw.updatedAt, true),
          "Final resolved oracle status and explicit CLOB winning token",
        );
        market.status = "RESOLVED";
      }
    }
  }
  return market;
}
export function normalizePolymarketBook(
  value: unknown,
  marketId: string,
  outcomeId: string,
  now = new Date(),
): OrderBook {
  const raw = record(value);
  const timestamp = providerTime(raw.timestamp);
  return finishBook({
    marketId,
    outcomeId,
    bids: externalLevels(raw.bids),
    asks: externalLevels(raw.asks),
    timestamp,
    stale: freshness(timestamp, now),
    source: "Polymarket CLOB · provider snapshot timestamp",
    ...(typeof raw.hash === "string" ? { hash: raw.hash } : {}),
  });
}
/** Canonical Kalshi ID: kalshi:<market ticker>; binary outcome IDs are yes and no. */
function providerResolution(
  market: Market,
  outcomeId: string,
  evidence: string,
  at: string,
  rationale: string,
): Resolution {
  return {
    id: `${market.id}:provider-final:${outcomeId}`,
    outcomeId,
    evidence,
    rationale,
    proposedBy: market.provider!,
    proposedAt: at,
    disputeUntil: at,
    state: "FINAL",
    disputes: [],
    reviews: [],
  };
}
export function normalizeKalshiMarket(value: unknown): Market {
  const raw = record(value);
  const ticker = identifier(raw.ticker, /^[A-Za-z0-9_-]+$/);
  const event = identifier(raw.event_ticker, /^[A-Za-z0-9_-]+$/);
  const yes =
    raw.last_price_dollars !== undefined
      ? number(raw.last_price_dollars, 1)
      : number(raw.last_price ?? 0, 100) / 100;
  const market: Market = {
    id: `kalshi:${ticker}`,
    exchange: "LIVE",
    provider: "kalshi",
    groupId: null,
    question: str(raw.title, true),
    description: [
      str(raw.subtitle),
      str(raw.rules_primary),
      str(raw.rules_secondary),
    ]
      .filter(Boolean)
      .join("\n\n"),
    category: str(raw.category) || "Other",
    outcomes: [
      {
        id: "yes",
        label: str(raw.yes_sub_title) ? `Yes · ${str(raw.yes_sub_title)}` : "Yes",
        probability: yes,
      },
      {
        id: "no",
        label: str(raw.no_sub_title) ? `No · ${str(raw.no_sub_title)}` : "No",
        probability: new Decimal(1).minus(yes).toNumber(),
      },
    ],
    status:
      raw.status === "active" || raw.status === "open"
        ? "OPEN"
        : raw.status === "settled" ||
            raw.status === "closed" ||
            raw.status === "finalized"
          ? "CLOSED"
          : "PAUSED",
    volume: optionalNumber(raw.volume_fp ?? raw.volume),
    liquidity: 0,
    closeAt: iso(raw.close_time ?? raw.expiration_time, true),
    createdAt: iso(raw.created_time),
    updatedAt: iso(raw.updated_time),
    sourceUrl: `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
    sequence: 0,
  };
  if (
    (raw.status === "settled" || raw.status === "finalized") &&
    (raw.result === "yes" || raw.result === "no")
  ) {
    market.resolution = providerResolution(
      market,
      raw.result,
      market.sourceUrl!,
      iso(raw.settlement_ts ?? raw.updated_time ?? raw.close_time, true),
      "Final provider settlement status and explicit binary result",
    );
    market.status = "RESOLVED";
  }
  return market;
}
export function normalizeKalshiBook(
  value: unknown,
  marketId: string,
  outcomeId: string,
  now = new Date(),
  responseDate?: string | null,
): OrderBook {
  if (outcomeId !== "yes" && outcomeId !== "no")
    throw new ProviderError("Unknown outcome", "INVALID_OUTCOME", 400);
  const raw = record(value);
  const fp = raw.orderbook_fp !== undefined;
  const book = record(fp ? raw.orderbook_fp : raw.orderbook);
  const yes = externalLevels(
    (fp ? book.yes_dollars : book.yes) ?? [],
    true,
    !fp,
  );
  const no = externalLevels((fp ? book.no_dollars : book.no) ?? [], true, !fp);
  const jsonTimestamp = providerTime(raw.timestamp ?? book.timestamp ?? raw.ts);
  const timestamp = jsonTimestamp || providerTime(responseDate);
  const own = outcomeId === "yes" ? yes : no;
  const opposite = outcomeId === "yes" ? no : yes;
  return finishBook({
    marketId,
    outcomeId,
    bids: own,
    asks: opposite.map((level) => ({
      ...level,
      price: new Decimal(1).minus(level.price).toNumber(),
    })),
    timestamp,
    stale: freshness(timestamp, now),
    source: jsonTimestamp
      ? "Kalshi · provider snapshot timestamp"
      : timestamp
        ? "Kalshi · upstream HTTP Date snapshot timestamp"
        : "Kalshi · received snapshot; provider timestamp unavailable; execution disabled",
  });
}
export function historyToCandles(value: unknown, seconds: number): Candle[] {
  if (!Number.isSafeInteger(seconds) || seconds < 1)
    throw new ProviderError("Invalid history interval");
  const observations = array(value)
    .map((item) => {
      const point = record(item);
      return { time: number(point.t), price: number(point.p, 1) };
    })
    .sort((a, b) => a.time - b.time);
  const candles = new Map<number, Candle>();
  for (const point of observations) {
    const time = Math.floor(point.time / seconds) * seconds;
    const candle = candles.get(time);
    if (candle) {
      candle.high = Math.max(candle.high, point.price);
      candle.low = Math.min(candle.low, point.price);
      candle.close = point.price;
    } else
      candles.set(time, {
        time,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
      });
  }
  return [...candles.values()];
}
interface ProviderState {
  state: "disabled" | "idle" | "available" | "unavailable";
  lastSuccessAt: string | null;
  error: string | null;
  dataUse: string;
}
interface Cached<T> {
  value: T;
  expires: number;
}
interface RequestResult {
  body: unknown;
  date: string | null;
}
export class MarketDataService {
  readonly isEnabled: boolean;
  private fetcher: typeof fetch;
  private now: () => Date;
  private caches = new Map<string, Cached<unknown>>();
  private flights = new Map<string, Promise<unknown>>();
  private markets = new Map<string, Market>();
  private marketTimes = new Map<string, number>();
  private rawMarkets = new Map<string, RecordValue>();
  private states: Record<Provider, ProviderState>;
  constructor(
    options: {
      enabled?: boolean;
      fetcher?: typeof fetch;
      now?: () => Date;
    } = {},
  ) {
    const production = process.env.NODE_ENV === "production";
    const acknowledged =
      process.env.LIVE_DATA_ENABLED === "true" &&
      process.env.DATA_USE_ACKNOWLEDGED === "true";
    this.isEnabled =
      options.enabled !== false &&
      (production ? acknowledged : process.env.LIVE_DATA_ENABLED !== "false");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    const state: ProviderState = {
      state: this.isEnabled ? "idle" : "disabled",
      lastSuccessAt: null,
      error: null,
      dataUse: production
        ? "Hosted data-use acknowledgement configured; operator remains responsible for provider permissions."
        : "Personal localhost preview. Public API access does not grant redistribution rights.",
    };
    this.states = { polymarket: { ...state }, kalshi: { ...state } };
  }
  status() {
    return {
      enabled: this.isEnabled,
      providers: structuredClone(this.states),
      freshnessLimitMs: MAX_AGE_MS,
    };
  }
  private gate() {
    if (!this.isEnabled)
      throw new ProviderError(
        "Live data is disabled. Production requires LIVE_DATA_ENABLED=true and DATA_USE_ACKNOWLEDGED=true.",
        "LIVE_DISABLED",
        503,
      );
  }
  private async cached<T>(
    key: string,
    ttl: number,
    load: () => Promise<T>,
    fresh = false,
  ): Promise<T> {
    const cached = this.caches.get(key);
    if (!fresh && cached && cached.expires > this.now().getTime())
      return structuredClone(cached.value as T);
    const active = this.flights.get(key);
    if (active) return structuredClone((await active) as T);
    const flight = load()
      .then((value) => {
        this.caches.set(key, { value, expires: this.now().getTime() + ttl });
        return value;
      })
      .finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return structuredClone(await flight);
  }
  private async request(
    provider: Provider,
    url: string,
  ): Promise<RequestResult> {
    this.gate();
    // Hosts and URL paths are built only from validated canonical IDs, never caller URLs.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(3_900),
          redirect: "error",
        });
        if (!response.ok) {
          if (
            attempt === 0 &&
            (response.status === 429 || response.status >= 500)
          ) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            continue;
          }
          throw new ProviderError(
            `${provider} returned HTTP ${response.status}`,
          );
        }
        const body: unknown = await response.json();
        this.states[provider] = {
          ...this.states[provider],
          state: "available",
          error: null,
          lastSuccessAt: this.now().toISOString(),
        };
        return { body, date: response.headers.get("date") };
      } catch (error) {
        if (attempt === 0 && !(error instanceof ProviderError)) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        const message =
          error instanceof Error ? error.message : "Unknown provider failure";
        this.states[provider] = {
          ...this.states[provider],
          state: "unavailable",
          error: message,
        };
        throw error instanceof ProviderError
          ? error
          : new ProviderError(`${provider} unavailable: ${message}`);
      }
    }
    throw new ProviderError("Provider retry exhausted");
  }
  private save(
    provider: Provider,
    raw: unknown,
    finalEvidence?: unknown,
  ): Market {
    try {
      const market =
        provider === "polymarket"
          ? normalizePolymarketMarket(raw, finalEvidence)
          : normalizeKalshiMarket(raw);
      this.markets.set(market.id, market);
      this.rawMarkets.set(market.id, record(raw));
      this.marketTimes.set(market.id, this.now().getTime());
      return market;
    } catch (error) {
      this.states[provider] = {
        ...this.states[provider],
        state: "unavailable",
        error:
          error instanceof Error
            ? error.message
            : "Malformed provider response",
      };
      throw error;
    }
  }
  async listMarkets(provider?: Provider, search = ""): Promise<Market[]> {
    this.gate();
    if (provider && provider !== "polymarket" && provider !== "kalshi")
      throw new ProviderError("Unknown provider", "INVALID_PROVIDER", 400);
    const load = async (p: Provider) =>
      this.cached(`discovery:${p}`, 15_000, async () => {
        const { body } = await this.request(
          p,
          p === "polymarket"
            ? `${GAMMA}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`
            : `${KALSHI}/events?status=open&limit=100&with_nested_markets=true`,
        );
        let raws: unknown[];
        if (p === "polymarket") raws = array(body);
        else {
          const object = record(body);
          if (Array.isArray(object.events))
            raws = object.events.flatMap((item) => {
              const event = record(item);
              return array(event.markets).map((m) => ({
                ...record(m),
                category: event.category ?? record(m).category,
              }));
            });
          else raws = array(object.markets);
        }
        // A single malformed market is excluded, without ever generating replacement prices.
        const valid: Market[] = [];
        for (const raw of raws) {
          try {
            valid.push(this.save(p, raw));
          } catch {
            /* unsupported metadata does not enter discovery */
          }
        }
        if (raws.length && !valid.length)
          throw new ProviderError(
            `${p} discovery contained no supported markets`,
          );
        this.states[p] = { ...this.states[p], state: "available", error: null };
        return valid;
      });
    let all: Market[];
    if (provider) all = await load(provider);
    else {
      const results = await Promise.allSettled([
        load("polymarket"),
        load("kalshi"),
      ]);
      all = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      if (
        !all.length &&
        results.every((result) => result.status === "rejected")
      )
        throw new ProviderError("Both live providers are unavailable");
    }
    const term = search.trim().toLowerCase();
    return all.filter(
      (m) =>
        !term ||
        `${m.question} ${m.description} ${m.category}`
          .toLowerCase()
          .includes(term),
    );
  }
  async getMarket(id: string): Promise<Market> {
    this.gate();
    const match = /^(poly|kalshi):([A-Za-z0-9_-]+)$/.exec(id);
    if (!match || (match[1] === "poly" && !/^\d+$/.test(match[2])))
      throw new ProviderError(
        "Invalid live market identifier",
        "INVALID_MARKET",
        400,
      );
    const existing = this.markets.get(id);
    if (
      existing &&
      this.now().getTime() - (this.marketTimes.get(id) ?? 0) < 15_000
    )
      return structuredClone(existing);
    const provider: Provider = match[1] === "poly" ? "polymarket" : "kalshi";
    const { body } = await this.request(
      provider,
      provider === "polymarket"
        ? `${GAMMA}/markets/${match[2]}`
        : `${KALSHI}/markets/${encodeURIComponent(match[2])}`,
    );
    const raw = provider === "kalshi" ? record(body).market : body;
    let finalEvidence: unknown;
    if (
      provider === "polymarket" &&
      record(raw).closed === true &&
      record(raw).umaResolutionStatus === "resolved"
    ) {
      const condition = identifier(
        record(raw).conditionId,
        /^0x[a-fA-F0-9]{64}$/,
      );
      finalEvidence = (
        await this.request("polymarket", `${CLOB}/markets/${condition}`)
      ).body;
    }
    const market = this.save(provider, raw, finalEvidence);
    if (market.id !== id)
      throw new ProviderError("Provider market identifier mismatch");
    return structuredClone(market);
  }
  async getBook(
    marketId: string,
    outcomeId: string,
    options: { fresh?: boolean } = {},
  ): Promise<OrderBook> {
    this.gate();
    const market = await this.getMarket(marketId);
    const outcome = market.outcomes.find((o) => o.id === outcomeId);
    if (!outcome)
      throw new ProviderError("Unknown outcome", "INVALID_OUTCOME", 400);
    const book = await this.cached(
      `book:${marketId}:${outcomeId}`,
      1_000,
      async () => {
        try {
          if (market.provider === "polymarket") {
            const { body } = await this.request(
              "polymarket",
              `${CLOB}/book?token_id=${encodeURIComponent(outcome.assetId!)}`,
            );
            const asset = record(body).asset_id;
            if (typeof asset !== "string" || asset !== outcome.assetId)
              throw new ProviderError("Provider asset mapping mismatch");
            return normalizePolymarketBook(
              body,
              marketId,
              outcomeId,
              this.now(),
            );
          }
          const { body, date } = await this.request(
            "kalshi",
            `${KALSHI}/markets/${encodeURIComponent(marketId.slice(7))}/orderbook?depth=100`,
          );
          return normalizeKalshiBook(
            body,
            marketId,
            outcomeId,
            this.now(),
            date,
          );
        } catch (error) {
          const p = market.provider!;
          this.states[p] = {
            ...this.states[p],
            state: "unavailable",
            error: error instanceof Error ? error.message : "Malformed book",
          };
          throw error;
        }
      },
      options.fresh,
    );
    // Re-evaluate even cached provider timestamps at the moment the caller receives them.
    return { ...book, stale: freshness(book.timestamp, this.now()) };
  }
  async getHistory(
    marketId: string,
    outcomeId: string,
    interval: string,
  ): Promise<Candle[]> {
    this.gate();
    const market = await this.getMarket(marketId);
    const outcome = market.outcomes.find((o) => o.id === outcomeId);
    if (!outcome)
      throw new ProviderError("Unknown outcome", "INVALID_OUTCOME", 400);
    // UI timeframe is a visible window, not a candle bucket. Keep real minute detail for intraday windows.
    const windows: Record<
      string,
      { window: number; bucket: number; poly: string }
    > = {
      "1h": { window: 3600, bucket: 60, poly: "1h" },
      "6h": { window: 21600, bucket: 60, poly: "6h" },
      "1d": { window: 86400, bucket: 60, poly: "1d" },
      "1w": { window: 604800, bucket: 900, poly: "1w" },
      max: { window: 0, bucket: 3600, poly: "max" },
      "1m": { window: 3600, bucket: 60, poly: "1h" },
      "5m": { window: 86400, bucket: 300, poly: "1d" },
      "15m": { window: 604800, bucket: 900, poly: "1w" },
      "4h": { window: 14400, bucket: 60, poly: "6h" },
    };
    const selection = windows[interval];
    if (!selection)
      throw new ProviderError(
        "Invalid history interval",
        "INVALID_INTERVAL",
        400,
      );
    const seconds = selection.bucket;
    return this.cached(
      `history:${marketId}:${outcomeId}:${interval}`,
      15_000,
      async () => {
        if (market.provider === "polymarket") {
          const { body } = await this.request(
            "polymarket",
            `${CLOB}/prices-history?market=${encodeURIComponent(outcome.assetId!)}&interval=${selection.poly}&fidelity=${Math.max(1, seconds / 60)}`,
          );
          return historyToCandles(record(body).history, seconds);
        }
        // Public historical candles are exposed per series. No flat line or invented volume fallback.
        const raw = this.rawMarkets.get(marketId)!;
        const event = str(raw.event_ticker);
        const series = str(raw.series_ticker) || event.replace(/-[^-]+$/, "");
        if (!/^[A-Za-z0-9_-]+$/.test(series)) return [];
        const end = Math.floor(this.now().getTime() / 1_000);
        const created = Math.floor(Date.parse(market.createdAt) / 1_000);
        const start = selection.window
          ? end - selection.window
          : Number.isFinite(created)
            ? created
            : end - 30 * 86400;
        // The public endpoint caps a response at 5000 periods. Use real daily candles for long all-time windows.
        const period =
          selection.window > 0 && selection.window <= 86400
            ? 1
            : (end - start) / 3600 > 4999
              ? 1440
              : 60;
        const candleSeconds = Math.max(seconds, period * 60);
        try {
          const { body } = await this.request(
            "kalshi",
            `${KALSHI}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(marketId.slice(7))}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${period}`,
          );
          const observed = array(record(body).candlesticks)
            .flatMap((value) => {
              const item = record(value);
              const price = record(item.price);
              const fixed = price.open_dollars !== undefined;
              if (
                price[fixed ? "open_dollars" : "open"] === null ||
                price[fixed ? "open_dollars" : "open"] === undefined
              )
                return [];
              const scale = fixed ? 1 : 100;
              const values = ["open", "high", "low", "close"].map(
                (key) =>
                  number(price[fixed ? `${key}_dollars` : key], scale) / scale,
              );
              const [open, high, low, close] =
                outcomeId === "no"
                  ? values.map((v) => new Decimal(1).minus(v).toNumber())
                  : values;
              return [
                {
                  time: number(item.end_period_ts) - period * 60,
                  open,
                  high: outcomeId === "no" ? low : high,
                  low: outcomeId === "no" ? high : low,
                  close,
                  ...(item.volume_fp !== undefined || item.volume !== undefined
                    ? { volume: number(item.volume_fp ?? item.volume) }
                    : {}),
                },
              ];
            })
            .sort((a, b) => a.time - b.time);
          const buckets = new Map<number, Candle>();
          for (const candle of observed) {
            const time =
              Math.floor(candle.time / candleSeconds) * candleSeconds;
            const previous = buckets.get(time);
            if (previous) {
              previous.high = Math.max(previous.high, candle.high);
              previous.low = Math.min(previous.low, candle.low);
              previous.close = candle.close;
              if (candle.volume !== undefined)
                previous.volume = (previous.volume ?? 0) + candle.volume;
            } else buckets.set(time, { ...candle, time });
          }
          return [...buckets.values()];
        } catch (error) {
          if (
            error instanceof ProviderError &&
            /HTTP (401|403|404)/.test(error.message)
          )
            return [];
          throw error;
        }
      },
    );
  }
}
