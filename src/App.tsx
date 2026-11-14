import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  Flag,
  Globe2,
  Layers3,
  Maximize2,
  Menu,
  Moon,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Sun,
  Trophy,
  Users,
  Wallet as WalletIcon,
  X,
} from "lucide-react";
import type {
  Bootstrap,
  Exchange,
  Market,
  Order,
  OrderBook,
  Position,
} from "../shared/types";
import { post, refreshAll, useEvents, useResource } from "./api";
import { downloadJournal } from "./journal";
import { MarketChart } from "./Chart";
import {
  AuthDialog,
  CreateMarketDialog,
  GroupsDialog,
  LeaderboardDialog,
  MarketSearch,
  NotificationsDialog,
  ProfileDialog,
} from "./Dialogs";
import { MarketTables, type TerminalTab } from "./MarketTables";
import { TradeTicket } from "./TradeTicket";
import { ModerationDialog, ReportDialog } from "./Moderation";
import {
  Badge,
  Empty,
  ErrorNote,
  IconButton,
  Loading,
  Modal,
  Select,
} from "./ui";
import { cents, compact, credits, date, errorMessage, percent } from "./utils";

type Dialog =
  | "auth"
  | "search"
  | "groups"
  | "create"
  | "leaderboard"
  | "notifications"
  | "profile"
  | "help"
  | "report"
  | "moderation"
  | null;
