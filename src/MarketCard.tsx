import { useState } from "react";
import { ArrowUpRight, Bookmark } from "lucide-react";
import type { Market } from "../shared/types";
import { chance, marketTopic } from "./market-discovery";
import { cents, compact } from "./utils";

export function MarketCard({
  market,
  saved,
  onOpen,
  onSave,
}: {
  market: Market;
  saved: boolean;
  onOpen: (market: Market, outcomeId?: string) => void;
  onSave: (market: Market) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const first = market.outcomes[0];
  return (
    <article className="market-card">
      <div className="card-meta">
        <span>
          {marketTopic(market)} <span className="meta-separator">/</span>{" "}
          {market.provider === "polymarket"
            ? "Polymarket"
            : market.provider === "kalshi"
              ? "Kalshi"
              : "Friends"}
        </span>
        <button
          className={`icon-button save-market ${saved ? "saved" : ""}`}
          aria-label={`${saved ? "Unsave" : "Save"} ${market.question}`}
          aria-pressed={saved}
          onClick={() => onSave(market)}
        >
          <Bookmark size={16} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="card-question-row">
        <button className="card-question" onClick={() => onOpen(market)}>
          {market.question}
        </button>
        {market.image && !imageFailed && (
          <img
            className="market-image"
            src={market.image}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
      <button className="card-probability" onClick={() => onOpen(market)}>
        <strong>{first ? chance(first.probability) : "—"}</strong>
        <span>
          {first?.label.toLowerCase() === "yes"
            ? "chance"
            : first?.label || "chance"}
        </span>
        {market.status !== "OPEN" && (
          <span className="market-state">
            {market.status.replaceAll("_", " ").toLowerCase()}
          </span>
        )}
      </button>
      <div className="card-outcomes">
        {market.outcomes.slice(0, 2).map((outcome, i) => (
          <button
            key={outcome.id}
            className={`outcome-choice ${i === 1 ? "no" : "yes"}`}
            onClick={() => onOpen(market, outcome.id)}
          >
            <span>{outcome.label}</span>
            <strong>{cents(outcome.probability)}</strong>
          </button>
        ))}
      </div>
      <footer className="card-footer">
        <span>
          {market.volume > 0
            ? `${market.provider === "polymarket" ? "$" : ""}${compact(market.volume)} ${market.exchange === "FRIENDS" ? "credits traded" : market.provider === "kalshi" ? "contracts" : "volume"}`
            : `Closes ${new Date(market.closeAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
        </span>
        <button
          onClick={() => onOpen(market)}
          aria-label={`View ${market.question}`}
        >
          <ArrowUpRight size={16} />
        </button>
      </footer>
    </article>
  );
}
