import type { Market } from "../shared/types";
export const topics = [
  "All",
  "Politics",
  "Sports",
  "Crypto",
  "Economy",
  "Technology",
  "Culture",
  "Climate",
];
export function marketTopic(
  market: Pick<Market, "category" | "question">,
): string {
  const category = market.category.toLowerCase();
  if (/politic|election/.test(category)) return "Politics";
  if (/sport/.test(category)) return "Sports";
  if (/crypto/.test(category)) return "Crypto";
  if (/econom|financ/.test(category)) return "Economy";
  if (/tech|science/.test(category)) return "Technology";
  if (/entertain|culture/.test(category)) return "Culture";
  if (/climate|weather/.test(category)) return "Climate";
  const question = market.question.toLowerCase();
  if (/bitcoin|ethereum|crypto|\bbtc\b|\bsolana\b/.test(question))
    return "Crypto";
  if (
    /president|senate|election|nomination|prime minister|mayor|republican|democrat|ceasefire|nato/.test(
      question,
    )
  )
    return "Politics";
  if (
    /\bvs\.?\b|spread:|championship|league|playoffs|super bowl/.test(question)
  )
    return "Sports";
  if (/fed |interest rate|inflation|gdp|recession/.test(question))
    return "Economy";
  if (/nvidia|\bai\b|spacex|mars|apple|openai|ceo/.test(question))
    return "Technology";
  return market.category === "Other" ? "Other" : market.category;
}
export type MarketSort = "discover" | "closing" | "newest";
export function discoverMarkets(
  markets: Market[],
  options: {
    query: string;
    topic: string;
    watched: string[];
    following: boolean;
    sort: MarketSort;
  },
): Market[] {
  const query = options.query.trim().toLowerCase();
  const result = markets.filter(
    (m) =>
      (!query ||
        `${m.question} ${m.category} ${m.provider || ""} ${m.outcomes.map((o) => o.label).join(" ")}`
          .toLowerCase()
          .includes(query)) &&
      (options.topic === "All" || marketTopic(m) === options.topic) &&
      (!options.following || options.watched.includes(m.id)),
  );
  // Keep the provider's discovery order; cross-provider volume units differ.
  if (options.sort === "closing")
    result.sort((a, b) => Date.parse(a.closeAt) - Date.parse(b.closeAt));
  if (options.sort === "newest")
    result.sort(
      (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
    );
  return result;
}
export function chance(value: number): string {
  const p = value * 100;
  if (p > 0 && p < 1) return "<1%";
  if (p > 99 && p < 100) return ">99%";
  return `${Math.round(p)}%`;
}
