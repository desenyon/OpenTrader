import Decimal from "decimal.js";
import type { Side } from "../shared/types.js";
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const MICRO = new D(1_000_000);
export function money(value: bigint | string): string {
  const n = BigInt(value);
  return `${n < 0n ? "-" : ""}${(n < 0n ? -n : n) / 1_000_000n}.${((n < 0n ? -n : n) % 1_000_000n).toString().padStart(6, "0")}`;
}
export function units(value: string | number): bigint {
  const d = new D(value).mul(MICRO);
  if (!d.isFinite() || !d.isInteger())
    throw new Error("Cash requires at most six decimal places");
  return BigInt(d.toFixed(0));
}
export function probability(q: number[], b: number, index: number): number {
  const max = Math.max(...q);
  const es = q.map((x) => new D(x - max).div(b).exp());
  return es[index]!.div(es.reduce((a, v) => a.add(v), new D(0))).toNumber();
}
function cost(q: number[], b: number, ctor: typeof Decimal): Decimal {
  const max = Math.max(...q);
  return new ctor(max).add(
    new ctor(b).mul(
      q
        .reduce(
          (sum, v) => sum.add(new ctor(v - max).div(b).exp()),
          new ctor(0),
        )
        .ln(),
    ),
  );
}
export function ammCost(
  q: number[],
  b: number,
  index: number,
  quantity: number,
  side: Side,
): bigint {
  if (
    q.length !== 2 ||
    ![0, 1].includes(index) ||
    !["BUY", "SELL"].includes(side) ||
    !Number.isInteger(b) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10000 ||
    b < 10 ||
    b > 10000 ||
    q.some((v) => !Number.isInteger(v) || v < 0 || v > 1_000_000)
  )
    throw new Error("Outside supported LMSR domain");
  const next = [...q];
  next[index]! += side === "BUY" ? quantity : -quantity;
  if (next[index]! > 1_000_000)
    throw new Error("Outside supported LMSR domain");
  if (next[index]! < 0) throw new Error("Uncovered AMM sale");
  if (
    (Math.max(...q) - Math.min(...q)) / b > 30 ||
    (Math.max(...next) - Math.min(...next)) / b > 30
  )
    throw new Error("Outside supported LMSR log-odds domain");
  // Symmetry gives an exact rational cost when the trade crosses the other
  // outcome's inventory by equal distances; avoid numerical subtraction here.
  if (q[index]! + next[index] === 2 * q[1 - index]!)
    return BigInt(quantity) * 500_000n;
  const a = cost(q, b, D),
    c = cost(next, b, D);
  const amount = (side === "BUY" ? c.sub(a) : a.sub(c)).mul(MICRO);
  // The bounded domain and 80-digit arithmetic leave >50 guard digits at microcredit scale.
  // Compare at independent precision and fail closed near an ambiguous rounding boundary.
  const E = Decimal.clone({ precision: 60 });
  const check = (
    side === "BUY"
      ? cost(next, b, E).sub(cost(q, b, E))
      : cost(q, b, E).sub(cost(next, b, E))
  ).mul(1_000_000);
  const mode = side === "BUY" ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR;
  // All intermediate costs are <= 1,010,000 and exp arguments are [-30, 0].
  // This deliberately loose 1e-40-microcredit envelope is far wider than
  // 60/80-digit roundoff in that domain. Reject near a rounding boundary.
  const envelope = new D("1e-40");
  const lower = amount.sub(envelope).toDecimalPlaces(0, mode);
  const upper = amount.add(envelope).toDecimalPlaces(0, mode);
  if (!lower.eq(upper)) throw new Error("LMSR precision ambiguity");
  const rounded = side === "BUY" ? upper : lower;
  if (!rounded.eq(check.toDecimalPlaces(0, mode)))
    throw new Error("LMSR precision ambiguity");
  const result = BigInt(rounded.toFixed(0));
  if (side === "BUY" && result <= 0n)
    throw new Error("LMSR debit precision unsafe");
  return result;
}
export function reserve(b: number): bigint {
  return (
    BigInt(new D(b).mul(new D(2).ln()).mul(MICRO).ceil().toFixed(0)) +
    1_000_000n
  );
}
