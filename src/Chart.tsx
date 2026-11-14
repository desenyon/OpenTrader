import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type LogicalRange,
  type Time,
} from "lightweight-charts";
import {
  Activity,
  CandlestickChart,
  Crosshair,
  Expand,
  LineChart,
  Minus,
  MoveHorizontal,
  Plus,
  RotateCcw,
  Settings2,
} from "lucide-react";
import type { Candle, Market, Outcome } from "../shared/types";
import { useResource } from "./api";
import { cents, percent } from "./utils";
import { Badge, ErrorNote, IconButton } from "./ui";

export function MarketChart({
  market,
  outcome,
  theme,
  expanded,
  onExpand,
}: {
  market?: Market;
  outcome?: Outcome;
  theme: string;
  expanded: boolean;
  onExpand: () => void;
}) {
  const [interval, setInterval] = useState("1d");
  const [kind, setKind] = useState<"candles" | "line">("candles");
  const [friendsSeries, setFriendsSeries] = useState<"amm" | "trades">("amm");
  const isAmm = market?.exchange === "FRIENDS" && friendsSeries === "amm";
  const [sma, setSma] = useState(false);
  const [crosshair, setCrosshair] = useState(true);
  const [hover, setHover] = useState<Candle | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const viewRange = useRef<LogicalRange | null>(null);
  const viewKey = useRef("");
  const history = useResource<Candle[]>(
    market && outcome
      ? `/markets/${encodeURIComponent(market.id)}/history?interval=${interval}&outcomeId=${encodeURIComponent(outcome.id)}${market.exchange === "FRIENDS" ? `&series=${friendsSeries}` : ""}`
      : null,
    15000,
  );
  const data = Array.isArray(history.data)
    ? history.data
        .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
        .sort((a, b) => a.time - b.time)
        .filter((c, i, a) => i === 0 || c.time !== a[i - 1]!.time)
    : [];
  const dataKey = JSON.stringify(data);
  const pointHistory =
    data.length > 0 &&
    data.every((c) => c.high === c.low && c.open === c.close);
  const renderKind =
    isAmm || (kind === "candles" && pointHistory) ? "line" : kind;
  const sourceKey = `${market?.id}-${outcome?.id}-${interval}-${friendsSeries}`;
  useEffect(() => {
    if (!container.current) return;
    const light = theme === "light";
    if (viewKey.current !== sourceKey) {
      viewKey.current = sourceKey;
      viewRange.current = null;
    }
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: {
          type: ColorType.Solid,
          color: light ? "#f7f8fa" : "#101214",
        },
        textColor: light ? "#717982" : "#7b828c",
        fontSize: 10,
        fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: light ? "#e8ebee" : "#1b1e22" },
        horzLines: { color: light ? "#e8ebee" : "#1b1e22" },
      },
      rightPriceScale: {
        borderColor: light ? "#dfe3e8" : "#25282d",
        scaleMargins: { top: 0.16, bottom: 0.15 },
      },
      timeScale: {
        borderColor: light ? "#dfe3e8" : "#25282d",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 9,
      },
      crosshair: {
        mode: crosshair ? CrosshairMode.Normal : CrosshairMode.Hidden,
        vertLine: { color: "#666e78", labelBackgroundColor: "#323941" },
        horzLine: { color: "#666e78", labelBackgroundColor: "#323941" },
      },
      localization: {
        priceFormatter: (price: number) => `${(price * 100).toFixed(2)}¢`,
      },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    const series =
      renderKind === "candles"
        ? chart.addSeries(CandlestickSeries, {
            upColor: "#55b598",
            downColor: "#d77b79",
            borderUpColor: "#55b598",
            borderDownColor: "#d77b79",
            wickUpColor: "#55b598",
            wickDownColor: "#d77b79",
            priceFormat: {
              type: "custom",
              minMove: 0.0001,
              formatter: (v: number) => cents(v),
            },
          })
        : chart.addSeries(LineSeries, {
            color: "#a9c7ff",
            lineWidth: 2,
            pointMarkersVisible: data.length < 100,
            pointMarkersRadius: 2,
            priceFormat: {
              type: "custom",
              minMove: 0.0001,
              formatter: (v: number) => cents(v),
            },
            crosshairMarkerRadius: 3,
          });
    const chartData = data.map((c) => ({
      ...c,
      time: c.time as Time,
      ...(renderKind === "line" ? { value: c.close } : {}),
    }));
    series.setData(chartData as never);
    if (data.some((c) => c.volume !== undefined)) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volume
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
      volume.setData(
        data
          .filter((c) => c.volume !== undefined)
          .map((c) => ({
            time: c.time as Time,
            value: c.volume!,
            color: c.close >= c.open ? "#55b59850" : "#d77b7950",
          })),
      );
    }
    if (sma) {
      const moving = chart.addSeries(LineSeries, {
        color: "#c9ac74",
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      moving.setData(
        data.flatMap((c, i) =>
          i < 9
            ? []
            : [
                {
                  time: c.time as Time,
                  value:
                    data.slice(i - 9, i + 1).reduce((s, n) => s + n.close, 0) /
                    10,
                },
              ],
        ),
      );
    }
    chart.subscribeCrosshairMove((param) => {
      const candle = data.find((c) => c.time === param.time);
      setHover(candle || null);
    });
    if (viewRange.current)
      chart.timeScale().setVisibleLogicalRange(viewRange.current);
    else chart.timeScale().fitContent();
    return () => {
      viewRange.current = chart.timeScale().getVisibleLogicalRange();
      chartRef.current = null;
      chart.remove();
    };
  }, [dataKey, renderKind, sma, crosshair, theme, sourceKey]);
  const latest = hover || data[data.length - 1];
  const zoom = (factor: number) => {
    const scale = chartRef.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (range && scale) {
      const mid = (range.from + range.to) / 2,
        width = ((range.to - range.from) * factor) / 2;
      scale.setVisibleLogicalRange({ from: mid - width, to: mid + width });
    }
  };
  return (
    <section className="chart-section" aria-label="Market probability chart">
      <div className="chart-controls">
        <div className="control-cluster">
          <button
            className={`text-button ${renderKind === "candles" ? "active" : ""}`}
            disabled={pointHistory || isAmm}
            title={
              isAmm
                ? "AMM probability shows actual committed state observations"
                : pointHistory
                  ? "Source supplies point prices; shown as a line without invented candle ranges."
                  : "Candlestick chart"
            }
            onClick={() => setKind("candles")}
          >
            <CandlestickChart size={13} />
            <span>Candles</span>
          </button>
          <button
            className={`text-button ${renderKind === "line" ? "active" : ""}`}
            onClick={() => setKind("line")}
          >
            <LineChart size={13} />
            <span>Line</span>
          </button>
          <span className="control-separator" />
          {market?.exchange === "FRIENDS" && (
            <>
              <button
                className={`text-button ${isAmm ? "active" : ""}`}
                onClick={() => setFriendsSeries("amm")}
              >
                AMM
              </button>
              <button
                className={`text-button ${!isAmm ? "active" : ""}`}
                onClick={() => setFriendsSeries("trades")}
              >
                Trades
              </button>
              <span className="control-separator" />
            </>
          )}
          <button
            className={`text-button ${sma ? "active" : ""}`}
            onClick={() => setSma(!sma)}
          >
            <Activity size={13} />
            Indicators {sma && <i className="tiny-dot" />}
          </button>
        </div>
        <div className="control-cluster">
          <span className="chart-currency">
            {isAmm
              ? "AMM probability"
              : market?.exchange === "FRIENDS"
                ? "Executed trade price"
                : "Source price"}{" "}
            / ¢
          </span>
          <IconButton
            label={expanded ? "Exit expanded chart" : "Expand chart"}
            onClick={onExpand}
          >
            <Expand size={14} />
          </IconButton>
        </div>
      </div>
      {sma && (
        <div className="indicator-strip">
          <span className="sma-dot" /> SMA · 10 periods{" "}
          <button onClick={() => setSma(false)}>Remove</button>
        </div>
      )}
      <div className="chart-stage">
        <div className="chart-tools">
          <IconButton
            label="Toggle crosshair"
            className={crosshair ? "active" : ""}
            onClick={() => setCrosshair(!crosshair)}
          >
            <Crosshair size={16} />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => zoom(0.7)}>
            <Plus size={16} />
          </IconButton>
          <IconButton label="Zoom out" onClick={() => zoom(1.4)}>
            <Minus size={16} />
          </IconButton>
          <IconButton
            label="Fit chart to data"
            onClick={() => chartRef.current?.timeScale().fitContent()}
          >
            <MoveHorizontal size={16} />
          </IconButton>
          <IconButton
            label="Reset chart"
            onClick={() => chartRef.current?.timeScale().resetTimeScale()}
          >
            <RotateCcw size={15} />
          </IconButton>
          <span className="toolbar-spacer" />
          <IconButton
            label="Toggle simple moving average"
            className={sma ? "active" : ""}
            onClick={() => setSma(!sma)}
          >
            <Settings2 size={15} />
          </IconButton>
          <span className="chart-brand-mark">
            O<span>↗</span>
          </span>
        </div>
        <div className="chart-canvas-wrap">
          <div className="chart-caption">
            <span>
              {outcome?.label || "Outcome"} / PLAY CREDIT ·{" "}
              {interval.toUpperCase()}
            </span>
            {market && (
              <Badge tone={history.error ? "amber" : "quiet"}>
                {isAmm
                  ? "AMM INDICATIVE PROBABILITY"
                  : market.exchange === "FRIENDS"
                    ? "EXECUTED TRADE PRICES"
                    : pointHistory
                      ? "SOURCE POINT HISTORY"
                      : market.exchange === "LIVE"
                        ? "EXTERNAL HISTORY"
                        : "FRIENDS EXCHANGE"}
              </Badge>
            )}
          </div>
          <div className="ohlc">
            {latest ? (
              <>
                <span>
                  O <b>{cents(latest.open)}</b>
                </span>
                <span>
                  H <b>{cents(latest.high)}</b>
                </span>
                <span>
                  L <b>{cents(latest.low)}</b>
                </span>
                <span>
                  C{" "}
                  <b
                    className={
                      latest.close >= latest.open ? "positive" : "negative"
                    }
                  >
                    {cents(latest.close)}
                  </b>
                </span>
                <span
                  className={
                    latest.close >= latest.open ? "positive" : "negative"
                  }
                >
                  {latest.open
                    ? `${latest.close >= latest.open ? "+" : ""}${((latest.close / latest.open - 1) * 100).toFixed(2)}%`
                    : ""}
                </span>
              </>
            ) : (
              <span>
                PRICE HISTORY <span className="muted">—</span>
              </span>
            )}
          </div>
          <div className="chart-canvas" ref={container} />
          {!data.length && (
            <div className="chart-empty">
              <div className="chart-empty-symbol">
                <Activity size={24} />
              </div>
              <strong>
                {history.loading
                  ? "Connecting to market history"
                  : market
                    ? "No recorded history yet"
                    : "Select a market to begin"}
              </strong>
              <p>
                {history.error ||
                  (market?.exchange === "FRIENDS"
                    ? isAmm
                      ? "Committed market states appear here after approval."
                      : "The first trade starts this market’s execution history."
                    : "Chart candles appear when verified source data is available.")}
              </p>
              <span>
                {outcome
                  ? `${outcome.label.toUpperCase()} ${percent(outcome.probability)} IMPLIED PROBABILITY`
                  : "LIVE MARKETS · FICTIONAL CAPITAL"}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="chart-footer">
        <div className="timeframes">
          {["1h", "6h", "1d", "1w", "max"].map((value) => (
            <button
              key={value}
              className={interval === value ? "active" : ""}
              onClick={() => setInterval(value)}
            >
              {value === "max" ? "All" : value.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="chart-footer-info">
          <span>
            {latest
              ? `${new Date(latest.time * 1000).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} UTC`
              : "Waiting for source history"}
          </span>
          <span className="subtle-divider" />{" "}
          <button onClick={() => chartRef.current?.timeScale().fitContent()}>
            fit
          </button>
          <span>%</span>
          <span>auto</span>
        </div>
      </div>
      <ErrorNote
        message={
          history.error && data.length
            ? `History refresh: ${history.error}`
            : ""
        }
      />
    </section>
  );
}
