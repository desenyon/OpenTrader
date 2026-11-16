import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { Store, fail } from "./store.js";
import { currentUser, requireUser } from "./auth.js";
import { friendsHistory } from "./friends-history.js";
import type { Market, OrderBook, Candle } from "../shared/types.js";
interface Providers {
  listMarkets(provider?: string, search?: string): Promise<Market[]>;
  getMarket(id: string): Promise<Market>;
  getBook(
    marketId: string,
    outcomeId: string,
    options?: { fresh?: boolean },
  ): Promise<OrderBook>;
  getHistory(
    marketId: string,
    outcomeId: string,
    interval?: string,
  ): Promise<Candle[]>;
}
const credentials = z.object({
  handle: z.string().max(30),
  password: z.string().max(200),
});
const registration = credentials.extend({
  anonymousTrading: z.boolean().default(false),
});
const orderSchema = z.object({
  marketId: z.string().min(1),
  outcomeId: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().int().min(1).max(1000),
  limitPrice: z.string(),
  timeInForce: z.enum(["IOC", "GTC", "GTD"]),
  maxTotalCost: z.string().optional(),
  maxAveragePrice: z.string().optional(),
  minAveragePrice: z.string().optional(),
  minTotalProceeds: z.string().optional(),
  minFillQuantity: z.number().int().optional(),
  expiresAt: z.string().optional(),
  quoteId: z.string().optional(),
  expectedSequence: z.number().int().optional(),
  ruleVersion: z.number().int().optional(),
});
const quoteSchema = z.object({
  outcomeId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().int().min(1).max(1000),
  limitPrice: z.union([z.string(), z.number()]).optional(),
});
const query = (request: FastifyRequest) =>
  request.query as Record<string, string | undefined>;
const param = (request: FastifyRequest, key = "id") =>
  (request.params as Record<string, string>)[key]!;
const liveId = (value: string) =>
  value.startsWith("poly:") || value.startsWith("kalshi:");
