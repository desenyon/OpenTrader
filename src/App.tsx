import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bookmark,
  ChevronDown,
  ExternalLink,
  Flag,
  Menu,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  Users,
} from "lucide-react";
import type {
  Bootstrap,
  Exchange,
  Group,
  Market,
  Order,
  OrderBook,
  Position,
} from "../shared/types";
import { api, post, refreshAll, useEvents, useResource } from "./api";
import { downloadJournal } from "./journal";

import {
  AuthDialog,
  CreateMarketDialog,
  GroupsDialog,
  LeaderboardDialog,
  NotificationsDialog,
  ProfileDialog,
} from "./Dialogs";
import { MarketTables, type TerminalTab } from "./MarketTables";
import { TradeTicket } from "./TradeTicket";
import { MarketCard } from "./MarketCard";
import { ModerationDialog, ReportDialog } from "./Moderation";
import { Empty, ErrorNote, Loading, Modal } from "./ui";
import { credits, errorMessage } from "./utils";
import {
  chance,
  discoverMarkets,
  marketTopic,
  topics,
  type MarketSort,
} from "./market-discovery";
import {
  readRoute,
  routeHash,
  routeForMarket,
  type AppRoute,
} from "./navigation";

const AdminDashboard = lazy(() => import("./AdminDashboard"));
const MarketChart = lazy(() =>
  import("./Chart").then((module) => ({ default: module.MarketChart })),
);
class ChartBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="history-empty">
          The app was updated.{" "}
          <button className="text-link" onClick={() => location.reload()}>
            Reload to show the chart
          </button>
        </div>
      );
    return this.props.children;
  }
}
type Dialog =
  | "auth"
  | "groups"
  | "create"
  | "leaderboard"
  | "notifications"
  | "profile"
  | "help"
  | "report"
  | "moderation"
  | null;
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
    /* Preferences are optional. */
  }
}
export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => readRoute(location.hash));
  const [theme, setTheme] = useState(() => preference("theme", "dark"));
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [outcomeId, setOutcomeId] = useState("");
  const [topic, setTopic] = useState("All");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [sort, setSort] = useState<MarketSort>("discover");
  const [following, setFollowing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(18);
  const [tab, setTab] = useState<TerminalTab>("rules");
  const [portfolioTab, setPortfolioTab] = useState<TerminalTab>("positions");
  const [actionError, setActionError] = useState("");
  const [watched, setWatched] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const bootstrap = useResource<Bootstrap>("/bootstrap", 15000);
  const identity = bootstrap.data?.user || null;
  const user =
    identity && (identity.status ?? "APPROVED") === "APPROVED"
      ? identity
      : null;
  const groups = bootstrap.data?.groups || [];
  const exchange = route.exchange;
  const groupId =
    route.groupId || bootstrap.data?.activeGroupId || groups[0]?.id || "";
  const group = groups.find((g) => g.id === groupId);
  const scope = `exchange=${exchange}${exchange === "FRIENDS" ? `&groupId=${encodeURIComponent(groupId)}` : ""}`;
  const navigate = useCallback((next: AppRoute) => {
    location.hash = routeHash(next);
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const openMarket = useCallback(
    (market: Market, selectedOutcome?: string) => {
      setOutcomeId(selectedOutcome || "");
      setTab("rules");
      setActionError("");
      navigate(routeForMarket(market));
      window.scrollTo({ top: 0 });
    },
    [navigate],
  );
  const selectMarket = useCallback(
    (id: string) => {
      // Notifications and history can point into another wallet or group.
      void api<Market>(`/markets/${encodeURIComponent(id)}`)
        .then((item) => openMarket(item))
        .catch((reason) => setActionError(errorMessage(reason)));
    },
    [openMarket],
  );
  const marketsResource = useResource<Market[]>(
    route.view === "admin" || (exchange === "FRIENDS" && (!user || !groupId))
      ? null
      : `/markets?${scope}${exchange === "LIVE" && provider !== "all" ? `&provider=${provider}` : ""}`,
    10000,
  );
  const allMarkets = Array.isArray(marketsResource.data)
    ? marketsResource.data
    : [];
  const details = useResource<Market>(
    route.view === "market" && route.marketId && (exchange === "LIVE" || !!user)
      ? `/markets/${encodeURIComponent(route.marketId)}`
      : null,
    10000,
  );
  const market =
    details.data || allMarkets.find((m) => m.id === route.marketId);
  const outcome =
    market?.outcomes.find((o) => o.id === outcomeId) || market?.outcomes[0];
  const book = useResource<OrderBook>(
    route.view === "market" && market && outcome
      ? `/markets/${encodeURIComponent(market.id)}/book?outcomeId=${encodeURIComponent(outcome.id)}`
      : null,
    2000,
  );
  const positionsResource = useResource<Position[]>(
    user && route.view !== "admin" && (exchange === "LIVE" || groupId)
      ? `/positions?${scope}`
      : null,
    5000,
  );
  const ordersResource = useResource<Order[]>(
    user && route.view !== "admin" && (exchange === "LIVE" || groupId)
      ? `/orders?${scope}`
      : null,
    5000,
  );
  const positions = positionsResource.data || [],
    orders = ordersResource.data || [];
  const wallet = bootstrap.data?.wallets.find(
    (w) =>
      w.exchange === exchange && (exchange === "LIVE" || w.groupId === groupId),
  );
  const operational = useResource<{ tradingEnabled: boolean; reason?: string }>(
    "/exchange-status",
    15000,
  );
  const tradingEnabled =
    operational.data?.tradingEnabled === true && !operational.error;
  const watchlist = useResource<string[]>(
    user && route.view !== "admin" ? "/watchlist" : null,
    15000,
  );
  const visibleMarkets = discoverMarkets(allMarkets, {
    query,
    topic,
    watched,
    following,
    sort,
  });
  const availableTopics = topics.filter(
    (item) => item === "All" || allMarkets.some((m) => marketTopic(m) === item),
  );
  const unread =
    bootstrap.data?.notifications.filter((n) => !n.readAt).length || 0;
  const holdingValue = positions.reduce(
    (sum, p) => sum + Number(p.indicativeValue),
    0,
  );
  const pnl = positions.reduce(
    (sum, p) => sum + Number(p.realizedPnl) + Number(p.unrealizedPnl),
    0,
  );
  useEvents(!!user && route.view !== "admin");
  useEffect(() => {
    if (watchlist.data) setWatched(watchlist.data);
    else if (!user) setWatched([]);
  }, [watchlist.data, user?.id]);
  useEffect(() => {
    const changed = () => {
      setRoute(readRoute(location.hash));
      setMenuOpen(false);
      setActionError("");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    setTopic("All");
    setQuery("");
    setFollowing(false);
    setVisibleCount(18);
    setOutcomeId("");
  }, [exchange, groupId]);
  useEffect(() => {
    setVisibleCount(18);
  }, [query, topic, following, provider, sort]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setMenuOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        setMenuOpen(false);
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerdown", outside);
    };
  }, []);
  const toggleWatch = async (item: Market) => {
    if (!user) {
      setDialog("auth");
      return;
    }
    try {
      const response = await post<{ marketIds: string[] }>(
        `/markets/${encodeURIComponent(item.id)}/watch`,
      );
      setWatched(response.marketIds);
      watchlist.refresh();
    } catch (reason) {
      setActionError(errorMessage(reason));
    }
  };
  const switchExchange = (next: Exchange) =>
    navigate({
      exchange: next,
      view: "markets",
      ...(next === "FRIENDS" && groupId ? { groupId } : {}),
    });
  const browse = () =>
    navigate({
      exchange,
      groupId: exchange === "FRIENDS" ? groupId : undefined,
      view: "markets",
    });
  const portfolio = () =>
    navigate({
      exchange,
      groupId: exchange === "FRIENDS" ? groupId : undefined,
      view: "portfolio",
    });
  const create = () => setDialog(user ? "create" : "auth");
  const journal = () => {
    void downloadJournal().catch((reason) =>
      setActionError(errorMessage(reason)),
    );
  };
  const inviteAttempt = useRef("");
  useEffect(() => {
    if (!bootstrap.data) return;
    const token = new URLSearchParams(location.search).get("invite");
    if (!token || inviteAttempt.current === token) return;
    if (!user) {
      setDialog("auth");
      return;
    }
    inviteAttempt.current = token;
    void post<Group>("/invites/redeem", { token })
      .then((joined) => {
        refreshAll();
        const destination = routeHash({
          exchange: "FRIENDS",
          groupId: joined.id,
          view: "markets",
        });
        history.replaceState({}, "", `/${destination}`);
        setRoute(readRoute(destination));
        closeDialog();
      })
      .catch((reason) => setActionError(errorMessage(reason)));
  }, [user?.id, !!bootstrap.data, closeDialog]);
  const onAuth = () => {
    refreshAll();
    closeDialog();
  };
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="site-header">
        <div className="header-inner">
          <a href="#/live" className="wordmark" aria-label="OpenTrader home">
            OpenTrader<span className="wordmark-point">.</span>
          </a>
          <nav className="exchange-switch" aria-label="Exchange">
            <button
              className={exchange === "LIVE" ? "active" : ""}
              aria-pressed={exchange === "LIVE"}
              onClick={() => switchExchange("LIVE")}
            >
              Live
            </button>
            <button
              className={exchange === "FRIENDS" ? "active" : ""}
              aria-pressed={exchange === "FRIENDS"}
              onClick={() => switchExchange("FRIENDS")}
            >
              Friends
            </button>
          </nav>
          <nav className="primary-nav" aria-label="Main navigation">
            <button
              onClick={browse}
              className={route.view !== "portfolio" ? "active" : ""}
            >
              Markets
            </button>
            <button
              onClick={portfolio}
              className={route.view === "portfolio" ? "active" : ""}
            >
              Portfolio
            </button>
          </nav>
          {route.view !== "admin" && (
            <label className="header-search">
              <Search size={17} />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search markets"
                placeholder="Search markets"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (route.view !== "markets") browse();
                }}
              />
              <kbd>⌘ K</kbd>
            </label>
          )}
          <div
            className={`header-actions${route.view === "admin" ? " admin-header-actions" : ""}`}
          >
            {user ? (
              <>
                <button className="wallet-button" onClick={portfolio}>
                  <strong>{credits(wallet?.available, 0)}</strong>
                  <span>play credits</span>
                </button>
                <button
                  className="icon-button notifications-button"
                  aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
                  onClick={() => setDialog("notifications")}
                >
                  <Bell size={18} />
                  {unread > 0 && <i />}
                </button>
                <button
                  className="account-button"
                  aria-label={`Account for ${user.handle}`}
                  onClick={() => setDialog("profile")}
                >
                  {user.handle[0]?.toUpperCase()}
                </button>
              </>
            ) : identity ? (
              <span className="section-kicker">{identity.handle}</span>
            ) : (
              <button
                className="button primary signup-button"
                onClick={() => setDialog("auth")}
              >
                Get started
              </button>
            )}
            <div className="menu-container" ref={menuRef}>
              <button
                className="icon-button"
                aria-label="More options"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Menu size={19} />
              </button>
              {menuOpen && (
                <div className="navigation-menu">
                  {user?.platformRole === "ADMIN" && (
                    <button
                      onClick={() => {
                        navigate({ exchange: "LIVE", view: "admin" });
                        setMenuOpen(false);
                      }}
                    >
                      <ShieldCheck size={15} /> Admin dashboard
                    </button>
                  )}

                  <button
                    onClick={() => {
                      portfolio();
                      setMenuOpen(false);
                    }}
                  >
                    Portfolio
                  </button>
                  <button
                    onClick={() => {
                      setDialog("groups");
                      setMenuOpen(false);
                    }}
                  >
                    Manage groups
                  </button>
                  <button
                    onClick={() => {
                      setDialog("leaderboard");
                      setMenuOpen(false);
                    }}
                  >
                    Leaderboard
                  </button>
                  {user && (
                    <button
                      onClick={() => {
                        setDialog("notifications");
                        setMenuOpen(false);
                      }}
                    >
                      Notifications{unread ? ` (${unread})` : ""}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setTheme(theme === "dark" ? "light" : "dark");
                      setMenuOpen(false);
                    }}
                  >
                    {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}{" "}
                    {theme === "dark" ? "Light" : "Dark"} appearance
                  </button>
                  <button
                    onClick={() => {
                      setDialog("help");
                      setMenuOpen(false);
                    }}
                  >
                    How it works
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {route.view === "markets" && (
          <nav className="topic-nav" aria-label="Market topics">
            <div>
              {availableTopics.map((item) => (
                <button
                  key={item}
                  className={topic === item ? "active" : ""}
                  aria-pressed={topic === item}
                  onClick={() => setTopic(item)}
                >
                  {item === "All" ? "Explore" : item}
                </button>
              ))}
            </div>
          </nav>
        )}
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className={`page-content view-${route.view}`}
      >
        {(bootstrap.error || actionError) && (
          <ErrorNote
            message={
              actionError ||
              `Cannot connect to your account: ${bootstrap.error}`
            }
          />
        )}
        {operational.data?.tradingEnabled === false && (
          <div className="notice">
            Trading is temporarily paused. You can still browse markets and view
            your account.
          </div>
        )}
        {exchange === "FRIENDS" && user && (
          <div className="group-context">
            <label>
              <Users size={16} />
              <select
                aria-label="Active Friends group"
                value={groupId}
                onChange={(event) =>
                  navigate({
                    exchange: "FRIENDS",
                    groupId: event.target.value,
                    view: "markets",
                  })
                }
              >
                {groups.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <button className="text-link" onClick={() => setDialog("groups")}>
              Manage group
            </button>
          </div>
        )}
        {identity &&
        identity.status !== "APPROVED" &&
        identity.status !== undefined ? (
          <section className="account-waiting">
            <ShieldCheck size={32} />
            <h1>
              {identity.status === "PENDING"
                ? "Your account is awaiting approval"
                : identity.status === "SUSPENDED"
                  ? "Your account is suspended"
                  : "Account request declined"}
            </h1>
            <p>
              {identity.status === "PENDING"
                ? "An administrator will review your request. Once approved, you’ll receive separate Live and Friends play-credit wallets."
                : "Trading and group access are unavailable. Your economic history remains recorded. Contact your administrator for review."}
            </p>
            <p>
              Signed in as <strong>{identity.handle}</strong>
            </p>
            <div>
              <button
                className="button primary"
                onClick={() => bootstrap.refresh()}
              >
                Check account status
              </button>
              <button
                className="button secondary"
                onClick={() => {
                  void post("/auth/logout")
                    .then(() => refreshAll())
                    .catch((e) => setActionError(errorMessage(e)));
                }}
              >
                Sign out
              </button>
            </div>
          </section>
        ) : route.view === "admin" ? (
          user?.platformRole === "ADMIN" ? (
            <Suspense fallback={<Loading />}>
              <AdminDashboard
                onBack={() => navigate({ exchange: "LIVE", view: "markets" })}
              />
            </Suspense>
          ) : (
            <Empty
              title="Admin access required"
              detail="Sign in with a platform administrator account to access this dashboard."
            />
          )
        ) : exchange === "FRIENDS" && !user && !bootstrap.loading ? (
          <section className="friends-intro">
            <span className="section-kicker">Just your circle</span>
            <h1>
              A market for your
              <br />
              group chat.
            </h1>
            <p>
              Ask a question. Make your prediction. See who called it.
              <br className="desktop-only" /> Your friends, your markets, your
              own play credits.
            </p>
            <button
              className="button primary"
              onClick={() => setDialog("auth")}
            >
              Start a group <ArrowRight size={16} />
            </button>
            <div className="friends-explainer">
              <div>
                <span>1</span>
                <h3>Invite your people</h3>
                <p>Markets stay private to approved members.</p>
              </div>
              <div>
                <span>2</span>
                <h3>Make a prediction</h3>
                <p>Each group has a separate play-credit balance.</p>
              </div>
              <div>
                <span>3</span>
                <h3>Decide the result</h3>
                <p>
                  The creator picks Yes, No, or Cancel. Credits settle
                  instantly.
                </p>
              </div>
            </div>
          </section>
        ) : route.view === "markets" ? (
          <>
            <div className="page-heading">
              <div>
                <h1>
                  {query
                    ? `Results for “${query}”`
                    : following
                      ? "Your watchlist"
                      : exchange === "FRIENDS"
                        ? "Your group’s markets"
                        : topic !== "All"
                          ? topic
                          : "What happens next?"}
                </h1>
                <p>
                  {exchange === "FRIENDS"
                    ? "Private predictions. A little friendly competition."
                    : "Real-world questions. Your predictions. All with play credits."}
                </p>
              </div>
              {exchange === "FRIENDS" && user && (
                <button className="button primary" onClick={create}>
                  <Plus size={16} />
                  Create bet
                </button>
              )}
            </div>
            <div className="discovery-toolbar">
              <div className="browse-tabs">
                <button
                  className={!following ? "active" : ""}
                  onClick={() => setFollowing(false)}
                >
                  Discover
                </button>
                <button
                  className={following ? "active" : ""}
                  onClick={() => setFollowing(true)}
                >
                  <Bookmark size={15} />
                  Following{watched.length > 0 && <span>{watched.length}</span>}
                </button>
              </div>
              <div className="browse-selects">
                {exchange === "LIVE" && (
                  <select
                    aria-label="Market provider"
                    value={provider}
                    onChange={(event) => setProvider(event.target.value)}
                  >
                    <option value="all">All sources</option>
                    <option value="polymarket">Polymarket</option>
                    <option value="kalshi">Kalshi</option>
                  </select>
                )}
                <select
                  aria-label="Sort markets"
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as MarketSort)
                  }
                >
                  <option value="discover">Default order</option>
                  <option value="closing">Closing soon</option>
                  <option value="newest">Newest</option>
                </select>
              </div>
            </div>
            {marketsResource.loading && !allMarkets.length ? (
              <div
                className="market-grid"
                aria-label="Loading markets"
                aria-busy="true"
              >
                {Array.from({ length: 6 }, (_, i) => (
                  <div className="card-skeleton" key={i}>
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            ) : marketsResource.error ? (
              <Empty
                title="Markets are temporarily unavailable"
                detail={marketsResource.error}
                action={
                  <button className="button" onClick={refreshAll}>
                    Try again
                  </button>
                }
              />
            ) : visibleMarkets.length ? (
              <>
                <div className="market-grid">
                  {visibleMarkets.slice(0, visibleCount).map((item) => (
                    <MarketCard
                      key={item.id}
                      market={item}
                      saved={watched.includes(item.id)}
                      onOpen={openMarket}
                      onSave={(item) => void toggleWatch(item)}
                    />
                  ))}
                </div>
                {visibleMarkets.length > visibleCount && (
                  <div className="load-more">
                    <button
                      className="button"
                      onClick={() => setVisibleCount((count) => count + 18)}
                    >
                      Show more markets
                    </button>
                  </div>
                )}
              </>
            ) : (
              <Empty
                title={
                  following
                    ? "Keep an eye on a question"
                    : query || topic !== "All"
                      ? "No matching markets"
                      : exchange === "FRIENDS"
                        ? "Your first question starts here"
                        : "No markets available"
                }
                detail={
                  following
                    ? "Save a market to find it here."
                    : exchange === "FRIENDS" && !query
                      ? "Ask a question, choose when betting closes, and invite your friends."
                      : "Try another topic or search."
                }
                action={
                  exchange === "FRIENDS" && !following && !query ? (
                    <button className="button primary" onClick={create}>
                      Create a bet
                    </button>
                  ) : (
                    <button
                      className="button"
                      onClick={() => {
                        setTopic("All");
                        setQuery("");
                        setFollowing(false);
                      }}
                    >
                      Browse markets
                    </button>
                  )
                }
              />
            )}
          </>
        ) : route.view === "portfolio" ? (
          <>
            <div className="page-heading">
              <div>
                <h1>Your portfolio</h1>
                <p>
                  {exchange === "LIVE"
                    ? "Your Live practice account"
                    : `${group?.name || "Friends"} · Separate group balance`}
                </p>
              </div>
              {user && (
                <button className="button" onClick={journal}>
                  Export history
                </button>
              )}
            </div>
            {!user ? (
              <Empty
                title="Your predictions, in one place"
                detail="Sign in to see your holdings and play-credit balance."
                action={
                  <button
                    className="button primary"
                    onClick={() => setDialog("auth")}
                  >
                    Sign in
                  </button>
                }
              />
            ) : (
              <>
                <div className="portfolio-summary">
                  <div>
                    <span>Available credits</span>
                    <strong>{credits(wallet?.available)}</strong>
                  </div>
                  <div>
                    <span>Held for orders</span>
                    <strong>{credits(wallet?.locked)}</strong>
                  </div>
                  <div>
                    <span>Positions · indicative</span>
                    <strong>{credits(holdingValue)}</strong>
                  </div>
                  <div>
                    <span>Total profit / loss</span>
                    <strong className={pnl < 0 ? "negative" : "positive"}>
                      {pnl > 0 ? "+" : ""}
                      {credits(pnl)}
                    </strong>
                  </div>
                </div>
                <ErrorNote
                  message={positionsResource.error || ordersResource.error}
                />
                <MarketTables
                  tab={portfolioTab}
                  setTab={setPortfolioTab}
                  tabs={["positions", "orders"]}
                  orders={orders}
                  positions={positions}
                  user={user}
                  group={group}
                  onSignIn={() => setDialog("auth")}
                  onMarket={selectMarket}
                  onJournal={journal}
                />
                <p className="quiet-note">
                  All amounts are fictional credits. Indicative values may
                  differ from the amount you can sell for.
                </p>
              </>
            )}
          </>
        ) : !market ? (
          <>
            {details.loading ? (
              <div className="page-loading">
                <Loading>Loading market…</Loading>
              </div>
            ) : (
              <Empty
                title="This market isn’t available"
                detail={
                  details.error ||
                  "It may be private, removed, or temporarily unavailable."
                }
                action={
                  <button className="button" onClick={browse}>
                    Back to markets
                  </button>
                }
              />
            )}
          </>
        ) : (
          <>
            <button className="back-link" onClick={browse}>
              <ArrowLeft size={16} />
              All markets<span>/</span>
              {marketTopic(market)}
            </button>
            <div className="market-detail-layout">
              <div className="market-detail-main">
                <div className="detail-heading">
                  <div>
                    <div className="detail-meta">
                      <span>
                        {market.provider === "polymarket"
                          ? "Polymarket"
                          : market.provider === "kalshi"
                            ? "Kalshi"
                            : group?.name || "Friends"}
                      </span>
                      <span>
                        Closes{" "}
                        {new Date(market.closeAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric", year: "numeric" },
                        )}
                      </span>
                      {market.status !== "OPEN" && (
                        <span className="market-state">
                          {market.status.replaceAll("_", " ").toLowerCase()}
                        </span>
                      )}
                    </div>
                    <h1>{market.question}</h1>
                  </div>
                  <button
                    className={`icon-button ${watched.includes(market.id) ? "saved" : ""}`}
                    aria-label={`${watched.includes(market.id) ? "Unsave" : "Save"} market`}
                    onClick={() => void toggleWatch(market)}
                  >
                    <Bookmark
                      size={19}
                      fill={
                        watched.includes(market.id) ? "currentColor" : "none"
                      }
                    />
                  </button>
                </div>
                <div className="detail-probability">
                  <strong>{outcome ? chance(outcome.probability) : "—"}</strong>
                  <span>
                    {outcome?.label.toLowerCase() === "yes"
                      ? "chance of Yes"
                      : outcome?.label}
                  </span>
                </div>
                {market.executionModel === "SOURCE_SEEDED_LMSR" && (
                  <p className="source-reference">
                    {market.pricing?.active
                      ? "OpenTrader price · "
                      : "Opening estimate · "}
                    {market.provider === "kalshi" ? "Kalshi" : "Polymarket"}{" "}
                    reference{" "}
                    {chance(
                      (market.reference?.outcomes ?? market.outcomes).find(
                        (o) => o.id === outcome?.id,
                      )?.probability ?? 0,
                    )}
                    <span>
                      {" "}
                      ·{" "}
                      {new Date(
                        market.reference?.timestamp ?? market.updatedAt,
                      ).toLocaleTimeString()}{" "}
                      · play credits
                    </span>
                  </p>
                )}
                <div className="detail-outcomes" aria-label="Chart outcome">
                  {market.outcomes.map((item) => (
                    <button
                      key={item.id}
                      aria-pressed={item.id === outcome?.id}
                      className={item.id === outcome?.id ? "active" : ""}
                      onClick={() => setOutcomeId(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <ChartBoundary>
                  <Suspense
                    fallback={
                      <div className="chart-loading">
                        <Loading>Loading chart…</Loading>
                      </div>
                    }
                  >
                    <MarketChart
                      market={market}
                      outcome={outcome}
                      theme={theme}
                    />
                  </Suspense>
                </ChartBoundary>
                <MarketTables
                  tab={tab}
                  setTab={setTab}
                  tabs={["rules", "discussion", "activity", "forecast", "book"]}
                  market={market}
                  outcome={outcome}
                  book={book.data}
                  orders={orders}
                  positions={positions}
                  user={user}
                  group={group}
                  onSignIn={() => setDialog("auth")}
                  onMarket={selectMarket}
                  onJournal={journal}
                />
                <div className="detail-actions">
                  {market.sourceUrl && (
                    <a href={market.sourceUrl} target="_blank" rel="noreferrer">
                      View original source
                      <ExternalLink size={14} />
                    </a>
                  )}
                  {exchange === "FRIENDS" && user && (
                    <button onClick={() => setDialog("report")}>
                      <Flag size={14} />
                      Report market
                    </button>
                  )}
                  {exchange === "FRIENDS" &&
                    group &&
                    ["OWNER", "MODERATOR"].includes(group.role) && (
                      <button onClick={() => setDialog("moderation")}>
                        <ShieldCheck size={14} />
                        Moderation
                      </button>
                    )}
                </div>
              </div>
              <TradeTicket
                market={market}
                tradingEnabled={tradingEnabled}
                outcome={outcome}
                setOutcome={setOutcomeId}
                wallet={wallet}
                user={user}
                book={book.error ? undefined : book.data}
                bookError={book.error}
                onRefreshBook={book.refresh}
                positions={positions}
                onSignIn={() => setDialog("auth")}
                onOrders={() => {
                  setPortfolioTab("orders");
                  portfolio();
                }}
              />
            </div>
            <div className="mobile-predict">
              <span>
                {outcome?.label}
                <strong>{outcome ? chance(outcome.probability) : ""}</strong>
              </span>
              <button
                className="button primary"
                onClick={() =>
                  document
                    .querySelector(".trade-ticket")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                Make a prediction
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}
      </main>
      {route.view !== "market" && (
        <nav className="mobile-navigation" aria-label="Mobile navigation">
          <button
            className={route.view === "markets" ? "active" : ""}
            onClick={browse}
          >
            Markets
          </button>
          <button
            className={route.view === "portfolio" ? "active" : ""}
            onClick={portfolio}
          >
            Portfolio
          </button>
          <button onClick={() => setDialog("groups")}>Groups</button>
        </nav>
      )}
      <footer className="site-footer">
        <span>Play credits. No cash value.</span>
        <button onClick={() => setDialog("help")}>How it works</button>
        {(allMarkets.length > 0 || market) && (
          <span className="footer-updates">Prices update automatically</span>
        )}
      </footer>
      {dialog === "auth" && (
        <AuthDialog onClose={closeDialog} onAuth={onAuth} />
      )}
      {dialog === "groups" && (
        <GroupsDialog
          groups={groups}
          activeId={groupId}
          user={user}
          onSelect={(id) =>
            navigate({ exchange: "FRIENDS", groupId: id, view: "markets" })
          }
          onClose={closeDialog}
        />
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
            refreshAll();
            navigate({ exchange: "LIVE", view: "markets" });
          }}
        />
      )}
      {dialog === "report" && market && (
        <ReportDialog market={market} onClose={closeDialog} />
      )}
      {dialog === "moderation" && group && (
        <ModerationDialog group={group} onClose={closeDialog} />
      )}
      {dialog === "help" && (
        <Modal title="How predictions work" onClose={closeDialog}>
          <div className="modal-body help-body">
            <section>
              <h3>Pick a question and an outcome</h3>
              <p>
                A price of 60¢ implies roughly a 60% chance. Each winning share
                pays one play credit; a losing share pays zero.
              </p>
            </section>
            <section>
              <h3>Review before you confirm</h3>
              <p>
                Choose your number of shares, preview the actual cost, then
                confirm. Prices may move. A new quote is required if the old one
                expires.
              </p>
            </section>
            <section>
              <h3>Two modes, separate balances</h3>
              <p>
                Live opens markets using Polymarket and Kalshi odds, then our
                credit trades move OpenTrader prices. Friends has private group
                questions and its own economy. Credits stay in their own wallet.
              </p>
            </section>
            <p className="form-footnote">
              Credits are free, fictional, and cannot be redeemed. Market prices
              are estimates, not guaranteed outcomes.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
