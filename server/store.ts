import {
  LIVE_LIQUIDITY_ACCOUNT,
  LIVE_INITIAL_SUBSIDY,
  LIVE_LIQUIDITY_B,
  LIVE_ACTIVATION_LIMIT,
  seedLiveCurve,
  curveReserve,
  sourceRulesHash,
  type LiveCurve,
} from "./live-economy.js";
import type {
  AdminAction,
  AdminReport,
  AdminSection,
  AdminRow,
} from "../shared/admin.js";
import { BINARY_VOID_POLICY } from "../shared/rules.js";
import { validateMarketContent } from "./content-policy.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type {
  User,
  Group,
  Wallet,
  Market,
  MarketRules,
  Order,
  OrderInput,
  OrderReceipt,
  Fill,
  Position,
  Quote,
  OrderBook,
  Candle,
  Member,
  Comment,
  Notification,
  Exchange,
  LeaderboardRow,
  Resolution,
} from "../shared/types.js";
import { ammCost, money, units, probability, reserve } from "./math.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new AppError(status, code, message);
}
const id = () => randomUUID();
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const requestHash = (input: OrderInput) =>
  hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ),
  );
const INITIAL = 10_000_000_000n;
const TREASURY = 100_000_000_000n;
type StoredUser = User & {
  password: string;
  salt: string;
  anonymitySeed?: string;
};
type StoredGroup = Omit<Group, "role" | "memberCount" | "treasury"> & {
  ownerId: string;
};
type Membership = {
  groupId: string;
  userId: string;
  role: Member["role"];
  joinedAt: string;
  status: string;
};
type StoredWallet = {
  id: string;
  userId: string;
  exchange: Exchange;
  groupId: string | null;
  seasonId: string;
  initial: string;
};
type StoredPosition = {
  userId: string;
  marketId: string;
  outcomeId: string;
  basis: string;
  realized: string;
};
type StoredOrder = Order & {
  userId: string;
  exchange: Exchange;
  groupId: string | null;
};
type StoredMarket = Market & {
  q: number[];
  curve?: LiveCurve;
  reserve: string;
  approvedBy?: string;
  determinedAt?: string;
  calibrationReason?: string;
  settledHoldings?: {
    userId: string;
    outcomeId: string;
    quantity: number;
    payout: string;
  }[];
};
type StoredFill = Fill & { userId: string };
type Invite = {
  id: string;
  groupId: string;
  hash: string;
  expiresAt: string;
  uses: number;
  revoked: boolean;
};
type Forecast = {
  id: string;
  userId: string;
  marketId: string;
  probability: number;
  createdAt: string;
};
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
type State = {
  users: Record<string, StoredUser>;
  sessions: Record<string, { userId: string; expiresAt: string }>;
  groups: Record<string, StoredGroup>;
  members: Membership[];
  wallets: Record<string, StoredWallet>;
  accounts: Record<string, string>;
  markets: Record<string, StoredMarket>;
  orders: Record<string, StoredOrder>;
  positions: Record<string, StoredPosition>;
  fills: StoredFill[];
  invites: Record<string, Invite>;
  idempotency: Record<string, { hash: string; result: OrderReceipt }>;
  quotes: Record<
    string,
    {
      userId: string;
      quote: Quote;
      input: Partial<OrderInput>;
      bookHash?: string;
      curve?: LiveCurve;
    }
  >;
  comments: Comment[];
  watch: Record<string, string[]>;
  notifications: Record<string, Notification[]>;
  preferences: Record<string, { fills: boolean; resolution: boolean }>;
  forecasts: Forecast[];
  corrections: Record<string, Correction>;
  liveBooks: Record<string, OrderBook>;
  operatorPaused: boolean;
  orderSequences: Record<string, number>;
};
const empty = (): State => ({
  users: {},
  sessions: {},
  groups: {},
  members: [],
  wallets: {},
  accounts: {},
  markets: {},
  orders: {},
  positions: {},
  fills: [],
  invites: {},
  idempotency: {},
  quotes: {},
  comments: [],
  watch: {},
  notifications: {},
  preferences: {},
  forecasts: [],
  corrections: {},
  liveBooks: {},
  operatorPaused: false,
  orderSequences: {},
});
export class Store {
  readonly db: DatabaseSync;
  private state: State;
  private inTx = false;
  private txid = "";
  private commandTime: number | null = null;
  private dataVersion = -1;
  private matchingWork = 0;
  readonly clock: () => Date;
  readonly liveCommunity: boolean;
  constructor(
    options: { path?: string; now?: () => Date; liveCommunity?: boolean } = {},
  ) {
    this.liveCommunity = options.liveCommunity ?? false;
    const path = options.path ?? "data/opentrader.sqlite";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const wallClock = options.now ?? (() => new Date());
    this.clock = () => new Date(this.commandTime ?? wallClock().getTime());
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS admin_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(actor_id,idempotency_key));
 CREATE TRIGGER IF NOT EXISTS admin_no_update BEFORE UPDATE ON admin_events BEGIN SELECT RAISE(ABORT,'Admin audit is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS admin_no_delete BEFORE DELETE ON admin_events BEGIN SELECT RAISE(ABORT,'Admin audit is immutable'); END;
 CREATE TABLE IF NOT EXISTS moderation_events (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS moderation_no_update BEFORE UPDATE ON moderation_events BEGIN SELECT RAISE(ABORT,'Moderation audit is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS moderation_no_delete BEFORE DELETE ON moderation_events BEGIN SELECT RAISE(ABORT,'Moderation audit is immutable'); END;
 CREATE TABLE IF NOT EXISTS market_events (market_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_index INTEGER NOT NULL DEFAULT 0, transaction_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(market_id,sequence,event_index));
 CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON market_events BEGIN SELECT RAISE(ABORT,'Market events are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON market_events BEGIN SELECT RAISE(ABORT,'Market events are immutable'); END;
 CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL, asset TEXT NOT NULL, account TEXT NOT NULL, delta TEXT NOT NULL, reason TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT,'Journal is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT,'Journal is immutable'); END;`);
    this.db
      .prepare("INSERT OR IGNORE INTO state(id,data) VALUES(1,?)")
      .run(JSON.stringify(empty()));
    this.state = empty();
    this.refresh();
    if (this.liveCommunity)
      this.transaction(() => {
        if (this.state.accounts[LIVE_LIQUIDITY_ACCOUNT] === undefined)
          this.transfer(
            "issuer:live-liquidity:v2",
            LIVE_LIQUIDITY_ACCOUNT,
            LIVE_INITIAL_SUBSIDY,
            "cash",
            "FINITE_LIVE_LIQUIDITY_BUDGET",
            "live-1:v2",
          );
      });
  }
  close() {
    this.db.close();
  }
  now() {
    return this.clock().toISOString();
  }
  private refresh(force = false) {
    if (this.inTx) return;
    const version = (
      this.db.prepare("PRAGMA data_version").get() as { data_version: number }
    ).data_version;
    if (force || version !== this.dataVersion) {
      this.state = {
        ...empty(),
        ...JSON.parse(
          (
            this.db.prepare("SELECT data FROM state WHERE id=1").get() as {
              data: string;
            }
          ).data,
        ),
      } as State;
      this.dataVersion = version;
    }
  }
  private transaction<T>(fn: () => T): T {
    if (this.inTx) {
      const value = fn();
      if (value && typeof value === "object" && "then" in value)
        throw new Error("SQLite commands must be synchronous");
      return value;
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.refresh();
    this.commandTime = this.clock().getTime();
    this.inTx = true;
    this.txid = id();
    this.matchingWork = 0;
    const previous = new Map(
      Object.values(this.state.markets).map((m) => [m.id, m.sequence]),
    );
    try {
      const result = fn(),
        changed = new Set<string>();
      if (result && typeof result === "object" && "then" in result)
        throw new Error("SQLite commands must be synchronous");
      for (const market of Object.values(this.state.markets)) {
        const before = previous.get(market.id);
        if (before === undefined || before !== market.sequence) {
          market.sequence =
            before === undefined ? Math.max(0, market.sequence) : before + 1;
          changed.add(market.id);
          this.db
            .prepare(
              "INSERT INTO market_events(market_id,sequence,transaction_id,type,data,created_at) VALUES(?,?,?,?,?,?)",
            )
            .run(
              market.id,
              market.sequence,
              this.txid,
              "MARKET_BATCH",
              JSON.stringify(this.marketView(market)),
              this.now(),
            );
        }
      }
      if (result && typeof result === "object" && "sequence" in result) {
        const value = result as {
            sequence: number;
            marketId?: string;
            id?: string;
            order?: { marketId: string };
          },
          marketId = value.marketId ?? value.order?.marketId ?? value.id;
        if (marketId && changed.has(marketId))
          value.sequence = this.state.markets[marketId]!.sequence;
      }
      const response = structuredClone(result);
      this.db
        .prepare("UPDATE state SET data=? WHERE id=1")
        .run(JSON.stringify(this.state));
      this.db.exec("COMMIT");
      this.inTx = false;
      this.commandTime = null;
      return response;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.inTx = false;
      this.commandTime = null;
      this.refresh(true);
      throw error;
    }
  }
  // Internal synchronous command composition; never expose callbacks to API clients.
  atomic<T>(fn: () => T): T {
    return this.transaction(fn);
  }
  private balance(account: string) {
    return BigInt(this.state.accounts[account] ?? "0");
  }
  private transfer(
    from: string,
    to: string,
    amount: bigint,
    asset: string,
    reason: string,
    reference: string,
  ) {
    if (amount < 0n) fail(422, "NEGATIVE", "Negative transfer");
    if (!amount) return;
    if (!from.startsWith("issuer:") && this.balance(from) < amount)
      fail(422, "INSUFFICIENT_FUNDS", "Insufficient available balance");
    this.state.accounts[from] = (this.balance(from) - amount).toString();
    this.state.accounts[to] = (this.balance(to) + amount).toString();
    const insert = this.db.prepare(
      "INSERT INTO journal(transaction_id,asset,account,delta,reason,reference,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    insert.run(
      this.txid,
      asset,
      from,
      (-amount).toString(),
      reason,
      reference,
      this.now(),
    );
    insert.run(
      this.txid,
      asset,
      to,
      amount.toString(),
      reason,
      reference,
      this.now(),
    );
  }
  private publicUser(u: StoredUser): User {
    return {
      id: u.id,
      handle: u.handle,
      createdAt: u.createdAt,
      anonymousTrading: u.anonymousTrading ?? false,
      platformRole: u.platformRole ?? "USER",
      status: u.status ?? "APPROVED",
    };
  }
  user(userId: string): User {
    this.refresh();
    const u = this.state.users[userId];
    if (!u) fail(401, "UNAUTHENTICATED", "Sign in required");
    if ((u.status ?? "APPROVED") !== "APPROVED")
      fail(
        403,
        "ACCOUNT_RESTRICTED",
        "Your account must be approved and active to continue",
      );
    return this.publicUser(u);
  }
  private tradingIdentity(
    userId: string,
    exchange: Exchange,
    groupId: string | null,
  ) {
    const user = this.state.users[userId]!;
    if (!user.anonymousTrading) return { userId, handle: user.handle };
    const opaque = hash(
      `${user.anonymitySeed ?? user.password}:${exchange}:${groupId ?? "global"}`,
    );
    return {
      userId: `anonymous:${opaque}`,
      handle: `Anonymous-${opaque.slice(0, 6).toUpperCase()}`,
    };
  }
  private session(userId: string) {
    const token = randomBytes(32).toString("base64url");
    this.state.sessions[hash(token)] = {
      userId,
      expiresAt: new Date(this.clock().getTime() + 30 * 864e5).toISOString(),
    };
    return token;
  }
  authenticate(token?: string): User | null {
    this.refresh();
    if (!token) return null;
    const s = this.state.sessions[hash(token)];
    return s && s.expiresAt > this.now() && this.state.users[s.userId]
      ? this.publicUser(this.state.users[s.userId]!)
      : null;
  }
  requestRegistration(
    handle: string,
    password: string,
    anonymousTrading = false,
  ) {
    return this.register(handle, password, { pending: true, anonymousTrading });
  }
  createAdmin(handle: string, password: string) {
    return this.transaction(() => {
      const result = this.register(handle, password, { admin: true });
      const eventId = id();
      this.db
        .prepare(
          "INSERT INTO admin_events(id,actor_id,idempotency_key,request_hash,action,data,result,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          eventId,
          result.user.id,
          eventId,
          hash(handle),
          "PROVISION_ADMIN",
          JSON.stringify({
            reason: "Local operator CLI provisioned administrator",
            targetId: result.user.id,
          }),
          JSON.stringify({ id: eventId, ok: true }),
          this.now(),
        );
      return result;
    });
  }
  // Trusted local provisioning only. HTTP registrations always use requestRegistration.
  register(
    handle: string,
    password: string,
    options: {
      pending?: boolean;
      admin?: boolean;
      anonymousTrading?: boolean;
    } = {},
  ) {
    if (
      typeof handle !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/.test(handle)
    )
      fail(
        422,
        "INVALID_HANDLE",
        "Use 3–30 letters, digits, underscores or hyphens",
      );
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 200
    )
      fail(422, "INVALID_PASSWORD", "Password must have 12–200 characters");
    const salt = randomBytes(16).toString("hex");
    const digest = scryptSync(password, salt, 64).toString("hex");
    return this.transaction(() => {
      if (
        Object.values(this.state.users).some(
          (u) => u.handle.toLowerCase() === handle.toLowerCase(),
        )
      )
        fail(409, "HANDLE_EXISTS", "Handle is already registered");
      const u: StoredUser = {
        anonymousTrading: options.anonymousTrading === true,
        anonymitySeed: randomBytes(32).toString("hex"),
        platformRole: options.admin ? "ADMIN" : "USER",
        status: options.pending ? "PENDING" : "APPROVED",
        id: id(),
        handle,
        createdAt: this.now(),
        salt,
        password: digest,
      };
      this.state.users[u.id] = u;
      if (!options.pending) this.initializeEconomy(u.id);
      return { user: this.publicUser(u), token: this.session(u.id) };
    });
  }
  private initializeEconomy(userId: string) {
    if (Object.values(this.state.wallets).some((w) => w.userId === userId))
      return;
    this.allocate(userId, "LIVE", null, "live-1");
    if (this.state.accounts["reserve:live-corrections"] === undefined)
      this.transfer(
        "issuer:live-correction-budget",
        "reserve:live-corrections",
        TREASURY,
        "cash",
        "FINITE_CORRECTION_BUDGET",
        "live-1",
      );
    this.createGroup(userId, {
      name: `${this.state.users[userId]!.handle}'s exchange`,
      description:
        "Private play-credit prediction markets. Invite friends to start.",
    });
  }
  login(handle: string, password: string) {
    this.refresh();
    if (
      typeof handle !== "string" ||
      typeof password !== "string" ||
      password.length > 200
    )
      fail(401, "INVALID_CREDENTIALS", "Invalid handle or password");
    const u = Object.values(this.state.users).find(
      (x) => x.handle.toLowerCase() === handle.toLowerCase(),
    );
    const salt = u?.salt ?? "00000000000000000000000000000000";
    const digest = scryptSync(password, salt, 64);
    if (!u || !timingSafeEqual(digest, Buffer.from(u.password, "hex")))
      fail(401, "INVALID_CREDENTIALS", "Invalid handle or password");
    return this.transaction(() => ({
      user: this.publicUser(u),
      token: this.session(u.id),
    }));
  }
  logout(token: string) {
    return this.transaction(() => {
      delete this.state.sessions[hash(token)];
      return { ok: true };
    });
  }
  private allocationKey(
    userId: string,
    exchange: Exchange,
    groupId: string | null,
    seasonId: string,
  ) {
    return `${exchange}:${groupId ?? "global"}:${seasonId}:${userId}`;
  }
  private allocate(
    userId: string,
    exchange: Exchange,
    groupId: string | null,
    seasonId: string,
  ) {
    const key = this.allocationKey(userId, exchange, groupId, seasonId);
    if (this.state.wallets[key]) return;
    this.state.wallets[key] = {
      id: key,
      userId,
      exchange,
      groupId,
      seasonId,
      initial: INITIAL.toString(),
    };
    this.transfer(
      `issuer:cash:${exchange}:${groupId ?? "global"}`,
      "cash:" + key,
      INITIAL,
      "cash",
      "SEASON_ALLOCATION",
      key,
    );
  }
  private walletRecord(
    userId: string,
    exchange: Exchange,
    groupId: string | null,
  ) {
    const w = Object.values(this.state.wallets).find(
      (w) =>
        w.userId === userId && w.exchange === exchange && w.groupId === groupId,
    );
    if (!w) fail(404, "WALLET_NOT_FOUND", "Wallet not found");
    return w;
  }
  private walletView(w: StoredWallet): Wallet {
    const available = this.balance("cash:" + w.id),
      locked = this.balance("lock:" + w.id);
    return {
      id: w.id,
      exchange: w.exchange,
      groupId: w.groupId,
      available: money(available),
      locked: money(locked),
      total: money(available + locked),
      initial: money(w.initial),
    };
  }
  wallets(userId: string): Wallet[] {
    this.refresh();
    this.user(userId);
    return Object.values(this.state.wallets)
      .filter((w) => w.userId === userId)
      .map((w) => this.walletView(w));
  }
  private membership(userId: string, groupId: string) {
    this.user(userId);
    const m = this.state.members.find(
      (m) =>
        m.userId === userId && m.groupId === groupId && m.status === "ACTIVE",
    );
    if (!m) fail(403, "GROUP_FORBIDDEN", "Active group membership required");
    return m;
  }
  private moderator(userId: string, groupId: string) {
    const m = this.membership(userId, groupId);
    if (m.role === "MEMBER")
      fail(403, "MODERATOR_REQUIRED", "Group moderator required");
    return m;
  }
  groups(userId: string): Group[] {
    this.refresh();
    this.user(userId);
    return this.state.members
      .filter((m) => m.userId === userId && m.status === "ACTIVE")
      .map((m) => ({
        ...this.state.groups[m.groupId]!,
        role: m.role,
        memberCount: this.state.members.filter(
          (x) => x.groupId === m.groupId && x.status === "ACTIVE",
        ).length,
        treasury: money(this.balance("treasury:" + m.groupId)),
      }));
  }
  createGroup(
    userId: string,
    input: { name: string; description?: string },
  ): Group {
    return this.transaction(() => {
      this.user(userId);
      if (
        typeof input.name !== "string" ||
        input.name.trim().length < 2 ||
        input.name.length > 80
      )
        fail(422, "INVALID_GROUP", "Group name must be 2–80 characters");
      if (
        Object.values(this.state.groups).filter((g) => g.ownerId === userId)
          .length >= 10
      )
        fail(422, "GROUP_LIMIT", "At most ten owned groups");
      const g = {
        id: id(),
        name: input.name.trim(),
        description: String(input.description ?? "").slice(0, 1000),
        seasonId: id(),
        createdAt: this.now(),
        ownerId: userId,
      };
      this.state.groups[g.id] = g;
      this.state.members.push({
        groupId: g.id,
        userId,
        role: "OWNER",
        joinedAt: this.now(),
        status: "ACTIVE",
      });
      this.allocate(userId, "FRIENDS", g.id, g.seasonId);
      this.transfer(
        "issuer:sponsor:" + g.id,
        "treasury:" + g.id,
        TREASURY,
        "cash",
        "FINITE_SPONSOR_BUDGET",
        g.id,
      );
      return this.groups(userId).find((x) => x.id === g.id)!;
    });
  }
  members(userId: string, groupId: string): Member[] {
    this.refresh();
    this.membership(userId, groupId);
    return this.state.members
      .filter((m) => m.groupId === groupId)
      .map((m) => ({
        id: m.userId,
        handle: this.state.users[m.userId]!.handle,
        role: m.role,
        joinedAt: m.joinedAt,
        status: m.status,
      }));
  }
  invite(
    userId: string,
    groupId: string,
    input: { expiresHours?: number; uses?: number },
  ) {
    return this.transaction(() => {
      this.moderator(userId, groupId);
      const hours = input.expiresHours ?? 72,
        uses = input.uses ?? 1;
      if (
        !Number.isInteger(uses) ||
        uses < 1 ||
        uses > 100 ||
        !Number.isFinite(hours) ||
        hours < 1 ||
        hours > 720
      )
        fail(422, "INVALID_INVITE", "Invite lifetime 1–720 hours; uses 1–100");
      const token = randomBytes(24).toString("base64url");
      const invite: Invite = {
        id: id(),
        groupId,
        hash: hash(token),
        expiresAt: new Date(
          this.clock().getTime() + hours * 36e5,
        ).toISOString(),
        uses,
        revoked: false,
      };
      this.state.invites[invite.id] = invite;
      return {
        id: invite.id,
        token,
        expiresAt: invite.expiresAt,
        url: `/?invite=${token}`,
      };
    });
  }
  invites(userId: string, groupId: string) {
    this.refresh();
    this.moderator(userId, groupId);
    return Object.values(this.state.invites)
      .filter((x) => x.groupId === groupId)
      .map(({ hash: _, ...x }) => x);
  }
  revokeInvite(userId: string, groupId: string, inviteId: string) {
    return this.transaction(() => {
      this.moderator(userId, groupId);
      const i = this.state.invites[inviteId];
      if (!i || i.groupId !== groupId)
        fail(404, "NOT_FOUND", "Invite not found");
      i.revoked = true;
      return { ok: true };
    });
  }
  redeem(userId: string, token: string) {
    return this.transaction(() => {
      this.user(userId);
      if (typeof token !== "string")
        fail(422, "INVALID_INVITE", "Invite token required");
      const i = Object.values(this.state.invites).find(
        (x) => x.hash === hash(token),
      );
      if (!i || i.revoked || i.uses < 1 || i.expiresAt <= this.now())
        fail(422, "INVALID_INVITE", "Invite expired, revoked or exhausted");
      let m = this.state.members.find(
        (x) => x.userId === userId && x.groupId === i.groupId,
      );
      if (m?.status === "ACTIVE")
        return this.groups(userId).find((g) => g.id === i.groupId)!;
      i.uses--;
      if (m) {
        m.status = "ACTIVE";
        m.role = "MEMBER";
      } else
        this.state.members.push({
          userId,
          groupId: i.groupId,
          role: "MEMBER",
          status: "ACTIVE",
          joinedAt: this.now(),
        });
      this.allocate(
        userId,
        "FRIENDS",
        i.groupId,
        this.state.groups[i.groupId]!.seasonId,
      );
      return this.groups(userId).find((g) => g.id === i.groupId)!;
    });
  }
  changeMember(
    userId: string,
    groupId: string,
    targetId: string,
    input: { role?: Member["role"]; status?: string },
  ) {
    return this.transaction(() => {
      const actor = this.moderator(userId, groupId);
      const target = this.state.members.find(
        (m) => m.userId === targetId && m.groupId === groupId,
      );
      if (!target) fail(404, "NOT_FOUND", "Member not found");
      if (
        target.role === "OWNER" ||
        (actor.role !== "OWNER" && target.role !== "MEMBER")
      )
        fail(
          403,
          "ROLE_PROTECTED",
          "Only the owner can manage moderators; owner cannot be removed",
        );
      if (input.role) {
        if (
          actor.role !== "OWNER" ||
          !["MEMBER", "MODERATOR"].includes(input.role)
        )
          fail(403, "ROLE_PROTECTED", "Only owner can appoint moderators");
        target.role = input.role;
      }
      if (input.status) {
        if (!["ACTIVE", "REMOVED"].includes(input.status))
          fail(422, "INVALID_STATUS", "Invalid member status");
        target.status = input.status;
        if (input.status === "REMOVED")
          for (const o of Object.values(this.state.orders))
            if (
              o.userId === targetId &&
              o.groupId === groupId &&
              o.status === "OPEN"
            )
              this.cancelInternal(o, "CANCELLED");
      }
      return this.members(userId, groupId);
    });
  }
  private canRead(userId: string, m: Market) {
    return (
      m.exchange === "LIVE" ||
      this.state.members.some(
        (member) =>
          member.groupId === m.groupId &&
          member.userId === userId &&
          member.status === "ACTIVE",
      )
    );
  }
  private marketRecord(userId: string, marketId: string) {
    const m = this.state.markets[marketId];
    if (!m) fail(404, "MARKET_NOT_FOUND", "Market not found");
    if (m.exchange === "FRIENDS") this.membership(userId, m.groupId!);
    else this.user(userId);
    return m;
  }
  private communityMarket(m: Market): boolean {
    const stored = this.state.markets[m.id];
    return (
      !!stored?.curve ||
      (this.liveCommunity &&
        m.exchange === "LIVE" &&
        m.outcomes.length === 2 &&
        !this.state.fills.some((f) => f.marketId === m.id))
    );
  }
  projectLiveMarket(source: Market): Market {
    this.refresh();
    const stored = this.state.markets[source.id];
    if (stored?.curve || stored?.resolution?.state === "FINAL")
      return this.syncLiveMarket(source);
    return {
      ...structuredClone(source),
      executionModel: this.communityMarket(source)
        ? "SOURCE_SEEDED_LMSR"
        : "EXTERNAL_SIM",
      engineVersion: this.communityMarket(source) ? 2 : 1,
    };
  }
  private candidateCurve(
    m: StoredMarket,
    book: OrderBook,
    userId: string,
  ): StoredMarket {
    if (m.curve) return m;
    let curve: LiveCurve;
    try {
      curve = seedLiveCurve(m, book, userId, this.now());
    } catch (error) {
      fail(422, "SEED_UNAVAILABLE", (error as Error).message);
    }
    const required = curveReserve(curve);
    if (this.balance(LIVE_LIQUIDITY_ACCOUNT) < required)
      fail(
        409,
        "LIVE_LIQUIDITY_EXHAUSTED",
        "Live liquidity budget is fully reserved; an administrator can allocate additional sponsor credits",
      );
    const active = Object.values(this.state.markets).filter(
      (x) =>
        x.curve?.openedBy === userId &&
        !["RESOLVED", "VOID"].includes(x.status),
    );
    if (active.length >= LIVE_ACTIVATION_LIMIT)
      fail(
        409,
        "LIVE_ACTIVATION_LIMIT",
        "An account may open at most five unsettled Live markets; existing markets remain available",
      );
    return {
      ...m,
      curve,
      b: LIVE_LIQUIDITY_B,
      q: [0, 0],
      reserve: required.toString(),
      volume: 0,
      reference: {
        outcomes: structuredClone(m.outcomes),
        timestamp: m.updatedAt,
        status: m.status,
        volume: m.volume,
      },
    };
  }
  private marketView(m: StoredMarket): Market {
    const {
      q,
      reserve: _,
      approvedBy,
      determinedAt,
      calibrationReason,
      settledHoldings,
      curve,
      ...v
    } = m;
    return structuredClone({
      ...v,
      ...(m.exchange === "LIVE"
        ? {
            executionModel: this.communityMarket(m)
              ? ("SOURCE_SEEDED_LMSR" as const)
              : ("EXTERNAL_SIM" as const),
            engineVersion: m.curve ? 2 : this.communityMarket(m) ? 2 : 1,
            ...(curve
              ? {
                  pricing: {
                    active: true,
                    prior: curve.prior.map((p) => p / 1_000_000),
                    anchorAt: curve.anchorAt,
                    openedAt: curve.openedAt,
                    maximumSubsidy: money(curveReserve(curve)),
                  },
                }
              : {}),
          }
        : {}),
      outcomes: v.outcomes.map((o, i) => ({
        ...o,
        probability:
          m.resolution?.state === "FINAL" &&
          ["RESOLVED", "VOID"].includes(m.status)
            ? m.resolution.outcomeId === null
              ? 0.5
              : m.resolution.outcomeId === o.id
                ? 1
                : 0
            : m.exchange === "FRIENDS" || !!m.curve
              ? probability(q, m.b!, i, m.curve?.prior)
              : o.probability,
      })),
    });
  }
  market(userId: string, marketId: string) {
    this.refresh();
    return this.marketView(this.marketRecord(userId, marketId));
  }
  markets(userId: string, groupId?: string): Market[] {
    this.refresh();
    if (groupId) this.membership(userId, groupId);
    const groups = new Set(this.groups(userId).map((x) => x.id));
    return Object.values(this.state.markets)
      .filter(
        (m) =>
          m.exchange === "FRIENDS" &&
          groups.has(m.groupId!) &&
          (!groupId || m.groupId === groupId),
      )
      .map((m) => this.marketView(m));
  }
  createMarket(
    userId: string,
    input: {
      groupId: string;
      question: string;
      description?: string;
      category?: string;
      closeAt: string;
      b?: number;
      rules: MarketRules;
    },
  ): Market {
    return this.transaction(() => {
      this.membership(userId, input.groupId);
      validateMarketContent(input);
      if (
        typeof input.question !== "string" ||
        input.question.trim().length < 10 ||
        input.question.length > 240
      )
        fail(422, "INVALID_QUESTION", "Question requires 10–240 characters");
      const close = Date.parse(input.closeAt),
        r = input.rules,
        b = input.b ?? 500;
      if (!Number.isFinite(close) || close <= this.clock().getTime())
        fail(422, "INVALID_CLOSE", "Close time must be in the future");
      if (!Number.isInteger(b) || b < 10 || b > 10000)
        fail(
          422,
          "INVALID_LIQUIDITY",
          "Liquidity b must be an integer from 10 to 10,000",
        );
      if (
        !r ||
        !r.condition?.trim() ||
        !r.source?.trim() ||
        !r.evidence?.trim() ||
        !Number.isFinite(Date.parse(r.observationAt))
      )
        fail(
          422,
          "INVALID_RULES",
          "Complete objective rules and observation deadline are required",
        );
      if (Date.parse(r.observationAt) < close)
        fail(
          422,
          "INVALID_OBSERVATION",
          "The observation deadline must be at or after trading close",
        );
      if (r.disputeHours !== 24)
        fail(422, "INVALID_RULES", "Challenge window is frozen at 24 hours");
      this.membership(r.resolverId, input.groupId);
      if (r.resolverId === userId)
        fail(
          422,
          "CONFLICTED_RESOLVER",
          "Creator cannot resolve their own market",
        );
      if (
        !Array.isArray(r.reviewerIds) ||
        new Set(r.reviewerIds).size !== r.reviewerIds.length ||
        r.reviewerIds.some((x) => x === userId || x === r.resolverId)
      )
        fail(
          422,
          "INVALID_REVIEWERS",
          "Reviewers must be distinct from creator and resolver",
        );
      r.reviewerIds.forEach((x) => this.membership(x, input.groupId));
      const m: StoredMarket = {
        id: id(),
        exchange: "FRIENDS",
        provider: null,
        groupId: input.groupId,
        question: input.question.trim(),
        description: String(input.description ?? "").slice(0, 5000),
        category: input.category ?? "Other",
        outcomes: [
          { id: "yes", label: "YES", probability: 0.5 },
          { id: "no", label: "NO", probability: 0.5 },
        ],
        status: "DRAFT",
        volume: 0,
        liquidity: 0,
        closeAt: new Date(close).toISOString(),
        createdAt: this.now(),
        updatedAt: this.now(),
        sequence: 0,
        b,
        creatorId: userId,
        resolverId: r.resolverId,
        rules: {
          ...structuredClone(r),
          observationAt: new Date(r.observationAt).toISOString(),
          voidPolicy: BINARY_VOID_POLICY,
        },
        q: [0, 0],
        reserve: "0",
      };
      this.state.markets[m.id] = m;
      return this.marketView(m);
    });
  }
  approveMarket(userId: string, marketId: string) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId);
      this.moderator(userId, m.groupId!);
      validateMarketContent(m);
      if (userId === m.creatorId)
        fail(403, "SELF_APPROVAL", "Creator cannot approve their market");
      if (
        m.status !== "DRAFT" ||
        Date.parse(m.closeAt) <= this.clock().getTime()
      )
        fail(409, "INVALID_STATE", "Only a future draft can be approved");
      this.membership(m.resolverId!, m.groupId!);
      const funding = reserve(m.b!);
      this.transfer(
        "treasury:" + m.groupId,
        "escrow:" + m.id,
        funding,
        "cash",
        "MARKET_RESERVE",
        m.id,
      );
      m.reserve = funding.toString();
      m.liquidity = Number(money(funding));
      m.approvedBy = userId;
      m.status = "OPEN";
      m.sequence++;
      m.updatedAt = this.now();
      return this.marketView(m);
    });
  }
  private notify(
    userId: string,
    type: string,
    title: string,
    body: string,
    marketId?: string,
  ) {
    const prefs = this.state.preferences[userId];
    if (
      (type === "FILL" && prefs?.fills === false) ||
      (type === "RESOLUTION" && prefs?.resolution === false)
    )
      return;
    const rows = (this.state.notifications[userId] ??= []);
    rows.unshift({
      id: id(),
      type,
      title,
      body,
      marketId,
      createdAt: this.now(),
      readAt: null,
    });
    if (rows.length > 500) rows.length = 500;
  }
  private positionKey(userId: string, marketId: string, outcomeId: string) {
    return `${userId}:${marketId}:${outcomeId}`;
  }
  private positionRecord(userId: string, marketId: string, outcomeId: string) {
    const key = this.positionKey(userId, marketId, outcomeId);
    return (this.state.positions[key] ??= {
      userId,
      marketId,
      outcomeId,
      basis: "0",
      realized: "0",
    });
  }
  private shareAccount(userId: string, marketId: string, outcomeId: string) {
    return "share:" + this.positionKey(userId, marketId, outcomeId);
  }
  private shareLock(userId: string, marketId: string, outcomeId: string) {
    return "held:" + this.positionKey(userId, marketId, outcomeId);
  }
  private quantity(userId: string, marketId: string, outcomeId: string) {
    return Number(
      this.balance(this.shareAccount(userId, marketId, outcomeId)) +
        this.balance(this.shareLock(userId, marketId, outcomeId)),
    );
  }
  private updateBasis(
    userId: string,
    m: StoredMarket,
    outcomeId: string,
    side: "BUY" | "SELL",
    quantity: number,
    cash: bigint,
    oldQuantity: number,
  ) {
    const p = this.positionRecord(userId, m.id, outcomeId);
    if (side === "BUY") p.basis = (BigInt(p.basis) + cash).toString();
    else {
      const used =
        oldQuantity === quantity
          ? BigInt(p.basis)
          : (BigInt(p.basis) * BigInt(quantity)) / BigInt(oldQuantity);
      p.basis = (BigInt(p.basis) - used).toString();
      p.realized = (BigInt(p.realized) + cash - used).toString();
    }
  }
  private assertTrading(userId: string, m: StoredMarket, outcomeId: string) {
    if (m.curve) {
      const source = this.state.liveBooks[m.id + ":" + outcomeId];
      if (!source)
        fail(409, "STALE_BOOK", "Fresh source confirmation is required");
      this.validateBook(m, source, outcomeId);
    }
    this.user(userId);
    if (this.state.operatorPaused)
      fail(
        503,
        "TRADING_PAUSED",
        "Trading is paused by the platform administrator",
      );
    if (
      m.status !== "OPEN" ||
      ((m.exchange === "FRIENDS" || !!m.curve) &&
        Date.parse(m.closeAt) <= this.clock().getTime())
    )
      fail(409, "MARKET_CLOSED", "Market is not open");
    if (!m.outcomes.some((x) => x.id === outcomeId))
      fail(422, "INVALID_OUTCOME", "Unknown outcome");
    if (m.exchange === "FRIENDS" && userId === m.resolverId)
      fail(
        403,
        "RESOLVER_CANNOT_TRADE",
        "Appointed resolver cannot trade this market",
      );
  }
  private validateInput(input: OrderInput) {
    if (
      !["BUY", "SELL"].includes(input.side) ||
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > 1000
    )
      fail(422, "INVALID_QUANTITY", "Use 1–1,000 whole shares");
    if (!["IOC", "GTC", "GTD"].includes(input.timeInForce))
      fail(422, "INVALID_TIME_IN_FORCE", "Use IOC, GTC or GTD");
    let price: bigint;
    try {
      price = units(input.limitPrice);
    } catch {
      fail(422, "INVALID_PRICE", "Limit must be a decimal price");
    }
    if (price < 100n || price > 999900n || price % 100n !== 0n)
      fail(
        422,
        "INVALID_PRICE",
        "Price must be 0.0001–0.9999 on a 0.0001 tick",
      );
    if (
      input.timeInForce === "GTD" &&
      (!input.expiresAt ||
        !Number.isFinite(Date.parse(input.expiresAt)) ||
        Date.parse(input.expiresAt) <= this.clock().getTime())
    )
      fail(422, "INVALID_EXPIRY", "GTD requires a future expiry");
    if (
      input.minFillQuantity !== undefined &&
      (!Number.isInteger(input.minFillQuantity) ||
        input.minFillQuantity < 0 ||
        input.minFillQuantity > input.quantity)
    )
      fail(422, "INVALID_MIN_FILL", "Invalid minimum fill");
    for (const k of [
      "maxTotalCost",
      "minTotalProceeds",
      "maxAveragePrice",
      "minAveragePrice",
    ] as const)
      if (input[k] !== undefined) {
        try {
          const value = units(input[k]!);
          if (
            value < 0n ||
            ((k === "maxAveragePrice" || k === "minAveragePrice") &&
              value > 1_000_000n)
          )
            throw new Error();
        } catch {
          fail(
            422,
            "INVALID_PROTECTION",
            "Cash protections must be nonnegative decimal amounts",
          );
        }
      }
    if (
      input.timeInForce !== "IOC" &&
      ((input.side === "BUY" &&
        input.maxAveragePrice !== undefined &&
        units(input.maxAveragePrice) < price) ||
        (input.side === "SELL" &&
          input.minAveragePrice !== undefined &&
          units(input.minAveragePrice) > price))
    )
      fail(
        422,
        "CONTRADICTORY_RESTING_BOUND",
        "The resting order limit must respect its average-price bound",
      );
    return price;
  }
  private orderPriority(order: StoredOrder) {
    return (
      order.createdSequence ??
      Object.values(this.state.orders).findIndex(
        (previous) => previous.id === order.id,
      ) + 1
    );
  }
  private nextOrderPriority(marketId: string) {
    let sequence = this.state.orderSequences[marketId];
    if (sequence === undefined) {
      sequence = 0;
      for (const previous of Object.values(this.state.orders).filter(
        (o) => o.marketId === marketId,
      )) {
        previous.createdSequence ??= sequence + 1;
        sequence = Math.max(sequence, previous.createdSequence);
      }
    }
    this.state.orderSequences[marketId] = sequence + 1;
    return sequence + 1;
  }
  private activePeers(
    m: StoredMarket,
    outcomeId: string,
    side: "BUY" | "SELL",
    userId: string,
  ) {
    return Object.values(this.state.orders)
      .filter(
        (o) =>
          o.marketId === m.id &&
          o.outcomeId === outcomeId &&
          o.side !== side &&
          o.userId !== userId &&
          o.status === "OPEN" &&
          (!o.expiresAt || o.expiresAt > this.now()),
      )
      .sort(
        (a, b) =>
          (side === "BUY"
            ? a.limitPrice - b.limitPrice
            : b.limitPrice - a.limitPrice) ||
          this.orderPriority(a) - this.orderPriority(b),
      );
  }
  private newOrder(
    userId: string,
    m: StoredMarket,
    input: OrderInput,
  ): StoredOrder {
    return {
      id: id(),
      createdSequence: this.nextOrderPriority(m.id),
      userId,
      exchange: m.exchange,
      groupId: m.groupId,
      marketId: m.id,
      outcomeId: input.outcomeId,
      side: input.side,
      quantity: input.quantity,
      filledQuantity: 0,
      limitPrice: Number(input.limitPrice),
      timeInForce: input.timeInForce,
      status: "PENDING",
      createdAt: this.now(),
      expiresAt:
        input.timeInForce === "GTD"
          ? new Date(input.expiresAt!).toISOString()
          : null,
      locked: "0.000000",
      question: m.question,
      outcomeLabel: m.outcomes.find((x) => x.id === input.outcomeId)?.label,
    };
  }
  private publicOrder(o: StoredOrder): Order {
    const { userId, exchange, groupId, ...v } = o;
    return v;
  }
  private fillRecord(
    o: StoredOrder,
    quantity: number,
    cash: bigint,
    source: Fill["source"],
  ): StoredFill {
    const f: StoredFill = {
      id: id(),
      userId: o.userId,
      orderId: o.id,
      marketId: o.marketId,
      outcomeId: o.outcomeId,
      side: o.side,
      quantity,
      cash: money(cash),
      price: Number(money(cash)) / quantity,
      source,
      createdAt: this.now(),
      handle: this.state.users[o.userId]!.handle,
    };
    this.state.fills.push(f);
    o.filledQuantity += quantity;
    this.notify(
      o.userId,
      "FILL",
      `${o.side} ${quantity} ${o.outcomeLabel}`,
      `${money(cash)} play credits`,
      o.marketId,
    );
    return f;
  }
  private fillAmm(o: StoredOrder, m: StoredMarket, cash: bigint, quantity = 1) {
    const w = this.walletRecord(o.userId, m.exchange, m.groupId),
      share = this.shareAccount(o.userId, m.id, o.outcomeId),
      asset = `share:${m.id}:${o.outcomeId}`,
      old = this.quantity(o.userId, m.id, o.outcomeId),
      index = m.outcomes.findIndex((x) => x.id === o.outcomeId);
    if (o.side === "BUY") {
      this.transfer(
        "cash:" + w.id,
        "escrow:" + m.id,
        cash,
        "cash",
        "AMM_BUY",
        m.id,
      );
      this.transfer(
        "issuer:" + asset,
        share,
        BigInt(quantity),
        asset,
        "AMM_ISSUE",
        m.id,
      );
      m.q[index]! += quantity;
    } else {
      this.transfer(
        share,
        "issuer:" + asset,
        BigInt(quantity),
        asset,
        "AMM_REDEEM",
        m.id,
      );
      this.transfer(
        "escrow:" + m.id,
        "cash:" + w.id,
        cash,
        "cash",
        "AMM_SELL",
        m.id,
      );
      m.q[index]! -= quantity;
    }
    this.updateBasis(o.userId, m, o.outcomeId, o.side, quantity, cash, old);
    m.volume += Number(money(cash));
    return this.fillRecord(o, quantity, cash, "AMM");
  }
  private fillPeer(
    taker: StoredOrder,
    maker: StoredOrder,
    m: StoredMarket,
    cash: bigint,
    quantity = 1,
  ) {
    const buy = taker.side === "BUY" ? taker : maker,
      sell = taker.side === "SELL" ? taker : maker,
      bw = this.walletRecord(buy.userId, m.exchange, m.groupId),
      sw = this.walletRecord(sell.userId, m.exchange, m.groupId),
      asset = `share:${m.id}:${taker.outcomeId}`,
      oldBuy = this.quantity(buy.userId, m.id, buy.outcomeId),
      oldSell = this.quantity(sell.userId, m.id, sell.outcomeId);
    this.transfer(
      (buy === maker ? "lock:" : "cash:") + bw.id,
      "cash:" + sw.id,
      cash,
      "cash",
      "PEER_TRADE",
      m.id,
    );
    this.transfer(
      sell === maker
        ? this.shareLock(sell.userId, m.id, sell.outcomeId)
        : this.shareAccount(sell.userId, m.id, sell.outcomeId),
      this.shareAccount(buy.userId, m.id, buy.outcomeId),
      BigInt(quantity),
      asset,
      "PEER_TRADE",
      m.id,
    );
    if (maker.side === "BUY") maker.locked = money(units(maker.locked) - cash);
    this.updateBasis(
      buy.userId,
      m,
      buy.outcomeId,
      "BUY",
      quantity,
      cash,
      oldBuy,
    );
    this.updateBasis(
      sell.userId,
      m,
      sell.outcomeId,
      "SELL",
      quantity,
      cash,
      oldSell,
    );
    this.fillRecord(maker, quantity, cash, "PEER");
    if (maker.filledQuantity === maker.quantity) maker.status = "FILLED";
    m.volume += Number(money(cash));
    return this.fillRecord(taker, quantity, cash, "PEER");
  }
  private lockOrder(o: StoredOrder, m: StoredMarket) {
    const left = o.quantity - o.filledQuantity;
    if (!left) return;
    const resting = Object.values(this.state.orders).filter(
      (other) =>
        other.marketId === m.id && other.status === "OPEN" && other.id !== o.id,
    );
    if (resting.length >= 100)
      fail(422, "ORDER_LIMIT", "Market supports at most 100 resting orders");
    if (resting.filter((other) => other.userId === o.userId).length >= 20)
      fail(
        422,
        "USER_ORDER_LIMIT",
        "Each account supports at most 20 resting orders per market",
      );
    const w = this.walletRecord(o.userId, m.exchange, m.groupId);
    if (o.side === "BUY") {
      const amount = units(o.limitPrice) * BigInt(left);
      this.transfer(
        "cash:" + w.id,
        "lock:" + w.id,
        amount,
        "cash",
        "ORDER_LOCK",
        o.id,
      );
      o.locked = money(amount);
    } else
      this.transfer(
        this.shareAccount(o.userId, m.id, o.outcomeId),
        this.shareLock(o.userId, m.id, o.outcomeId),
        BigInt(left),
        `share:${m.id}:${o.outcomeId}`,
        "ORDER_LOCK",
        o.id,
      );
    o.status = "OPEN";
  }
  private releaseOrder(o: StoredOrder) {
    const m = this.state.markets[o.marketId]!,
      w = this.walletRecord(o.userId, m.exchange, m.groupId),
      left = o.quantity - o.filledQuantity;
    if (o.side === "BUY") {
      this.transfer(
        "lock:" + w.id,
        "cash:" + w.id,
        units(o.locked),
        "cash",
        "ORDER_UNLOCK",
        o.id,
      );
      o.locked = "0.000000";
    } else if (left > 0)
      this.transfer(
        this.shareLock(o.userId, m.id, o.outcomeId),
        this.shareAccount(o.userId, m.id, o.outcomeId),
        BigInt(left),
        `share:${m.id}:${o.outcomeId}`,
        "ORDER_UNLOCK",
        o.id,
      );
  }
  private cancelInternal(o: StoredOrder, status: string) {
    if (o.status !== "OPEN") return;
    this.releaseOrder(o);
    o.status = status;
    const m = this.state.markets[o.marketId];
    if (m) {
      m.sequence++;
      m.updatedAt = this.now();
    }
  }
  cancel(userId: string, orderId: string) {
    return this.transaction(() => {
      const o = this.state.orders[orderId];
      if (!o || o.userId !== userId)
        fail(404, "ORDER_NOT_FOUND", "Order not found");
      this.marketRecord(userId, o.marketId);
      if (o.status !== "OPEN")
        fail(409, "ORDER_CLOSED", "Order is no longer open");
      this.cancelInternal(o, "CANCELLED");
      return this.publicOrder(o);
    });
  }
  orders(userId: string, exchange?: Exchange, groupId?: string) {
    this.tick();
    this.refresh();
    if (groupId) this.membership(userId, groupId);
    return Object.values(this.state.orders)
      .filter(
        (o) =>
          o.userId === userId &&
          this.canRead(userId, this.state.markets[o.marketId]!) &&
          (!exchange || o.exchange === exchange) &&
          (!groupId || o.groupId === groupId),
      )
      .reverse()
      .map((o) => this.publicOrder(o));
  }
  private protections(
    input: OrderInput,
    quantity: number,
    spent: bigint,
    received: bigint,
    locked = 0n,
  ) {
    if (
      input.maxTotalCost !== undefined &&
      spent + locked > units(input.maxTotalCost)
    )
      fail(409, "COST_PROTECTION", "Order exceeds maximum total cost");
    if (
      input.minTotalProceeds !== undefined &&
      received < units(input.minTotalProceeds)
    )
      fail(409, "PROCEEDS_PROTECTION", "Order misses minimum total proceeds");
    if (
      input.side === "BUY" &&
      input.maxAveragePrice !== undefined &&
      spent > units(input.maxAveragePrice) * BigInt(quantity)
    )
      fail(
        409,
        "AVERAGE_PRICE_PROTECTION",
        "Order exceeds maximum average price",
      );
    if (
      input.side === "SELL" &&
      input.minAveragePrice !== undefined &&
      received < units(input.minAveragePrice) * BigInt(quantity)
    )
      fail(
        409,
        "AVERAGE_PRICE_PROTECTION",
        "Order misses minimum average price",
      );
    if (quantity < (input.minFillQuantity ?? 0))
      fail(409, "FILL_PROTECTION", "Order misses minimum fill quantity");
  }
  private plan(
    userId: string,
    m: StoredMarket,
    input: {
      outcomeId: string;
      side: "BUY" | "SELL";
      quantity: number;
      limitPrice: string | number;
    },
  ) {
    const q = [...m.q],
      index = m.outcomes.findIndex((x) => x.id === input.outcomeId),
      limit = units(input.limitPrice),
      peers = this.activePeers(m, input.outcomeId, input.side, userId).map(
        (o) => ({ ...o, remaining: o.quantity - o.filledQuantity }),
      ),
      funds = this.balance(
        "cash:" + this.walletRecord(userId, m.exchange, m.groupId).id,
      ),
      available =
        input.side === "SELL"
          ? Number(
              this.balance(this.shareAccount(userId, m.id, input.outcomeId)),
            )
          : input.quantity;
    const segments: {
      source: "AMM" | "PEER";
      quantity: number;
      cash: bigint;
      peerId?: string;
      startQ: number[];
    }[] = [];
    let total = 0n,
      filled = 0;
    const maximum = Math.min(input.quantity, available);
    while (filled < maximum) {
      const peer = peers.find((p) => p.remaining > 0);
      const amm =
        input.side === "SELL" && q[index] === 0
          ? undefined
          : ammCost(q, m.b!, index, 1, input.side, m.curve?.prior);
      const pc = peer ? units(peer.limitPrice) : undefined;
      const usePeer =
        pc !== undefined &&
        (amm === undefined || (input.side === "BUY" ? pc <= amm : pc >= amm));
      const price = usePeer ? pc : amm;
      if (
        price === undefined ||
        (input.side === "BUY" ? price > limit : price < limit)
      )
        break;
      const source = usePeer ? ("PEER" as const) : ("AMM" as const);
      const prev = segments.at(-1);
      const same =
        !!prev &&
        prev.source === source &&
        prev.peerId === (usePeer ? peer!.id : undefined);
      const costCache = new Map<number, bigint>(
        !usePeer && !same ? [[1, price]] : [],
      );
      const cashFor = (quantity: number): bigint => {
        const cached = costCache.get(quantity);
        if (cached !== undefined) return cached;
        const cash = usePeer
          ? price * BigInt(quantity)
          : same
            ? ammCost(
                prev!.startQ,
                m.b!,
                index,
                prev!.quantity + quantity,
                input.side,
                m.curve?.prior,
              ) - prev!.cash
            : ammCost(q, m.b!, index, quantity, input.side, m.curve?.prior);
        costCache.set(quantity, cash);
        return cash;
      };
      let size = Math.min(
        maximum - filled,
        usePeer ? peer!.remaining : input.side === "SELL" ? q[index]! : maximum,
      );
      if (usePeer) {
        if (input.side === "BUY")
          size = Math.min(size, Number((funds - total) / price));
      } else if (size === 1) {
        if (input.side === "BUY" && total + cashFor(1) > funds) size = 0;
      } else {
        // Per-lot integrated prices are monotone. Find the last executable whole
        // lot before the next peer price, caller limit, or available cash boundary.
        // Charge the full integrated curve once, preserving directional rounding.
        let low = 0,
          high = size;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2),
            beforeLast = [...q];
          beforeLast[index]! += (input.side === "BUY" ? 1 : -1) * (middle - 1);
          const last = ammCost(
            beforeLast,
            m.b!,
            index,
            1,
            input.side,
            m.curve?.prior,
          );
          const withinPrice =
            input.side === "BUY"
              ? last <= limit && (pc === undefined || last < pc)
              : last >= limit && (pc === undefined || last > pc);
          if (
            withinPrice &&
            (input.side !== "BUY" || total + cashFor(middle) <= funds)
          )
            low = middle;
          else high = middle - 1;
        }
        size = low;
      }
      if (size < 1) break;
      if (this.inTx && (this.matchingWork += size) > 10000)
        fail(
          422,
          "COMPLEXITY_LIMIT",
          "Matching exceeds 10,000-lot atomic work limit",
        );
      const cash = cashFor(size);
      total += cash;
      filled += size;
      if (same) {
        prev!.quantity += size;
        prev!.cash += cash;
      } else
        segments.push({
          source,
          quantity: size,
          cash,
          peerId: usePeer ? peer!.id : undefined,
          startQ: [...q],
        });
      if (usePeer) peer!.remaining -= size;
      else q[index]! += (input.side === "BUY" ? 1 : -1) * size;
    }
    return { segments, q, total, filled };
  }
  private match(o: StoredOrder, m: StoredMarket) {
    const plan = this.plan(o.userId, m, {
      ...o,
      quantity: o.quantity - o.filledQuantity,
    });
    return plan.segments.map((segment) =>
      segment.source === "PEER"
        ? this.fillPeer(
            o,
            this.state.orders[segment.peerId!]!,
            m,
            segment.cash,
            segment.quantity,
          )
        : this.fillAmm(o, m, segment.cash, segment.quantity),
    );
  }
  private cascade(m: StoredMarket) {
    let work = 0,
      changed = true;
    while (changed) {
      changed = false;
      const open = Object.values(this.state.orders)
        .filter((o) => o.marketId === m.id && o.status === "OPEN")
        .sort((a, b) => this.orderPriority(a) - this.orderPriority(b));
      for (const o of open) {
        if (o.status !== "OPEN") continue;
        if (++work > 2000)
          fail(422, "COMPLEXITY_LIMIT", "Matching exceeds atomic work limit");
        this.releaseOrder(o);
        o.status = "PENDING";
        const fills = this.match(o, m);
        if (fills.length) changed = true;
        if (o.filledQuantity === o.quantity) o.status = "FILLED";
        else this.lockOrder(o, m);
      }
    }
  }
  replayOrder(
    userId: string,
    input: OrderInput,
    key: string,
  ): OrderReceipt | null {
    this.refresh();
    this.user(userId);
    const m = this.state.markets[input.marketId];
    if (!m) return null;
    if (m.exchange === "FRIENDS") this.membership(userId, m.groupId!);
    const prior =
      this.state.idempotency[
        `${userId}:${m.exchange}:${m.groupId ?? "global"}:${key}`
      ];
    if (!prior) return null;
    if (prior.hash !== requestHash(input))
      fail(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Key was used with different parameters",
      );
    return structuredClone(prior.result);
  }
  execute(userId: string, input: OrderInput, key: string): OrderReceipt {
    return this.transaction(() => {
      this.validateInput(input);
      const m = this.marketRecord(userId, input.marketId);
      if (m.exchange === "LIVE" && !m.curve)
        fail(
          422,
          "INVALID_EXECUTION_MODEL",
          "Legacy source simulation requires its own execution path",
        );
      const idemKey = `${userId}:${m.exchange}:${m.groupId ?? "global"}:${key}`;
      if (typeof key !== "string" || key.length < 4 || key.length > 200)
        fail(
          422,
          "IDEMPOTENCY_REQUIRED",
          "Idempotency-Key requires 4–200 characters",
        );
      const digest = requestHash(input),
        prior = this.state.idempotency[idemKey];
      if (prior) {
        if (prior.hash !== digest)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Key was used with different parameters",
          );
        return prior.result;
      }
      this.expireAndClose();
      this.assertTrading(userId, m, input.outcomeId);
      this.validateQuote(userId, m, input);
      if (
        input.side === "SELL" &&
        this.balance(this.shareAccount(userId, m.id, input.outcomeId)) <
          BigInt(input.quantity)
      )
        fail(
          422,
          "INSUFFICIENT_SHARES",
          "Only available owned shares may be sold",
        );
      const o = this.newOrder(userId, m, input);
      this.state.orders[o.id] = o;
      const fills = this.match(o, m),
        spent = fills
          .filter((f) => f.side === "BUY")
          .reduce((s, f) => s + units(f.cash), 0n),
        received = fills
          .filter((f) => f.side === "SELL")
          .reduce((s, f) => s + units(f.cash), 0n);
      this.protections(input, o.filledQuantity, spent, received);
      if (o.filledQuantity === o.quantity) o.status = "FILLED";
      else if (input.timeInForce === "IOC")
        o.status = o.filledQuantity ? "PARTIAL" : "CANCELLED";
      else this.lockOrder(o, m);
      this.cascade(m);
      const ownFills = this.state.fills.filter((f) => f.orderId === o.id),
        actualSpent = ownFills
          .filter((f) => f.side === "BUY")
          .reduce((sum, f) => sum + units(f.cash), 0n),
        actualReceived = ownFills
          .filter((f) => f.side === "SELL")
          .reduce((sum, f) => sum + units(f.cash), 0n);
      this.protections(
        input,
        o.filledQuantity,
        actualSpent,
        actualReceived,
        units(o.locked),
      );
      m.sequence++;
      m.updatedAt = this.now();
      const result = {
        order: this.publicOrder(o),
        fills: ownFills.map(({ userId: _, ...f }) => f),
        spent: money(actualSpent),
        received: money(actualReceived),
        wallet: this.walletView(
          this.walletRecord(userId, m.exchange, m.groupId),
        ),
        sequence: m.sequence,
      };
      this.state.idempotency[idemKey] = { hash: digest, result };
      return result;
    });
  }
  private validateQuote(userId: string, m: StoredMarket, input: OrderInput) {
    const version = m.curve ? 2 : 1;
    if (input.engineVersion !== undefined && input.engineVersion !== version)
      fail(
        409,
        "ENGINE_VERSION",
        "Execution model changed; request a new quote",
      );
    if (m.curve && input.engineVersion !== 2 && !input.quoteId)
      fail(
        409,
        "ENGINE_VERSION",
        "Accept execution model version 2 or request a fresh quote",
      );
    if (
      input.expectedSequence !== undefined &&
      input.expectedSequence !== m.sequence
    )
      fail(409, "REQUOTE", "Market changed; request a fresh quote");
    if (input.ruleVersion !== undefined && input.ruleVersion !== 1)
      fail(409, "RULE_VERSION", "Rules version is 1");
    if (input.quoteId) {
      const q = this.state.quotes[input.quoteId];
      if (
        !q ||
        q.userId !== userId ||
        q.quote.marketId !== m.id ||
        q.quote.outcomeId !== input.outcomeId ||
        q.quote.side !== input.side ||
        q.quote.quantity !== input.quantity ||
        (q.quote.engineVersion ?? 1) !== version ||
        q.quote.expiresAt <= this.now()
      )
        fail(409, "QUOTE_EXPIRED", "Quote expired or does not match order");
    }
  }
  quote(
    userId: string,
    marketId: string,
    input: {
      outcomeId: string;
      side: "BUY" | "SELL";
      quantity: number;
      limitPrice?: string | number;
    },
  ): Quote {
    return this.transaction(() => {
      this.expireAndClose();
      const m = this.marketRecord(userId, marketId);
      this.assertTrading(userId, m, input.outcomeId);
      if (m.exchange === "LIVE" && !m.curve)
        fail(
          422,
          "INVALID_EXECUTION_MODEL",
          "Request a source-confirmed Live quote",
        );
      return this.quoteCurve(userId, m, input);
    });
  }
  private quoteCurve(
    userId: string,
    m: StoredMarket,
    input: {
      outcomeId: string;
      side: "BUY" | "SELL";
      quantity: number;
      limitPrice?: string | number;
    },
  ): Quote {
    const full: OrderInput = {
      ...input,
      marketId: m.id,
      limitPrice: String(
        input.limitPrice ?? (input.side === "BUY" ? "0.9999" : "0.0001"),
      ),
      timeInForce: "IOC",
    };
    this.validateInput(full);
    const plan = this.plan(userId, m, full),
      index = m.outcomes.findIndex((x) => x.id === input.outcomeId),
      sources: Quote["sources"] = [];
    for (const segment of plan.segments) {
      const existing = sources.find((x) => x.source === segment.source);
      if (existing) {
        existing.quantity += segment.quantity;
        existing.cash = money(units(existing.cash) + segment.cash);
      } else
        sources.push({
          source: segment.source,
          quantity: segment.quantity,
          cash: money(segment.cash),
        });
    }
    const owns =
      input.side !== "SELL" ||
      this.balance(this.shareAccount(userId, m.id, input.outcomeId)) >=
        BigInt(input.quantity);
    const quote: Quote = {
      id: id(),
      engineVersion: m.curve ? 2 : 1,
      ...(m.curve ? { executionModel: "SOURCE_SEEDED_LMSR" as const } : {}),
      marketId: m.id,
      outcomeId: input.outcomeId,
      side: input.side,
      quantity: input.quantity,
      filledQuantity: plan.filled,
      estimatedCash: money(plan.total),
      averagePrice: plan.filled ? Number(money(plan.total)) / plan.filled : 0,
      afterProbability: probability(plan.q, m.b!, index, m.curve?.prior),
      ...(m.curve && !this.state.markets[m.id]?.curve
        ? { openingProbability: m.curve.prior[index]! / 1_000_000 }
        : {}),
      expiresAt: new Date(
        m.curve
          ? Date.parse(
              this.state.liveBooks[m.id + ":" + input.outcomeId]!.timestamp,
            ) + 5000
          : this.clock().getTime() + 15000,
      ).toISOString(),
      sequence: m.sequence,
      executable: plan.filled > 0 && owns,
      reason: !owns
        ? "Not enough unlocked shares to sell the requested quantity"
        : plan.filled
          ? undefined
          : "No executable liquidity within limits or insufficient available holdings",
      sources,
    };
    this.state.quotes[quote.id] = {
      userId,
      quote,
      input: full,
      curve: m.curve,
    };
    return quote;
  }

  book(userId: string, marketId: string, outcomeId: string): OrderBook {
    this.tick();
    this.refresh();
    const m = this.marketRecord(userId, marketId);
    if (!m.outcomes.some((o) => o.id === outcomeId))
      fail(422, "INVALID_OUTCOME", "Unknown outcome");
    return this.curveBook(m, outcomeId);
  }
  private curveBook(m: StoredMarket, outcomeId: string): OrderBook {
    const levels = (side: "BUY" | "SELL") => {
      const map = new Map<number, number>();
      for (const o of Object.values(this.state.orders))
        if (
          o.marketId === m.id &&
          o.outcomeId === outcomeId &&
          o.side === side &&
          o.status === "OPEN"
        )
          map.set(
            o.limitPrice,
            (map.get(o.limitPrice) ?? 0) + o.quantity - o.filledQuantity,
          );
      return [...map]
        .sort((a, b) => (side === "BUY" ? b[0] - a[0] : a[0] - b[0]))
        .map(([price, quantity]) => ({
          price,
          quantity,
          source: "PEER" as const,
        }));
    };
    const bids = levels("BUY"),
      asks = levels("SELL");
    if (m.status === "OPEN") {
      const i = m.outcomes.findIndex((x) => x.id === outcomeId);
      asks.push({
        price: Number(money(ammCost(m.q, m.b!, i, 1, "BUY", m.curve?.prior))),
        quantity: 1,
        source: "AMM" as "PEER",
      });
      if (m.q[i]! > 0)
        bids.push({
          price: Number(
            money(ammCost(m.q, m.b!, i, 1, "SELL", m.curve?.prior)),
          ),
          quantity: 1,
          source: "AMM" as "PEER",
        });
    }
    return {
      marketId: m.id,
      outcomeId,
      bids: bids.sort((a, b) => b.price - a.price),
      asks: asks.sort((a, b) => a.price - b.price),
      timestamp: m.curve
        ? (this.state.liveBooks[m.id + ":" + outcomeId]?.timestamp ??
          m.updatedAt)
        : this.now(),
      stale: false,
      source: "OpenTrader peer orders and next whole-share LMSR lot",
    };
  }
  liveBook(source: Market, book: OrderBook): OrderBook {
    return this.transaction(() => {
      this.syncLiveMarket(source);
      const m = this.state.markets[source.id]!;
      if (!this.communityMarket(m)) return book;
      // Stale feeds remain visibly stale; never substitute a local timestamp.
      if (
        book.stale ||
        this.clock().getTime() - Date.parse(book.timestamp) > 5000
      )
        return {
          ...book,
          bids: [],
          asks: [],
          stale: true,
          source: "Source confirmation unavailable",
        };
      this.validateBook(m, book, book.outcomeId);
      this.state.liveBooks[m.id + ":" + book.outcomeId] = book;
      const candidate = m.curve ? m : this.candidateCurve(m, book, "");
      return this.curveBook(candidate, book.outcomeId);
    });
  }
  fills(userId: string, marketId: string) {
    this.refresh();
    this.marketRecord(userId, marketId);
    return this.state.fills
      .filter(
        (f) =>
          f.marketId === marketId &&
          (this.state.markets[marketId]!.exchange === "FRIENDS" ||
            !!this.state.markets[marketId]!.curve ||
            f.userId === userId),
      )
      .slice(-500)
      .reverse()
      .map(({ userId: ownerId, ...f }) => ({
        ...f,
        handle: this.tradingIdentity(
          ownerId,
          this.state.markets[marketId]!.exchange,
          this.state.markets[marketId]!.groupId,
        ).handle,
      }));
  }
  history(
    userId: string,
    marketId: string,
    interval = "1h",
    outcomeId = "yes",
  ): Candle[] {
    this.refresh();
    this.marketRecord(userId, marketId);
    const seconds =
      interval === "1m"
        ? 60
        : interval === "5m"
          ? 300
          : interval === "1d"
            ? 86400
            : 3600;
    const buckets = new Map<number, Candle>();
    for (const f of this.state.fills) {
      if (f.marketId !== marketId || f.outcomeId !== outcomeId) continue;
      if (f.source === "PEER" && f.side === "SELL") continue;
      const time =
          Math.floor(Date.parse(f.createdAt) / 1000 / seconds) * seconds,
        c = buckets.get(time);
      if (c) {
        c.high = Math.max(c.high, f.price);
        c.low = Math.min(c.low, f.price);
        c.close = f.price;
        c.volume! += f.quantity;
      } else
        buckets.set(time, {
          time,
          open: f.price,
          high: f.price,
          low: f.price,
          close: f.price,
          volume: f.quantity,
        });
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }
  positions(userId: string, exchange?: Exchange, groupId?: string): Position[] {
    this.refresh();
    this.user(userId);
    if (groupId) this.membership(userId, groupId);
    return Object.values(this.state.positions)
      .filter((p) => p.userId === userId)
      .flatMap((p) => {
        const m = this.state.markets[p.marketId]!;
        if (!this.canRead(userId, m)) return [];
        if (
          (exchange && m.exchange !== exchange) ||
          (groupId && m.groupId !== groupId)
        )
          return [];
        const quantity = this.quantity(userId, m.id, p.outcomeId),
          locked = Number(
            this.balance(this.shareLock(userId, m.id, p.outcomeId)),
          ),
          index = m.outcomes.findIndex((x) => x.id === p.outcomeId),
          mark =
            m.exchange === "FRIENDS" || !!m.curve
              ? probability(m.q, m.b!, index, m.curve?.prior)
              : m.outcomes[index]!.probability;
        let liquidation = 0n,
          liquidationAvailable = quantity === 0,
          valuationAt = m.updatedAt,
          valuationNote: string | undefined;
        if (quantity && m.status === "OPEN") {
          if (m.exchange === "FRIENDS" || m.curve) {
            const source = m.curve
              ? this.state.liveBooks[m.id + ":" + p.outcomeId]
              : undefined;
            const fresh =
              !m.curve ||
              (!!source &&
                !source.stale &&
                Number.isFinite(Date.parse(source.timestamp)) &&
                this.clock().getTime() - Date.parse(source.timestamp) <= 5000);
            const plan = this.plan(userId, m, {
              outcomeId: p.outcomeId,
              side: "SELL",
              quantity: Math.min(quantity, 1000),
              limitPrice: "0.0001",
            });
            liquidation = plan.total;
            liquidationAvailable = fresh && plan.filled === quantity;
            valuationAt = source?.timestamp ?? this.now();
            if (!fresh)
              valuationNote =
                "Source confirmation is stale; liquidation is indicative only";
            if (fresh && !liquidationAvailable)
              valuationNote =
                quantity > 1000
                  ? "Position exceeds the 1,000-share immediate order limit"
                  : "Locked shares or price floor prevent full immediate liquidation";
          } else {
            const book = this.state.liveBooks[m.id + ":" + p.outcomeId];
            if (
              book &&
              !book.stale &&
              Number.isFinite(Date.parse(book.timestamp)) &&
              this.clock().getTime() - Date.parse(book.timestamp) <= 5000
            ) {
              const result = this.walkLive(book, {
                marketId: m.id,
                outcomeId: p.outcomeId,
                side: "SELL",
                quantity,
                limitPrice: "0.0001",
                timeInForce: "IOC",
              });
              liquidation = result.cash;
              liquidationAvailable = result.quantity === quantity;
              valuationAt = book.timestamp;
              valuationNote = liquidationAvailable
                ? undefined
                : "Insufficient fresh bid depth for full liquidation";
            } else valuationNote = "Fresh executable bid depth is unavailable";
          }
        } else if (quantity)
          valuationNote =
            m.exchange === "LIVE"
              ? "Trading closed; awaiting verified provider resolution"
              : "Trading closed; awaiting final resolution";
        const indicative = BigInt(Math.floor(quantity * mark * 1e6));
        return [
          {
            marketId: m.id,
            outcomeId: p.outcomeId,
            question: m.question,
            outcomeLabel: m.outcomes[index]!.label,
            exchange: m.exchange,
            groupId: m.groupId,
            quantity,
            locked,
            costBasis: money(p.basis),
            markPrice: mark,
            indicativeValue: money(indicative),
            liquidationValue: money(liquidation),
            realizedPnl: money(p.realized),
            unrealizedPnl: money(indicative - BigInt(p.basis)),
            sourceUrl: m.sourceUrl,
            liquidationAvailable,
            valuationAt,
            valuationNote,
          },
        ];
      });
  }
  commentById(userId: string, commentId: string) {
    this.refresh();
    const comment = this.state.comments.find((c) => c.id === commentId);
    if (!comment) fail(404, "COMMENT_NOT_FOUND", "Comment not found");
    this.marketRecord(userId, comment.marketId);
    return structuredClone(comment);
  }
  private recordModeration(
    userId: string,
    groupId: string,
    action: string,
    targetId: string,
    data: unknown,
  ) {
    this.db
      .prepare(
        "INSERT INTO moderation_events(id,group_id,actor_id,action,target_id,data,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id(),
        groupId,
        userId,
        action,
        targetId,
        JSON.stringify(data),
        this.now(),
      );
  }
  moderationAudit(userId: string, groupId: string) {
    this.refresh();
    this.moderator(userId, groupId);
    return this.db
      .prepare(
        "SELECT id,actor_id AS actorId,action,target_id AS targetId,data,created_at AS createdAt FROM moderation_events WHERE group_id=? ORDER BY created_at DESC,id DESC LIMIT 500",
      )
      .all(groupId) as unknown as {
      id: string;
      actorId: string;
      action: string;
      targetId: string;
      data: string;
      createdAt: string;
    }[];
  }
  hideComment(userId: string, commentId: string) {
    return this.transaction(() => {
      const comment = this.state.comments.find((c) => c.id === commentId);
      if (!comment) fail(404, "COMMENT_NOT_FOUND", "Comment not found");
      const market = this.marketRecord(userId, comment.marketId);
      this.moderator(userId, market.groupId!);
      if (comment.body === "[Removed by a moderator]") return comment;
      this.recordModeration(
        userId,
        market.groupId!,
        "HIDE_COMMENT",
        commentId,
        { original: structuredClone(comment) },
      );
      comment.body = "[Removed by a moderator]";
      market.sequence++;
      return comment;
    });
  }
  haltMarket(userId: string, marketId: string, rationale: string) {
    return this.transaction(() => {
      const market = this.marketRecord(userId, marketId);
      this.moderator(userId, market.groupId!);
      if (market.status !== "OPEN")
        fail(409, "INVALID_STATE", "Only an open market can be halted");
      if (
        typeof rationale !== "string" ||
        rationale.trim().length < 5 ||
        rationale.length > 5000
      )
        fail(422, "RATIONALE_REQUIRED", "A moderation rationale is required");
      this.recordModeration(userId, market.groupId!, "HALT_MARKET", marketId, {
        rationale,
      });
      for (const order of Object.values(this.state.orders))
        if (order.marketId === marketId && order.status === "OPEN")
          this.cancelInternal(order, "CANCELLED");
      market.status = "HALTED";
      market.sequence++;
      market.updatedAt = this.now();
      this.notifyMarket(market, "Trading halted", rationale);
      return this.marketView(market);
    });
  }
  resumeMarket(userId: string, marketId: string, rationale: string) {
    return this.transaction(() => {
      const market = this.marketRecord(userId, marketId);
      this.moderator(userId, market.groupId!);
      if (
        market.status !== "HALTED" ||
        Date.parse(market.closeAt) <= this.clock().getTime()
      )
        fail(
          409,
          "INVALID_STATE",
          "Only a halted market before its frozen close can resume",
        );
      if (
        typeof rationale !== "string" ||
        rationale.trim().length < 5 ||
        rationale.length > 5000
      )
        fail(422, "RATIONALE_REQUIRED", "A review rationale is required");
      this.recordModeration(
        userId,
        market.groupId!,
        "RESUME_MARKET",
        marketId,
        { rationale },
      );
      market.status = "OPEN";
      market.sequence++;
      market.updatedAt = this.now();
      this.notifyMarket(market, "Trading resumed", rationale);
      return this.marketView(market);
    });
  }
  comments(userId: string, marketId: string) {
    this.refresh();
    this.marketRecord(userId, marketId);
    return this.state.comments.filter((c) => c.marketId === marketId);
  }
  comment(userId: string, marketId: string, body: string) {
    return this.transaction(() => {
      this.marketRecord(userId, marketId);
      if (
        typeof body !== "string" ||
        body.trim().length < 1 ||
        body.length > 2000
      )
        fail(422, "INVALID_COMMENT", "Comment requires 1–2,000 characters");
      const c = {
        id: id(),
        marketId,
        userId,
        handle: this.user(userId).handle,
        body: body.trim(),
        createdAt: this.now(),
      };
      this.state.comments.push(c);
      return c;
    });
  }
  watch(userId: string, marketId: string) {
    return this.transaction(() => {
      this.marketRecord(userId, marketId);
      const watched = (this.state.watch[userId] ??= []);
      const i = watched.indexOf(marketId);
      if (i >= 0) watched.splice(i, 1);
      else watched.push(marketId);
      return { watching: i < 0, marketIds: watched };
    });
  }
  watchlist(userId: string) {
    this.refresh();
    return (this.state.watch[userId] ?? []).filter((mid) => {
      const m = this.state.markets[mid];
      return (
        m &&
        (m.exchange === "LIVE" ||
          this.state.members.some(
            (x) =>
              x.groupId === m.groupId &&
              x.userId === userId &&
              x.status === "ACTIVE",
          ))
      );
    });
  }
  forecast(userId: string, marketId: string, value: number) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId);
      const cutoff = Math.min(
        Date.parse(m.closeAt),
        Date.parse(m.rules?.observationAt ?? m.closeAt),
        m.determinedAt ? Date.parse(m.determinedAt) : Infinity,
      );
      if (m.status !== "OPEN" || this.clock().getTime() >= cutoff)
        fail(409, "FORECAST_CLOSED", "Forecast cutoff has passed");
      if (!Number.isFinite(value) || value < 0 || value > 1)
        fail(
          422,
          "INVALID_FORECAST",
          "Probability must be between zero and one",
        );
      const f = {
        id: id(),
        userId,
        marketId,
        probability: value,
        createdAt: this.now(),
      };
      this.state.forecasts.push(f);
      return f;
    });
  }
  forecasts(userId: string, marketId: string) {
    this.refresh();
    this.marketRecord(userId, marketId);
    return this.state.forecasts.filter(
      (f) => f.userId === userId && f.marketId === marketId,
    );
  }
  private impartial(userId: string, m: StoredMarket) {
    if (m.exchange === "FRIENDS") this.membership(userId, m.groupId!);
    else this.user(userId);
    if (
      userId === m.creatorId ||
      this.state.fills.some((f) => f.marketId === m.id && f.userId === userId)
    )
      fail(
        403,
        "CONFLICTED_REVIEWER",
        "Creator and anyone who ever traded cannot resolve or review",
      );
  }
  closeMarket(userId: string, marketId: string) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId);
      this.moderator(userId, m.groupId!);
      if (Date.parse(m.closeAt) > this.clock().getTime())
        fail(409, "EARLY_CLOSE_FORBIDDEN", "Frozen close time has not passed");
      this.expireAndClose();
      return this.marketView(m);
    });
  }
  private resolutionReadyAt(m: Market) {
    return Math.max(
      Date.parse(m.closeAt),
      Date.parse(m.rules?.observationAt ?? m.closeAt),
    );
  }
  propose(
    userId: string,
    marketId: string,
    input: {
      outcomeId: string | null;
      evidence: string;
      rationale: string;
      determinedAt?: string;
    },
  ) {
    this.tick();
    return this.transaction(() => {
      this.expireAndClose();
      const m = this.marketRecord(userId, marketId);
      if (this.clock().getTime() < this.resolutionReadyAt(m))
        fail(
          409,
          "OBSERVATION_PENDING",
          "The frozen observation deadline has not passed",
        );
      if (this.clock().getTime() >= this.resolutionReadyAt(m) + 72 * 36e5)
        fail(
          409,
          "RESOLUTION_LONGSTOP",
          "The frozen resolution longstop has passed",
        );
      if (m.status !== "CLOSED")
        fail(409, "INVALID_STATE", "Close market before proposing a result");
      this.impartial(userId, m);
      if (userId !== m.resolverId)
        fail(
          403,
          "RESOLVER_REQUIRED",
          "Only the appointed resolver can propose",
        );
      if (
        input.outcomeId !== null &&
        !m.outcomes.some((x) => x.id === input.outcomeId)
      )
        fail(422, "INVALID_OUTCOME", "Invalid resolution outcome");
      if (
        !input.evidence?.trim() ||
        !input.rationale?.trim() ||
        input.evidence.length > 10000 ||
        input.rationale.length > 5000
      )
        fail(422, "EVIDENCE_REQUIRED", "Evidence and rationale are required");
      if (input.determinedAt) {
        const t = Date.parse(input.determinedAt);
        if (!Number.isFinite(t) || t > this.clock().getTime())
          fail(
            422,
            "INVALID_DETERMINATION",
            "Public determination timestamp must be a known past time",
          );
        m.determinedAt = new Date(t).toISOString();
      } else
        m.calibrationReason =
          "Earliest public answer timestamp was not established; excluded from forecast scoring";
      const r: Resolution = {
        id: id(),
        outcomeId: input.outcomeId,
        evidence: input.evidence,
        rationale: input.rationale,
        proposedBy: userId,
        proposedAt: this.now(),
        disputeUntil: new Date(
          this.clock().getTime() + 24 * 36e5,
        ).toISOString(),
        state: "PROPOSED",
        disputes: [],
        reviews: [],
      };
      m.resolution = r;
      m.status = "RESOLVING";
      m.sequence++;
      m.updatedAt = this.now();
      this.notifyMarket(
        m,
        "Result proposed",
        "24-hour challenge window is open.",
      );
      return this.marketView(m);
    });
  }
  private notifyMarket(m: StoredMarket, title: string, body: string) {
    const ids = new Set([
      ...this.state.members
        .filter((x) => x.groupId === m.groupId && x.status === "ACTIVE")
        .map((x) => x.userId),
      ...Object.entries(this.state.watch)
        .filter(([, list]) => list.includes(m.id))
        .map(([uid]) => uid),
    ]);
    for (const uid of ids) this.notify(uid, "RESOLUTION", title, body, m.id);
  }
  dispute(userId: string, marketId: string, rationale: string) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId),
        r = m.resolution;
      if (m.status !== "RESOLVING" || !r || r.disputeUntil <= this.now())
        fail(409, "DISPUTE_CLOSED", "Challenge window is closed");
      if (
        typeof rationale !== "string" ||
        rationale.trim().length < 5 ||
        rationale.length > 5000
      )
        fail(
          422,
          "RATIONALE_REQUIRED",
          "Explain the dispute in 5–5,000 characters",
        );
      if (r.disputes.some((d) => d.userId === userId))
        fail(409, "ALREADY_DISPUTED", "You already disputed this proposal");
      r.disputes.push({ id: id(), userId, rationale, createdAt: this.now() });
      r.state = "DISPUTED";
      m.sequence++;
      return this.marketView(m);
    });
  }
  review(
    userId: string,
    marketId: string,
    input: { decision: string; outcomeId?: string | null; rationale: string },
  ) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId),
        r = m.resolution;
      this.impartial(userId, m);
      if (userId === m.resolverId || !m.rules!.reviewerIds.includes(userId))
        fail(
          403,
          "REVIEWER_REQUIRED",
          "A separately appointed impartial reviewer is required",
        );
      if (
        !r ||
        m.status !== "RESOLVING" ||
        r.state !== "DISPUTED" ||
        this.clock().getTime() >= Date.parse(r.disputeUntil) + 48 * 36e5
      )
        fail(409, "REVIEW_CLOSED", "No active disputed review");
      if (r.reviews.some((x) => x.userId === userId))
        fail(409, "ALREADY_REVIEWED", "Review is immutable");
      if (
        !["CONFIRM", "VOID", "REJECT"].includes(input.decision) ||
        !input.rationale?.trim()
      )
        fail(
          422,
          "INVALID_REVIEW",
          "Choose CONFIRM, REJECT or VOID with a rationale",
        );
      r.reviews.push({
        userId,
        decision: input.decision,
        rationale: input.rationale.slice(0, 5000),
      });
      m.sequence++;
      this.finalizeDue();
      return this.marketView(m);
    });
  }
  private settle(m: StoredMarket, outcomeId: string | null, reason: string) {
    if (["RESOLVED", "VOID"].includes(m.status)) return;
    for (const o of Object.values(this.state.orders))
      if (o.marketId === m.id && o.status === "OPEN")
        this.cancelInternal(o, "CANCELLED");
    m.settledHoldings = [];
    for (const p of Object.values(this.state.positions).filter(
      (p) => p.marketId === m.id,
    )) {
      const quantity = this.quantity(p.userId, m.id, p.outcomeId);
      if (!quantity) continue;
      const payout =
          BigInt(quantity) *
          (outcomeId === null
            ? 500000n
            : outcomeId === p.outcomeId
              ? 1000000n
              : 0n),
        w = this.walletRecord(p.userId, m.exchange, m.groupId);
      this.transfer(
        "escrow:" + m.id,
        "cash:" + w.id,
        payout,
        "cash",
        "SETTLEMENT",
        m.id,
      );
      this.transfer(
        this.shareAccount(p.userId, m.id, p.outcomeId),
        "issuer:share:" + m.id + ":" + p.outcomeId,
        BigInt(quantity),
        `share:${m.id}:${p.outcomeId}`,
        "SETTLEMENT",
        m.id,
      );
      p.realized = (BigInt(p.realized) + payout - BigInt(p.basis)).toString();
      p.basis = "0";
      m.settledHoldings.push({
        userId: p.userId,
        outcomeId: p.outcomeId,
        quantity,
        payout: money(payout),
      });
      this.notify(
        p.userId,
        "RESOLUTION",
        m.question,
        `Settlement: ${money(payout)} play credits. ${reason}`,
        m.id,
      );
    }
    this.transfer(
      "escrow:" + m.id,
      m.curve ? LIVE_LIQUIDITY_ACCOUNT : "treasury:" + m.groupId,
      this.balance("escrow:" + m.id),
      "cash",
      "RESERVE_RETURN",
      m.id,
    );
    m.status = outcomeId === null ? "VOID" : "RESOLVED";
    m.q = [0, 0];
    if (m.resolution) {
      m.resolution.state = "FINAL";
      m.resolution.outcomeId = outcomeId;
    } else
      m.resolution = {
        id: id(),
        outcomeId: null,
        evidence: "Frozen neutral-void longstop",
        rationale: reason,
        proposedBy: "system",
        proposedAt: this.now(),
        disputeUntil: this.now(),
        state: "FINAL",
        disputes: [],
        reviews: [],
      };
    m.sequence++;
    m.updatedAt = this.now();
  }
  private expireAndClose() {
    for (const o of Object.values(this.state.orders))
      if (o.status === "OPEN" && o.expiresAt && o.expiresAt <= this.now())
        this.cancelInternal(o, "EXPIRED");
    for (const m of Object.values(this.state.markets))
      if (
        (m.exchange === "FRIENDS" || !!m.curve) &&
        ["OPEN", "HALTED"].includes(m.status) &&
        Date.parse(m.closeAt) <= this.clock().getTime()
      ) {
        for (const o of Object.values(this.state.orders))
          if (o.marketId === m.id && o.status === "OPEN")
            this.cancelInternal(o, "CANCELLED");
        m.status = "CLOSED";
        m.sequence++;
        m.updatedAt = this.now();
      }
  }
  private finalizeDue() {
    for (const m of Object.values(this.state.markets)) {
      if (m.exchange !== "FRIENDS") continue;
      const r = m.resolution;
      if (
        m.status === "CLOSED" &&
        this.clock().getTime() >= this.resolutionReadyAt(m) + 72 * 36e5
      )
        this.settle(
          m,
          null,
          "No resolution proposal by the 72-hour observation longstop",
        );
      if (m.status !== "RESOLVING" || !r || r.disputeUntil > this.now())
        continue;
      if (!r.disputes.length)
        this.settle(m, r.outcomeId, "Unchallenged resolution finalized");
      else {
        const confirm = r.reviews.filter(
            (x) => x.decision === "CONFIRM",
          ).length,
          voids = r.reviews.filter(
            (x) => x.decision === "VOID" || x.decision === "REJECT",
          ).length;
        if (confirm >= 2)
          this.settle(m, r.outcomeId, "Two impartial reviewers confirmed");
        else if (
          voids >= 2 ||
          this.clock().getTime() >= Date.parse(r.disputeUntil) + 48 * 36e5
        )
          this.settle(m, null, "Neutral void: no confirming impartial quorum");
      }
    }
  }
  tick() {
    this.refresh();
    const now = this.now(),
      ms = this.clock().getTime(),
      due =
        Object.values(this.state.orders).some(
          (o) => o.status === "OPEN" && o.expiresAt && o.expiresAt <= now,
        ) ||
        Object.values(this.state.markets).some(
          (m) =>
            (m.exchange === "FRIENDS" || !!m.curve) &&
            ((["OPEN", "HALTED"].includes(m.status) &&
              Date.parse(m.closeAt) <= ms) ||
              (m.exchange === "FRIENDS" &&
                m.status === "CLOSED" &&
                ms >= this.resolutionReadyAt(m) + 72 * 36e5) ||
              (m.status === "RESOLVING" &&
                m.resolution &&
                m.resolution.disputeUntil <= now)),
        ) ||
        Object.values(this.state.quotes).some((q) => q.quote.expiresAt < now) ||
        Object.values(this.state.sessions).some((s) => s.expiresAt < now);
    if (!due) return { ok: true };
    return this.transaction(() => {
      this.expireAndClose();
      this.finalizeDue();
      for (const [key, q] of Object.entries(this.state.quotes))
        if (q.quote.expiresAt < this.now()) delete this.state.quotes[key];
      for (const [key, s] of Object.entries(this.state.sessions))
        if (s.expiresAt < this.now()) delete this.state.sessions[key];
      return { ok: true };
    });
  }
  maintenance() {
    return this.tick();
  }
  correction(
    userId: string,
    marketId: string,
    input: { outcomeId: string | null; evidence: string; rationale: string },
  ) {
    return this.transaction(() => {
      const m = this.marketRecord(userId, marketId);
      if (m.exchange === "LIVE")
        fail(
          403,
          "PROVIDER_CORRECTION_ONLY",
          "Live corrections must originate from verified provider evidence",
        );
      this.impartial(userId, m);
      if (
        !["RESOLVED", "VOID"].includes(m.status) ||
        !input.evidence?.trim() ||
        !input.rationale?.trim()
      )
        fail(
          422,
          "INVALID_CORRECTION",
          "Settled market and documented evidence required",
        );
      if (
        input.outcomeId !== null &&
        !m.outcomes.some((o) => o.id === input.outcomeId)
      )
        fail(422, "INVALID_OUTCOME", "Unknown outcome");
      if (
        Object.values(this.state.corrections).some(
          (c) => c.marketId === m.id && c.state === "PENDING",
        )
      )
        fail(409, "CORRECTION_PENDING", "A correction is already pending");
      const c: Correction = {
        id: id(),
        marketId,
        outcomeId: input.outcomeId,
        evidence: input.evidence,
        rationale: input.rationale,
        proposedBy: userId,
        approvals: [],
        state: "PENDING",
      };
      this.state.corrections[c.id] = c;
      return c;
    });
  }
  corrections(userId: string, marketId: string) {
    this.refresh();
    this.marketRecord(userId, marketId);
    return Object.values(this.state.corrections).filter(
      (c) => c.marketId === marketId,
    );
  }
  approveCorrection(userId: string, caseId: string) {
    return this.transaction(() => {
      const c = this.state.corrections[caseId];
      if (!c) fail(404, "NOT_FOUND", "Correction not found");
      const m = this.marketRecord(userId, c.marketId);
      this.impartial(userId, m);
      if (m.exchange === "LIVE" && !this.isLiveReviewer(userId))
        fail(
          403,
          "REVIEWER_REQUIRED",
          "Live corrections require an operator-appointed platform reviewer",
        );
      if (
        userId === c.proposedBy ||
        (m.exchange === "FRIENDS" && !m.rules!.reviewerIds.includes(userId))
      )
        fail(403, "REVIEWER_REQUIRED", "Separate appointed reviewer required");
      if (c.state !== "PENDING" || c.approvals.includes(userId))
        fail(409, "INVALID_STATE", "Correction already reviewed");
      c.approvals.push(userId);
      if (c.approvals.length < 2) return c;
      const changes = (m.settledHoldings ?? []).map((h) => ({
        ...h,
        delta:
          BigInt(h.quantity) *
            (c.outcomeId === null
              ? 500000n
              : c.outcomeId === h.outcomeId
                ? 1000000n
                : 0n) -
          units(h.payout),
      }));
      const required = changes.reduce(
        (sum, h) => sum + (h.delta > 0n ? h.delta : 0n),
        0n,
      );
      const funding =
        m.exchange === "LIVE"
          ? "reserve:live-corrections"
          : "treasury:" + m.groupId;
      if (this.balance(funding) < required)
        fail(
          422,
          "CORRECTION_RESERVE",
          "Finite sponsor reserve cannot fund correction without negative wallets",
        );
      for (const h of changes) {
        const w = this.walletRecord(h.userId, m.exchange, m.groupId);
        if (h.delta > 0n)
          this.transfer(
            funding,
            "cash:" + w.id,
            h.delta,
            "cash",
            "CORRECTION_GRANT",
            m.id,
          );
        else if (h.delta < 0n) {
          const recover =
            this.balance("cash:" + w.id) < -h.delta
              ? this.balance("cash:" + w.id)
              : -h.delta;
          this.transfer(
            "cash:" + w.id,
            funding,
            recover,
            "cash",
            "CORRECTION_RECOVERY",
            m.id,
          );
        }
        h.payout = money(
          BigInt(h.quantity) *
            (c.outcomeId === null
              ? 500000n
              : c.outcomeId === h.outcomeId
                ? 1000000n
                : 0n),
        );
      }
      m.settledHoldings = changes.map(({ delta, ...h }) => h);
      m.resolution!.outcomeId = c.outcomeId;
      m.resolution!.evidence = c.evidence;
      m.resolution!.rationale = c.rationale;
      m.status = c.outcomeId === null ? "VOID" : "RESOLVED";
      m.sequence++;
      c.state = "APPLIED";
      for (const h of changes)
        this.notify(
          h.userId,
          "RESOLUTION",
          "Reviewed correction applied",
          `${c.rationale} No negative wallet was created.`,
          m.id,
        );
      return c;
    });
  }
  isLiveReviewer(userId: string): boolean {
    this.user(userId);
    return (process.env.PLATFORM_REVIEWER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(userId);
  }
  notifications(userId: string) {
    this.refresh();
    this.user(userId);
    return (this.state.notifications[userId] ?? []).filter(
      (n) =>
        !n.marketId ||
        (this.state.markets[n.marketId] &&
          this.canRead(userId, this.state.markets[n.marketId]!)),
    );
  }
  updateNotifications(
    userId: string,
    input: {
      ids?: string[];
      all?: boolean;
      preferences?: { fills?: boolean; resolution?: boolean };
    },
  ) {
    return this.transaction(() => {
      this.user(userId);
      if (input.preferences) {
        const existing = this.state.preferences[userId] ?? {
          fills: true,
          resolution: true,
        };
        for (const key of ["fills", "resolution"] as const)
          if (typeof input.preferences[key] === "boolean")
            existing[key] = input.preferences[key]!;
        this.state.preferences[userId] = existing;
      }
      for (const n of this.state.notifications[userId] ?? [])
        if (input.all || input.ids?.includes(n.id)) n.readAt = this.now();
      return this.notifications(userId);
    });
  }
  preferences(userId: string) {
    this.refresh();
    this.user(userId);
    return this.state.preferences[userId] ?? { fills: true, resolution: true };
  }
  leaderboard(
    userId: string,
    exchange: Exchange = "FRIENDS",
    groupId?: string,
  ): LeaderboardRow[] {
    this.refresh();
    if (exchange === "FRIENDS") {
      if (!groupId) fail(422, "GROUP_REQUIRED", "Group required");
      this.membership(userId, groupId);
    }
    const members =
      exchange === "FRIENDS"
        ? this.state.members
            .filter(
              (m) =>
                m.groupId === groupId &&
                m.status === "ACTIVE" &&
                (this.state.users[m.userId]?.status ?? "APPROVED") ===
                  "APPROVED",
            )
            .map((m) => ({ id: m.userId, joinedAt: m.joinedAt }))
        : [{ id: userId, joinedAt: this.user(userId).createdAt }];
    return members
      .map((member) => {
        const user = this.state.users[member.id]!,
          w = this.walletRecord(member.id, exchange, groupId ?? null),
          positions = this.positions(member.id, exchange, groupId),
          net =
            this.balance("cash:" + w.id) +
            this.balance("lock:" + w.id) +
            positions.reduce((sum, p) => sum + units(p.indicativeValue), 0n),
          adjustment = (
            this.db
              .prepare(
                "SELECT delta FROM journal WHERE account=? AND reason IN ('CORRECTION_GRANT','CORRECTION_RECOVERY','ADMIN_ALLOCATION','ADMIN_RECLAIM')",
              )
              .all("cash:" + w.id) as unknown as { delta: string }[]
          ).reduce((sum, row) => sum + BigInt(row.delta), 0n),
          pnl = net - BigInt(w.initial) - adjustment;
        let score = 0,
          count = 0;
        for (const m of Object.values(this.state.markets)) {
          if (
            m.exchange !== exchange ||
            m.groupId !== (groupId ?? null) ||
            m.status !== "RESOLVED" ||
            m.calibrationReason ||
            !m.determinedAt
          )
            continue;
          const cutoff = Math.min(
            Date.parse(m.closeAt),
            Date.parse(m.rules!.observationAt),
            Date.parse(m.determinedAt),
          );
          const f = this.state.forecasts
            .filter(
              (f) =>
                f.userId === member.id &&
                f.marketId === m.id &&
                Date.parse(f.createdAt) < cutoff,
            )
            .at(-1);
          if (f) {
            score +=
              (f.probability - (m.resolution!.outcomeId === "yes" ? 1 : 0)) **
              2;
            count++;
          }
        }
        return {
          ...this.tradingIdentity(user.id, exchange, groupId ?? null),
          netWorth: money(net),
          pnl: money(pnl),
          returnPercent: (Number(pnl) / Number(w.initial)) * 100,
          tradeCount: this.state.fills.filter(
            (f) =>
              f.userId === user.id &&
              this.state.markets[f.marketId]?.exchange === exchange &&
              this.state.markets[f.marketId]?.groupId === (groupId ?? null),
          ).length,
          brierScore: count ? score / count : null,
          forecastCount: count,
          ...(!user.anonymousTrading ? { joinedAt: member.joinedAt } : {}),
        };
      })
      .sort(
        (a, b) =>
          Number(b.netWorth) - Number(a.netWorth) ||
          a.userId.localeCompare(b.userId),
      );
  }
  events(userId: string, marketId: string, after = -1) {
    this.refresh();
    this.marketRecord(userId, marketId);
    if (!Number.isInteger(after) || after < -1)
      fail(422, "INVALID_CURSOR", "Event cursor must be a sequence number");
    return (
      this.db
        .prepare(
          "SELECT sequence,event_index AS eventIndex,type,data,created_at AS createdAt FROM market_events WHERE market_id=? AND sequence>? ORDER BY sequence,event_index LIMIT 500",
        )
        .all(marketId, after) as unknown as {
        sequence: number;
        eventIndex: number;
        type: string;
        data: string;
        createdAt: string;
      }[]
    ).map((row) => ({ ...row, data: JSON.parse(row.data) }));
  }
  audit(userId: string) {
    this.refresh();
    this.user(userId);
    const wallets = new Set(
      Object.values(this.state.wallets)
        .filter((w) => w.userId === userId)
        .flatMap((w) => ["cash:" + w.id, "lock:" + w.id]),
    );
    return (
      this.db.prepare("SELECT * FROM journal ORDER BY id").all() as unknown as {
        account: string;
      }[]
    ).filter(
      (row) =>
        wallets.has(row.account) ||
        row.account.startsWith("share:" + userId + ":") ||
        row.account.startsWith("held:" + userId + ":"),
    );
  }
  reconcile(userId: string) {
    this.refresh();
    this.user(userId);
    return { ...this.reconcileSystem(), ownEntries: this.audit(userId).length };
  }
  // Internal operational check: returns aggregate invariants, never user data.
  reconcileSystem() {
    this.refresh(true);
    const rows = this.db
      .prepare(
        "SELECT transaction_id,asset,account,delta,reason,reference FROM journal ORDER BY id",
      )
      .all() as unknown as {
      transaction_id: string;
      asset: string;
      account: string;
      delta: string;
      reason: string;
      reference: string;
    }[];
    const sums = new Map<string, bigint>(),
      balances = new Map<string, bigint>();
    for (const r of rows) {
      const key = r.transaction_id + ":" + r.asset;
      sums.set(key, (sums.get(key) ?? 0n) + BigInt(r.delta));
      balances.set(
        r.account,
        (balances.get(r.account) ?? 0n) + BigInt(r.delta),
      );
    }
    const journalBalanced = [...sums.values()].every((x) => x === 0n),
      projectionsMatch = [
        ...new Set([...Object.keys(this.state.accounts), ...balances.keys()]),
      ].every(
        (account) => this.balance(account) === (balances.get(account) ?? 0n),
      ),
      nonnegative = Object.entries(this.state.accounts).every(
        ([account, value]) =>
          account.startsWith("issuer:") || BigInt(value) >= 0n,
      );
    let inventoryMatches = true,
      escrowsSolvent = true,
      locksMatch = true,
      riskReservesMatch = true;
    for (const market of Object.values(this.state.markets)) {
      if (market.curve) {
        try {
          const expected = curveReserve(market.curve);
          const funded = rows
            .filter(
              (r) =>
                r.account === "escrow:" + market.id &&
                r.reason === "LIVE_MARKET_RESERVE" &&
                r.reference === market.id,
            )
            .reduce((sum, r) => sum + BigInt(r.delta), 0n);
          if (
            market.b !== LIVE_LIQUIDITY_B ||
            market.curve.version !== 2 ||
            BigInt(market.reserve) !== expected ||
            funded !== expected ||
            market.outcomes.length !== 2 ||
            market.q.length !== 2 ||
            market.q.some((q) => !Number.isSafeInteger(q) || q < 0)
          )
            riskReservesMatch = false;
        } catch {
          riskReservesMatch = false;
        }
      }
      for (const [index, outcome] of market.outcomes.entries()) {
        const suffix = ":" + market.id + ":" + outcome.id;
        const supply = Object.entries(this.state.accounts)
          .filter(
            ([account]) =>
              (account.startsWith("share:") || account.startsWith("held:")) &&
              account.endsWith(suffix),
          )
          .reduce((total, [, value]) => total + BigInt(value), 0n);
        if (
          this.balance("issuer:share:" + market.id + ":" + outcome.id) !==
            -supply ||
          ((market.exchange === "FRIENDS" || !!market.curve) &&
            BigInt(market.q[index]!) !== supply)
        )
          inventoryMatches = false;
      }
      if (
        (market.exchange === "FRIENDS" || !!market.curve) &&
        this.balance("escrow:" + market.id) <
          BigInt(Math.max(...market.q)) * 1_000_000n
      )
        escrowsSolvent = false;
    }
    const expectedLocks = new Map<string, bigint>();
    for (const order of Object.values(this.state.orders).filter(
      (order) => order.status === "OPEN",
    )) {
      const amount =
        order.side === "BUY"
          ? units(order.limitPrice) *
            BigInt(order.quantity - order.filledQuantity)
          : BigInt(order.quantity - order.filledQuantity);
      const account =
        order.side === "BUY"
          ? "lock:" +
            this.walletRecord(order.userId, order.exchange, order.groupId).id
          : this.shareLock(order.userId, order.marketId, order.outcomeId);
      expectedLocks.set(account, (expectedLocks.get(account) ?? 0n) + amount);
      if (order.side === "BUY" && units(order.locked) !== amount)
        locksMatch = false;
    }
    for (const account of new Set([
      ...Object.keys(this.state.accounts).filter(
        (account) => account.startsWith("lock:") || account.startsWith("held:"),
      ),
      ...expectedLocks.keys(),
    ]))
      if (this.balance(account) !== (expectedLocks.get(account) ?? 0n))
        locksMatch = false;
    return {
      balanced:
        journalBalanced &&
        projectionsMatch &&
        nonnegative &&
        inventoryMatches &&
        escrowsSolvent &&
        locksMatch &&
        riskReservesMatch,
      inventoryMatches,
      riskReservesMatch,
      escrowsSolvent,
      locksMatch,
      journalBalanced,
      projectionsMatch,
      nonnegative,
      checkedAt: this.now(),
    };
  }
  requireAdmin(userId: string) {
    const user = this.user(userId);
    if (user.platformRole !== "ADMIN")
      fail(403, "ADMIN_REQUIRED", "Platform administrator required");
    return user;
  }
  tradingPaused() {
    this.refresh();
    return this.state.operatorPaused;
  }
  adminAction(actorId: string, action: AdminAction, key: string) {
    return this.transaction(() => {
      this.requireAdmin(actorId);
      if (!key || key.length > 200)
        fail(422, "IDEMPOTENCY_REQUIRED", "An idempotency key is required");
      const digest = hash(JSON.stringify(action));
      const prior = this.db
        .prepare(
          "SELECT request_hash, result FROM admin_events WHERE actor_id=? AND idempotency_key=?",
        )
        .get(actorId, key) as
        | { request_hash: string; result: string }
        | undefined;
      if (prior) {
        if (prior.request_hash !== digest)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Key was used with different parameters",
          );
        return JSON.parse(prior.result) as { id: string; ok: true };
      }
      let before: unknown;
      if (action.type === "ACCOUNT_STATUS") {
        const u = this.state.users[action.targetId];
        if (!u) fail(404, "USER_NOT_FOUND", "Account not found");
        if (
          !["PENDING", "APPROVED", "REJECTED", "SUSPENDED"].includes(
            action.status,
          )
        )
          fail(422, "INVALID_STATUS", "Invalid account status");
        before = this.publicUser(u);
        const oldStatus = u.status ?? "APPROVED";
        if (
          action.status === "PENDING" ||
          (action.status === "REJECTED" &&
            oldStatus !== "PENDING" &&
            oldStatus !== "REJECTED")
        )
          fail(
            409,
            "INVALID_TRANSITION",
            "Active accounts must be suspended; only pending requests may be rejected",
          );
        if (
          u.platformRole === "ADMIN" &&
          action.status !== "APPROVED" &&
          Object.values(this.state.users).filter(
            (x) =>
              x.platformRole === "ADMIN" &&
              (x.status ?? "APPROVED") === "APPROVED",
          ).length <= 1
        )
          fail(409, "LAST_ADMIN", "Keep at least one approved administrator");
        u.status = action.status;
        if (action.status !== "APPROVED") {
          for (const order of Object.values(this.state.orders))
            if (order.userId === u.id && order.status === "OPEN")
              this.cancelInternal(order, "CANCELLED");
        } else this.initializeEconomy(u.id);
        this.notify(u.id, "ACCOUNT", "Account status changed", action.status);
      } else if (
        action.type === "WALLET_ADJUSTMENT" ||
        action.type === "TREASURY_ADJUSTMENT"
      ) {
        let amount: bigint;
        try {
          amount = units(action.amount);
        } catch {
          fail(
            422,
            "INVALID_AMOUNT",
            "Use a signed decimal with at most six decimal places",
          );
        }
        if (
          amount === 0n ||
          amount > 1_000_000_000_000n ||
          amount < -1_000_000_000_000n
        )
          fail(
            422,
            "INVALID_AMOUNT",
            "Adjust between -1,000,000 and 1,000,000 credits, excluding zero",
          );
        let account: string, issuer: string;
        if (action.type === "WALLET_ADJUSTMENT") {
          const w = this.state.wallets[action.targetId];
          if (!w) fail(404, "WALLET_NOT_FOUND", "Wallet not found");
          account = "cash:" + w.id;
          issuer = `issuer:admin:${w.exchange}:${w.groupId ?? "global"}:${w.seasonId}`;
          this.notify(
            w.userId,
            "ECONOMY",
            "Credit adjustment",
            `${money(amount)} play credits adjusted by an administrator`,
          );
        } else {
          if (
            action.targetId === LIVE_LIQUIDITY_ACCOUNT &&
            this.state.accounts[LIVE_LIQUIDITY_ACCOUNT] !== undefined
          ) {
            account = LIVE_LIQUIDITY_ACCOUNT;
            issuer = "issuer:admin-sponsor:live-1:v2";
          } else {
            if (!this.state.groups[action.targetId])
              fail(404, "GROUP_NOT_FOUND", "Group not found");
            account = "treasury:" + action.targetId;
            issuer = "issuer:admin-sponsor:" + action.targetId;
          }
        }
        before = { account, available: money(this.balance(account)) };
        if (amount > 0n)
          this.transfer(
            issuer,
            account,
            amount,
            "cash",
            "ADMIN_ALLOCATION",
            action.targetId,
          );
        else
          this.transfer(
            account,
            issuer,
            -amount,
            "cash",
            "ADMIN_RECLAIM",
            action.targetId,
          );
      } else if (action.type === "TRADING_PAUSE") {
        if (typeof action.paused !== "boolean")
          fail(422, "INVALID_PAUSE", "Choose a trading state");
        if (!action.paused && !this.reconcileSystem().balanced)
          fail(
            409,
            "RECONCILIATION_MISMATCH",
            "Reconcile the economy before resuming trading",
          );
        before = this.state.operatorPaused;
        this.state.operatorPaused = action.paused;
      } else if (action.type === "CANCEL_ORDER") {
        const order = this.state.orders[action.targetId];
        if (!order) fail(404, "ORDER_NOT_FOUND", "Order not found");
        if (order.status !== "OPEN")
          fail(409, "ORDER_CLOSED", "Only open orders can be cancelled");
        before = this.publicOrder(order);
        this.cancelInternal(order, "CANCELLED");
        this.notify(
          order.userId,
          "ORDER",
          "Order cancelled by administrator",
          "An administrator canceled this order.",
        );
      } else if (
        ["HALT_MARKET", "RESUME_MARKET", "CLOSE_MARKET"].includes(action.type)
      ) {
        const m = this.state.markets[action.targetId];
        if (!m || (m.exchange !== "FRIENDS" && !m.curve))
          fail(404, "MARKET_NOT_FOUND", "Local market not found");
        if (
          m.curve &&
          action.type === "RESUME_MARKET" &&
          (m.curve.mappingHalted || m.reference?.status !== "OPEN")
        )
          fail(
            409,
            "SOURCE_HALTED",
            "Source status or immutable outcome mapping blocks resumption",
          );
        before = { status: m.status, sequence: m.sequence };
        if (action.type === "HALT_MARKET" && m.status !== "OPEN")
          fail(409, "INVALID_STATE", "Only an open market can be halted");
        if (
          action.type === "RESUME_MARKET" &&
          (m.status !== "HALTED" ||
            Date.parse(m.closeAt) <= this.clock().getTime())
        )
          fail(
            409,
            "INVALID_STATE",
            "Only a halted market before its frozen close can resume",
          );
        if (
          action.type === "CLOSE_MARKET" &&
          (!["OPEN", "HALTED"].includes(m.status) ||
            Date.parse(m.closeAt) > this.clock().getTime())
        )
          fail(
            409,
            "EARLY_CLOSE_FORBIDDEN",
            "The frozen trading deadline must pass before closing",
          );
        if (action.type !== "RESUME_MARKET")
          for (const order of Object.values(this.state.orders))
            if (order.marketId === m.id && order.status === "OPEN")
              this.cancelInternal(order, "CANCELLED");
        if (m.curve) m.curve.operatorHalted = action.type === "HALT_MARKET";
        m.status =
          action.type === "HALT_MARKET"
            ? "HALTED"
            : action.type === "RESUME_MARKET"
              ? "OPEN"
              : "CLOSED";
        m.sequence++;
        m.updatedAt = this.now();
        this.notifyMarket(m, "Administrator market action", m.status);
      } else
        fail(422, "INVALID_ADMIN_ACTION", "Unsupported administrator action");
      const result = { id: id(), ok: true as const };
      this.db
        .prepare(
          "INSERT INTO admin_events(id,actor_id,idempotency_key,request_hash,action,data,result,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          result.id,
          actorId,
          key,
          digest,
          action.type,
          JSON.stringify({ ...action, before }),
          JSON.stringify(result),
          this.now(),
        );
      return result;
    });
  }
  adminReport(
    actorId: string,
    section: AdminSection = "users",
    offset = 0,
    limit = 50,
    search = "",
    status = "",
  ): AdminReport {
    this.requireAdmin(actorId);
    offset = Math.max(0, Math.floor(offset));
    limit = Math.max(1, Math.min(100, Math.floor(limit)));
    const handle = (userId: string) =>
      this.state.users[userId]?.handle ?? "Deleted account";
    const scope = (exchange: string, groupId: string | null) =>
      exchange === "LIVE"
        ? "Live Markets"
        : (this.state.groups[groupId!]?.name ?? "Friends Exchange");
    const summary = {
      users: Object.keys(this.state.users).length,
      pending: Object.values(this.state.users).filter(
        (u) => u.status === "PENDING",
      ).length,
      openOrders: Object.values(this.state.orders).filter(
        (o) => o.status === "OPEN",
      ).length,
      markets: Object.keys(this.state.markets).length,
      tradingPaused: this.state.operatorPaused,
    };
    const filledCash = new Map<string, bigint>();
    if (section === "bets")
      for (const fill of this.state.fills)
        if (fill.orderId)
          filledCash.set(
            fill.orderId,
            (filledCash.get(fill.orderId) ?? 0n) + units(fill.cash),
          );
    let rows: AdminRow[] = [];
    if (section === "users")
      rows = Object.values(this.state.users).map((u) => ({
        id: u.id,
        primary: u.handle,
        secondary: this.publicUser(u).platformRole!,
        scope: "Platform",
        status: u.status ?? "APPROVED",
        createdAt: u.createdAt,
        detail: `Account ${u.id}`,
      }));
    else if (section === "wallets")
      rows = Object.values(this.state.wallets).map((w) => {
        const wallet = this.walletView(w);
        const realized = Object.values(this.state.positions)
          .filter(
            (p) =>
              p.userId === w.userId &&
              this.state.markets[p.marketId]?.exchange === w.exchange &&
              this.state.markets[p.marketId]?.groupId === w.groupId,
          )
          .reduce((sum, p) => sum + BigInt(p.realized), 0n);
        return {
          id: w.id,
          primary: handle(w.userId),
          secondary: `${wallet.locked} locked · ${wallet.initial} starting credits`,
          scope: scope(w.exchange, w.groupId),
          status: this.publicUser(this.state.users[w.userId]!).status!,
          amount: wallet.available,
          profit: money(realized),
          createdAt: this.state.users[w.userId]!.createdAt,
          detail: `Wallet ${w.id} · Season ${w.seasonId} · Only available credits can be reclaimed. Realized P&L excludes credit allocations.`,
        };
      });
    else if (section === "positions")
      rows = Object.values(this.state.positions).map((p) => {
        const m = this.state.markets[p.marketId]!,
          quantity = this.quantity(p.userId, p.marketId, p.outcomeId),
          locked = this.balance(
            this.shareLock(p.userId, p.marketId, p.outcomeId),
          );
        return {
          id: this.positionKey(p.userId, p.marketId, p.outcomeId),
          primary: handle(p.userId),
          secondary: m.question,
          scope: scope(m.exchange, m.groupId),
          status: quantity > 0 ? "HELD" : "CLOSED",
          amount: money(p.basis),
          profit: money(p.realized),
          createdAt: m.updatedAt,
          detail: `${quantity} ${p.outcomeId} shares owned · ${locked} locked · Market ${m.status} · Cost basis is the remaining acquisition cost, not an executable liquidation quote. Market ${m.id}`,
        };
      });
    else if (section === "bets")
      rows = Object.values(this.state.orders).map((o) => {
        const m = this.state.markets[o.marketId]!;

        return {
          id: o.id,
          primary: handle(o.userId),
          secondary: m.question,
          scope: scope(o.exchange, o.groupId),
          status: o.status,
          amount: money(filledCash.get(o.id) ?? 0n),
          createdAt: o.createdAt,
          detail: `${o.side} ${o.outcomeLabel ?? o.outcomeId} · ${o.filledQuantity}/${o.quantity} shares filled · limit ${o.limitPrice} · ${o.timeInForce} · ${o.locked} locked · Order ${o.id} · Market ${m.id}`,
        };
      });
    else if (section === "fills")
      rows = this.state.fills.map((f) => {
        const m = this.state.markets[f.marketId]!;
        return {
          id: f.id,
          primary: handle(f.userId),
          secondary: m.question,
          scope: scope(m.exchange, m.groupId),
          status: f.source,
          amount: f.cash,
          createdAt: f.createdAt,
          detail: `${f.side} ${f.quantity} ${f.outcomeId} shares · ${f.price} average price · Fill ${f.id} · Order ${f.orderId}`,
        };
      });
    else if (section === "settlements")
      rows = Object.values(this.state.markets).flatMap((m) =>
        (m.settledHoldings ?? []).map((h) => {
          const position =
            this.state.positions[this.positionKey(h.userId, m.id, h.outcomeId)];
          return {
            id: `${m.id}:${h.userId}:${h.outcomeId}`,
            primary: handle(h.userId),
            secondary: m.question,
            scope: scope(m.exchange, m.groupId),
            status: m.status,
            amount: h.payout,
            profit: money(position?.realized ?? "0"),
            createdAt: m.updatedAt,
            detail: `${h.quantity} ${h.outcomeId} shares settled · Outcome ${m.resolution?.outcomeId ?? "VOID"} · Payout is gross contractual entitlement; realized P&L includes prior sales. Authorized corrections and any capped recoveries are recorded separately in the ledger.`,
          };
        }),
      );
    else if (section === "markets")
      rows = Object.values(this.state.markets).map((m) => ({
        id: m.id,
        exchange: m.exchange,
        executionModel: m.curve
          ? "SOURCE_SEEDED_LMSR"
          : m.exchange === "LIVE"
            ? "EXTERNAL_SIM"
            : undefined,
        primary: m.question,
        secondary: `${m.outcomes.map((o) => o.label).join(" / ")} · closes ${m.closeAt}`,
        scope: scope(m.exchange, m.groupId),
        status: m.status,
        amount:
          m.exchange === "FRIENDS" || !!m.curve
            ? money(this.balance("escrow:" + m.id))
            : undefined,
        createdAt: m.createdAt,
        detail: `${m.exchange} · Creator ${m.creatorId ? handle(m.creatorId) : m.provider} · Resolver ${m.resolverId ? handle(m.resolverId) : "Provider"} · Sequence ${m.sequence} · ${m.rules?.condition ?? m.description} · ${m.rules?.source ?? m.sourceUrl ?? ""} · Rules and settlement governance remain immutable.`,
      }));
    else if (section === "treasuries")
      rows = [
        ...(this.state.accounts[LIVE_LIQUIDITY_ACCOUNT] === undefined
          ? []
          : [
              {
                id: LIVE_LIQUIDITY_ACCOUNT,
                primary: "Live market liquidity",
                secondary: "Independent Live sponsor treasury",
                scope: "Live",
                status: "SPONSOR_BUDGET",
                amount: money(this.balance(LIVE_LIQUIDITY_ACCOUNT)),
                createdAt: (
                  this.db
                    .prepare(
                      "SELECT min(created_at) AS at FROM journal WHERE account=?",
                    )
                    .get(LIVE_LIQUIDITY_ACCOUNT) as { at: string }
                ).at,
                detail:
                  "Free sponsor credits only. Weighted LMSR reserves stay locked in market escrow until provider-final settlement. Separate from user wallets and Friends budgets.",
              },
            ]),
        ...Object.values(this.state.groups).map((g) => ({
          id: g.id,
          primary: g.name,
          secondary: `Owner ${handle(g.ownerId)}`,
          scope: g.name,
          status: "SPONSOR_BUDGET",
          amount: money(this.balance("treasury:" + g.id)),
          createdAt: g.createdAt,
          detail: `Unreserved sponsor budget only. Open-market reserves are held in market escrow and cannot be reclaimed here. Group ${g.id}`,
        })),
      ];
    else if (section === "audit")
      rows = (
        this.db
          .prepare(
            "SELECT id,actor_id,action,data,created_at FROM admin_events ORDER BY rowid DESC",
          )
          .all() as unknown as {
          id: string;
          actor_id: string;
          action: string;
          data: string;
          created_at: string;
        }[]
      ).map((e) => {
        const data = JSON.parse(e.data);
        return {
          id: e.id,
          primary: handle(e.actor_id),
          secondary: data.reason || e.action.toLowerCase().replaceAll("_", " "),
          scope: data.targetId ?? "Platform",
          status: e.action,
          amount: data.amount,
          createdAt: e.created_at,
          detail: [
            data.targetId ? `Target ${data.targetId}` : "Platform action",
            data.status ? `Status ${data.status}` : "",
            typeof data.paused === "boolean"
              ? `Trading paused: ${data.paused}`
              : "",
            data.before?.available
              ? `Previous available balance: ${data.before.available} CR`
              : "",
            data.before?.status ? `Previous status: ${data.before.status}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      });
    else fail(422, "INVALID_SECTION", "Unknown report section");
    const needle = search.trim().toLowerCase();
    rows = rows
      .filter((row) => !status || row.status === status.toUpperCase())
      .filter(
        (row) =>
          !needle ||
          [
            row.id,
            row.primary,
            row.secondary,
            row.scope,
            row.status,
            row.detail,
          ].some((v) => v?.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      section,
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit,
      summary,
    };
  }
  adminLedger(actorId: string, walletId: string, offset = 0) {
    this.requireAdmin(actorId);
    const w = this.state.wallets[walletId];
    if (!w) fail(404, "WALLET_NOT_FOUND", "Wallet not found");
    return this.db
      .prepare(
        "SELECT id,transaction_id AS transactionId,asset,account,delta,reason,reference,created_at AS createdAt FROM journal WHERE account IN (?,?) ORDER BY id DESC LIMIT 100 OFFSET ?",
      )
      .all("cash:" + walletId, "lock:" + walletId, offset);
  }
  bootstrap(userId: string | null) {
    this.tick();
    const identity =
      userId && this.state.users[userId]
        ? this.publicUser(this.state.users[userId]!)
        : null;
    const active = identity?.status === "APPROVED" ? userId : null;
    return {
      user: identity,
      groups: active ? this.groups(active) : [],
      wallets: active ? this.wallets(active) : [],
      notifications: active ? this.notifications(active) : [],
      settings: { liveEnabled: true, registrationOpen: true, version: "0.1.0" },
      activeGroupId: active ? this.groups(active)[0]?.id : undefined,
    };
  }
  liveMarketIds() {
    this.refresh();
    return [
      ...new Set(
        Object.values(this.state.positions)
          .filter((p) => this.state.markets[p.marketId]?.exchange === "LIVE")
          .map((p) => p.marketId)
          .concat(
            Object.values(this.state.markets)
              .filter(
                (m) => m.curve && !["RESOLVED", "VOID"].includes(m.status),
              )
              .map((m) => m.id),
          ),
      ),
    ];
  }
  syncLiveMarket(market: Market, book?: OrderBook) {
    return this.transaction(() => {
      if (
        market.exchange !== "LIVE" ||
        market.groupId !== null ||
        !market.provider
      )
        fail(422, "INVALID_MARKET", "Expected external provider market");
      const existing = this.state.markets[market.id];
      if (existing && existing.exchange !== "LIVE")
        fail(409, "SCOPE_MISMATCH", "Market scope mismatch");
      if (
        existing?.resolution?.state === "FINAL" &&
        ["RESOLVED", "VOID"].includes(existing.status)
      ) {
        if (market.resolution?.state === "FINAL")
          for (const correction of Object.values(this.state.corrections))
            if (
              correction.marketId === market.id &&
              correction.state === "PENDING" &&
              correction.proposedBy === market.provider &&
              correction.outcomeId !== market.resolution.outcomeId
            )
              correction.state = "SUPERSEDED";
        if (
          market.resolution?.state === "FINAL" &&
          market.resolution.outcomeId !== existing.resolution.outcomeId
        ) {
          const pending = Object.values(this.state.corrections).find(
            (c) =>
              c.marketId === market.id &&
              c.state === "PENDING" &&
              c.outcomeId === market.resolution!.outcomeId,
          );
          const key = "provider-correction:" + market.id + ":" + id();
          if (!pending) {
            this.state.corrections[key] = {
              id: key,
              marketId: market.id,
              outcomeId: market.resolution.outcomeId,
              evidence: market.resolution.evidence,
              rationale:
                "Provider changed a finalized outcome. Automatic clawback is blocked; two-reviewer funded correction is required.",
              proposedBy: market.provider,
              approvals: [],
              state: "PENDING",
            };
            for (const h of existing.settledHoldings ?? [])
              this.notify(
                h.userId,
                "RESOLUTION",
                "Provider correction requires review",
                this.state.corrections[key]!.rationale,
                market.id,
              );
          }
        }
        return this.marketView(existing);
      }
      const changedRules =
        !!existing?.curve &&
        sourceRulesHash(market) !== existing.curve.rulesHash;
      const sourceOutcomes =
        existing?.curve && !changedRules
          ? existing.outcomes.map(
              (o) => market.outcomes.find((x) => x.id === o.id)!,
            )
          : market.outcomes;
      const m: StoredMarket = existing?.curve
        ? {
            ...existing,
            reference: {
              outcomes: structuredClone(market.outcomes),
              timestamp: market.updatedAt,
              status: market.status,
              volume: market.volume,
            },
            outcomes: changedRules ? existing.outcomes : sourceOutcomes,
            status: changedRules
              ? "HALTED"
              : market.resolution?.state === "FINAL" &&
                  ["RESOLVED", "VOID"].includes(market.status)
                ? market.status
                : existing.curve.mappingHalted || existing.curve.operatorHalted
                  ? "HALTED"
                  : Date.parse(market.closeAt) <= this.clock().getTime() ||
                      Date.parse(existing.closeAt) <= this.clock().getTime()
                    ? "CLOSED"
                    : market.status,
            closeAt:
              Date.parse(market.closeAt) < Date.parse(existing.closeAt)
                ? market.closeAt
                : existing.closeAt,
            resolution: changedRules ? existing.resolution : market.resolution,
            sourceUrl: market.sourceUrl,
            updatedAt: this.now(),
          }
        : { ...market, q: [], reserve: "0", sequence: existing?.sequence ?? 0 };
      if (changedRules && m.curve) m.curve.mappingHalted = true;
      if (m.curve && m.status !== "OPEN") {
        for (const order of Object.values(this.state.orders))
          if (order.marketId === m.id && order.status === "OPEN")
            this.cancelInternal(order, "CANCELLED");
      }
      if (existing?.curve && m.status !== existing.status)
        m.sequence = Math.max(m.sequence, existing.sequence) + 1;
      this.state.markets[m.id] = m;
      if (book) {
        this.validateBook(m, book, book.outcomeId);
        this.state.liveBooks[m.id + ":" + book.outcomeId] = book;
      }
      if (
        m.resolution?.state === "FINAL" &&
        ["RESOLVED", "VOID"].includes(m.status)
      ) {
        const outcomeId = m.resolution.outcomeId;
        if (outcomeId !== null && !m.outcomes.some((o) => o.id === outcomeId))
          fail(
            422,
            "INVALID_PROVIDER_RESULT",
            "Provider winner does not map to an outcome",
          );
        if (!m.resolution.evidence)
          fail(
            422,
            "MISSING_PROVIDER_EVIDENCE",
            "Final provider evidence is required",
          );
        if (m.curve) {
          m.status = "CLOSED";
          this.settle(m, outcomeId, "Verified final provider resolution");
          return this.marketView(m);
        }
        m.settledHoldings = [];
        for (const p of Object.values(this.state.positions).filter(
          (p) => p.marketId === m.id,
        )) {
          const quantity = this.quantity(p.userId, m.id, p.outcomeId);
          if (!quantity) continue;
          const payout =
              BigInt(quantity) *
              (outcomeId === null
                ? 500000n
                : outcomeId === p.outcomeId
                  ? 1000000n
                  : 0n),
            w = this.walletRecord(p.userId, "LIVE", null),
            asset = "share:" + m.id + ":" + p.outcomeId;
          this.transfer(
            "issuer:external-cash",
            "cash:" + w.id,
            payout,
            "cash",
            "PROVIDER_SETTLEMENT",
            m.id,
          );
          this.transfer(
            this.shareAccount(p.userId, m.id, p.outcomeId),
            "issuer:" + asset,
            BigInt(quantity),
            asset,
            "PROVIDER_SETTLEMENT",
            m.id,
          );
          p.realized = (
            BigInt(p.realized) +
            payout -
            BigInt(p.basis)
          ).toString();
          p.basis = "0";
          m.settledHoldings.push({
            userId: p.userId,
            outcomeId: p.outcomeId,
            quantity,
            payout: money(payout),
          });
          this.notify(
            p.userId,
            "RESOLUTION",
            m.question,
            `Verified provider settlement: ${money(payout)} play credits`,
            m.id,
          );
        }
        m.sequence++;
      }
      return this.marketView(m);
    });
  }
  private liveMarket(userId: string, market: Market) {
    this.user(userId);
    this.syncLiveMarket(market);
    return this.state.markets[market.id]!;
  }
  private validateBook(m: Market, book: OrderBook, outcomeId: string) {
    const age = this.clock().getTime() - Date.parse(book.timestamp);
    if (
      book.marketId !== m.id ||
      book.outcomeId !== outcomeId ||
      !m.outcomes.some((o) => o.id === outcomeId)
    )
      fail(422, "BOOK_MISMATCH", "Book does not match market and outcome");
    if (book.stale || !Number.isFinite(age) || age < -1000 || age > 5000)
      fail(
        409,
        "STALE_BOOK",
        "External source timestamp is missing or older than five seconds",
      );
    for (const list of [book.bids, book.asks])
      for (const level of list) {
        if (
          !Number.isFinite(level.price) ||
          level.price <= 0 ||
          level.price >= 1 ||
          !Number.isFinite(level.quantity) ||
          level.quantity < 0
        )
          fail(422, "INVALID_BOOK", "Invalid external level");
        try {
          units(level.price);
        } catch {
          fail(
            422,
            "INVALID_BOOK_PRECISION",
            "External prices require at most six decimal places",
          );
        }
      }
  }
  private walkLive(book: OrderBook, input: OrderInput) {
    const levels = [...(input.side === "BUY" ? book.asks : book.bids)].sort(
        (a, b) =>
          input.side === "BUY" ? a.price - b.price : b.price - a.price,
      ),
      limit = units(input.limitPrice);
    let left = input.quantity,
      cash = 0n;
    const fills: { quantity: number; cash: bigint }[] = [];
    for (const level of levels) {
      let price: bigint;
      try {
        price = units(level.price);
      } catch {
        fail(
          422,
          "INVALID_BOOK_PRECISION",
          "External prices require at most six decimal places",
        );
      }
      if (input.side === "BUY" ? price > limit : price < limit) break;
      const quantity = Math.min(left, Math.floor(level.quantity));
      if (quantity < 1) continue;
      fills.push({ quantity, cash: price * BigInt(quantity) });
      cash += price * BigInt(quantity);
      left -= quantity;
      if (!left) break;
    }
    return { fills, cash, quantity: input.quantity - left };
  }
  quoteLive(
    userId: string,
    market: Market,
    book: OrderBook,
    input: {
      outcomeId: string;
      side: "BUY" | "SELL";
      quantity: number;
      limitPrice?: string | number;
    },
  ): Quote {
    return this.transaction(() => {
      const m = this.liveMarket(userId, market);
      this.validateBook(m, book, input.outcomeId);
      this.state.liveBooks[m.id + ":" + input.outcomeId] = book;
      this.assertTrading(userId, m, input.outcomeId);
      if (this.communityMarket(m))
        return this.quoteCurve(
          userId,
          this.candidateCurve(m, book, userId),
          input,
        );
      const full: OrderInput = {
        ...input,
        marketId: m.id,
        limitPrice: String(
          input.limitPrice ?? (input.side === "BUY" ? "0.9999" : "0.0001"),
        ),
        timeInForce: "IOC",
      };
      this.validateInput(full);
      const result = this.walkLive(book, full),
        w = this.walletRecord(userId, "LIVE", null),
        owns =
          input.side === "BUY"
            ? this.balance("cash:" + w.id) >= result.cash
            : this.balance(this.shareAccount(userId, m.id, input.outcomeId)) >=
              BigInt(input.quantity);
      const quote: Quote = {
        id: id(),
        engineVersion: 1,
        executionModel: "EXTERNAL_SIM",
        marketId: m.id,
        outcomeId: input.outcomeId,
        side: input.side,
        quantity: input.quantity,
        filledQuantity: result.quantity,
        estimatedCash: money(result.cash),
        averagePrice: result.quantity
          ? Number(money(result.cash)) / result.quantity
          : 0,
        afterProbability: market.outcomes.find((o) => o.id === input.outcomeId)!
          .probability,
        expiresAt: new Date(Date.parse(book.timestamp) + 5000).toISOString(),
        sequence: m.sequence,
        executable: result.quantity > 0 && owns,
        reason: owns
          ? undefined
          : "Insufficient available balance or owned shares",
        sources: result.quantity
          ? [
              {
                source: "EXTERNAL",
                quantity: result.quantity,
                cash: money(result.cash),
              },
            ]
          : [],
      };
      this.state.quotes[quote.id] = {
        userId,
        quote,
        input: full,
        bookHash: book.hash,
      };
      return quote;
    });
  }
  executeLive(
    userId: string,
    market: Market,
    book: OrderBook,
    input: OrderInput,
    key: string,
  ): OrderReceipt {
    return this.transaction(() => {
      this.validateInput(input);
      if (typeof key !== "string" || key.length < 4 || key.length > 200)
        fail(
          422,
          "IDEMPOTENCY_REQUIRED",
          "Idempotency-Key requires 4–200 characters",
        );
      const idemKey = `${userId}:LIVE:global:${key}`,
        digest = requestHash(input),
        prior = this.state.idempotency[idemKey];
      if (prior) {
        if (prior.hash !== digest)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Key was used with different parameters",
          );
        return prior.result;
      }
      if (input.marketId !== market.id)
        fail(
          422,
          "MARKET_MISMATCH",
          "Input market does not match fetched market",
        );
      const m = this.liveMarket(userId, market);
      this.validateBook(m, book, input.outcomeId);
      this.state.liveBooks[m.id + ":" + input.outcomeId] = book;
      this.assertTrading(userId, m, input.outcomeId);
      this.state.liveBooks[m.id + ":" + input.outcomeId] = book;
      if (this.communityMarket(m)) {
        if (!m.curve) {
          const candidate = this.candidateCurve(m, book, userId);
          this.validateQuote(userId, candidate, input);
          const quoted = input.quoteId
            ? this.state.quotes[input.quoteId]?.curve
            : undefined;
          if (
            quoted &&
            (quoted.rulesHash !== candidate.curve!.rulesHash ||
              quoted.prior.some((p, i) => p !== candidate.curve!.prior[i]))
          )
            fail(
              409,
              "REQUOTE",
              "Source opening odds changed; request a new quote",
            );
          if (
            input.timeInForce === "IOC" &&
            !this.plan(userId, candidate, input).filled
          )
            fail(
              409,
              "NO_FILL",
              "No liquidity within the protected price or available balance",
            );
          this.transfer(
            LIVE_LIQUIDITY_ACCOUNT,
            "escrow:" + m.id,
            BigInt(candidate.reserve),
            "cash",
            "LIVE_MARKET_RESERVE",
            m.id,
          );
          this.state.markets[m.id] = candidate;
        }
        return this.execute(userId, input, key);
      }
      if (input.timeInForce !== "IOC")
        fail(
          422,
          "LIVE_IOC_ONLY",
          "External simulation supports immediate orders only",
        );
      this.validateQuote(userId, m, input);
      const result = this.walkLive(book, input),
        w = this.walletRecord(userId, "LIVE", null);
      if (
        input.side === "SELL" &&
        this.balance(this.shareAccount(userId, m.id, input.outcomeId)) <
          BigInt(input.quantity)
      )
        fail(
          422,
          "INSUFFICIENT_SHARES",
          "Only available owned shares may be sold",
        );
      if (input.side === "BUY" && this.balance("cash:" + w.id) < result.cash)
        fail(422, "INSUFFICIENT_FUNDS", "Insufficient play credits");
      const spent = input.side === "BUY" ? result.cash : 0n,
        received = input.side === "SELL" ? result.cash : 0n;
      this.protections(input, result.quantity, spent, received);
      const o = this.newOrder(userId, m, input);
      this.state.orders[o.id] = o;
      const fills: Fill[] = [];
      for (const f of result.fills) {
        const old = this.quantity(userId, m.id, input.outcomeId),
          asset = `share:${m.id}:${input.outcomeId}`,
          share = this.shareAccount(userId, m.id, input.outcomeId);
        if (input.side === "BUY") {
          this.transfer(
            "cash:" + w.id,
            "issuer:external-cash",
            f.cash,
            "cash",
            "EXTERNAL_SIM_BUY",
            m.id,
          );
          this.transfer(
            "issuer:" + asset,
            share,
            BigInt(f.quantity),
            asset,
            "EXTERNAL_SIM_BUY",
            m.id,
          );
        } else {
          this.transfer(
            share,
            "issuer:" + asset,
            BigInt(f.quantity),
            asset,
            "EXTERNAL_SIM_SELL",
            m.id,
          );
          this.transfer(
            "issuer:external-cash",
            "cash:" + w.id,
            f.cash,
            "cash",
            "EXTERNAL_SIM_SELL",
            m.id,
          );
        }
        this.updateBasis(
          userId,
          m,
          input.outcomeId,
          input.side,
          f.quantity,
          f.cash,
          old,
        );
        const { userId: _, ...fill } = this.fillRecord(
          o,
          f.quantity,
          f.cash,
          "EXTERNAL",
        );
        fills.push(fill);
      }
      o.status =
        o.filledQuantity === o.quantity
          ? "FILLED"
          : o.filledQuantity
            ? "PARTIAL"
            : "CANCELLED";
      m.sequence++;
      const receipt = {
        order: this.publicOrder(o),
        fills,
        spent: money(spent),
        received: money(received),
        wallet: this.walletView(w),
        sequence: m.sequence,
      };
      this.state.idempotency[idemKey] = { hash: digest, result: receipt };
      return receipt;
    });
  }
}