type ProviderStatus = {
  enabled: boolean;
  providers: Record<
    string,
    {
      state: string;
      lastSuccessAt?: string | null;
      error?: string;
      dataUse?: string;
    }
  >;
  freshnessLimitMs?: number;
};
function preference(name: string, fallback: string) {
  try {
    return localStorage.getItem(`opentrader:${name}`) || fallback;
  } catch {
    return fallback;
  }
}
function savePreference(name: string, value: string) {
  try {
    localStorage.setItem(`opentrader:${name}`, value);
  } catch {
    /* Private browsing may make preferences ephemeral. */
  }
}
export default function App() {
  const [exchange, setExchange] = useState<Exchange>(() =>
    preference("exchange", "LIVE") === "FRIENDS" ? "FRIENDS" : "LIVE",
  );
  const [groupId, setGroupId] = useState(""),
    [marketId, setMarketId] = useState(""),
    [outcomeId, setOutcomeId] = useState("");
  const [theme, setTheme] = useState(() => preference("theme", "dark")),
    [dialog, setDialog] = useState<Dialog>(null),
    [tab, setTab] = useState<TerminalTab>("activity");
  const [category, setCategory] = useState("all"),
    [provider, setProvider] = useState("all"),
    [watchOnly, setWatchOnly] = useState(false),
    [expanded, setExpanded] = useState(false),
    [actionError, setActionError] = useState("");
  const [watched, setWatched] = useState<string[]>(() => {
    try {
      return JSON.parse(preference("watchlist", "[]"));
    } catch {
      return [];
    }
  });
  const [clock, setClock] = useState(new Date());
  const bootstrap = useResource<Bootstrap>("/bootstrap", 15000);
  const operational = useResource<{ tradingEnabled: boolean; reason?: string }>(
    "/exchange-status",
    15000,
  );
  const tradingEnabled =
    operational.data?.tradingEnabled !== false && !operational.error;
  const user = bootstrap.data?.user || null,
    groups = bootstrap.data?.groups || [];
  const group = groups.find((g) => g.id === groupId);
  const scope = `exchange=${exchange}${exchange === "FRIENDS" && groupId ? `&groupId=${encodeURIComponent(groupId)}` : ""}`;
  const marketsResource = useResource<Market[]>(
    exchange === "FRIENDS" && (!user || !groupId)
      ? null
      : `/markets?${scope}${provider !== "all" && exchange === "LIVE" ? `&provider=${provider}` : ""}`,
    15000,
  );
  const allMarkets = Array.isArray(marketsResource.data)
    ? marketsResource.data
    : [];
  const categories = [...new Set(allMarkets.map((m) => m.category))]
    .filter(Boolean)
    .sort();
  const visibleMarkets = allMarkets.filter(
    (m) =>
      (category === "all" || m.category === category) &&
      (!watchOnly || watched.includes(m.id)),
  );
  const defaultMarket =
    visibleMarkets.find(
      (m) =>
        m.status === "OPEN" &&
        (m.outcomes[0]?.probability || 0) > 0.05 &&
        (m.outcomes[0]?.probability || 0) < 0.95 &&
        m.liquidity > 0,
    ) ||
    visibleMarkets.find(
      (m) =>
        m.status === "OPEN" &&
        (m.outcomes[0]?.probability || 0) > 0.05 &&
        (m.outcomes[0]?.probability || 0) < 0.95,
    ) ||
    visibleMarkets[0];
  const marketFromList = marketId
    ? allMarkets.find((m) => m.id === marketId)
    : defaultMarket;
  const selectedId = marketId || defaultMarket?.id;
  useEffect(() => {
    if (!marketId && defaultMarket) setMarketId(defaultMarket.id);
  }, [marketId, defaultMarket?.id]);
  const details = useResource<Market>(
    selectedId ? `/markets/${encodeURIComponent(selectedId)}` : null,
    15000,
  );
  const market =
    details.data?.id === selectedId ? details.data : marketFromList;
  const outcome =
    market?.outcomes.find((o) => o.id === outcomeId) || market?.outcomes[0];
  const book = useResource<OrderBook>(
    market && outcome
      ? `/markets/${encodeURIComponent(market.id)}/book?outcomeId=${encodeURIComponent(outcome.id)}`
      : null,
    2000,
  );
  const positionsResource = useResource<Position[]>(
    user && (exchange !== "FRIENDS" || groupId) ? `/positions?${scope}` : null,
    5000,
  );
  const ordersResource = useResource<Order[]>(
    user && (exchange !== "FRIENDS" || groupId) ? `/orders?${scope}` : null,
    5000,
  );
  const watchlist = useResource<string[]>(user ? "/watchlist" : null, 15000);
  useEffect(() => {
    if (watchlist.data) setWatched(watchlist.data);
  }, [watchlist.data]);
  const status = useResource<ProviderStatus>("/live/status", 15000);
  const positions = positionsResource.data || [],
    orders = ordersResource.data || [];
  const wallet = bootstrap.data?.wallets.find(
    (w) =>
      w.exchange === exchange && (exchange === "LIVE" || w.groupId === groupId),
  );
  const holdingValue = positions.reduce(
    (sum, p) => sum + Number(p.indicativeValue),
    0,
  );
  const pnl = positions.reduce(
    (sum, p) => sum + Number(p.unrealizedPnl) + Number(p.realizedPnl),
    0,
  );
  const unread =
    bootstrap.data?.notifications.filter((n) => !n.readAt).length || 0;
  const selectMarket = useCallback((id: string) => {
    setMarketId(id);
    setOutcomeId("");
    setActionError("");
    savePreference("market", id);
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  useEvents(!!user);
  useEffect(() => {
    if (bootstrap.data && !groups.some((g) => g.id === groupId))
      setGroupId(bootstrap.data.activeGroupId || groups[0]?.id || "");
  }, [bootstrap.data, groupId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    savePreference("exchange", exchange);
    setMarketId("");
    setOutcomeId("");
    setCategory("all");
    setWatchOnly(false);
  }, [exchange, groupId]);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDialog((current) => (current === "search" ? null : "search"));
      }
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  const toggleWatch = async () => {
    if (!market) return;
    const next = watched.includes(market.id)
      ? watched.filter((id) => id !== market.id)
      : [...watched, market.id];
    if (user) {
      try {
        const response = await post<{ marketIds: string[] }>(
          `/markets/${market.id}/watch`,
        );
        setWatched(response.marketIds);
        savePreference("watchlist", JSON.stringify(response.marketIds));
        watchlist.refresh();
        return;
      } catch (reason) {
        setActionError(errorMessage(reason));
        return;
      }
    }
    setWatched(next);
    savePreference("watchlist", JSON.stringify(next));
  };
  const feed = market?.provider
    ? status.data?.providers?.[market.provider]
    : null;
  const feedReady =
    exchange === "FRIENDS" || (!!book.data && !book.data.stale && !book.error);
  const hasFeedError =
    exchange === "LIVE" &&
    !!market &&
    (book.error ||
      book.data?.stale ||
      (feed?.state &&
        !["healthy", "ready", "available", "ok", "connected"].includes(
          feed.state.toLowerCase(),
        )));
  return (
    <div className={`app-shell ${expanded ? "chart-expanded" : ""}`}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="OpenTrader home">
          <span className="brand-symbol">
            <i />
            <b>↗</b>
          </span>
          <span>
            Open<span className="brand-light">Trader</span>
            <sup>α</sup>
          </span>
        </a>
        <span className="nav-divider" />
        <nav className="main-nav" aria-label="Exchange">
          <button
            className={exchange === "LIVE" ? "active" : ""}
            onClick={() => setExchange("LIVE")}
          >
            <Radio size={13} />
            Live
          </button>
          <button
            className={exchange === "FRIENDS" ? "active" : ""}
            onClick={() => setExchange("FRIENDS")}
          >
            <Users size={13} />
            Friends
          </button>
        </nav>
        <span className="nav-divider desktop-only" />
        <nav className="secondary-nav">
          <button onClick={() => setDialog("leaderboard")}>
            <Trophy size={12} />
            Leaderboard
          </button>
          <button onClick={() => setDialog(user ? "groups" : "auth")}>
            Groups
          </button>
        </nav>
        <div className="topbar-spacer" />
        <button
          className="global-search"
          aria-label="Search markets"
          onClick={() => setDialog("search")}
        >
          <Search size={12} />
          <span>Search markets</span>
          <kbd>⌘ K</kbd>
        </button>
        <IconButton
          label={theme === "dark" ? "Use daylight theme" : "Use midnight theme"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="theme-toggle"
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </IconButton>
        <IconButton
          label={`Notifications${unread ? `, ${unread} unread` : ""}`}
          onClick={() => setDialog(user ? "notifications" : "auth")}
          className="notification-button"
        >
          <Bell size={14} />
          {unread > 0 && <i />}
        </IconButton>
        <div className="header-balance">
          <WalletIcon size={12} />
          <span>{user ? credits(wallet?.available, 0) : "—"}</span>
          <small>CR</small>
        </div>
        <button
          className={`profile-button ${user ? "signed-in" : ""}`}
          aria-label={user ? `Account for ${user.handle}` : "Sign in"}
          onClick={() => setDialog(user ? "profile" : "auth")}
        >
          {user ? (
            <>
              <span className="avatar-tiny">
                {user.handle[0]?.toUpperCase()}
              </span>
              <span>@{user.handle}</span>
              <ChevronDown size={11} />
            </>
          ) : (
            <>
              Sign in <ArrowUpRight size={12} />
            </>
          )}
        </button>
      </header>
      <div className="market-ribbon">
        <div className="ribbon-label">
          <i className="tiny-dot" />
          {exchange === "LIVE" ? "LIVE MARKETS" : "GROUP MARKETS"}
        </div>
        <div className="ticker-scroll">
          {visibleMarkets.slice(0, 24).map((m, i) => (
            <button
              key={m.id}
              className={`ticker-item ${market?.id === m.id ? "selected" : ""}`}
              onClick={() => selectMarket(m.id)}
              title={m.question}
            >
              <span className={`ticker-glyph glyph-${i % 5}`}>
                {m.category?.slice(0, 1) || "↗"}
              </span>
              <span className="ticker-question">{m.question}</span>
              <span className="ticker-probability">
                {percent(m.outcomes[0]?.probability)}
              </span>
              {watched.includes(m.id) && <Star size={9} fill="currentColor" />}
            </button>
          ))}
          {!visibleMarkets.length && (
            <span className="ribbon-empty">
              {marketsResource.loading
                ? "Connecting to markets…"
                : exchange === "FRIENDS"
                  ? "Private questions. Shared conviction."
                  : "Waiting for verified market sources"}
            </span>
          )}
        </div>
        <IconButton
          label="Browse all markets"
          onClick={() => setDialog("search")}
        >
          <Layers3 size={13} />
        </IconButton>
      </div>
      <div className="market-filterbar">
        <div className="market-breadcrumb">
          <span className={exchange === "LIVE" ? "live-icon" : "friends-icon"}>
            {exchange === "LIVE" ? <Globe2 size={12} /> : <Users size={12} />}
          </span>
          <strong>
            {exchange === "LIVE" ? "Live simulator" : "Friends exchange"}
          </strong>
          <span className="breadcrumb-slash">/</span>
          {exchange === "FRIENDS" ? (
            <Select
              label="Active Friends group"
              value={groupId}
              onChange={setGroupId}
            >
              <option value="">Choose group</option>
              {groups.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="muted">Global markets, your perspective.</span>
          )}
        </div>
        <div className="market-filter-controls">
          <Select
            label="Market category"
            value={category}
            onChange={setCategory}
          >
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          {exchange === "LIVE" && (
            <Select
              label="Market provider"
              value={provider}
              onChange={(value) => {
                setProvider(value);
                setMarketId("");
              }}
            >
              <option value="all">All sources</option>
              <option value="polymarket">Polymarket</option>
              <option value="kalshi">Kalshi</option>
            </Select>
          )}
          <button
            className={`text-button watch-filter ${watchOnly ? "active" : ""}`}
            onClick={() => setWatchOnly(!watchOnly)}
          >
            <Star size={11} fill={watchOnly ? "currentColor" : "none"} />
            Watchlist<span>{watched.length}</span>
          </button>
          {exchange === "FRIENDS" && (
            <button
              className="create-market-button"
              onClick={() => setDialog(user ? "create" : "auth")}
            >
              <Plus size={12} />
              Create market
            </button>
          )}
          {exchange === "FRIENDS" && user && market && (
            <IconButton
              label="Report market"
              onClick={() => setDialog("report")}
            >
              <Flag size={13} />
            </IconButton>
          )}
          {exchange === "FRIENDS" &&
            group &&
            ["OWNER", "MODERATOR"].includes(group.role) && (
              <IconButton
                label="Group moderation queue"
                onClick={() => setDialog("moderation")}
              >
                <ShieldCheck size={14} />
              </IconButton>
            )}
        </div>
      </div>
      <section className="market-overview">
        <div className="market-identity">
          <button
            className="selected-market-glyph"
            onClick={() => setDialog("search")}
            aria-label="Select market"
          >
            {market?.category?.[0] || <Activity size={20} />}
          </button>
          <div>
            <div className="market-title-row">
              <button
                className="market-title"
                onClick={() => setDialog("search")}
              >
                {market?.question ||
                  (exchange === "FRIENDS"
                    ? "Your group. Your predictions."
                    : "Find the signal. Take a position.")}
                <ChevronDown size={12} />
              </button>
              <IconButton
                label={
                  watched.includes(market?.id || "")
                    ? "Remove market from watchlist"
                    : "Add market to watchlist"
                }
                disabled={!market}
                onClick={() => void toggleWatch()}
                className={watched.includes(market?.id || "") ? "watched" : ""}
              >
                <Star
                  size={12}
                  fill={
                    watched.includes(market?.id || "") ? "currentColor" : "none"
                  }
                />
              </IconButton>
            </div>
            <div className="market-meta">
              <span>
                {market?.provider
                  ? market.provider.toUpperCase()
                  : exchange === "FRIENDS"
                    ? group?.name || "PRIVATE GROUP"
                    : "PREDICTION EXCHANGE"}
              </span>
              <span>·</span>
              <span>{market?.category || "Fictional credits"}</span>
              {market && (
                <>
                  <span>·</span>
                  <Badge tone={market.status === "OPEN" ? "green" : "quiet"}>
                    {market.status.replaceAll("_", " ")}
                  </Badge>
                </>
              )}
              {market?.sourceUrl && (
                <a
                  href={market.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View original market source"
                >
                  <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="market-stats">
          <div className="stat primary-stat">
            <span>{outcome?.label || "YES"} probability</span>
            <strong>{percent(outcome?.probability)}</strong>
          </div>
          <div className="stat">
            <span>Price / share</span>
            <strong>{cents(outcome?.probability)}</strong>
          </div>
          <div className="stat">
            <span>
              {exchange === "LIVE"
                ? market?.provider === "kalshi"
                  ? "Source volume · contracts"
                  : "Source volume · USD"
                : "Traded · CR"}
            </span>
            <strong>
              {market
                ? exchange === "LIVE"
                  ? `${market.provider === "kalshi" ? "" : "$"}${compact(market.volume)}`
                  : compact(market.volume)
                : "—"}
            </strong>
          </div>
          <div className="stat">
            <span>Closes</span>
            <strong>
              {market
                ? new Date(market.closeAt).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })
                : "—"}
            </strong>
          </div>
          <div className="stat account-stat">
            <span>Holdings · CR</span>
            <strong>{user ? credits(holdingValue) : "—"}</strong>
          </div>
          <div className="stat account-stat">
            <span>P&L · CR</span>
            <strong
              className={user ? (pnl >= 0 ? "positive" : "negative") : ""}
            >
              {user ? `${pnl > 0 ? "+" : ""}${credits(pnl)}` : "—"}
            </strong>
          </div>
        </div>
      </section>
      {(bootstrap.error ||
        marketsResource.error ||
        actionError ||
        (hasFeedError && market)) && (
        <div className="connection-notice">
          <span className="warning-dot" />
          {bootstrap.error
            ? `Server connection: ${bootstrap.error}`
            : marketsResource.error
              ? `Market source: ${marketsResource.error}`
              : actionError ||
                `Source ${book.data?.stale ? "snapshot is stale" : "connection unavailable"}. Verified data is required before trading.`}
          <button
            onClick={() => {
              setActionError("");
              refreshAll();
            }}
          >
            Retry <RefreshCw size={10} />
          </button>
        </div>
      )}
      <main className="terminal-workspace">
        <div className="terminal-main">
          <div className="chart-outcome-bar">
            <div
              className="outcome-tabs"
              role="group"
              aria-label="Chart outcome"
            >
              {market?.outcomes.map((o) => (
                <button
                  key={o.id}
                  className={outcome?.id === o.id ? "active" : ""}
                  onClick={() => setOutcomeId(o.id)}
                >
                  <span
                    className={`outcome-dot ${market.outcomes.indexOf(o) === 1 ? "no" : ""}`}
                  />
                  {o.label}
                  <strong>{cents(o.probability)}</strong>
                </button>
              )) || <span className="muted">MARKET PROBABILITY</span>}
            </div>
            <div className="chart-source-label">
              <span className={`tiny-dot ${!feedReady ? "offline" : ""}`} />
              {exchange === "FRIENDS" ? "PRIVATE EXCHANGE" : "LIVE SOURCE"}
              <span className="control-separator" /> <span>PLAY CREDIT</span>
            </div>
          </div>
          {exchange === "FRIENDS" && !user ? (
            <div className="friends-empty">
              <div className="friends-empty-visual">
                <span />
                <Users size={28} />
                <span />
              </div>
              <Badge tone="blue">THE PRIVATE EXCHANGE</Badge>
              <h1>Private group markets</h1>
              <p>
                Sign in to select a Friends group and trade with separate
                fictional credits.
              </p>
              <button
                className="button primary"
                onClick={() => setDialog("auth")}
              >
                Create your account <ArrowUpRight size={13} />
              </button>
              <small>10,000 fictional credits. Zero money on the line.</small>
            </div>
          ) : (
            <MarketChart
              market={market}
              outcome={outcome}
              theme={theme}
              expanded={expanded}
              onExpand={() => setExpanded(!expanded)}
            />
          )}
          <MarketTables
            key={`${exchange}-${groupId}`}
            tab={tab}
            setTab={setTab}
            market={market}
            outcome={outcome}
            book={book.data}
            orders={orders}
            positions={positions}
            user={user}
            group={group}
            onSignIn={() => setDialog("auth")}
            onMarket={selectMarket}
            onJournal={() => {
              void downloadJournal().catch((reason) =>
                setActionError(errorMessage(reason)),
              );
            }}
          />
        </div>
        <TradeTicket
          market={market}
          tradingEnabled={tradingEnabled}
          outcome={outcome}
          setOutcome={setOutcomeId}
          wallet={wallet}
          user={user}
          book={book.error ? undefined : book.data}
          positions={positions}
          onSignIn={() => setDialog("auth")}
          onOrders={() => setTab("orders")}
        />
      </main>
      <div className="mobile-trade-launch">
        <div>
          <strong>
            {outcome?.label || "Prediction market"}{" "}
            <span>{cents(outcome?.probability)}</span>
          </strong>
          <small>PLAY CREDIT · NO CASH VALUE</small>
        </div>
        <button
          onClick={() => {
            if (!user) setDialog("auth");
            else
              document
                .querySelector(".trade-ticket")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {user ? "Trade market" : "Sign in to trade"}
          <ArrowUpRight size={13} />
        </button>
      </div>
      <footer className="statusbar">
        <div>
          <span
            className={`status-indicator ${bootstrap.error ? "offline" : ""}`}
          />
          {bootstrap.error
            ? "Connection interrupted"
            : !tradingEnabled
              ? "Trading paused · read-only"
              : bootstrap.loading && !bootstrap.data
                ? "Connecting"
                : "Operational"}
          <span className="status-separator" />v
          {bootstrap.data?.settings.version || "0.1.0"}
          <span className="status-separator" />
          <span className="status-credit">PLAY CREDIT · NO CASH VALUE</span>
        </div>
        <div>
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noreferrer"
            className="chart-attribution"
          >
            Charts by TradingView
          </a>
          <span className="status-separator" />
          <button onClick={() => setDialog("help")}>
            How it works <CircleHelp size={10} />
          </button>
          <span className="status-separator" />
          <time>{clock.toLocaleTimeString([], { hour12: false })}</time>
          <span className="timezone">
            {Intl.DateTimeFormat()
              .resolvedOptions()
              .timeZone.split("/")
              .pop()
              ?.replace("_", " ")}
          </span>
        </div>
      </footer>
      {dialog === "auth" && (
        <AuthDialog
          onClose={closeDialog}
          onAuth={() => {
            refreshAll();
            closeDialog();
            const invite = new URLSearchParams(location.search).get("invite");
            if (invite) {
              void post("/invites/redeem", { token: invite })
                .then(() => {
                  refreshAll();
                  setExchange("FRIENDS");
                  setDialog("groups");
                  history.replaceState({}, "", "/");
                })
                .catch((reason) => setActionError(errorMessage(reason)));
            }
          }}
        />
      )}
      {dialog === "search" && (
        <MarketSearch
          markets={allMarkets}
          loading={marketsResource.loading}
          error={marketsResource.error}
          selected={market?.id}
          onSelect={selectMarket}
          onClose={closeDialog}
        />
      )}
      {dialog === "groups" && (
        <GroupsDialog
          groups={groups}
          activeId={groupId}
          user={user}
          onSelect={(id) => {
            setGroupId(id);
            setExchange("FRIENDS");
          }}
          onClose={closeDialog}
        />
      )}
      {dialog === "report" && market && (
        <ReportDialog market={market} onClose={closeDialog} />
      )}
      {dialog === "moderation" && group && (
        <ModerationDialog group={group} onClose={closeDialog} />
      )}
      {dialog === "create" && user && (
        <CreateMarketDialog
          group={group}
          user={user}
          onClose={closeDialog}
          onCreated={(id) => {
            selectMarket(id);
            setTab("rules");
            closeDialog();
          }}
        />
      )}
      {dialog === "leaderboard" && (
        <LeaderboardDialog
          exchange={exchange}
          groupId={groupId}
          onClose={closeDialog}
        />
      )}
      {dialog === "notifications" && (
        <NotificationsDialog onClose={closeDialog} onMarket={selectMarket} />
      )}
      {dialog === "profile" && bootstrap.data && (
        <ProfileDialog
          bootstrap={bootstrap.data}
          theme={theme}
          setTheme={setTheme}
          onClose={closeDialog}
          onSignOut={() => {
            closeDialog();
            setGroupId("");
            setMarketId("");
            setExchange("LIVE");
          }}
        />
      )}
      {dialog === "help" && (
        <Modal
          title="Conviction meets consequence."
          eyebrow="HOW OPENTRADER WORKS"
          onClose={closeDialog}
        >
          <div className="modal-body help-body">
            <div>
              <Badge tone="blue">01</Badge>
              <h3>Read the question. Read the rules.</h3>
              <p>
                Each share pays 1 fictional credit if its outcome wins, and 0 if
                it loses. A 62¢ price implies about a 62% chance.
              </p>
            </div>
            <div>
              <Badge tone="blue">02</Badge>
              <h3>Two exchanges. Separate credits.</h3>
              <p>
                Live simulates orders against real public market depth. Friends
                is a private exchange with peer orders and a funded automated
                market maker. Each wallet starts independently; no credit moves
                between them.
              </p>
            </div>
            <div>
              <Badge tone="blue">03</Badge>
              <h3>Preview. Protect. Confirm.</h3>
              <p>
                Review a fresh quote before submitting. Market orders fill
                available shares immediately; limit orders can rest until
                filled, canceled, or expired. Stale sources pause trading.
              </p>
            </div>
            <div>
              <Badge tone="blue">04</Badge>
              <h3>Forecasts are a different skill.</h3>
              <p>
                Record a probability without making a trade. Forecast
                calibration and trading profit have separate leaderboards.
              </p>
            </div>
            <p className="form-footnote">
              All credit is fictional. Nothing here is a real-money wager,
              investment, or promise of returns. Source availability and local
              server uptime affect the experience.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
