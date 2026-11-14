import { describe, expect, it } from "vitest";
import { protectionForQuote } from "../src/order-protection";

describe("client order protection", () => {
  it("bounds buy average price as well as total cost and received shares", () => {
    expect(
      protectionForQuote(
        { estimatedCash: "5.000000", filledQuantity: 10 },
        "BUY",
      ),
    ).toEqual({
      maxTotalCost: "5.050000",
      maxAveragePrice: "0.505000",
      minFillQuantity: 10,
    });
  });
  it("bounds sell average price when a later book offers more shares at worse prices", () => {
    expect(
      protectionForQuote(
        { estimatedCash: "2.500000", filledQuantity: 5 },
        "SELL",
      ),
    ).toEqual({
      minTotalProceeds: "2.475000",
      minAveragePrice: "0.495000",
      minFillQuantity: 5,
    });
  });
  it("rounds spend protection outward using integers rather than browser floats", () => {
    expect(
      protectionForQuote(
        { estimatedCash: "0.000001", filledQuantity: 1 },
        "BUY",
      ).maxTotalCost,
    ).toBe("0.000002");
  });
  it("rejects a quote without a positive filled quantity", () => {
    expect(() =>
      protectionForQuote(
        { estimatedCash: "0.000000", filledQuantity: 0 },
        "BUY",
      ),
    ).toThrow();
  });
});
