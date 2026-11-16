import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type LogicalRange,
  type Time,
} from "lightweight-charts";
import type { Candle, Market, Outcome } from "../shared/types";
import { useResource } from "./api";
import { Loading } from "./ui";

export function MarketChart({
  market,
  outcome,
  theme,
}: {
  market: Market;
  outcome?: Outcome;
  theme: string;
}) {
  const [interval, setInterval] = useState("1d");
  const [series, setSeries] = useState<"amm" | "trades">("amm");
  const container = useRef<HTMLDivElement>(null);
  const range = useRef<LogicalRange | null>(null);
  const sourceRef = useRef("");
  const source = `${market.id}/${outcome?.id}/${interval}/${series}`;
  const history = useResource<Candle[]>(
    outcome
      ? `/markets/${encodeURIComponent(market.id)}/history?interval=${interval}&outcomeId=${encodeURIComponent(outcome.id)}${market.exchange === "FRIENDS" ? `&series=${series}` : ""}`
      : null,
    15000,
  );
  const observations = Array.isArray(history.data)
    ? history.data
        .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.close))
        .sort((a, b) => a.time - b.time)
        .filter((p, i, all) => i === 0 || p.time !== all[i - 1]!.time)
    : [];
  const dataKey = JSON.stringify(observations.map((p) => [p.time, p.close]));
  useEffect(() => {
    if (!container.current || !observations.length) return;
    if (sourceRef.current !== source) {
      range.current = null;
      sourceRef.current = source;
    }
    const light = theme === "light";
    const chart: IChartApi = createChart(container.current, {
      autoSize: true,
      layout: {
        background: {
          type: ColorType.Solid,
          color: light ? "#ffffff" : "#111214",
        },
        textColor: light ? "#69717c" : "#8e949e",
        fontSize: 12,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: light ? "#eef0f2" : "#222428" },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.1 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        barSpacing: 6,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: light ? "#d1d5dc" : "#454a53",
          labelBackgroundColor: light ? "#66707d" : "#343941",
        },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: {
        priceFormatter: (p: number) => `${(p * 100).toFixed(0)}%`,
      },
      handleScroll: true,
      handleScale: true,
    });
    const line = chart.addSeries(LineSeries, {
      color: light ? "#456fb2" : "#a9c7ff",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
      priceFormat: {
        type: "custom",
        minMove: 0.0001,
        formatter: (p: number) => `${(p * 100).toFixed(1)}%`,
      },
    });
    line.setData(
      observations.map((p) => ({ time: p.time as Time, value: p.close })),
    );
    if (range.current) chart.timeScale().setVisibleLogicalRange(range.current);
    else chart.timeScale().fitContent();
    return () => {
      range.current = chart.timeScale().getVisibleLogicalRange();
      chart.remove();
    };
  }, [dataKey, source, theme]);
  return (
    <section className="probability-chart" aria-label="Probability history">
      <div className="history-toolbar">
        <span>
          {market.exchange === "FRIENDS" && series === "trades"
            ? "Trade prices"
            : "Probability over time"}
        </span>
        <div className="history-timeframes" aria-label="History period">
          {[
            ["1h", "1H"],
            ["1d", "1D"],
            ["1w", "1W"],
            ["max", "All"],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={interval === value}
              className={interval === value ? "active" : ""}
              onClick={() => setInterval(value!)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {observations.length > 0 ? (
        <div className="probability-canvas" ref={container} />
      ) : (
        <div className="history-empty">
          {history.loading ? (
            <Loading>Loading history…</Loading>
          ) : (
            history.error ||
            "No recorded history yet. New observations will appear here."
          )}
        </div>
      )}
      <div className="history-caption">
        <span>
          {market.exchange === "FRIENDS"
            ? "Recorded group market activity"
            : "Historical prices from the source market"}{" "}
          · UTC
        </span>
        {market.exchange === "FRIENDS" && (
          <div>
            <button
              className={series === "amm" ? "active" : ""}
              onClick={() => setSeries("amm")}
            >
              Market probability
            </button>
            <button
              className={series === "trades" ? "active" : ""}
              onClick={() => setSeries("trades")}
            >
              Trade prices
            </button>
          </div>
        )}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
      </div>
    </section>
  );
}
