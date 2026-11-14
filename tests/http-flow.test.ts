import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import type { Market, OrderInput, OrderReceipt, Quote } from "../shared/types";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const store = new Store({
    path: ":memory:",
    now: () => new Date("2030-01-01T00:00:00Z"),
  });
  const alice = store.register("alice", "test-only-correct-horse");
  const bob = store.register("bobby", "test-only-correct-horse");
  const resolver = store.register("resolver", "test-only-correct-horse");
  const group = store.groups(alice.user.id)[0]!;
  const invite = store.invite(alice.user.id, group.id, { uses: 2 });
  store.redeem(bob.user.id, invite.token);
  store.redeem(resolver.user.id, invite.token);
  store.changeMember(alice.user.id, group.id, bob.user.id, {
    role: "MODERATOR",
  });
  const market = store.createMarket(alice.user.id, {
    groupId: group.id,
    question: "Will the published observation exceed 50?",
    category: "Science",
    closeAt: "2030-01-03T00:00:00Z",
    b: 500,
    rules: {
      condition: "The published observation must be strictly greater than 50",
      source: "https://example.com/observation",
      evidence: "Official source timestamp and value",
      observationAt: "2030-01-03T00:00:00Z",
      voidPolicy: "Neutral 0.5 per binary share",
      disputeHours: 24,
      resolverId: resolver.user.id,
      reviewerIds: [],
    },
  });
  store.approveMarket(bob.user.id, market.id);
  const app = await createApp({
    store,
    liveEnabled: false,
    serveStatic: false,
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
  });
  return {
    store,
    app,
    alice,
    bob,
    resolver,
    group,
    market,
    cookie: `session=${alice.token}`,
  };
}

describe("HTTP trading and privacy", () => {
  it("returns one committed execution for 100 simultaneous retries of the same key", async () => {
    const { app, store, alice, market, cookie } = await fixture();
    const input: OrderInput = {
      marketId: market.id,
      outcomeId: market.outcomes[0]!.id,
      side: "BUY",
      quantity: 100,
      limitPrice: "0.5900",
      timeInForce: "IOC",
      maxTotalCost: "59.0000",
      ruleVersion: 1,
    };
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.inject({
          method: "POST",
          url: "/api/orders",
          headers: { cookie, "idempotency-key": "http-same-request" },
          payload: input,
        }),
      ),
    );
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([200]));
    const receipts = responses.map((r) => r.json<OrderReceipt>());
    expect(new Set(receipts.map((r) => r.order.id)).size).toBe(1);
    expect(receipts[0]!.spent).toBe("52.495845");
    expect(store.positions(alice.user.id)[0]!.quantity).toBe(100);
    expect(store.reconcile(alice.user.id).balanced).toBe(true);
  });

  it("requires idempotency and rejects changed payloads under a committed key", async () => {
    const { app, market, cookie } = await fixture();
    const input = {
      marketId: market.id,
      outcomeId: market.outcomes[0]!.id,
      side: "BUY",
      quantity: 1,
      limitPrice: "0.59",
      timeInForce: "IOC",
      maxTotalCost: "0.59",
    };
    const missing = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { cookie },
      payload: input,
    });
    expect(missing.statusCode).toBe(422);
    const first = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { cookie, "idempotency-key": "same" },
      payload: input,
    });
    expect(first.statusCode).toBe(200);
    const altered = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { cookie, "idempotency-key": "same" },
      payload: { ...input, quantity: 2 },
    });
    expect(altered.statusCode).toBe(409);
  });

  it("protects private market details, books, history, comments and fills from guessed IDs", async () => {
    const { app, market } = await fixture();
    for (const suffix of ["", "/book", "/history", "/comments", "/fills"]) {
      const response = await app.inject(`/api/markets/${market.id}${suffix}`);
      expect([401, 403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain(market.question);
    }
  });

  it("returns a protected quote and exports only the signed-in account journal", async () => {
    const { app, store, alice, bob, market, cookie } = await fixture();
    const quoteResponse = await app.inject({
      method: "POST",
      url: `/api/markets/${market.id}/quote`,
      headers: { cookie },
      payload: {
        outcomeId: market.outcomes[0]!.id,
        side: "BUY",
        quantity: 25,
        limitPrice: "0.59",
      },
    });
    expect(quoteResponse.statusCode).toBe(200);
    const quote = quoteResponse.json<Quote>();
    expect(quote.executable).toBe(true);
    expect(quote.filledQuantity).toBe(25);
    expect(quote.estimatedCash).toMatch(/^\d+\.\d{6}$/);
    const audit = await app.inject({
      method: "GET",
      url: "/api/audit/me?format=csv",
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.headers["content-type"]).toContain("text/csv");
    expect(audit.headers["content-disposition"]).toContain("attachment");
    expect(audit.body).toContain(alice.user.id);
    expect(audit.body).not.toContain(bob.user.id);
    expect(store.reconcile(alice.user.id).balanced).toBe(true);
  });

  it("preserves group privacy immediately after membership removal", async () => {
    const { app, store, alice, bob, group, market } = await fixture();
    store.changeMember(alice.user.id, group.id, bob.user.id, {
      status: "REMOVED",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/markets/${market.id}`,
      headers: { cookie: `session=${bob.token}` },
    });
    expect([403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain(market.question);
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: `session=${bob.token}` },
    });
    expect(
      bootstrap.json().groups.some((g: { id: string }) => g.id === group.id),
    ).toBe(false);
  });

  it("does not reveal removed-group questions through unscoped account history", async () => {
    const { app, store, alice, bob, group, market } = await fixture();
    store.execute(
      bob.user.id,
      {
        marketId: market.id,
        outcomeId: market.outcomes[0]!.id,
        side: "BUY",
        quantity: 1,
        limitPrice: "0.59",
        maxTotalCost: "0.59",
        timeInForce: "IOC",
      },
      "before-removal",
    );
    store.changeMember(alice.user.id, group.id, bob.user.id, {
      status: "REMOVED",
    });
    for (const path of [
      "/api/positions",
      "/api/orders",
      "/api/notifications",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie: `session=${bob.token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(market.question);
    }
  });
});
