import type { Exchange, Market } from "../shared/types";

export type PageView = "markets" | "market" | "portfolio";
export interface AppRoute {
  exchange: Exchange;
  view: PageView;
  groupId?: string;
  marketId?: string;
}
export function readRoute(hash: string): AppRoute {
  try {
    const segments = hash.replace(/^#\/?/, "").split("/");
    const exchange = segments.shift() === "friends" ? "FRIENDS" : "LIVE";
    const groupId =
      exchange === "FRIENDS" &&
      segments[0] &&
      !["market", "portfolio"].includes(segments[0])
        ? decodeURIComponent(segments.shift()!)
        : undefined;
    const view =
      segments[0] === "portfolio"
        ? "portfolio"
        : segments[0] === "market" && segments[1]
          ? "market"
          : "markets";
    return {
      exchange,
      view,
      ...(groupId ? { groupId } : {}),
      ...(view === "market"
        ? { marketId: decodeURIComponent(segments[1]!) }
        : {}),
    };
  } catch {
    return { exchange: "LIVE", view: "markets" };
  }
}
export function routeHash(route: AppRoute): string {
  const prefix =
    route.exchange === "FRIENDS"
      ? `friends${route.groupId ? `/${encodeURIComponent(route.groupId)}` : ""}`
      : "live";
  return `#/${prefix}${route.view === "portfolio" ? "/portfolio" : route.view === "market" && route.marketId ? `/market/${encodeURIComponent(route.marketId)}` : ""}`;
}

export function routeForMarket(
  market: Pick<Market, "id" | "exchange" | "groupId">,
): AppRoute {
  return {
    exchange: market.exchange,
    view: "market",
    marketId: market.id,
    ...(market.groupId ? { groupId: market.groupId } : {}),
  };
}
