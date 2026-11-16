import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Info,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import type {
  Market,
  OrderBook,
  OrderInput,
  OrderReceipt,
  Outcome,
  Position,
  Quote,
  Side,
  User,
  Wallet,
} from "../shared/types";
import { ApiError, post, refreshAll } from "./api";
import { protectionForQuote } from "./order-protection";
import { cents, credits, errorMessage, percent, uid } from "./utils";
import { Badge, ErrorNote, Loading, Modal } from "./ui";

export function TradeTicket({
  market,
  outcome,
  setOutcome,
  wallet,
  user,
  book,
  positions,
  onSignIn,
  onOrders,
  tradingEnabled = true,
  bookError,
  onRefreshBook,
}: {
  market?: Market;
  outcome?: Outcome;
  setOutcome: (id: string) => void;
  wallet?: Wallet;
  user: User | null;
  book?: OrderBook;
  positions: Position[];
  onSignIn: () => void;
  onOrders: () => void;
  tradingEnabled?: boolean;
  bookError?: string;
  onRefreshBook?: () => void;
}) {
  const [side, setSide] = useState<Side>("BUY"),
    [mode, setMode] = useState<"IOC" | "GTC" | "GTD">("IOC");
  const [quantity, setQuantity] = useState("10"),
    [price, setPrice] = useState("50"),
    [cap, setCap] = useState(""),
    [expires, setExpires] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submission = useRef<{ key: string; body: OrderInput } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<OrderReceipt | null>(null),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setQuote(null);
    setReview(false);
    setError("");
    setReceipt(null);
    if (outcome) setPrice((outcome.probability * 100).toFixed(2));
    if (
      market?.exchange === "LIVE" &&
      market.executionModel !== "SOURCE_SEEDED_LMSR"
    )
      setMode("IOC");
  }, [market?.id, market?.executionModel, outcome?.id, side, mode]);
  useEffect(() => {
    setQuote(null);
    setError("");
    setReceipt(null);
  }, [quantity, price, cap, expires]);
  const amount = Number(quantity),
    limit = Number(price) / 100;
  const hasMarketHoldings = positions.some(
    (p) => p.marketId === market?.id && p.quantity > 0,
  );
  useEffect(() => {
    if (!hasMarketHoldings && !uncertain) setSide("BUY");
  }, [hasMarketHoldings, uncertain]);
  const position = positions.find(
    (p) => p.marketId === market?.id && p.outcomeId === outcome?.id,
  );
  const availableShares = Math.max(
    0,
    (position?.quantity || 0) - (position?.locked || 0),
  );
  const stale =
    !!book?.stale ||
    (market?.exchange === "LIVE" &&
      !!book &&
      now - new Date(book.timestamp).getTime() > 5000);
  const isOpen =
    market?.status === "OPEN" && new Date(market.closeAt).getTime() > now;
  const valid =
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount <= 1000 &&
    (mode === "IOC" || (limit > 0 && limit < 1)) &&
    (!cap || (Number(cap) > 0 && Number.isFinite(Number(cap)))) &&
    (mode !== "GTD" || (!!expires && new Date(expires).getTime() > now));
  const quoteExpired = !!quote && new Date(quote.expiresAt).getTime() <= now;
  const estimate =
    amount * (mode === "IOC" ? outcome?.probability || 0 : limit);
  const expirySeconds = quote
    ? Math.max(0, Math.ceil((new Date(quote.expiresAt).getTime() - now) / 1000))
    : 0;
  const effectiveLimit =
    mode === "IOC" ? (side === "BUY" ? 0.9999 : 0.0001) : limit;
  // Round conservatively to the server's six-decimal credit precision.
  const quoteProtection =
    quote && quote.filledQuantity > 0
      ? protectionForQuote(quote, side)
      : undefined;
  const protectedCash =
    (side === "BUY"
      ? quoteProtection?.maxTotalCost
      : quoteProtection?.minTotalProceeds) ?? "0";
  const defaultProtection =
    mode === "IOC" || side === "SELL"
      ? protectedCash
      : (Math.ceil(amount * limit * 1e6) / 1e6).toFixed(6);
  const hardProtection = cap || defaultProtection;
  const requestQuote = async () => {
    if (!user) {
      onSignIn();
      return;
    }
    if (submission.current) {
      await confirm();
      return;
    }
    if (!market || !outcome) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<Quote>(`/markets/${market.id}/quote`, {
        outcomeId: outcome.id,
        side,
        quantity: amount,
        limitPrice: effectiveLimit.toFixed(4),
      });
      setQuote(result);
      setReview(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!submission.current && (!quote || !market || !outcome || quoteExpired))
      return;
    if (!submission.current)
      submission.current = {
        key: uid(),
        body: {
          marketId: market!.id,
          outcomeId: outcome!.id,
          side,
          quantity: amount,
          limitPrice: effectiveLimit.toFixed(4),
          timeInForce: mode,
          engineVersion: quote!.engineVersion ?? 1,
          ...(mode === "IOC" ? quoteProtection : {}),
          ...(side === "BUY"
            ? { maxTotalCost: hardProtection }
            : { minTotalProceeds: hardProtection }),
          ...(mode === "GTD"
            ? { expiresAt: new Date(expires).toISOString() }
            : {}),
          quoteId: quote!.id,
          expectedSequence: quote!.sequence,
        },
      };
    setBusy(true);
    setError("");
    try {
      // Retry the exact same confirmed payload with the same key, even after a lost response.
      const result = await post<OrderReceipt>(
        "/orders",
        submission.current.body,
        { "Idempotency-Key": submission.current.key },
      );
      submission.current = null;
      setUncertain(false);
      setReceipt(result);
      setQuote(null);
      setReview(false);
      refreshAll();
    } catch (reason) {
      setReview(false);
      if (
        !uncertain &&
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        reason.status !== 408
      ) {
        submission.current = null;
        setUncertain(false);
        setQuote(null);
        setError(
          `${errorMessage(reason)} No new order was accepted; refresh the quote to try again.`,
        );
        refreshAll();
        return;
      }
      setUncertain(true);
      setError(
        `${errorMessage(reason)} Retry checks the original confirmed order, even if you change the selected market; it cannot place a duplicate.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="trade-ticket" aria-label="Order ticket">
      <header className="ticket-header">
        <h2>Make a prediction</h2>
      </header>
      <div className="ticket-content">
        {hasMarketHoldings && (
          <div className={`side-switch ${side.toLowerCase()}`}>
            <button
              disabled={uncertain || busy}
              onClick={() => setSide("BUY")}
              className={side === "BUY" ? "selected" : ""}
            >
              Buy
            </button>
            <button
              disabled={uncertain || busy}
              onClick={() => setSide("SELL")}
              className={side === "SELL" ? "selected" : ""}
            >
              Sell
            </button>
          </div>
        )}
        <label className="ticket-label">Choose your outcome</label>
        <div className="ticket-outcomes">
          {market?.outcomes.map((item, i) => (
            <button
              key={item.id}
              disabled={uncertain || busy}
              aria-pressed={outcome?.id === item.id}
              className={`${i === 1 ? "no" : "yes"} ${outcome?.id === item.id ? "selected" : ""}`}
              onClick={() => setOutcome(item.id)}
            >
              <span>{item.label}</span>
              <strong>{cents(item.probability)}</strong>
            </button>
          ))}
        </div>
        <div className="outcome-select" hidden>
          <select
            aria-label="Trade outcome"
            value={outcome?.id || ""}
            onChange={(event) => setOutcome(event.target.value)}
            disabled={!market || uncertain || busy}
          >
            {market?.outcomes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            )) || <option>Select a market</option>}
          </select>
          <ChevronDown size={13} />
        </div>
        <label className="ticket-label" htmlFor="order-quantity">
          Number of shares<span>1–1,000</span>
        </label>
        <div className="ticket-input">
          <input
            id="order-quantity"
            disabled={uncertain || busy}
            type="number"
            min="1"
            max="1000"
            step="1"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
          <span>shares</span>
        </div>
        <div className="quick-sizes">
          {[10, 50, 100].map((size) => (
            <button
              key={size}
              disabled={uncertain || busy}
              onClick={() => setQuantity(String(size))}
            >
              {size}
            </button>
          ))}
          <button
            onClick={() =>
              setQuantity(
                String(
                  Math.min(
                    1000,
                    side === "SELL"
                      ? Math.floor(availableShares)
                      : Math.max(
                          0,
                          Math.floor(
                            Number(wallet?.available || 0) /
                              Math.max(outcome?.probability || 0.5, 0.001),
                          ),
                        ),
                  ),
                ),
              )
            }
            disabled={!user || uncertain || busy}
          >
            Max
          </button>
        </div>
        <div className="trade-estimate">
          <div>
            <span>Estimated {side === "BUY" ? "cost" : "proceeds"}</span>
            <strong>
              {valid && market ? credits(estimate) : "—"} <small>CR</small>
            </strong>
          </div>
          <div>
            <span>Available {side === "BUY" ? "credit" : "shares"}</span>
            <span>
              {user
                ? side === "BUY"
                  ? `${credits(wallet?.available)} CR`
                  : availableShares.toLocaleString()
                : "Sign in"}
            </span>
          </div>
          <div>
            <span>
              {side === "BUY"
                ? "Payout if you’re right"
                : "Payout per winning share"}
            </span>
            <span>{side === "BUY" ? credits(amount, 0) : "1"} credits</span>
          </div>
        </div>
        <ErrorNote message={error} />
        {!tradingEnabled && (
          <div className="warning-note">
            Exchange trading is paused for operational review. Committed orders
            and balances remain available.
          </div>
        )}
        {uncertain && (
          <button
            className="inline-link"
            onClick={() => {
              submission.current = null;
              setUncertain(false);
              setQuote(null);
              setReview(false);
              setError(
                "Previous confirmation may have completed. Check Orders before placing a new order.",
              );
              onOrders();
            }}
          >
            Check orders and start a new order
          </button>
        )}
        {stale && (
          <div className="warning-note">
            <Info size={13} />
            Waiting for a fresh source price. Trading will resume automatically.
          </div>
        )}
        {user && !book && isOpen && (
          <div className="warning-note">
            {bookError || "Getting the latest price…"}
            {bookError && onRefreshBook && (
              <button className="inline-link" onClick={onRefreshBook}>
                Retry
              </button>
            )}
          </div>
        )}
        {market && !isOpen && (
          <div className="warning-note">
            {market.status === "OPEN"
              ? "Trading has closed for this market."
              : `Market is ${market.status.toLowerCase().replaceAll("_", " ")}.`}
          </div>
        )}
        <div className="trade-submit-wrap">
          <button
            className={`trade-submit ${side.toLowerCase()}`}
            onClick={() => void requestQuote()}
            disabled={
              busy ||
              (!uncertain &&
                (!market ||
                  !outcome ||
                  (!!user &&
                    (!valid || stale || !book || !isOpen || !tradingEnabled))))
            }
          >
            {busy ? (
              <Loading>Getting quote…</Loading>
            ) : uncertain ? (
              <>
                Retry confirmed order
                <ArrowRight size={14} />
              </>
            ) : !user ? (
              <>
                <LockKeyhole size={13} /> Sign in to trade
              </>
            ) : (
              <>
                {side === "BUY" ? "Review prediction" : "Review sale"}
                <ArrowRight size={16} />
              </>
            )}
          </button>
          <div className="ticket-disclaimer">
            Fictional credits. No deposits. No cash value.
          </div>
        </div>
        {receipt && (
          <div className="receipt" role="status">
            <Check size={15} />
            <div>
              <strong>
                {receipt.order.status === "OPEN"
                  ? "Limit order placed"
                  : "Order submitted"}
              </strong>
              <p>
                {receipt.fills.length} fill
                {receipt.fills.length === 1 ? "" : "s"} ·{" "}
                {receipt.order.filledQuantity} / {receipt.order.quantity} shares
              </p>
              <button className="inline-link" onClick={onOrders}>
                View orders <ArrowRight size={11} />
              </button>
            </div>
          </div>
        )}
        <details className="trade-protection">
          <summary>
            <ShieldCheck size={12} />
            Order options
            <ChevronDown size={12} />
          </summary>
          {(market?.exchange === "FRIENDS" ||
            market?.executionModel === "SOURCE_SEEDED_LMSR") && (
            <label className="limit-order-toggle">
              <input
                type="checkbox"
                checked={mode !== "IOC"}
                disabled={uncertain || busy}
                onChange={(event) =>
                  setMode(event.target.checked ? "GTC" : "IOC")
                }
              />
              Set a limit price
            </label>
          )}
          {mode !== "IOC" && (
            <>
              <label className="ticket-label" htmlFor="limit-price">
                Limit price<span>0.01–99.99¢</span>
              </label>
              <div className="ticket-input">
                <input
                  id="limit-price"
                  type="number"
                  min="0.01"
                  max="99.99"
                  step="0.01"
                  disabled={uncertain || busy}
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
                <span>¢</span>
              </div>
              <label className="ticket-label" htmlFor="time-in-force">
                Time in force
              </label>
              <select
                className="ticket-select"
                id="time-in-force"
                disabled={uncertain || busy}
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as "GTC" | "GTD")
                }
              >
                <option value="GTC">Good until canceled</option>
                <option value="GTD">Good until date</option>
              </select>
              {mode === "GTD" && (
                <input
                  className="ticket-select"
                  aria-label="Order expiry"
                  disabled={uncertain || busy}
                  type="datetime-local"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                />
              )}
            </>
          )}
          <label className="ticket-label" htmlFor="order-cap">
            {side === "BUY"
              ? "Maximum total spend"
              : "Minimum immediate proceeds"}
            <span>Optional</span>
          </label>
          <div className="ticket-input">
            <input
              id="order-cap"
              disabled={uncertain || busy}
              type="number"
              min="0.01"
              step="0.01"
              placeholder="No additional cap"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <span>CR</span>
          </div>
          <p>
            Immediate orders protect average fill price within 1% of the quote,
            subject to microcredit rounding, and require the quoted minimum
            share count. Limit orders use your entered price. Tighter credit
            caps still apply. Unfilled immediate shares are canceled.
          </p>
        </details>
      </div>
      {review && quote && (
        <Modal
          title="Review your prediction"
          eyebrow={
            market?.exchange === "LIVE"
              ? "Live practice wallet"
              : "Friends group wallet"
          }
          onClose={() => setReview(false)}
        >
          <div className="modal-body">
            <p className="review-question">{market?.question}</p>
            <div className="review-side">
              <Badge tone={side === "BUY" ? "green" : "red"}>{side}</Badge>
              <strong>
                {amount} {outcome?.label} shares
              </strong>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Quoted immediate fill</dt>
                <dd>{quote.filledQuantity} shares</dd>
              </div>
              <div>
                <dt>Average fill price</dt>
                <dd>{cents(quote.averagePrice)}</dd>
              </div>
              <div>
                <dt>Estimated {side === "BUY" ? "spend" : "proceeds"}</dt>
                <dd>{credits(quote.estimatedCash)} CR</dd>
              </div>
              <div>
                <dt>
                  {side === "BUY"
                    ? "Hard maximum spend"
                    : "Hard minimum proceeds"}
                </dt>
                <dd>{credits(hardProtection, 6)} CR</dd>
              </div>
              <div>
                <dt>Price protection</dt>
                <dd>
                  {cap
                    ? "Your custom credit cap"
                    : mode === "IOC"
                      ? "Maximum 1% quote slippage"
                      : "Your entered limit price"}
                </dd>
              </div>
              {mode === "IOC" && quoteProtection && (
                <>
                  <div>
                    <dt>Minimum received shares</dt>
                    <dd>{quoteProtection.minFillQuantity}</dd>
                  </div>
                  <div>
                    <dt>
                      {side === "BUY"
                        ? "Maximum average price"
                        : "Minimum average price"}
                    </dt>
                    <dd>
                      {cents(
                        Number(
                          side === "BUY"
                            ? quoteProtection.maxAveragePrice
                            : quoteProtection.minAveragePrice,
                        ),
                      )}
                    </dd>
                  </div>
                </>
              )}
              {side === "BUY" && (
                <>
                  <div>
                    <dt>
                      If {mode === "IOC" ? "quoted" : "all requested"} shares
                      win
                    </dt>
                    <dd>
                      {credits(mode === "IOC" ? quote.filledQuantity : amount)}{" "}
                      CR payout
                    </dd>
                  </div>
                  <div>
                    <dt>If outcome loses</dt>
                    <dd>0.00 CR payout</dd>
                  </div>
                  <div>
                    <dt>If those shares are voided</dt>
                    <dd>
                      {credits(
                        (mode === "IOC" ? quote.filledQuantity : amount) * 0.5,
                      )}{" "}
                      CR neutral payout
                    </dd>
                  </div>
                </>
              )}
              {quote.openingProbability !== undefined && (
                <div>
                  <dt>Opening OpenTrader odds</dt>
                  <dd>{percent(quote.openingProbability)}</dd>
                </div>
              )}
              <div>
                <dt>Probability after fill</dt>
                <dd>{percent(quote.afterProbability)}</dd>
              </div>
              <div>
                <dt>Execution sources</dt>
                <dd>
                  {quote.sources
                    .map((s) => `${s.source.toLowerCase()} ${s.quantity}`)
                    .join(" · ") || "No immediate match"}
                </dd>
              </div>
              {mode !== "IOC" && (
                <div>
                  <dt>Unfilled shares</dt>
                  <dd>Rest at {cents(limit)}</dd>
                </div>
              )}
              <div>
                <dt>Quote validity</dt>
                <dd className={quoteExpired ? "negative" : ""}>
                  {quoteExpired
                    ? "Expired — refresh quote"
                    : `${expirySeconds}s remaining`}
                </dd>
              </div>
            </dl>
            {quote.reason && <div className="warning-note">{quote.reason}</div>}
            <ErrorNote message={error} />
            <div className="dialog-actions">
              <button
                className="button"
                onClick={() => void requestQuote()}
                disabled={busy || uncertain}
              >
                Refresh quote
              </button>
              <button
                className={`button ${side === "BUY" ? "buy-button" : "sell-button"}`}
                disabled={
                  busy ||
                  (!uncertain &&
                    (!tradingEnabled ||
                      quoteExpired ||
                      stale ||
                      (mode === "IOC" && !quote.executable)))
                }
                onClick={() => void confirm()}
              >
                {busy ? (
                  <Loading>Submitting…</Loading>
                ) : uncertain ? (
                  "Retry same confirmed order"
                ) : (
                  "Confirm order"
                )}
              </button>
            </div>
            <p className="form-footnote">
              This transaction uses fictional credits in your{" "}
              {market?.exchange === "LIVE" ? "Live" : "selected Friends group"}{" "}
              wallet.{" "}
              {quote.openingProbability !== undefined &&
                "Opening odds use the source bid/ask midpoint, bounded to 1–99%. "}
              {market?.executionModel === "SOURCE_SEEDED_LMSR"
                ? " Your trades move OpenTrader odds. Provider odds are a separate reference. Zero transaction fees."
                : market?.exchange === "LIVE"
                  ? " Counterfactual source-book estimate. Simulation fees are zero; provider fees are not modeled."
                  : ""}
            </p>
          </div>
        </Modal>
      )}
    </aside>
  );
}
