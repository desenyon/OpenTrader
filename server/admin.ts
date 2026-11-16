import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { Store } from "./store.js";
const reason = z.string().trim().max(2000).optional(),
  targetId = z.string().min(1).max(250);
const adjustment = z.object({
  type: z.enum(["WALLET_ADJUSTMENT", "TREASURY_ADJUSTMENT"]),
  targetId,
  amount: z.string().max(22),
  reason,
});
const actionSchema = z.union([
  z.object({
    type: z.literal("ACCOUNT_STATUS"),
    targetId,
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]),
    reason,
  }),
  adjustment,
  z.object({ type: z.literal("TRADING_PAUSE"), paused: z.boolean(), reason }),
  z.object({
    type: z.enum([
      "CANCEL_ORDER",
      "HALT_MARKET",
      "RESUME_MARKET",
      "CLOSE_MARKET",
    ]),
    targetId,
    reason,
  }),
]);
const querySchema = z.object({
  section: z
    .enum([
      "users",
      "wallets",
      "positions",
      "bets",
      "fills",
      "settlements",
      "markets",
      "treasuries",
      "audit",
    ])
    .default("users"),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().max(200).default(""),
  status: z.string().max(40).default(""),
});
export async function registerAdminRoutes(
  app: FastifyInstance,
  store: Store,
  accounting: { check: () => unknown; status: () => unknown },
) {
  app.get("/api/admin/report", async (request) => {
    const actor = store.requireAdmin(requireUser(request, store).id);
    const q = querySchema.parse(request.query);
    return store.adminReport(
      actor.id,
      q.section,
      q.offset,
      q.limit,
      q.search,
      q.status,
    );
  });
  app.get("/api/admin/reconciliation", async (request) => {
    store.requireAdmin(requireUser(request, store).id);
    return {
      ...store.reconcileSystem(),
      guard: accounting.status(),
      operatorPaused: store.tradingPaused(),
    };
  });
  app.post(
    "/api/admin/actions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = store.requireAdmin(requireUser(request, store).id);
      const key = z
        .string()
        .min(1)
        .max(200)
        .parse(request.headers["idempotency-key"]);
      const result = store.adminAction(
        actor.id,
        actionSchema.parse(request.body),
        key,
      );
      accounting.check();
      return result;
    },
  );
  app.get("/api/admin/wallets/:id/ledger", async (request) => {
    const actor = store.requireAdmin(requireUser(request, store).id);
    const walletId = z.object({ id: targetId }).parse(request.params).id;
    const offset = z
      .object({
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(request.query).offset;
    return store.adminLedger(actor.id, walletId, offset);
  });
}
