import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Shield,
  Users,
} from "lucide-react";
import type {
  Bootstrap,
  Group,
  LeaderboardRow,
  Market,
  Member,
  Notification,
  User,
} from "../shared/types";
import { api, patch, post, refreshAll, useResource } from "./api";
import { downloadJournal } from "./journal";
import { BINARY_VOID_POLICY } from "../shared/rules";
import { PrivacyRequest } from "./Moderation";
import { credits, date, errorMessage, percent } from "./utils";
import {
  ActionForm,
  Badge,
  Empty,
  ErrorNote,
  Field,
  Loading,
  Modal,
  Select,
} from "./ui";

export function AuthDialog({
  onClose,
  onAuth,
}: {
  onClose: () => void;
  onAuth: () => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  return (
    <Modal
      title={mode === "login" ? "Sign in" : "Create your account"}
      eyebrow="OpenTrader"
      onClose={onClose}
    >
      <div className="modal-body">
        <p className="dialog-intro">
          {mode === "login"
            ? "Sign in to trade, track your positions, and join your friends."
            : "Request an account. After admin approval, receive separate Live and Friends wallets with 10,000 fictional credits each. Platform administrators can review trading activity across groups."}
        </p>
        <div className="dialog-tabs">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Create account
          </button>
        </div>
        <ActionForm
          key={mode}
          submitLabel={mode === "login" ? "Sign in" : "Create account"}
          onSubmit={async (form) => {
            await post(`/auth/${mode}`, {
              handle: form.get("handle"),
              password: form.get("password"),
              ...(mode === "register"
                ? { anonymousTrading: form.get("anonymousTrading") === "on" }
                : {}),
            });
            onAuth();
          }}
        >
          <Field label="Handle">
            <input
              name="handle"
              autoComplete="username"
              placeholder="your_handle"
              required
              minLength={3}
              maxLength={30}
              pattern={"[a-zA-Z][a-zA-Z0-9_\\-]{2,29}"}
              title="Start with a letter; use 3–30 letters, digits, underscores, or hyphens"
            />
          </Field>
          {mode === "register" && (
            <label className="signup-privacy">
              <input
                type="checkbox"
                name="anonymousTrading"
                aria-describedby="anonymous-trading-help"
              />
              <span>
                <strong>Appear anonymous when trading</strong>
                <small id="anonymous-trading-help">
                  Use an alias in trade history and rankings. Admins can still
                  see your account. Comments and market roles use your name.
                </small>
              </span>
            </label>
          )}
          <Field
            label="Password"
            hint={
              mode === "register" ? "Use at least 12 characters." : undefined
            }
          >
            <input
              name="password"
              type="password"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              required
              minLength={mode === "register" ? 12 : 1}
              maxLength={200}
            />
          </Field>
        </ActionForm>
        <div className="auth-notice">
          <Shield size={15} />
          <p>
            Play credit only. No real money, deposits, withdrawals, or cash
            prizes. Your password stays on this server.
          </p>
        </div>
      </div>
    </Modal>
  );
}

export function MarketSearch({
  markets,
  selected,
  onSelect,
  onClose,
  loading,
  error,
}: {
  markets: Market[];
  selected?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("All"),
    [provider, setProvider] = useState("all");
  const categories = [...new Set(markets.map((m) => m.category))]
    .filter(Boolean)
    .sort();
  const filtered = markets.filter(
    (m) =>
      (!query ||
        `${m.question} ${m.category} ${m.provider || ""}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (category === "All" || m.category === category) &&
      (provider === "all" || m.provider === provider),
  );
  const select = (id: string) => {
    onSelect(id);
    onClose();
  };
  return (
    <Modal
      title="Find your next conviction"
      eyebrow="MARKET DIRECTORY"
      onClose={onClose}
      wide
    >
      <div className="market-search-input">
        <span>⌕</span>
        <input
          aria-label="Search markets"
          placeholder="Search markets, questions, categories…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filtered[0]) select(filtered[0].id);
          }}
        />
        <kbd>↵</kbd>
      </div>
      <div className="search-filters">
        <div className="category-pills">
          {["All", ...categories].map((item) => (
            <button
              key={item}
              className={category === item ? "active" : ""}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <Select label="Filter provider" value={provider} onChange={setProvider}>
          <option value="all">All sources</option>
          <option value="polymarket">Polymarket</option>
          <option value="kalshi">Kalshi</option>
        </Select>
      </div>
      <div className="market-results">
        {filtered.map((m) => (
          <button
            className={`market-result ${m.id === selected ? "selected" : ""}`}
            key={m.id}
            onClick={() => select(m.id)}
          >
            <span
              className={`market-glyph ${m.category.toLowerCase().replace(/[^a-z]/g, "")}`}
            >
              {m.category?.[0] || "↗"}
            </span>
            <div>
              <strong>{m.question}</strong>
              <span>
                {m.provider || "Friends"} <i>·</i> {m.category} <i>·</i>{" "}
                {m.status.toLowerCase()}
              </span>
            </div>
            <div className="result-probability">
              <strong>{percent(m.outcomes[0]?.probability)}</strong>
              <span>{m.outcomes[0]?.label || "Yes"}</span>
            </div>
            {m.id === selected ? <Check size={14} /> : <ArrowRight size={14} />}
          </button>
        ))}
        {!filtered.length && (
          <Empty
            title={
              loading
                ? "Connecting to sources…"
                : error
                  ? "Market source unavailable"
                  : "No matching markets"
            }
            detail={error || "Try a different question, category, or source."}
            action={
              error ? (
                <button className="button small" onClick={refreshAll}>
                  Retry sources
                </button>
              ) : undefined
            }
          />
        )}
      </div>
      <footer className="search-footer">
        <span>{filtered.length} markets</span>
        <span>
          <kbd>esc</kbd> to close <kbd>↵</kbd> open first result
        </span>
      </footer>
    </Modal>
  );
}

export function GroupsDialog({
  groups,
  activeId,
  user,
  onSelect,
  onClose,
}: {
  groups: Group[];
  activeId: string;
  user: User | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("groups"),
    [groupId, setGroupId] = useState(activeId || groups[0]?.id || ""),
    [invite, setInvite] = useState(""),
    [copied, setCopied] = useState(false),
    [notice, setNotice] = useState("");
  const group = groups.find((g) => g.id === groupId);
  const members = useResource<Member[]>(
    tab === "members" && groupId ? `/groups/${groupId}/members` : null,
  );
  const mayModerate = !!group && ["OWNER", "MODERATOR"].includes(group.role);
  const invites = useResource<
    { id: string; expiresAt: string; uses: number; revoked: boolean }[]
  >(
    tab === "invite" && groupId && mayModerate
      ? `/groups/${groupId}/invites`
      : null,
  );
  const [error, setError] = useState("");
  const updateMember = async (id: string, role: string) => {
    try {
      await patch(`/groups/${groupId}/members`, { userId: id, role });
      refreshAll();
      setNotice("Member role updated.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const changeAdmission = async (member: Member) => {
    const removing = member.status === "ACTIVE";
    if (
      removing &&
      !window.confirm(
        `Remove @${member.handle}? Their access stops and open orders are canceled; holdings and settlement records remain intact.`,
      )
    )
      return;
    try {
      await patch(`/groups/${groupId}/members`, {
        userId: member.id,
        status: removing ? "REMOVED" : "ACTIVE",
      });
      refreshAll();
      setNotice(
        removing
          ? "Member removed; economic records preserved."
          : "Membership restored without issuing another season allocation.",
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const revoke = async (id: string) => {
    try {
      await api(`/groups/${groupId}/invites/${id}`, { method: "DELETE" });
      refreshAll();
      setNotice("Invitation revoked.");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  return (
    <Modal
      title="Your groups"
      eyebrow="FRIENDS EXCHANGE"
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="dialog-tabs">
          {["groups", "create", "invite", "join", "members"].map((item) => (
            <button
              key={item}
              className={tab === item ? "active" : ""}
              onClick={() => setTab(item)}
            >
              {item === "groups"
                ? "Your groups"
                : item[0]!.toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
        {!user ? (
          <Empty
            title="Sign in to join the conversation"
            detail="Friends groups are private, invite-only prediction exchanges."
          />
        ) : (
          <>
            {tab === "groups" && (
              <div className="groups-list">
                {groups.map((item) => (
                  <button
                    className={activeId === item.id ? "active" : ""}
                    key={item.id}
                    onClick={() => {
                      onSelect(item.id);
                      onClose();
                    }}
                  >
                    <span className="group-avatar">
                      <Users size={19} />
                    </span>
                    <div>
                      <strong>{item.name}</strong>
                      <p>{item.description || "Private prediction exchange"}</p>
                      <small>
                        {item.memberCount} members · {item.role.toLowerCase()}
                      </small>
                    </div>
                    {activeId === item.id && <Check size={15} />}
                  </button>
                ))}
                {!groups.length && (
                  <Empty
                    title="Your next rivalry awaits"
                    detail="Create a private group or join using an invite."
                  />
                )}
              </div>
            )}
            {tab === "create" && (
              <ActionForm
                submitLabel="Create private group"
                onSubmit={(form) =>
                  post("/groups", {
                    name: form.get("name"),
                    description: form.get("description"),
                  })
                }
                onSuccess={() => {
                  refreshAll();
                  setTab("groups");
                }}
              >
                <Field label="Group name">
                  <input
                    name="name"
                    placeholder="The Monday Forecast"
                    required
                    minLength={2}
                    maxLength={60}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    name="description"
                    rows={3}
                    placeholder="Who’s in, and what are you predicting?"
                    maxLength={500}
                  />
                </Field>
                <p className="form-footnote">
                  Each group has its own credit economy. Credits and performance
                  never cross into another group or Live.
                </p>
              </ActionForm>
            )}
            {["invite", "members"].includes(tab) && (
              <Field label="Group">
                <select
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    setInvite("");
                  }}
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {tab === "invite" &&
              (groupId ? (
                <ActionForm
                  submitLabel="Generate invite"
                  onSubmit={(form) =>
                    post<{ token: string; url: string }>(
                      `/groups/${groupId}/invites`,
                      {
                        expiresHours: Number(form.get("hours")),
                        uses: Number(form.get("uses")),
                      },
                    )
                  }
                  onSuccess={(result) => {
                    const r = result as { token: string; url: string };
                    setInvite(
                      r.url ? new URL(r.url, location.origin).href : r.token,
                    );
                  }}
                >
                  <div className="form-grid">
                    <Field label="Expires in">
                      <select name="hours">
                        <option value="24">24 hours</option>
                        <option value="72">3 days</option>
                        <option value="168">7 days</option>
                      </select>
                    </Field>
                    <Field label="Maximum uses">
                      <input
                        name="uses"
                        type="number"
                        defaultValue="10"
                        min="1"
                        max="100"
                        required
                      />
                    </Field>
                  </div>
                  {invite && (
                    <div className="invite-result">
                      <input
                        aria-label="Generated invitation"
                        value={invite}
                        readOnly
                      />
                      <button
                        type="button"
                        className="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(invite);
                            setCopied(true);
                          } catch {
                            setError(
                              "Clipboard unavailable. Select and copy the invite above.",
                            );
                          }
                        }}
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  )}
                </ActionForm>
              ) : (
                <Empty title="Create a group first" />
              ))}
            {tab === "invite" && (
              <div className="invite-history">
                {!mayModerate && group && (
                  <p className="warning-note">
                    Only group owners and moderators can issue or revoke
                    invitations.
                  </p>
                )}
                {invites.data?.map((item) => (
                  <div key={item.id}>
                    <span>
                      {item.revoked
                        ? "Revoked"
                        : item.uses === 0
                          ? "Used"
                          : `${item.uses} use${item.uses === 1 ? "" : "s"} left`}
                      <small>Expires {date(item.expiresAt)}</small>
                    </span>
                    <button
                      className="button small"
                      disabled={item.revoked || item.uses === 0}
                      onClick={() => void revoke(item.id)}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
            {tab === "join" && (
              <ActionForm
                submitLabel="Join group"
                onSubmit={(form) => {
                  let token = String(form.get("token") || "").trim();
                  try {
                    const url = new URL(token, location.origin);
                    token =
                      url.searchParams.get("invite") ||
                      token.split("/").pop() ||
                      token;
                  } catch {
                    /* Raw token accepted. */
                  }
                  return post("/invites/redeem", { token });
                }}
                onSuccess={() => {
                  refreshAll();
                  setTab("groups");
                }}
              >
                <Field label="Invite link or token">
                  <input
                    name="token"
                    placeholder="Paste your private invitation"
                    required
                  />
                </Field>
                <p className="form-footnote">
                  Joining gives you a separate group wallet. Existing positions
                  stay in their original exchange.
                </p>
              </ActionForm>
            )}
            {tab === "members" && (
              <>
                {members.loading && <Loading />}
                <ErrorNote message={members.error} />
                <div className="members-list">
                  {members.data?.map((member) => (
                    <div key={member.id}>
                      <span className="member-avatar">
                        {member.handle.slice(0, 2).toUpperCase()}
                      </span>
                      <span>
                        <strong>@{member.handle}</strong>
                        <small>
                          {member.status?.toLowerCase()} · joined{" "}
                          {date(member.joinedAt)}
                        </small>
                      </span>
                      {group?.role === "OWNER" && member.id !== user.id ? (
                        <Select
                          value={member.role}
                          label={`Role for ${member.handle}`}
                          onChange={(role) =>
                            void updateMember(member.id, role)
                          }
                        >
                          <option value="MEMBER">Member</option>
                          <option value="MODERATOR">Moderator</option>
                        </Select>
                      ) : (
                        <Badge>{member.role}</Badge>
                      )}
                      {mayModerate &&
                        member.id !== user.id &&
                        member.role !== "OWNER" &&
                        (group?.role === "OWNER" ||
                          member.role === "MEMBER") && (
                          <button
                            className="button small"
                            onClick={() => void changeAdmission(member)}
                          >
                            {member.status === "ACTIVE" ? "Remove" : "Re-admit"}
                          </button>
                        )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <ErrorNote message={error} />
        {notice && (
          <p className="success-note" role="status">
            {notice}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function CreateMarketDialog({
  group,
  user,
  onClose,
  onCreated,
}: {
  group?: Group;
  user: User;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const members = useResource<Member[]>(
    group ? `/groups/${group.id}/members` : null,
  );
  const [b, setB] = useState("100");
  const [resolverId, setResolverId] = useState("");
  const eligibleResolvers =
    members.data?.filter((m) => m.id !== user.id && m.status === "ACTIVE") ||
    [];
  const resolver = resolverId || eligibleResolvers[0]?.id || "";
  return (
    <Modal
      title="Make the question count."
      eyebrow={`CREATE MARKET · ${group?.name || "FRIENDS"}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        {!group ? (
          <Empty
            title="Select a Friends group first"
            detail="Group markets stay private to their members."
          />
        ) : (
          <ActionForm
            submitLabel="Submit market for approval"
            onSubmit={(form) =>
              post<Market>("/markets", {
                groupId: group.id,
                question: form.get("question"),
                description: form.get("description"),
                category: form.get("category"),
                closeAt: new Date(String(form.get("closeAt"))).toISOString(),
                b: Number(b),
                resolverId: form.get("resolverId"),
                rules: {
                  condition: form.get("condition"),
                  source: form.get("source"),
                  evidence: form.get("evidence"),
                  observationAt: new Date(
                    String(form.get("observationAt")),
                  ).toISOString(),
                  voidPolicy: form.get("voidPolicy"),
                  disputeHours: Number(form.get("disputeHours")),
                  resolverId: form.get("resolverId"),
                  reviewerIds: form.getAll("reviewerIds"),
                },
              })
            }
            onSuccess={(result) => {
              refreshAll();
              onCreated((result as Market).id);
            }}
          >
            {eligibleResolvers.length === 0 && (
              <div className="warning-note">
                Invite another group member before creating a market. The
                creator cannot resolve or approve their own question. An
                independent moderator approves the draft.
              </div>
            )}
            <Field
              label="Question"
              hint="A precise, binary question that can be objectively resolved."
            >
              <input
                name="question"
                placeholder="Will … happen before …?"
                required
                minLength={10}
                maxLength={240}
              />
            </Field>
            <div className="form-grid">
              <Field label="Category">
                <select name="category">
                  <option>Politics</option>
                  <option>Sports</option>
                  <option>Technology</option>
                  <option>Economy</option>
                  <option>Culture</option>
                  <option>Science</option>
                  <option>Personal</option>
                  <option>Other</option>
                </select>
              </Field>
              <Field label="Trading closes">
                <input name="closeAt" type="datetime-local" required />
              </Field>
            </div>
            <Field label="Description">
              <textarea
                name="description"
                rows={2}
                maxLength={2000}
                placeholder="Add useful context for your group."
              />
            </Field>
            <div className="form-section-heading">Resolution contract</div>
            <Field label="Exact YES condition">
              <textarea
                name="condition"
                rows={2}
                required
                minLength={10}
                placeholder="Resolves YES if the official source reports…"
              />
            </Field>
            <div className="form-grid">
              <Field label="Authoritative source">
                <input
                  name="source"
                  placeholder="https://official-source.example"
                  required
                />
              </Field>
              <Field label="Observation time">
                <input name="observationAt" type="datetime-local" required />
              </Field>
            </div>
            <Field label="Required evidence">
              <input
                name="evidence"
                required
                placeholder="Official result page, published report, or archived statement"
              />
            </Field>
            <Field
              label="Void / ambiguity policy"
              hint="Fixed binary policy. Review this before submitting the market."
            >
              <textarea
                name="voidPolicy"
                rows={3}
                required
                readOnly
                value={BINARY_VOID_POLICY}
              />
            </Field>
            <div className="form-grid">
              <Field
                label="Independent resolver"
                hint="The creator and anyone who trades cannot resolve a market."
              >
                <select
                  name="resolverId"
                  required
                  value={resolver}
                  onChange={(event) => setResolverId(event.target.value)}
                >
                  {!eligibleResolvers.length && (
                    <option value="">Invite another member first</option>
                  )}
                  {eligibleResolvers.map((m) => (
                    <option key={m.id} value={m.id}>
                      @{m.handle}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Dispute window">
                <select name="disputeHours" defaultValue="24">
                  <option value="24">24 hours · fixed</option>
                </select>
              </Field>
            </div>
            <Field
              label="Independent reviewers"
              hint="Choose members other than the creator and resolver. Two impartial confirmations are needed for a disputed result; no quorum triggers neutral void."
            >
              <select
                name="reviewerIds"
                multiple
                size={Math.min(3, Math.max(2, members.data?.length || 2))}
              >
                {members.data
                  ?.filter(
                    (m) =>
                      m.id !== user.id &&
                      m.id !== resolver &&
                      m.status === "ACTIVE",
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      @{m.handle}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="form-section-heading">Market liquidity</div>
            <Field
              label="Liquidity parameter (b)"
              hint="Higher b makes prices more stable and uses more treasury credit."
            >
              <input
                name="b"
                type="number"
                min="10"
                max="10000"
                step="1"
                value={b}
                onChange={(e) => setB(e.target.value)}
                required
              />
            </Field>
            <div className="liquidity-impact">
              <Shield size={16} />
              <p>
                Required binary LMSR reserve:{" "}
                <strong>
                  {Number(b) > 0
                    ? credits(
                        Math.ceil(Number(b) * Math.log(2) * 1e6) / 1e6 + 1,
                      )
                    : "—"}{" "}
                  CR
                </strong>
                <br />
                <span>
                  Includes 1 CR rounding allowance. Reserved from the group
                  treasury, currently {credits(group.treasury)} CR.
                </span>
              </p>
            </div>
            <div className="liquidity-preview">
              <div className="form-section-heading">Starting price impact</div>
              <table>
                <thead>
                  <tr>
                    <th>Buy YES</th>
                    <th>Indicative cost · CR</th>
                    <th>YES after trade</th>
                  </tr>
                </thead>
                <tbody>
                  {[10, 100, 500].map((quantity) => {
                    const depth = Number(b);
                    const t = quantity / depth;
                    const supported = depth >= 10 && depth <= 10000 && t <= 30;
                    const cost = supported
                      ? depth * (t + Math.log1p(Math.exp(-t)) - Math.LN2)
                      : 0;
                    return (
                      <tr key={quantity}>
                        <td>{quantity} shares</td>
                        <td>
                          {supported
                            ? credits(cost)
                            : "Outside supported range"}
                        </td>
                        <td>
                          {supported ? percent(1 / (1 + Math.exp(-t))) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="form-footnote">
                Illustrative uniform 50/50 starting state, no peers or fees.
                Only an exact server quote can authorize a trade.
              </p>
            </div>
          </ActionForm>
        )}
      </div>
    </Modal>
  );
}

export function LeaderboardDialog({
  exchange,
  groupId,
  onClose,
}: {
  exchange: string;
  groupId: string;
  onClose: () => void;
}) {
  const [sort, setSort] = useState("profit");
  const rows = useResource<LeaderboardRow[]>(
    `/leaderboards?exchange=${exchange}${groupId && exchange === "FRIENDS" ? `&groupId=${encodeURIComponent(groupId)}` : ""}`,
    15000,
  );
  const ranked = [...(rows.data || [])].sort((a, b) =>
    sort === "profit"
      ? Number(b.pnl) - Number(a.pnl)
      : (a.brierScore ?? Infinity) - (b.brierScore ?? Infinity),
  );
  return (
    <Modal
      title={
        exchange === "LIVE"
          ? "Your live performance."
          : "A little friendly competition."
      }
      eyebrow={`${exchange === "LIVE" ? "PERSONAL PERFORMANCE" : "FRIENDS LEADERBOARD"} · SEPARATE ECONOMY`}
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="dialog-tabs">
          <button
            className={sort === "profit" ? "active" : ""}
            onClick={() => setSort("profit")}
          >
            Trading profit
          </button>
          <button
            className={sort === "calibration" ? "active" : ""}
            onClick={() => setSort("calibration")}
          >
            Forecast calibration
          </button>
        </div>
        <p className="form-footnote">
          {sort === "profit"
            ? "Trading performance stays within this exchange. Live shows your personal performance; Friends ranks your private group. Live and Friends never share a ranking."
            : "Lower Brier scores are better. Forecast accuracy is independent of trading profit; unresolved forecasts do not contribute."}
        </p>
        <ErrorNote message={rows.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Trader</th>
                <th>{sort === "profit" ? "Net worth" : "Brier score"}</th>
                <th>{sort === "profit" ? "Profit / loss" : "Forecasts"}</th>
                <th>{sort === "profit" ? "Return" : "Trades"}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row, i) => (
                <tr key={row.userId}>
                  <td className="muted">{i + 1 < 10 ? `0${i + 1}` : i + 1}</td>
                  <td className="strong">@{row.handle}</td>
                  <td>
                    {sort === "profit"
                      ? `${credits(row.netWorth)} CR`
                      : row.brierScore?.toFixed(4) || "Unscored"}
                  </td>
                  <td
                    className={
                      sort === "profit"
                        ? Number(row.pnl) >= 0
                          ? "positive"
                          : "negative"
                        : ""
                    }
                  >
                    {sort === "profit"
                      ? `${Number(row.pnl) >= 0 ? "+" : ""}${credits(row.pnl)} CR`
                      : row.forecastCount}
                  </td>
                  <td>
                    {sort === "profit"
                      ? `${row.returnPercent.toFixed(2)}%`
                      : row.tradeCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ranked.length && !rows.loading && (
          <Empty
            title="The board is wide open"
            detail={
              rows.error
                ? "Leaderboard data is unavailable."
                : "Performance appears after members trade or submit forecasts."
            }
          />
        )}
        {rows.loading && !rows.data && <Loading />}
      </div>
    </Modal>
  );
}

export function NotificationsDialog({
  onClose,
  onMarket,
}: {
  onClose: () => void;
  onMarket: (id: string) => void;
}) {
  const rows = useResource<Notification[]>("/notifications", 15000);
  const [error, setError] = useState("");
  const mark = async (id?: string) => {
    try {
      await patch(
        "/notifications",
        id ? { ids: [id], read: true } : { all: true, read: true },
      );
      refreshAll();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  return (
    <Modal title="Your inbox" eyebrow="NOTIFICATIONS" onClose={onClose}>
      <div className="modal-body">
        <div className="row-between">
          <span className="muted">
            {rows.data?.filter((n) => !n.readAt).length || 0} unread
          </span>
          <button className="inline-link" onClick={() => void mark()}>
            Mark all as read
          </button>
        </div>
        <ErrorNote message={error || rows.error} />
        <div className="notifications-list">
          {rows.data?.map((row) => (
            <div key={row.id} className={!row.readAt ? "unread" : ""}>
              <div className="notification-dot" />
              <div>
                <strong>{row.title}</strong>
                <p>{row.body}</p>
                <small>{date(row.createdAt)}</small>
                <div className="notification-actions">
                  {row.marketId && (
                    <button
                      onClick={() => {
                        onMarket(row.marketId!);
                        onClose();
                      }}
                    >
                      View market <ArrowRight size={11} />
                    </button>
                  )}
                  {!row.readAt && (
                    <button onClick={() => void mark(row.id)}>Mark read</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {!rows.data?.length && !rows.loading && (
          <Empty
            title="All caught up"
            detail="Fills, market updates, and group activity will appear here."
          />
        )}
      </div>
    </Modal>
  );
}

export function ProfileDialog({
  bootstrap,
  theme,
  setTheme,
  onClose,
  onSignOut,
}: {
  bootstrap: Bootstrap;
  theme: string;
  setTheme: (theme: string) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const preferences = useResource<{ fills: boolean; resolution: boolean }>(
    "/preferences",
  );
  const [tab, setTab] = useState("account"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      await downloadJournal();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`@${bootstrap.user?.handle}`}
      eyebrow="YOUR OPENTRADER"
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="dialog-tabs">
          <button
            className={tab === "account" ? "active" : ""}
            onClick={() => setTab("account")}
          >
            Account
          </button>
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            Appearance
          </button>
          <button
            className={tab === "journal" ? "active" : ""}
            onClick={() => setTab("journal")}
          >
            Journal
          </button>
        </div>
        {tab === "account" && (
          <>
            <div className="profile-identity">
              <span>{bootstrap.user?.handle.slice(0, 2).toUpperCase()}</span>
              <div>
                <h3>@{bootstrap.user?.handle}</h3>
                <p>Member since {date(bootstrap.user?.createdAt)}</p>
              </div>
            </div>
            <p className="profile-trading-privacy">
              Trading identity:{" "}
              {bootstrap.user?.anonymousTrading
                ? "Anonymous to other traders"
                : "Your account name"}
            </p>
            <div className="form-section-heading">Your isolated wallets</div>
            <div className="wallet-list">
              {bootstrap.wallets.map((wallet) => (
                <div key={wallet.id}>
                  <span>
                    <strong>
                      {wallet.exchange === "LIVE"
                        ? "Live simulator"
                        : bootstrap.groups.find((g) => g.id === wallet.groupId)
                            ?.name || "Friends group"}
                    </strong>
                    <small>{credits(wallet.locked)} CR locked</small>
                  </span>
                  <strong>
                    {credits(wallet.available)} <small>CR</small>
                  </strong>
                </div>
              ))}
            </div>
            <PrivacyRequest />
            <button
              className="button danger full"
              onClick={async () => {
                try {
                  await post("/auth/logout");
                  refreshAll();
                  onSignOut();
                } catch (reason) {
                  setError(errorMessage(reason));
                }
              }}
            >
              <LogOut size={13} />
              Sign out
            </button>
          </>
        )}
        {tab === "settings" && (
          <>
            <Field label="Appearance">
              <Select value={theme} onChange={setTheme} label="Theme">
                <option value="dark">Midnight</option>
                <option value="light">Daylight</option>
              </Select>
            </Field>
            <div className="form-section-heading">Notification preferences</div>
            <div className="preference-options">
              {(["fills", "resolution"] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={preferences.data?.[key] ?? true}
                    disabled={!preferences.data}
                    onChange={async (event) => {
                      try {
                        await patch("/preferences", {
                          [key]: event.target.checked,
                        });
                        preferences.refresh();
                      } catch (reason) {
                        setError(errorMessage(reason));
                      }
                    }}
                  />
                  <span>
                    {key === "fills"
                      ? "Order fills and trade activity"
                      : "Resolution and governance updates"}
                  </span>
                </label>
              ))}
            </div>
            <div className="auth-notice">
              <KeyRound size={15} />
              <p>
                Only display preferences are stored in your browser. Credits,
                orders, and positions live on the server.
              </p>
            </div>
          </>
        )}
        {tab === "journal" && (
          <>
            <div className="journal-icon">
              <ArrowDownToLine size={26} />
            </div>
            <h3 className="center">Your account history</h3>
            <p className="dialog-intro center">
              Download your personal accounting journal for an inspectable
              record of activity across your isolated wallets.
            </p>
            <button
              className="button primary full"
              onClick={() => void download()}
              disabled={busy}
            >
              {busy ? (
                <Loading>Preparing export…</Loading>
              ) : (
                <>
                  <ArrowDownToLine size={13} />
                  Download journal CSV
                </>
              )}
            </button>
          </>
        )}
        <ErrorNote message={error} />
        <p className="form-footnote">
          OpenTrader {bootstrap.settings.version} · Fictional credit economy
        </p>
      </div>
    </Modal>
  );
}
