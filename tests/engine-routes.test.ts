import { it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { Store } from "../server/store";
import { registerRoutes } from "../server/routes";
import type { Market } from "../shared/types";

it("ingests fresh verified Live metadata for watch, comments and forecasts without requesting depth or trading", async () => {
  const store = new Store({
    path: ":memory:",
    now: () => new Date("2030-01-01T00:00:00Z"),
  });
  const user = store.register("socialuser", "correct horse battery");
  const market: Market = {
    id: "poly:1",
    exchange: "LIVE",
    provider: "polymarket",
    groupId: null,
    question: "A discovered provider question?",
    description: "",
    category: "Other",
    outcomes: [
      { id: "yes", label: "YES", probability: 0.5 },
      { id: "no", label: "NO", probability: 0.5 },
    ],
    status: "OPEN",
    volume: 0,
    liquidity: 0,
    closeAt: "2030-02-01T00:00:00Z",
    createdAt: store.now(),
    updatedAt: store.now(),
    sequence: 0,
  };
  let books = 0;
  const app = Fastify();
  await app.register(cookie);
  await registerRoutes(app, store, {
    liveEnabled: true,
    providers: {
      listMarkets: async () => [],
      getMarket: async (id) => ({ ...market, id }),
      getBook: async () => {
        books++;
        throw new Error("No book needed");
      },
      getHistory: async () => [],
    },
  });
  try {
    const headers = { cookie: `session=${user.token}` };
    for (const [id, path, payload] of [
      ["1", "watch", {}],
      ["2", "comments", { body: "A factual public observation" }],
      ["3", "forecast", { probability: 0.7 }],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/markets/poly:${id}/${path}`,
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(store.market(user.user.id, `poly:${id}`).exchange).toBe("LIVE");
    }
    for (const [id, path] of [
      ["4", "comments"],
      ["5", "forecast"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/markets/poly:${id}/${path}`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual([]);
    }
    expect(books).toBe(0);
    expect(store.orders(user.user.id)).toEqual([]);
    expect(store.positions(user.user.id)).toEqual([]);
  } finally {
    await app.close();
    store.close();
  }
});
