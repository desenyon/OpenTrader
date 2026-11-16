import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Flag,
  MessageSquare,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  Comment,
  Fill,
  Group,
  Market,
  Order,
  OrderBook,
  Outcome,
  Position,
  User,
} from "../shared/types";
import { api, post, refreshAll, useResource } from "./api";
import { ReportDialog } from "./Moderation";
import { cents, credits, date, errorMessage, short } from "./utils";
import {
  ActionForm,
  Badge,
  Empty,
  ErrorNote,
  Field,
  IconButton,
  Modal,
} from "./ui";

export type TerminalTab =
  | "activity"
  | "positions"
  | "orders"
  | "book"
  | "rules"
  | "discussion"
  | "forecast";
const tabNames: Record<TerminalTab, string> = {
  activity: "Activity",
  positions: "Positions",
  orders: "Orders",
  book: "Order book",
  rules: "About",
  discussion: "Discussion",
  forecast: "Your forecast",
};
export function MarketTables({
  tab,
  setTab,
  market,
  outcome,
  book,
  orders,
  positions,
  user,
  group,
  onSignIn,
  onMarket,
  onJournal,
  tabs = Object.keys(tabNames) as TerminalTab[],
}: {
  tabs?: TerminalTab[];
  tab: TerminalTab;
  setTab: (tab: TerminalTab) => void;
  market?: Market;
  outcome?: Outcome;
  book?: OrderBook;
  orders: Order[];
  positions: Position[];
  user: User | null;
  group?: Group;
  onSignIn: () => void;
  onMarket: (id: string) => void;
  onJournal: () => void;
}) {
  const fills = useResource<Fill[]>(
    market && user && tab === "activity" ? `/markets/${market.id}/fills` : null,
    5000,
  );
  const [error, setError] = useState(""),
    [canceling, setCanceling] = useState("");
  const cancel = async (id: string) => {
    setCanceling(id);
    setError("");
    try {
      await api(`/orders/${id}`, { method: "DELETE" });
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCanceling("");
    }
  };
  const openOrders = orders.filter(
    (o) =>
      o.timeInForce !== "IOC" &&
      ["OPEN", "PARTIAL", "PARTIALLY_FILLED", "PENDING"].includes(o.status),
  );
  return (
    <section
      className={`terminal-tables tab-${tab}`}
      aria-label="Market information"
    >
      <header className="table-tabs">
        <div role="tablist" aria-label="Market sections">
          {tabs.map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {tabNames[key]}
              {key === "orders" && openOrders.length > 0 && (
                <span className="tab-count">{openOrders.length}</span>
              )}
            </button>
          ))}
        </div>
      </header>
      <ErrorNote message={error} />
      <div className="table-panel" role="tabpanel">
        {tab === "activity" && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Outcome</th>
                    <th>Shares</th>
                    <th>Price</th>
                    <th>Total · CR</th>
                    <th>Source</th>
                    <th>Trader</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.data?.map((fill) => (
                    <tr key={fill.id}>
                      <td>{date(fill.createdAt)}</td>
                      <td
                        className={
                          fill.side === "BUY" ? "positive" : "negative"
                        }
                      >
                        {fill.side === "BUY" ? "Buy" : "Sell"}
                      </td>
                      <td>
                        {market?.outcomes.find((o) => o.id === fill.outcomeId)
                          ?.label || short(fill.outcomeId)}
                      </td>
                      <td>{fill.quantity.toLocaleString()}</td>
                      <td>{cents(fill.price)}</td>
                      <td>{credits(fill.cash)}</td>
                      <td>
                        <span className="source-dot" />
                        {fill.source.toLowerCase()}
                      </td>
                      <td className="muted">
                        {fill.handle ? `@${fill.handle}` : "Private"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!fills.data?.length && (
              <Empty
                title={
                  fills.loading ? "Loading activity…" : "No exchange fills yet"
                }
                detail={
                  fills.error ||
                  (!user
                    ? "Sign in to view your exchange fills."
                    : market?.executionModel === "SOURCE_SEEDED_LMSR"
                      ? "OpenTrader trades in this market appear here."
                      : market?.exchange === "LIVE"
                        ? "Your simulated fills appear here. External market volume is shown above."
                        : "Trades by this group will appear here in real time.")
                }
              />
            )}
          </>
        )}
        {tab === "positions" &&
          (!user ? (
            <SignInEmpty onSignIn={onSignIn} />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Market / outcome</th>
                      <th>Shares</th>
                      <th>Cost basis · CR</th>
                      <th>Mark</th>
                      <th>Indicative · CR</th>
                      <th>Liquidation · CR</th>
                      <th>Unrealized · CR</th>
                      <th>Realized · CR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={`${p.marketId}-${p.outcomeId}`}>
                        <td className="market-cell">
                          <button onClick={() => onMarket(p.marketId)}>
                            {p.question}
                          </button>
                          <span>
                            {p.outcomeLabel}
                            {p.locked > 0 ? ` · ${p.locked} locked` : ""}
                          </span>
                        </td>
                        <td>{p.quantity.toLocaleString()}</td>
                        <td>{credits(p.costBasis)}</td>
                        <td>{cents(p.markPrice)}</td>
                        <td>{credits(p.indicativeValue)}</td>
                        <td
                          title={
                            p.valuationNote ||
                            (p.valuationAt
                              ? `Snapshot ${date(p.valuationAt)}`
                              : undefined)
                          }
                        >
                          {p.liquidationAvailable === false ? (
                            <span className="muted">Unavailable</span>
                          ) : (
                            credits(p.liquidationValue)
                          )}
                        </td>
                        <td
                          className={
                            Number(p.unrealizedPnl) >= 0
                              ? "positive"
                              : "negative"
                          }
                        >
                          {Number(p.unrealizedPnl) > 0 ? "+" : ""}
                          {credits(p.unrealizedPnl)}
                        </td>
                        <td
                          className={
                            Number(p.realizedPnl) >= 0 ? "positive" : "negative"
                          }
                        >
                          {credits(p.realizedPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!positions.length && (
                <Empty
                  title="No positions yet"
                  detail="Your holdings in this exchange will appear here after a fill."
                />
              )}
            </>
          ))}
        {tab === "orders" &&
          (!user ? (
            <SignInEmpty onSignIn={onSignIn} />
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Created</th>
                      <th>Market / outcome</th>
                      <th>Side</th>
                      <th>Filled / quantity</th>
                      <th>Limit</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id}>
                        <td>{date(order.createdAt)}</td>
                        <td className="market-cell">
                          <button onClick={() => onMarket(order.marketId)}>
                            {order.question || short(order.marketId)}
                          </button>
                          <span>
                            {order.outcomeLabel || short(order.outcomeId)}
                          </span>
                        </td>
                        <td
                          className={
                            order.side === "BUY" ? "positive" : "negative"
                          }
                        >
                          {order.side.toLowerCase()}
                        </td>
                        <td>
                          {order.filledQuantity} / {order.quantity}
                        </td>
                        <td>{cents(order.limitPrice)}</td>
                        <td
                          title={
                            order.expiresAt
                              ? `Expires ${date(order.expiresAt)}`
                              : undefined
                          }
                        >
                          {order.timeInForce}
                        </td>
                        <td>
                          <Badge
                            tone={order.status === "FILLED" ? "green" : "quiet"}
                          >
                            {order.status.replaceAll("_", " ")}
                          </Badge>
                        </td>
                        <td>
                          {openOrders.some((o) => o.id === order.id) && (
                            <button
                              className="cancel-button"
                              onClick={() => void cancel(order.id)}
                              disabled={canceling === order.id}
                            >
                              <Trash2 size={11} />
                              {canceling === order.id ? "Canceling" : "Cancel"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!orders.length && (
                <Empty
                  title="No orders yet"
                  detail="Market and limit orders in this exchange appear here."
                />
              )}
            </>
          ))}
        {tab === "book" && <OrderBookPanel book={book} outcome={outcome} />}
        {tab === "rules" && (
          <MarketRules market={market} user={user} group={group} />
        )}
        {tab === "discussion" && (
          <Discussion market={market} user={user} onSignIn={onSignIn} />
        )}
        {tab === "forecast" && (
          <Forecast market={market} user={user} onSignIn={onSignIn} />
        )}
      </div>
    </section>
  );
}
function SignInEmpty({ onSignIn }: { onSignIn: () => void }) {
  return (
    <Empty
      title="Sign in to see your account"
      detail="Sign in to view your separate credit wallets, orders, and positions."
      action={
        <button className="button small" onClick={onSignIn}>
          Sign in <ArrowRight size={12} />
        </button>
      }
    />
  );
}
export function OrderBookPanel({
  book,
  outcome,
}: {
  book?: OrderBook;
  outcome?: Outcome;
}) {
  const bids = book?.bids || [],
    asks = book?.asks || [],
    max = Math.max(...[...bids, ...asks].map((l) => l.quantity), 1);
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : undefined;
  return (
    <div className="book-panel">
      <div className="book-info">
        <span>{outcome?.label || "Outcome"} DEPTH</span>
        <span>
          Spread <b>{cents(spread)}</b>
        </span>
        <Badge tone={book?.stale ? "amber" : "quiet"}>
          {book?.stale ? "STALE" : book?.source || "WAITING"}
        </Badge>
      </div>
      <div className="book-columns">
        <div>
          <div className="book-column-label positive">
            <span>BID · ¢</span>
            <span>SHARES</span>
            <span>SOURCE</span>
          </div>
          {bids.slice(0, 10).map((level, i) => (
            <div className="book-level" key={i}>
              <i
                className="bid-bar"
                style={{
                  width: `${Math.max(1, (level.quantity / max) * 100)}%`,
                }}
              />
              <span className="positive">{cents(level.price)}</span>
              <span>
                {level.quantity.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>
              <span className="muted">{level.source.toLowerCase()}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="book-column-label negative">
            <span>ASK · ¢</span>
            <span>SHARES</span>
            <span>SOURCE</span>
          </div>
          {asks.slice(0, 10).map((level, i) => (
            <div className="book-level" key={i}>
              <i
                className="ask-bar"
                style={{
                  width: `${Math.max(1, (level.quantity / max) * 100)}%`,
                }}
              />
              <span className="negative">{cents(level.price)}</span>
              <span>
                {level.quantity.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>
              <span className="muted">{level.source.toLowerCase()}</span>
            </div>
          ))}
        </div>
      </div>
      {!bids.length && !asks.length && (
        <Empty
          title="No executable depth"
          detail="The source has no available orders for this outcome."
        />
      )}
      <div className="book-footnote">
        {book ? `Source timestamp ${date(book.timestamp)} · ` : ""}Displayed
        depth is indicative until a protected quote is confirmed.
      </div>
    </div>
  );
}
function MarketRules({
  market,
  user,
  group,
}: {
  market?: Market;
  user: User | null;
  group?: Group;
}) {
  const [dialog, setDialog] = useState(""),
    [error, setError] = useState("");
  type Correction = {
    id: string;
    marketId: string;
    outcomeId: string | null;
    evidence: string;
    rationale: string;
    proposedBy: string;
    approvals: string[];
    state: string;
  };
  const settled = !!market && ["RESOLVED", "VOID"].includes(market.status);
  const corrections = useResource<Correction[]>(
    user && market && settled ? `/markets/${market.id}/corrections` : null,
    15000,
  );
  const permissions = useResource<{ liveCorrectionReview: boolean }>(
    user && market?.exchange === "LIVE" && settled ? "/permissions" : null,
  );
  const [approving, setApproving] = useState("");
  const approveCorrection = async (id: string) => {
    setApproving(id);
    setError("");
    try {
      await post(`/corrections/${id}/approve`);
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setApproving("");
    }
  };
  if (!market) return <Empty title="Select a market to inspect its rules" />;
  const rules = market.rules,
    resolution = market.resolution;
  const admin = group && ["OWNER", "MODERATOR"].includes(group.role);
  const govern = async (action: string) => {
    setError("");
    try {
      await post(`/markets/${market.id}/${action}`);
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  return (
    <div className="rules-panel">
      <div className="rules-main">
        <div className="rules-title">
          <ShieldCheck size={15} />
          <strong>How this market resolves</strong>
          <Badge>{market.status}</Badge>
          {market.sourceUrl && (
            <a href={market.sourceUrl} target="_blank" rel="noreferrer">
              Source market <ExternalLink size={11} />
            </a>
          )}
        </div>
        <p>
          {rules?.condition ||
            market.description ||
            "See the original market source for the complete resolution condition."}
        </p>
        {market.executionModel === "SOURCE_SEEDED_LMSR" && (
          <p>
            External odds set the opening price. OpenTrader credit trades then
            move our odds through a fixed-liquidity market maker and peer
            orders. Provider odds remain a separate live reference. A winning
            share pays 1 CR; provider-confirmed voids pay 0.50 CR per share. No
            order reaches the provider.
            {market.pricing?.active && (
              <>
                {" "}
                Liquidity b = {market.b}; maximum sponsor subsidy{" "}
                {credits(market.pricing.maximumSubsidy)} CR, funded before
                trading.
              </>
            )}
          </p>
        )}
        <div className="rules-grid">
          <div>
            <small>Source of truth</small>
            {rules?.source ? (
              /^https?:\/\//.test(rules.source) ? (
                <a href={rules.source} target="_blank" rel="noreferrer">
                  {rules.source}
                  <ExternalLink size={10} />
                </a>
              ) : (
                <span>{rules.source}</span>
              )
            ) : market.sourceUrl ? (
              <a href={market.sourceUrl} target="_blank" rel="noreferrer">
                {market.provider}
                <ExternalLink size={10} />
              </a>
            ) : (
              <span>Defined in market description</span>
            )}
          </div>
          <div>
            <small>Trading closes</small>
            <span>{date(market.closeAt)}</span>
          </div>
          {rules && (
            <>
              <div>
                <small>Observation and disputes</small>
                <span>
                  {date(rules.observationAt)} · {rules.disputeHours}h window
                </span>
              </div>
              <div>
                <small>If the market is voided</small>
                <span>{rules.voidPolicy}</span>
              </div>
              <div>
                <small>Required evidence</small>
                <span>{rules.evidence}</span>
              </div>
            </>
          )}
        </div>
        {resolution && (
          <div className="resolution-status">
            <Badge tone="amber">{resolution.state}</Badge>
            <strong>
              {market.outcomes.find((o) => o.id === resolution.outcomeId)
                ?.label || "Void"}
            </strong>
            <p>{resolution.rationale}</p>
            <span>Evidence: {resolution.evidence}</span>
            <small>
              Dispute window ends {date(resolution.disputeUntil)} ·{" "}
              {resolution.disputes.length} disputes ·{" "}
              {resolution.reviews.length} reviews
            </small>
            {resolution.disputes.map((d) => (
              <blockquote key={d.id}>{d.rationale}</blockquote>
            ))}
          </div>
        )}
        {corrections.data?.map((correction) => (
          <div className="correction-case" key={correction.id}>
            <div>
              <Badge tone={correction.state === "APPLIED" ? "green" : "amber"}>
                {correction.state} CORRECTION
              </Badge>
              <strong>
                {market.outcomes.find((o) => o.id === correction.outcomeId)
                  ?.label || "Neutral void"}
              </strong>
            </div>
            <p>{correction.rationale}</p>
            <p className="muted">Evidence: {correction.evidence}</p>
            <small>
              {correction.approvals.length} / 2 independent approvals · changes
              are funded from finite reserves
            </small>
            {user &&
              correction.state === "PENDING" &&
              correction.proposedBy !== user.id &&
              ((market.exchange === "LIVE" &&
                permissions.data?.liveCorrectionReview) ||
                rules?.reviewerIds.includes(user.id)) && (
                <button
                  className="button small"
                  disabled={
                    approving === correction.id ||
                    correction.approvals.includes(user.id)
                  }
                  onClick={() => void approveCorrection(correction.id)}
                >
                  {correction.approvals.includes(user.id)
                    ? "Your approval recorded"
                    : approving === correction.id
                      ? "Reviewing…"
                      : "Approve correction"}
                </button>
              )}
          </div>
        ))}
        <ErrorNote message={error || corrections.error} />
      </div>
      {market.exchange === "FRIENDS" && user && (
        <div className="rules-actions">
          {admin && market.status === "HALTED" && (
            <button
              className="button small"
              onClick={() => setDialog("resume")}
            >
              Resume trading
            </button>
          )}
          {admin &&
            market.creatorId !== user.id &&
            ["DRAFT", "PENDING", "PENDING_APPROVAL"].includes(
              market.status,
            ) && (
              <button
                className="button small"
                onClick={() => void govern("approve")}
              >
                <CheckCircle2 size={12} />
                Approve market
              </button>
            )}
          {admin &&
            market.status === "OPEN" &&
            Date.now() >= Date.parse(market.closeAt) && (
              <button
                className="button small"
                onClick={() => setDialog("close")}
              >
                Close trading
              </button>
            )}
          {(market.resolverId === user.id || rules?.resolverId === user.id) &&
            market.status === "CLOSED" && (
              <button
                className="button small"
                onClick={() => setDialog("resolution")}
                disabled={
                  Date.now() <
                  Math.max(
                    Date.parse(market.closeAt),
                    Date.parse(rules?.observationAt ?? market.closeAt),
                  )
                }
                title="Resolution is available after trading closes and the observation window ends"
              >
                Propose resolution
              </button>
            )}
          {resolution &&
            market.status === "RESOLVING" &&
            !["FINAL", "SETTLED", "RESOLVED"].includes(resolution.state) && (
              <>
                <button
                  className="button small"
                  onClick={() => setDialog("disputes")}
                >
                  Dispute resolution
                </button>
                {rules?.reviewerIds.includes(user.id) &&
                  resolution.state === "DISPUTED" && (
                    <button
                      className="button small"
                      onClick={() => setDialog("review")}
                    >
                      Review resolution
                    </button>
                  )}
              </>
            )}
          {settled && market.creatorId !== user.id && (
            <button
              className="button small"
              onClick={() => setDialog("corrections")}
            >
              Propose correction
            </button>
          )}
          <span className="form-footnote">
            All governance actions are journaled. Resolvers and reviewers must
            never have traded this market.
          </span>
        </div>
      )}
      {dialog && (
        <Modal
          title={
            dialog === "resolution"
              ? "Propose a resolution"
              : dialog === "disputes"
                ? "Challenge this resolution"
                : dialog === "close"
                  ? "Close trading"
                  : dialog === "resume"
                    ? "Resume trading"
                    : dialog === "corrections"
                      ? "Propose a funded correction"
                      : "Independent review"
          }
          eyebrow={market.question}
          onClose={() => setDialog("")}
        >
          <div className="modal-body">
            <ActionForm
              submitLabel={
                dialog === "close" ? "Close trading now" : "Submit for review"
              }
              onSubmit={(form) =>
                post(
                  `/markets/${market.id}/${dialog}`,
                  dialog === "close"
                    ? {}
                    : ["resolution", "corrections"].includes(dialog)
                      ? {
                          outcomeId: form.get("outcomeId") || null,
                          evidence: form.get("evidence"),
                          rationale: form.get("rationale"),
                          ...(form.get("determinedAt")
                            ? {
                                determinedAt: new Date(
                                  String(form.get("determinedAt")),
                                ).toISOString(),
                              }
                            : {}),
                        }
                      : dialog === "review"
                        ? {
                            decision: form.get("decision"),
                            rationale: form.get("rationale"),
                          }
                        : { rationale: form.get("rationale") },
                )
              }
              onSuccess={() => {
                refreshAll();
                setDialog("");
              }}
            >
              {dialog === "corrections" && (
                <div className="warning-note">
                  A documented correction needs two independent approvals and
                  sufficient finite reserves. Historical records are retained.
                  Anyone who ever traded this market cannot propose or approve a
                  correction.
                </div>
              )}
              {dialog === "close" ? (
                <p className="dialog-intro">
                  This applies the frozen trading deadline and cancels open
                  orders. Resolution follows the market’s published rules.
                </p>
              ) : (
                <>
                  {dialog === "review" && (
                    <Field label="Decision">
                      <select name="decision">
                        <option value="CONFIRM">Confirm proposal</option>
                        <option value="REJECT">
                          Reject proposal → neutral void
                        </option>
                        <option value="VOID">Void market</option>
                      </select>
                    </Field>
                  )}
                  {["resolution", "corrections"].includes(dialog) && (
                    <Field label="Resolved outcome">
                      <select name="outcomeId">
                        {market.outcomes.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                        <option value="">Void / no determinable outcome</option>
                      </select>
                    </Field>
                  )}
                  {dialog === "resolution" && (
                    <Field
                      label="Public answer first known at (optional)"
                      hint="Only forecasts made before this known past timestamp can be scored. Omit it if the earliest public answer time cannot be established."
                    >
                      <input name="determinedAt" type="datetime-local" />
                    </Field>
                  )}
                  {["resolution", "corrections"].includes(dialog) && (
                    <Field label="Evidence / authoritative source">
                      <textarea
                        name="evidence"
                        required
                        minLength={5}
                        rows={3}
                        placeholder="Link to and quote the evidence required by the rules."
                      />
                    </Field>
                  )}
                  <Field label="Rationale">
                    <textarea
                      name="rationale"
                      required
                      minLength={10}
                      rows={3}
                      placeholder="Explain how the evidence satisfies the published condition."
                    />
                  </Field>
                </>
              )}
            </ActionForm>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Discussion({
  market,
  user,
  onSignIn,
}: {
  market?: Market;
  user: User | null;
  onSignIn: () => void;
}) {
  const rows = useResource<Comment[]>(
    market && user ? `/markets/${market.id}/comments` : null,
    10000,
  );
  const [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reportCommentId, setReportCommentId] = useState<string | null>(null);
  const submit = async () => {
    if (!market || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      await post(`/markets/${market.id}/comments`, { body });
      setBody("");
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="discussion-panel">
      <div className="comment-list">
        {rows.data?.map((row) => (
          <article className="comment" key={row.id}>
            <span className="member-avatar">
              {row.handle.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <header>
                <strong>@{row.handle}</strong>
                <span>{date(row.createdAt)}</span>
                {market?.exchange === "FRIENDS" && (
                  <IconButton
                    label={`Report comment by ${row.handle}`}
                    onClick={() => setReportCommentId(row.id)}
                  >
                    <Flag size={11} />
                  </IconButton>
                )}
              </header>
              <p>{row.body}</p>
            </div>
          </article>
        ))}
        {!rows.data?.length && (
          <Empty
            title="Have a different read?"
            detail={
              rows.error ||
              "Share your reasoning, sources, and counterarguments."
            }
          />
        )}
      </div>
      <ErrorNote message={error} />
      {user && market ? (
        <form
          className="comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={2000}
            placeholder="Add your read on this market…"
            aria-label="Comment"
            required
          />
          <button
            type="submit"
            className="button small"
            disabled={busy || !body.trim()}
          >
            <Send size={12} />
            Post
          </button>
        </form>
      ) : (
        <button className="comment-signin" onClick={onSignIn}>
          <MessageSquare size={13} />
          Sign in to join the discussion
          <ArrowRight size={12} />
        </button>
      )}
      {reportCommentId && market && (
        <ReportDialog
          market={market}
          commentId={reportCommentId}
          onClose={() => setReportCommentId(null)}
        />
      )}
    </div>
  );
}
function Forecast({
  market,
  user,
  onSignIn,
}: {
  market?: Market;
  user: User | null;
  onSignIn: () => void;
}) {
  const [value, setValue] = useState("50"),
    [saved, setSaved] = useState(false);
  if (!market) return <Empty title="Select a market to make a forecast" />;
  if (!user) return <SignInEmpty onSignIn={onSignIn} />;
  return (
    <div className="forecast-panel">
      <div>
        <small>YOUR INDEPENDENT FORECAST</small>
        <h3>What do you think the chances are?</h3>
        <p>
          Forecast the probability of{" "}
          <strong>{market.outcomes[0]?.label || "YES"}</strong>. Calibration is
          scored separately from trading profit after resolution.
        </p>
        <span className="form-footnote">
          A forecast spends no credits. Update it as your evidence changes.
        </span>
      </div>
      <ActionForm
        submitLabel={saved ? "Update forecast" : "Record forecast"}
        onSubmit={() =>
          post(`/markets/${market.id}/forecast`, {
            probability: Number(value) / 100,
          })
        }
        onSuccess={() => {
          setSaved(true);
          refreshAll();
        }}
      >
        <div className="forecast-value">
          <input
            aria-label="Forecast probability"
            type="number"
            min="0.1"
            max="99.9"
            step="0.1"
            required
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setSaved(false);
            }}
          />
          <span>%</span>
        </div>
        <input
          aria-label="Probability slider"
          type="range"
          min="0.1"
          max="99.9"
          step="0.1"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
          }}
        />
        <div className="forecast-scale">
          <span>Unlikely</span>
          <span>Even odds</span>
          <span>Likely</span>
        </div>
      </ActionForm>
    </div>
  );
}