export async function registerRoutes(
  app: FastifyInstance,
  store: Store,
  options: {
    providers?: Providers;
    liveEnabled?: boolean;
    canTrade?: () => boolean;
  } = {},
) {
  const uid = (r: FastifyRequest) => requireUser(r, store).id;
  const providers = () => {
    if (!options.liveEnabled || !options.providers)
      fail(
        503,
        "LIVE_DISABLED",
        "External market data is disabled on this server",
      );
    return options.providers;
  };
  const socialMarket = async (request: FastifyRequest) => {
    const userId = uid(request),
      marketId = param(request);
    if (liveId(marketId)) {
      const market = await providers().getMarket(marketId);
      if (market.id !== marketId)
        fail(
          422,
          "MARKET_MISMATCH",
          "Provider metadata does not match the requested market",
        );
      store.syncLiveMarket(market);
    }
    return { userId, marketId };
  };
  const session = (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ) =>
    reply.setCookie("session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure:
        request.protocol === "https" || process.env.COOKIE_SECURE === "true",
      path: "/",
      maxAge: 30 * 86400,
    });
  app.get("/api/bootstrap", async (request) => ({
    ...store.bootstrap(currentUser(request, store)?.id ?? null),
    settings: {
      liveEnabled: !!options.liveEnabled,
      registrationOpen: process.env.REGISTRATION_OPEN !== "false",
      version: "0.1.0",
    },
  }));
  app.post(
    "/api/auth/register",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
          keyGenerator: (request: FastifyRequest) => request.ip,
        },
      },
    },
    async (request, reply) => {
      if (process.env.REGISTRATION_OPEN === "false")
        fail(
          403,
          "REGISTRATION_CLOSED",
          "Registration is closed on this server",
        );
      const body = registration.parse(request.body),
        result = store.requestRegistration(
          body.handle,
          body.password,
          body.anonymousTrading,
        );
      session(request, reply, result.token);
      return {
        ...store.bootstrap(result.user.id),
        settings: {
          liveEnabled: !!options.liveEnabled,
          registrationOpen: process.env.REGISTRATION_OPEN !== "false",
          version: "0.1.0",
        },
      };
    },
  );
  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "15 minutes",
          keyGenerator: (request: FastifyRequest) => request.ip,
        },
      },
    },
    async (request, reply) => {
      const body = credentials.parse(request.body),
        result = store.login(body.handle, body.password);
      session(request, reply, result.token);
      return {
        ...store.bootstrap(result.user.id),
        settings: {
          liveEnabled: !!options.liveEnabled,
          registrationOpen: process.env.REGISTRATION_OPEN !== "false",
          version: "0.1.0",
        },
      };
    },
  );
  app.post("/api/auth/logout", async (request, reply) => {
    if (request.cookies.session) store.logout(request.cookies.session);
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/groups", async (request) => store.groups(uid(request)));
  app.post("/api/groups", async (request) =>
    store.createGroup(
      uid(request),
      z
        .object({ name: z.string(), description: z.string().optional() })
        .parse(request.body),
    ),
  );
  app.get("/api/groups/:id/invites", async (request) =>
    store.invites(uid(request), param(request)),
  );
  app.post("/api/groups/:id/invites", async (request) =>
    store.invite(
      uid(request),
      param(request),
      z
        .object({
          expiresHours: z.number().optional(),
          uses: z.number().optional(),
        })
        .parse(request.body ?? {}),
    ),
  );
  app.delete("/api/groups/:id/invites/:inviteId", async (request) =>
    store.revokeInvite(
      uid(request),
      param(request),
      param(request, "inviteId"),
    ),
  );
  app.post("/api/invites/redeem", async (request) =>
    store.redeem(
      uid(request),
      z.object({ token: z.string() }).parse(request.body).token,
    ),
  );
  app.get("/api/groups/:id/members", async (request) =>
    store.members(uid(request), param(request)),
  );
  app.patch("/api/groups/:id/members", async (request) => {
    const body = z
      .object({
        userId: z.string(),
        role: z.enum(["MODERATOR", "MEMBER"]).optional(),
        status: z.enum(["ACTIVE", "REMOVED"]).optional(),
      })
      .parse(request.body);
    return store.changeMember(uid(request), param(request), body.userId, body);
  });
  app.patch("/api/groups/:id/members/:userId", async (request) =>
    store.changeMember(
      uid(request),
      param(request),
      param(request, "userId"),
      z
        .object({
          role: z.enum(["MODERATOR", "MEMBER"]).optional(),
          status: z.enum(["ACTIVE", "REMOVED"]).optional(),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/markets", async (request) => {
    const q = query(request);
    if (q.exchange === "LIVE")
      return providers().listMarkets(q.provider, q.search);
    return store.markets(uid(request), q.groupId);
  });
  app.post("/api/markets", async (request) =>
    store.createMarket(
      uid(request),
      z
        .object({
          groupId: z.string(),
          question: z.string(),
          description: z.string().optional(),
          category: z.string(),
          closeAt: z.string(),
          b: z.number().optional(),
          rules: z.object({
            condition: z.string(),
            source: z.string(),
            evidence: z.string(),
            observationAt: z.string(),
            voidPolicy: z.string(),
            disputeHours: z.number(),
            resolverId: z.string(),
            reviewerIds: z.array(z.string()),
          }),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/markets/:id", async (request) =>
    liveId(param(request))
      ? providers().getMarket(param(request))
      : store.market(uid(request), param(request)),
  );
  app.post("/api/markets/:id/approve", async (request) =>
    store.approveMarket(uid(request), param(request)),
  );
  app.get("/api/markets/:id/book", async (request) => {
    const marketId = param(request),
      outcomeId = query(request).outcomeId ?? "yes";
    return liveId(marketId)
      ? providers().getBook(marketId, outcomeId)
      : store.book(uid(request), marketId, outcomeId);
  });
  app.get("/api/markets/:id/history", async (request) => {
    const marketId = param(request),
      q = query(request);
    const interval = z
      .enum(["1h", "6h", "1d", "1w", "max"])
      .parse(q.interval ?? "1d");
    return liveId(marketId)
      ? providers().getHistory(marketId, q.outcomeId ?? "yes", interval)
      : friendsHistory(
          store,
          uid(request),
          marketId,
          q.outcomeId ?? "yes",
          interval,
          (q.series ?? "amm") as "amm" | "trades",
        );
  });
  app.post("/api/markets/:id/quote", async (request) => {
    const userId = uid(request),
      marketId = param(request),
      body = quoteSchema.parse(request.body);
    if (!liveId(marketId)) return store.quote(userId, marketId, body);
    const p = providers(),
      market = await p.getMarket(marketId),
      book = await p.getBook(marketId, body.outcomeId, { fresh: true });
    return store.quoteLive(userId, market, book, body);
  });
  app.post("/api/orders", async (request) => {
    const userId = uid(request),
      input = orderSchema.parse(request.body),
      key = request.headers["idempotency-key"];
    if (typeof key !== "string")
      fail(422, "IDEMPOTENCY_REQUIRED", "Idempotency-Key header is required");
    const replay = store.replayOrder(userId, input, key);
    if (replay) return replay;
    if (options.canTrade && !options.canTrade())
      fail(
        503,
        "EXCHANGE_READ_ONLY",
        "Trading is paused for accounting review; committed history remains available",
      );
    if (!liveId(input.marketId)) return store.execute(userId, input, key);
    const p = providers(),
      market = await p.getMarket(input.marketId),
      book = await p.getBook(input.marketId, input.outcomeId, { fresh: true });
    return store.executeLive(userId, market, book, input, key);
  });
  app.get("/api/orders", async (request) => {
    const q = query(request);
    return store.orders(
      uid(request),
      q.exchange === "LIVE"
        ? "LIVE"
        : q.exchange === "FRIENDS"
          ? "FRIENDS"
          : undefined,
      q.groupId,
    );
  });
  app.delete("/api/orders/:id", async (request) =>
    store.cancel(uid(request), param(request)),
  );
  app.get("/api/wallets", async (request) => store.wallets(uid(request)));
  app.get("/api/positions", async (request) => {
    const q = query(request),
      userId = uid(request),
      exchange =
        q.exchange === "LIVE"
          ? "LIVE"
          : q.exchange === "FRIENDS"
            ? "FRIENDS"
            : undefined;
    const positions = store.positions(userId, exchange, q.groupId);
    if (options.liveEnabled && options.providers && exchange !== "FRIENDS") {
      const live = positions
        .filter((p) => p.exchange === "LIVE" && p.quantity > 0)
        .slice(0, 30);
      for (let start = 0; start < live.length; start += 5)
        await Promise.allSettled(
          live.slice(start, start + 5).map(async (position) => {
            const market = await options.providers!.getMarket(
              position.marketId,
            );
            store.syncLiveMarket(market);
            if (market.status === "OPEN") {
              try {
                const book = await options.providers!.getBook(
                  market.id,
                  position.outcomeId,
                );
                store.syncLiveMarket(market, book);
              } catch {
                /* Keep last timestamped mark, explicitly unavailable when stale. */
              }
            }
          }),
        );
    }
    return store.positions(userId, exchange, q.groupId);
  });
  app.get("/api/markets/:id/events", async (request) =>
    store.events(
      uid(request),
      param(request),
      Number(query(request).after ?? -1),
    ),
  );
  app.get("/api/markets/:id/fills", async (request) => {
    if (liveId(param(request))) {
      uid(request);
      try {
        return store.fills(uid(request), param(request));
      } catch (error) {
        if ((error as { code: string }).code === "MARKET_NOT_FOUND") return [];
        throw error;
      }
    }
    return store.fills(uid(request), param(request));
  });
  app.get("/api/markets/:id/comments", async (request) => {
    const { userId, marketId } = await socialMarket(request);
    return store.comments(userId, marketId);
  });
  app.post("/api/markets/:id/comments", async (request) => {
    const body = z.object({ body: z.string() }).parse(request.body),
      { userId, marketId } = await socialMarket(request);
    return store.comment(userId, marketId, body.body);
  });
  app.get("/api/watchlist", async (request) => store.watchlist(uid(request)));
  app.post("/api/markets/:id/watch", async (request) => {
    const { userId, marketId } = await socialMarket(request);
    return store.watch(userId, marketId);
  });
  app.get("/api/markets/:id/forecast", async (request) => {
    const { userId, marketId } = await socialMarket(request);
    return store.forecasts(userId, marketId);
  });
  app.post("/api/markets/:id/forecast", async (request) => {
    const body = z.object({ probability: z.number() }).parse(request.body),
      { userId, marketId } = await socialMarket(request);
    return store.forecast(userId, marketId, body.probability);
  });
  app.post("/api/markets/:id/resolution", async (request) =>
    store.propose(
      uid(request),
      param(request),
      z
        .object({
          outcomeId: z.string().nullable(),
          evidence: z.string(),
          rationale: z.string(),
          determinedAt: z.string().optional(),
        })
        .parse(request.body),
    ),
  );
  app.post("/api/markets/:id/disputes", async (request) =>
    store.dispute(
      uid(request),
      param(request),
      z.object({ rationale: z.string() }).parse(request.body).rationale,
    ),
  );
  app.post("/api/markets/:id/review", async (request) =>
    store.review(
      uid(request),
      param(request),
      z
        .object({
          decision: z.string(),
          outcomeId: z.string().nullable().optional(),
          rationale: z.string(),
        })
        .parse(request.body),
    ),
  );
  app.post("/api/markets/:id/close", async (request) =>
    store.closeMarket(uid(request), param(request)),
  );
  app.get("/api/markets/:id/corrections", async (request) =>
    store.corrections(uid(request), param(request)),
  );
  app.post("/api/markets/:id/corrections", async (request) =>
    store.correction(
      uid(request),
      param(request),
      z
        .object({
          outcomeId: z.string().nullable(),
          evidence: z.string(),
          rationale: z.string(),
        })
        .parse(request.body),
    ),
  );
  app.post("/api/corrections/:id/approve", async (request) =>
    store.approveCorrection(uid(request), param(request)),
  );
  app.get("/api/leaderboards", async (request) => {
    const q = query(request);
    return store.leaderboard(
      uid(request),
      q.exchange === "LIVE" ? "LIVE" : "FRIENDS",
      q.groupId,
    );
  });
  app.get("/api/notifications", async (request) =>
    store.notifications(uid(request)),
  );
  app.patch("/api/notifications", async (request) =>
    store.updateNotifications(
      uid(request),
      z
        .object({
          ids: z.array(z.string()).optional(),
          all: z.boolean().optional(),
          preferences: z
            .object({
              fills: z.boolean().optional(),
              resolution: z.boolean().optional(),
            })
            .optional(),
        })
        .parse(request.body),
    ),
  );
  app.get("/api/preferences", async (request) =>
    store.preferences(uid(request)),
  );
  app.patch("/api/preferences", async (request) => {
    const preferences = z
      .object({
        fills: z.boolean().optional(),
        resolution: z.boolean().optional(),
      })
      .parse(request.body);
    store.updateNotifications(uid(request), { preferences });
    return store.preferences(uid(request));
  });
  app.get("/api/audit/me", async (request, reply) => {
    const rows = store.audit(uid(request));
    if (query(request).format !== "csv") return rows;
    const fields = [
      "id",
      "transaction_id",
      "asset",
      "account",
      "delta",
      "reason",
      "reference",
      "created_at",
    ];
    const csv =
      fields.join(",") +
      "\n" +
      rows
        .map((row) =>
          fields
            .map(
              (field) =>
                '"' +
                String(
                  (row as unknown as Record<string, unknown>)[field] ?? "",
                ).replaceAll('"', '""') +
                '"',
            )
            .join(","),
        )
        .join("\n");
    return reply
      .type("text/csv")
      .header(
        "Content-Disposition",
        'attachment; filename="opentrader-audit.csv"',
      )
      .send(csv);
  });
  app.get("/api/reconcile", async (request) => store.reconcile(uid(request)));
}
