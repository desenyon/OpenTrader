import type { Quote, Side } from "../shared/types";

function format(value: bigint): string {
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`;
}

export function protectionForQuote(
  quote: Pick<Quote, "estimatedCash" | "filledQuantity">,
  side: Side,
) {
  if (
    !Number.isSafeInteger(quote.filledQuantity) ||
    quote.filledQuantity < 1 ||
    !/^\d{1,15}\.\d{6}$/.test(quote.estimatedCash)
  )
    throw new Error("A positive exact quote is required");
  const cash = BigInt(quote.estimatedCash.replace(".", ""));
  const numerator = cash * (side === "BUY" ? 101n : 99n);
  const divide = (denominator: bigint) =>
    side === "BUY"
      ? (numerator + denominator - 1n) / denominator
      : numerator / denominator;
  const total = divide(100n);
  const average = divide(100n * BigInt(quote.filledQuantity));
  const price = average > 1_000_000n ? 1_000_000n : average;
  return side === "BUY"
    ? {
        maxTotalCost: format(total),
        maxAveragePrice: format(price),
        minFillQuantity: quote.filledQuantity,
      }
    : {
        minTotalProceeds: format(total),
        minAveragePrice: format(price),
        minFillQuantity: quote.filledQuantity,
      };
}
