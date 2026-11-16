import { useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  AdminAction,
  AdminReport,
  AdminRow,
  AdminSection,
} from "../shared/admin";
import { post, refreshAll, useResource } from "./api";
import { ErrorNote, Field, Loading, Modal } from "./ui";
import { errorMessage } from "./utils";
import "./admin.css";
const sections: {
  id: AdminSection;
  label: string;
  amount?: string;
  profit?: string;
}[] = [
  { id: "users", label: "Accounts" },
  {
    id: "positions",
    label: "Positions",
    amount: "Remaining cost basis",
    profit: "Realized P&L",
  },
  { id: "bets", label: "Orders", amount: "Filled value" },
  { id: "fills", label: "Trades", amount: "Trade value" },
  {
    id: "settlements",
    label: "Results",
    amount: "Gross payout",
    profit: "Realized P&L",
  },
  {
    id: "wallets",
    label: "Wallets",
    amount: "Available credits",
    profit: "Realized P&L",
  },
  { id: "treasuries", label: "Liquidity budgets", amount: "Free budget" },
  { id: "markets", label: "Markets", amount: "Settlement escrow" },
  { id: "audit", label: "Admin history", amount: "Adjustment" },
];
const categories: { label: string; sections: AdminSection[] }[] = [
  { label: "Accounts", sections: ["users"] },
  {
    label: "Activity",
    sections: ["bets", "fills", "positions", "settlements"],
  },
  { label: "Economy", sections: ["wallets", "treasuries"] },
  { label: "Markets", sections: ["markets"] },
  { label: "History", sections: ["audit"] },
];
function amount(value?: string) {
  return value === undefined
    ? "—"
    : `${value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} CR`;
}
function microcredits(value: string) {
  const raw = BigInt(value),
    absolute = raw < 0n ? -raw : raw;
  return `${raw < 0n ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}
export default function AdminDashboard({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState<AdminSection>("users"),
    [search, setSearch] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AdminRow | null>(null),
    [pending, setPending] = useState<{
      action: AdminAction;
      title: string;
    } | null>(null);
  const [adjustment, setAdjustment] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [attempt, setAttempt] = useState<{
    digest: string;
    key: string;
  } | null>(null);
  const [ledger, setLedger] = useState<{
    row: AdminRow;
    offset: number;
  } | null>(null);
  const ledgerResource = useResource<
    {
      id: number;
      transactionId: string;
      delta: string;
      reason: string;
      account: string;
      createdAt: string;
    }[]
  >(
    ledger
      ? `/admin/wallets/${encodeURIComponent(ledger.row.id)}/ledger?offset=${ledger.offset}`
      : null,
  );
  const report = useResource<AdminReport>(
    `/admin/report?section=${section}&offset=${offset}&limit=50&search=${encodeURIComponent(search)}&status=${section === "users" ? statusFilter : ""}`,
    15000,
  );
  const health = useResource<{
    balanced: boolean;
    checkedAt: string;
    guard: { tradingEnabled: boolean; reason?: string };
    operatorPaused: boolean;
    [key: string]: unknown;
  }>("/admin/reconciliation", 30000);
  const meta = sections.find((s) => s.id === section)!;
  const category = categories.find((c) => c.sections.includes(section))!;
  function prepare(action: AdminAction, title: string) {
    setAdjustment("");
    setError("");
    setSuccess("");
    setAttempt(null);
    setSelected(null);
    setPending({ action, title });
  }
  async function commit(event: React.FormEvent) {
    event.preventDefault();
    if (!pending || busy) return;
    const action = {
      ...pending.action,
      ...(pending.action.type.endsWith("ADJUSTMENT")
        ? { amount: adjustment }
        : {}),
    } as AdminAction;
    const digest = JSON.stringify(action),
      key = attempt?.digest === digest ? attempt.key : crypto.randomUUID();
    setAttempt({ digest, key });
    setBusy(true);
    setError("");
    try {
      await post("/admin/actions", action, { "Idempotency-Key": key });
      setSuccess(`${pending.title} completed.`);
      setPending(null);
      setSelected(null);
      refreshAll();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function exportPage() {
    const blob = new Blob([JSON.stringify(report.data, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `opentrader-admin-${section}-${offset}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <button className="text-link" onClick={onBack}>
            <ArrowLeft size={14} /> Back to markets
          </button>
          <h1>Admin</h1>
          <p>Manage accounts, activity, and play credits.</p>
        </div>
        <div className="admin-heading-actions">
          <span className="admin-trading-status">
            {health.data?.operatorPaused
              ? "Trading paused"
              : health.data?.guard.tradingEnabled
                ? "Trading live"
                : "Trading suspended"}
          </span>{" "}
          <button
            className="button secondary"
            disabled={!health.data}
            onClick={() =>
              prepare(
                {
                  type: "TRADING_PAUSE",
                  paused: !health.data?.operatorPaused,
                },
                health.data?.operatorPaused
                  ? "Resume trading"
                  : "Pause trading",
              )
            }
          >
            {health.data?.operatorPaused ? (
              <Play size={15} />
            ) : (
              <Pause size={15} />
            )}
            {health.data?.operatorPaused ? "Resume trading" : "Pause trading"}
          </button>
        </div>
      </div>
      <div className="admin-stats">
        <button
          onClick={() => {
            setSection("users");
            setSearch("");
            setStatusFilter("PENDING");
            setOffset(0);
          }}
        >
          <span>Awaiting approval</span>
          <strong>{report.data?.summary.pending ?? "—"}</strong>
          <small>Review account requests</small>
        </button>
        <div>
          <span>Accounts</span>
          <strong>{report.data?.summary.users ?? "—"}</strong>
          <small>Across the platform</small>
        </div>
        <div>
          <span>Open orders</span>
          <strong>{report.data?.summary.openOrders ?? "—"}</strong>
          <small>Cash and shares reserved</small>
        </div>
        <div>
          <span>Economy checks</span>
          <strong
            className={health.data?.balanced ? "admin-good" : "admin-warning"}
          >
            {health.error
              ? "Unavailable"
              : health.data?.balanced
                ? "Balanced"
                : health.loading
                  ? "Checking…"
                  : "Review needed"}
          </strong>
          <small>
            {health.data
              ? new Date(health.data.checkedAt).toLocaleTimeString()
              : "Ledger, holdings, locks and escrow"}
          </small>
        </div>
      </div>
      {error && !pending && <ErrorNote message={error} />}{" "}
      {success && (
        <p className="admin-success" role="status">
          {success}
        </p>
      )}
      {(report.error || health.error) && (
        <ErrorNote message={report.error || health.error} />
      )}
      <nav className="admin-tabs" aria-label="Admin sections">
        {categories.map((item) => (
          <button
            key={item.label}
            className={category.label === item.label ? "active" : ""}
            onClick={() => {
              setSection(item.sections[0]!);
              setOffset(0);
              setSearch("");
              setStatusFilter("");
              setSelected(null);
            }}
          >
            {item.label}
            {item.label === "Accounts" && !!report.data?.summary.pending && (
              <span>{report.data.summary.pending}</span>
            )}
          </button>
        ))}
      </nav>
      {category.sections.length > 1 && (
        <nav className="admin-subnav" aria-label={`${category.label} views`}>
          {category.sections.map((id) => (
            <button
              key={id}
              className={section === id ? "active" : ""}
              onClick={() => {
                setSection(id);
                setOffset(0);
                setSearch("");
                setSelected(null);
              }}
            >
              {sections.find((item) => item.id === id)!.label}
            </button>
          ))}
        </nav>
      )}
      <div className="admin-toolbar">
        {section === "users" && (
          <select
            className="admin-account-filter"
            aria-label="Account status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All accounts</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="REJECTED">Rejected</option>
          </select>
        )}
        <label>
          <Search size={16} />
          <input
            aria-label="Search admin records"
            placeholder={`Search ${meta.label.toLowerCase()}…`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <div>
          <span>{report.data?.total ?? 0} records</span>
          <button
            className="icon-button"
            aria-label="Refresh admin records"
            onClick={() => {
              report.refresh();
              health.refresh();
            }}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="button secondary compact"
            disabled={!report.data}
            onClick={() => void exportPage()}
          >
            <Download size={14} /> Export page
          </button>
        </div>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>
                {section === "markets"
                  ? "Market"
                  : section === "treasuries"
                    ? "Treasury"
                    : "Account"}
              </th>
              <th>Scope</th>
              <th>Status</th>
              {meta.amount && <th className="numeric">{meta.amount}</th>}
              {meta.profit && <th className="numeric">{meta.profit}</th>}
              <th>Date</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {report.data?.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <button
                    className="admin-record"
                    onClick={() => setSelected(row)}
                  >
                    <strong>{row.primary}</strong>
                    <span>{row.secondary}</span>
                  </button>
                </td>
                <td>{row.scope}</td>
                <td>
                  <span
                    className={`admin-status status-${row.status.toLowerCase()}`}
                  >
                    {row.status.replaceAll("_", " ")}
                  </span>
                </td>
                {meta.amount && (
                  <td className="numeric">{amount(row.amount)}</td>
                )}
                {meta.profit && (
                  <td className="numeric">{amount(row.profit)}</td>
                )}
                <td className="admin-date">
                  {new Date(row.createdAt).toLocaleDateString()}
                </td>
                <td>
                  {section === "users" && row.status === "PENDING" ? (
                    <div className="admin-row-actions">
                      <button
                        title="Approve account"
                        aria-label={`Approve ${row.primary}`}
                        onClick={() =>
                          prepare(
                            {
                              type: "ACCOUNT_STATUS",
                              targetId: row.id,
                              status: "APPROVED",
                            },
                            `Approve ${row.primary}`,
                          )
                        }
                      >
                        <Check size={16} />
                      </button>
                      <button
                        title="Reject account"
                        aria-label={`Reject ${row.primary}`}
                        onClick={() =>
                          prepare(
                            {
                              type: "ACCOUNT_STATUS",
                              targetId: row.id,
                              status: "REJECTED",
                            },
                            `Reject ${row.primary}`,
                          )
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-link"
                      onClick={() => setSelected(row)}
                    >
                      Details
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.loading && !report.data ? (
          <Loading />
        ) : report.data?.rows.length === 0 ? (
          <div className="admin-empty">
            No {meta.label.toLowerCase()} match this view.
          </div>
        ) : null}
      </div>
      <div className="admin-pagination">
        <span>
          {report.data?.total
            ? `${offset + 1}–${Math.min(offset + 50, report.data.total)} of ${report.data.total}`
            : "0 records"}
        </span>
        <div>
          <button
            className="icon-button"
            aria-label="Previous admin page"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Next admin page"
            disabled={!report.data || offset + 50 >= report.data.total}
            onClick={() => setOffset(offset + 50)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <p className="admin-footnote">
        Play credits · No cash value. Admin actions are saved automatically.
      </p>
      {selected && (
        <Modal
          title={selected.primary}
          eyebrow={meta.label}
          onClose={() => setSelected(null)}
        >
          <div className="modal-body admin-detail">
            <span className="admin-status">{selected.status}</span>
            <p>{selected.secondary}</p>
            <dl>
              <dt>Scope</dt>
              <dd>{selected.scope}</dd>
              <dt>Record ID</dt>
              <dd className="mono">{selected.id}</dd>
              {selected.amount !== undefined && (
                <>
                  <dt>{meta.amount}</dt>
                  <dd>{amount(selected.amount)}</dd>
                </>
              )}
              {selected.profit !== undefined && (
                <>
                  <dt>Realized P&amp;L</dt>
                  <dd>{amount(selected.profit)}</dd>
                </>
              )}
            </dl>
            <p className="admin-record-detail">{selected.detail}</p>
            <div className="admin-detail-actions">
              {section === "users" && (
                <>
                  <button
                    className="button secondary"
                    disabled={selected.status === "APPROVED"}
                    onClick={() =>
                      prepare(
                        {
                          type: "ACCOUNT_STATUS",
                          targetId: selected.id,
                          status: "APPROVED",
                        },
                        `Approve ${selected.primary}`,
                      )
                    }
                  >
                    Approve account
                  </button>
                  <button
                    className="button secondary"
                    disabled={selected.status !== "APPROVED"}
                    onClick={() =>
                      prepare(
                        {
                          type: "ACCOUNT_STATUS",
                          targetId: selected.id,
                          status: "SUSPENDED",
                        },
                        `Suspend ${selected.primary}`,
                      )
                    }
                  >
                    Suspend account
                  </button>
                </>
              )}
              {(section === "wallets" || section === "treasuries") && (
                <button
                  className="button primary"
                  onClick={() =>
                    prepare(
                      {
                        type:
                          section === "wallets"
                            ? "WALLET_ADJUSTMENT"
                            : "TREASURY_ADJUSTMENT",
                        targetId: selected.id,
                        amount: "",
                      },
                      `Adjust ${section === "wallets" ? "wallet" : "group budget"}`,
                    )
                  }
                >
                  Adjust credits
                </button>
              )}
              {section === "wallets" && (
                <button
                  className="button secondary"
                  onClick={() => {
                    setLedger({ row: selected, offset: 0 });
                    setSelected(null);
                  }}
                >
                  View cash ledger
                </button>
              )}
              {section === "bets" && selected.status === "OPEN" && (
                <button
                  className="button secondary"
                  onClick={() =>
                    prepare(
                      {
                        type: "CANCEL_ORDER",
                        targetId: selected.id,
                      },
                      "Cancel order",
                    )
                  }
                >
                  Cancel order and release locks
                </button>
              )}
              {section === "markets" &&
                (selected.exchange === "FRIENDS" ||
                  selected.executionModel === "SOURCE_SEEDED_LMSR") &&
                ["OPEN", "HALTED"].includes(selected.status) && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      prepare(
                        {
                          type:
                            selected.status === "OPEN"
                              ? "HALT_MARKET"
                              : "RESUME_MARKET",
                          targetId: selected.id,
                        },
                        selected.status === "OPEN"
                          ? "Halt market"
                          : "Resume market",
                      )
                    }
                  >
                    {selected.status === "OPEN"
                      ? "Halt market"
                      : "Resume market"}
                  </button>
                )}
            </div>
          </div>
        </Modal>
      )}
      {pending && (
        <Modal
          title={pending.title}
          eyebrow="Admin"
          onClose={() => {
            if (!busy) {
              setPending(null);
              setError("");
            }
          }}
        >
          <form
            className="modal-body admin-action-form"
            onSubmit={(e) => void commit(e)}
          >
            <p>
              {pending.action.type.endsWith("ADJUSTMENT")
                ? "Enter a positive amount to allocate credits, or a negative amount to reclaim available credits. Locked funds and market escrow cannot be reclaimed."
                : pending.action.type === "ACCOUNT_STATUS" &&
                    pending.action.status === "APPROVED"
                  ? "First approval creates separate Live and Friends wallets with 10,000 play credits each. Reactivation never issues a second allocation."
                  : "Changes are saved automatically. Existing fills and holdings remain recorded."}
            </p>
            {pending.action.type.endsWith("ADJUSTMENT") && (
              <Field
                label="Credit adjustment"
                hint="Up to 6 decimal places. Maximum 1,000,000 credits per action."
              >
                <input
                  value={adjustment}
                  onChange={(e) => setAdjustment(e.target.value)}
                  placeholder="e.g. 250 or -100"
                  required
                  pattern="-?[0-9]+(\.[0-9]{1,6})?"
                  autoFocus
                />
              </Field>
            )}
            {error && <ErrorNote message={error} />}
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? "Saving…" : pending.title}
            </button>
          </form>
        </Modal>
      )}
      {ledger && (
        <Modal
          title={`${ledger.row.primary} · Cash ledger`}
          eyebrow={ledger.row.scope}
          onClose={() => setLedger(null)}
        >
          <div className="modal-body">
            {ledgerResource.error && (
              <ErrorNote message={ledgerResource.error} />
            )}
            <p>
              Exact signed credit amounts from the journal, including available
              and held cash accounts.
            </p>
            <div className="admin-ledger">
              {ledgerResource.data?.map((e) => (
                <article key={e.id}>
                  <strong>{amount(microcredits(e.delta))}</strong>
                  <span>{e.reason.replaceAll("_", " ")}</span>
                  <small>
                    {new Date(e.createdAt).toLocaleString()} ·{" "}
                    {e.account.startsWith("lock:") ? "Held" : "Available"}
                  </small>
                  <small className="mono">{e.transactionId}</small>
                </article>
              ))}
            </div>
            <div className="admin-pagination">
              <button
                className="button secondary"
                disabled={!ledger.offset}
                onClick={() =>
                  setLedger({
                    ...ledger,
                    offset: Math.max(0, ledger.offset - 100),
                  })
                }
              >
                Previous
              </button>
              <button
                className="button secondary"
                disabled={(ledgerResource.data?.length ?? 0) < 100}
                onClick={() =>
                  setLedger({ ...ledger, offset: ledger.offset + 100 })
                }
              >
                Next 100
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
