import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Store, fail } from "./store.js";
import { requireUser } from "./auth.js";
import { randomUUID } from "node:crypto";

interface ReportRow {
  id: string;
  group_id: string;
  market_id: string;
  comment_id: string | null;
  reporter_id: string;
  reason: string;
  evidence: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  decision: string | null;
  rationale: string | null;
}

export async function registerModerationRoutes(
  app: FastifyInstance,
  store: Store,
) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, market_id TEXT NOT NULL,
      comment_id TEXT, reporter_id TEXT NOT NULL, reason TEXT NOT NULL,
      evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL,
      reviewed_at TEXT, decision TEXT, rationale TEXT
    );
    CREATE INDEX IF NOT EXISTS reports_group_status ON reports(group_id,status,created_at);
    CREATE TABLE IF NOT EXISTS report_decisions (
      id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id),
      reviewer_id TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS report_decisions_no_update BEFORE UPDATE ON report_decisions BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS report_decisions_no_delete BEFORE DELETE ON report_decisions BEGIN SELECT RAISE(ABORT,'Decision history is immutable'); END;
    CREATE TABLE IF NOT EXISTS privacy_requests (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL
    );
  `);
  const actor = (request: FastifyRequest) => requireUser(request, store).id;
  app.get("/api/permissions", async (request) => ({
    liveCorrectionReview: store.isLiveReviewer(actor(request)),
  }));
  const moderator = (userId: string, groupId: string) => {
    const group = store.groups(userId).find((group) => group.id === groupId);
    if (!group || !["OWNER", "MODERATOR"].includes(group.role))
      fail(
        403,
        "MODERATOR_REQUIRED",
        "Only this group’s moderators can view restricted reports.",
      );
    return group;
  };

  app.post(
    "/api/reports",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request) => {
      const userId = actor(request);
      const body = z
        .object({
          marketId: z.string(),
          commentId: z.string().optional(),
          reason: z.string().trim().min(10).max(2000),
          evidence: z.string().max(5000).optional(),
        })
        .parse(request.body);
      const market = store.market(userId, body.marketId);
      if (market.exchange !== "FRIENDS" || !market.groupId)
        fail(
          422,
          "GROUP_REQUIRED",
          "Private-group reports require a Friends market.",
        );
      if (
        body.commentId &&
        store.commentById(userId, body.commentId).marketId !== market.id
      )
        fail(422, "TARGET_MISMATCH", "Comment and market do not match.");
      const id = randomUUID();
      store.db
        .prepare(
          "INSERT INTO reports(id,group_id,market_id,comment_id,reporter_id,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          market.groupId,
          market.id,
          body.commentId ?? null,
          userId,
          body.reason,
          body.evidence ?? "",
          store.now(),
        );
      return { id, status: "OPEN" };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/groups/:id/reports",
    async (request) => {
      moderator(actor(request), request.params.id);
      return store.db
        .prepare(
          "SELECT * FROM reports WHERE group_id=? ORDER BY created_at DESC LIMIT 200",
        )
        .all(request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/reports/:id/review",
    async (request) => {
      const userId = actor(request);
      const body = z
        .object({
          decision: z.enum(["DISMISS", "HALT_MARKET", "REMOVE_COMMENT"]),
          rationale: z.string().trim().min(10).max(2000),
        })
        .parse(request.body);
      return store.atomic(() => {
        const report = store.db
          .prepare("SELECT * FROM reports WHERE id=?")
          .get(request.params.id) as unknown as ReportRow | undefined;
        if (!report) fail(404, "NOT_FOUND", "Report not found.");
        moderator(userId, report.group_id);
        if (report.status !== "OPEN")
          fail(
            409,
            "ALREADY_REVIEWED",
            "This report already has a recorded decision.",
          );
        if (body.decision === "HALT_MARKET")
          store.haltMarket(userId, report.market_id, body.rationale);
        if (body.decision === "REMOVE_COMMENT") {
          if (!report.comment_id)
            fail(
              422,
              "COMMENT_REQUIRED",
              "This report does not target a comment.",
            );
          store.hideComment(userId, report.comment_id);
        }
        store.db
          .prepare(
            "UPDATE reports SET status=?,reviewed_at=?,decision=?,rationale=? WHERE id=?",
          )
          .run(
            "REVIEWED",
            store.now(),
            body.decision,
            body.rationale,
            report.id,
          );
        store.db
          .prepare("INSERT INTO report_decisions VALUES(?,?,?,?,?,?)")
          .run(
            randomUUID(),
            report.id,
            userId,
            body.decision,
            body.rationale,
            store.now(),
          );
        return { id: report.id, status: "REVIEWED", decision: body.decision };
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/markets/:id/resume",
    async (request) =>
      store.resumeMarket(
        actor(request),
        request.params.id,
        z
          .object({ rationale: z.string().trim().min(10).max(2000) })
          .parse(request.body).rationale,
      ),
  );
  app.get<{ Params: { id: string } }>(
    "/api/groups/:id/moderation-audit",
    async (request) => store.moderationAudit(actor(request), request.params.id),
  );
  app.get("/api/privacy/requests", async (request) =>
    store.db
      .prepare(
        "SELECT id,request_type,status,created_at FROM privacy_requests WHERE user_id=? ORDER BY created_at DESC",
      )
      .all(actor(request)),
  );
  app.post("/api/privacy/requests", async (request) => {
    const userId = actor(request);
    const { type } = z
      .object({ type: z.enum(["DELETE_ACCOUNT", "EXPORT_DATA"]) })
      .parse(request.body);
    const pending = store.db
      .prepare(
        "SELECT id,status FROM privacy_requests WHERE user_id=? AND request_type=? AND status=?",
      )
      .get(userId, type, "PENDING");
    if (pending) return pending;
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO privacy_requests(id,user_id,request_type,created_at) VALUES(?,?,?,?)",
      )
      .run(id, userId, type, store.now());
    return {
      id,
      status: "PENDING",
      message:
        "Request recorded for the server operator. Shared economic records must be preserved or anonymized during review; this request does not claim the data has already been deleted.",
    };
  });
}
