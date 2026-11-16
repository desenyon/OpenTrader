import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store";
import { registerRoutes } from "./routes";
import { currentUser } from "./auth";
import { registerAdminRoutes } from "./admin";
import { MarketDataService } from "./providers";
import { registerModerationRoutes } from "./moderation";
import { createReconciliationGuard } from "./reconciliation";

export interface AppOptions {
  databasePath?: string;
  liveEnabled?: boolean;
  serveStatic?: boolean;
  logger?: boolean;
  store?: Store;
  providers?: MarketDataService;
}

function enabledLiveData() {
  if (process.env.LIVE_DATA_ENABLED === "false") return false;
  if (process.env.NODE_ENV !== "production") return true;
  return (
    process.env.LIVE_DATA_ENABLED === "true" &&
    process.env.DATA_USE_ACKNOWLEDGED === "true"
  );
}

export async function createApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.body.password",
            "req.body.token",
          ],
          serializers: {
            req: (request) => ({
              method: request.method,
              url: String(request.url ?? "").split("?")[0],
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    bodyLimit: 65_536,
    requestTimeout: 15_000,
    keepAliveTimeout: 10_000,
  });
  const store =
    options.store ??
    new Store({
      path:
        options.databasePath ??
        process.env.DATABASE_PATH ??
        "./data/opentrader.sqlite",
    });
  const liveEnabled = options.liveEnabled ?? enabledLiveData();
  const accounting = createReconciliationGuard(store, {
    onFailure: (state) =>
      app.log.error(
        { reason: state.reason, diagnostics: state.diagnostics },
        "Trading suspended by accounting reconciliation",
      ),
  });
  const providers =
    options.providers ?? new MarketDataService({ enabled: liveEnabled });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const user = currentUser(request, store);
      return user ? `user:${user.id}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: () =>
      Object.assign(new Error("Too many requests. Try again shortly."), {
        statusCode: 429,
        code: "RATE_LIMITED",
      }),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://ws-subscriptions-clob.polymarket.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    if (request.url.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin
    ) {
      let accepted = false;
      try {
        const origin = new URL(request.headers.origin);
        const own = new URL(`${request.protocol}://${request.headers.host}`);
        accepted =
          origin.origin === own.origin ||
          (!!process.env.PUBLIC_ORIGIN &&
            origin.origin === new URL(process.env.PUBLIC_ORIGIN).origin);
        if (process.env.NODE_ENV !== "production")
          accepted ||=
            ["http://localhost:3000", "http://127.0.0.1:3000"].includes(
              origin.origin,
            ) && ["localhost", "127.0.0.1", "[::1]"].includes(own.hostname);
      } catch {
        accepted = false;
      }
      if (!accepted)
        return reply.status(403).send({
          error: "This request did not originate from OpenTrader.",
          code: "ORIGIN_REJECTED",
        });
    }
  });

  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; code?: string; issues?: unknown },
      request,
      reply,
    ) => {
      const validation =
        error.name === "ZodError" || Array.isArray(error.issues);
      const status = validation
        ? 422
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
      if (status >= 500) request.log.error({ err: error }, "Request failed");
      return reply.status(status).send({
        error:
          status >= 500
            ? "The request could not be completed. Your committed trades remain recorded."
            : validation
              ? "Check the request fields and try again."
              : error.message,
        code: validation
          ? "VALIDATION_ERROR"
          : (error.code ??
            (status === 413 ? "BODY_TOO_LARGE" : "REQUEST_FAILED")),
      });
    },
  );

  app.get("/api/health", async () => ({
    status:
      accounting.status().tradingEnabled && !store.tradingPaused()
        ? "ok"
        : "read-only",
    version: "0.1.0",
  }));
  app.get("/api/exchange-status", async () => {
    const { tradingEnabled, checkedAt, reason } = accounting.status();
    return {
      tradingEnabled: tradingEnabled && !store.tradingPaused(),
      checkedAt,
      reason: store.tradingPaused() ? "ADMIN_PAUSED" : reason,
    };
  });
  app.get("/api/live/status", async () => providers.status());
  await registerRoutes(app, store, {
    providers,
    liveEnabled,
    canTrade: () =>
      accounting.status().tradingEnabled && !store.tradingPaused(),
  });
  await registerModerationRoutes(app, store);
  await registerAdminRoutes(app, store, accounting);

  // Due actions are also checked inline by the engine; this timer makes
  // expiry, closing and resolution progress when no browser is open.
  const maintenance = setInterval(() => {
    try {
      store.tick();
    } catch (error) {
      app.log.error({ err: error }, "Persisted market maintenance failed");
    }
  }, 5000);
  maintenance.unref();
  let synchronizing = false;
  let shuttingDown = false;
  const syncProviders = async () => {
    if (!liveEnabled || synchronizing || shuttingDown) return;
    synchronizing = true;
    try {
      const ids = store.liveMarketIds();
      for (let offset = 0; offset < ids.length && !shuttingDown; offset += 4) {
        await Promise.all(
          ids.slice(offset, offset + 4).map(async (id) => {
            try {
              const market = await providers.getMarket(id);
              if (!shuttingDown) store.syncLiveMarket(market);
            } catch (error) {
              app.log.warn(
                { marketId: id, err: error },
                "Provider settlement remains pending",
              );
            }
          }),
        );
      }
    } finally {
      synchronizing = false;
    }
  };
  const providerMaintenance = setInterval(() => void syncProviders(), 30_000);
  providerMaintenance.unref();

  // SSE carries refresh notifications only. Economic state is always fetched
  // through the authenticated snapshot API and its committed market sequence.
  const streams = new Set<() => void>();
  app.get<{ Querystring: { groupId?: string } }>(
    "/api/events",
    async (request, reply) => {
      const user = currentUser(request, store);
      if (!user)
        return reply.status(401).send({
          error: "Sign in to receive private updates.",
          code: "AUTH_REQUIRED",
        });
      const groupId = request.query.groupId;
      const authorized = () => {
        if (currentUser(request, store)?.status !== "APPROVED") return false;
        return (
          !groupId ||
          store.bootstrap(user.id).groups.some((group) => group.id === groupId)
        );
      };
      if (!authorized())
        return reply
          .status(404)
          .send({ error: "Group not found.", code: "NOT_FOUND" });
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      raw.write("retry: 3000\n\n");
      let cursor = 0;
      const pulse = () => {
        if (!authorized()) {
          cleanup();
          raw.end();
          return;
        }
        raw.write(
          `id: ${++cursor}\nevent: refresh\ndata: ${JSON.stringify({ schemaVersion: 1, serverTs: new Date().toISOString() })}\n\n`,
        );
      };
      const timer = setInterval(pulse, 3000);
      timer.unref();
      const cleanup = () => {
        clearInterval(timer);
        streams.delete(cleanup);
        if (!raw.writableEnded) raw.end();
      };
      streams.add(cleanup);
      request.raw.once("close", cleanup);
      pulse();
    },
  );

  const staticRoot = resolve(process.cwd(), "dist");
  if (
    options.serveStatic !== false &&
    existsSync(resolve(staticRoot, "index.html"))
  ) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      cacheControl: false,
      preCompressed: true,
    });
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url.startsWith("/assets/"))
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return payload;
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      !request.url.startsWith("/api/") &&
      request.method === "GET" &&
      options.serveStatic !== false &&
      existsSync(resolve(staticRoot, "index.html"))
    ) {
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply.status(404).send({ error: "Not found.", code: "NOT_FOUND" });
  });
  app.addHook("preClose", async () => {
    shuttingDown = true;
    accounting.close();
    clearInterval(maintenance);
    clearInterval(providerMaintenance);
    for (const cleanup of streams) cleanup();
  });
  app.addHook("onClose", async () => {
    if (!options.store) store.close();
  });
  return app;
}
