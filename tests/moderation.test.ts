import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../server/store";
import { createApp } from "../server/app";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

describe("private reporting and moderation", () => {
  it("restricts evidence to moderators and halts trading without confiscating positions", async () => {
    const store = new Store({
      path: ":memory:",
      now: () => new Date("2030-01-01T00:00:00Z"),
    });
    const owner = store.register("owner", "correct-horse-test-only");
    const member = store.register("member", "correct-horse-test-only");
    const resolver = store.register("resolver", "correct-horse-test-only");
    const group = store.groups(owner.user.id)[0]!;
    const invitation = store.invite(owner.user.id, group.id, { uses: 2 });
    store.redeem(member.user.id, invitation.token);
    store.redeem(resolver.user.id, invitation.token);
    store.changeMember(owner.user.id, group.id, member.user.id, {
      role: "MODERATOR",
    });
    const market = store.createMarket(owner.user.id, {
      groupId: group.id,
      question: "Will our public release ship before January 3?",
      category: "Technology",
      closeAt: "2030-01-03T00:00:00Z",
      rules: {
        condition: "Official version one release published",
        source: "https://example.com/releases",
        evidence: "Release timestamp",
        observationAt: "2030-01-03T00:00:00Z",
        voidPolicy: "Neutral void",
        disputeHours: 24,
        resolverId: resolver.user.id,
        reviewerIds: [],
      },
    });
    store.approveMarket(member.user.id, market.id);
    const app = await createApp({
      store,
      serveStatic: false,
      liveEnabled: false,
    });
    cleanup.push(async () => {
      await app.close();
      store.close();
    });
    const headers = { cookie: `session=${resolver.token}` };
    const report = await app.inject({
      method: "POST",
      url: "/api/reports",
      headers,
      payload: {
        marketId: market.id,
        reason: "The question contains disputed private context",
        evidence: "Restricted evidence for moderators only",
      },
    });
    expect(report.statusCode).toBe(200);
    const denied = await app.inject({
      method: "GET",
      url: `/api/groups/${group.id}/reports`,
      headers,
    });
    expect(denied.statusCode).toBe(403);
    const ownerHeaders = { cookie: `session=${owner.token}` };
    const queue = await app.inject({
      method: "GET",
      url: `/api/groups/${group.id}/reports`,
      headers: ownerHeaders,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.body).toContain("Restricted evidence");
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/reports/${report.json().id}/review`,
      headers: ownerHeaders,
      payload: {
        decision: "HALT_MARKET",
        rationale: "Pause while the context is independently checked",
      },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(store.market(owner.user.id, market.id).status).toBe("HALTED");
    expect(store.reconcile(owner.user.id).balanced).toBe(true);
  });
});
