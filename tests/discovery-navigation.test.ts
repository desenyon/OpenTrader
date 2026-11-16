import { describe, expect, it } from "vitest";
import { readRoute, routeHash, routeForMarket } from "../src/navigation";
import { chance, discoverMarkets, marketTopic } from "../src/market-discovery";
import type { Market } from "../shared/types";
const market = (id: string, changes: Partial<Market> = {}): Market => ({
  id,
  exchange: "LIVE",
  provider: "polymarket",
  groupId: null,
  question: `Question ${id}`,
  description: "",
  category: "Other",
  outcomes: [
    { id: "yes", label: "Yes", probability: 0.5 },
    { id: "no", label: "No", probability: 0.5 },
  ],
  status: "OPEN",
  volume: 0,
  liquidity: 0,
  closeAt: "2027-01-01T00:00:00Z",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-15T00:00:00Z",
  sequence: 0,
  ...changes,
});
const options = {
  query: "",
  topic: "All",
  watched: [],
  following: false,
  sort: "discover" as const,
};
describe("browse-first navigation", () => {
  it("opens market discovery by default, without forcing a selected question", () => {
    expect(readRoute("")).toEqual({ exchange: "LIVE", view: "markets" });
  });
  it("round-trips provider IDs and independent private-group routes", () => {
    for (const route of [
      {
        exchange: "LIVE" as const,
        view: "market" as const,
        marketId: "polymarket:0xabc/questions",
      },
      {
        exchange: "FRIENDS" as const,
        view: "market" as const,
        marketId: "mkt_test",
        groupId: "group_one",
      },
      {
        exchange: "FRIENDS" as const,
        view: "portfolio" as const,
        groupId: "group_two",
      },
    ])
      expect(readRoute(routeHash(route))).toEqual(route);
  });
  it("handles a malformed shared URL safely", () => {
    expect(readRoute("#/live/market/%E0%A4%A")).toEqual({
      exchange: "LIVE",
      view: "markets",
    });
  });
});
it("opens a notification in its actual exchange and group, independent of the current wallet", () => {
  expect(
    routeForMarket(
      market("private", { exchange: "FRIENDS", groupId: "other-group" }),
    ),
  ).toEqual({
    exchange: "FRIENDS",
    groupId: "other-group",
    view: "market",
    marketId: "private",
  });
  expect(routeForMarket(market("live"))).toEqual({
    exchange: "LIVE",
    view: "market",
    marketId: "live",
  });
});
describe("live market discovery", () => {
  it("searches question, source, and outcome labels together", () => {
    const items = [
      market("a", {
        outcomes: [{ id: "hawks", label: "Hawks", probability: 0.6 }],
      }),
      market("b"),
    ];
    expect(
      discoverMarkets(items, { ...options, query: " HAWKS " }).map((m) => m.id),
    ).toEqual(["a"]);
  });
  it("classifies generic provider metadata using the question", () => {
    expect(
      marketTopic(market("a", { question: "Will Bitcoin reach 100,000?" })),
    ).toBe("Crypto");
    expect(
      marketTopic(market("a", { question: "Who wins the Senate election?" })),
    ).toBe("Politics");
    expect(
      marketTopic(market("a", { category: "Science and Technology" })),
    ).toBe("Technology");
  });
  it("filters saved questions without mutating provider discovery order", () => {
    const items = [
      market("a", { volume: 10 }),
      market("b", { volume: 100000 }),
    ];
    expect(discoverMarkets(items, options).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      discoverMarkets(items, {
        ...options,
        watched: ["b"],
        following: true,
      }).map((m) => m.id),
    ).toEqual(["b"]);
    expect(items.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("sorts close dates without treating incompatible source volumes as a ranking", () => {
    const items = [
      market("a"),
      market("b", { closeAt: "2026-12-01T00:00:00Z" }),
    ];
    expect(
      discoverMarkets(items, { ...options, sort: "closing" }).map((m) => m.id),
    ).toEqual(["b", "a"]);
    expect(items.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("does not round uncertain prices into certainty", () => {
    expect(chance(0.0005)).toBe("<1%");
    expect(chance(0.9995)).toBe(">99%");
    expect(chance(0.63)).toBe("63%");
    expect(chance(0)).toBe("0%");
    expect(chance(1)).toBe("100%");
  });
});
