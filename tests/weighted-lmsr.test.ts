import { expect, it } from "vitest";
import Decimal from "decimal.js";
import { ammCost, probability, reserve } from "../server/math";
const D = Decimal.clone({ precision: 100 });
it("seeds the external prior and integrates the full trade cost", () => {
  const prior: [number, number] = [630000, 370000];
  expect(probability([0, 0], 500, 0, prior)).toBeCloseTo(0.63, 14);
  const expected = new D(500)
    .mul(new D(".63").mul(new D(".2").exp()).add(".37").ln())
    .mul(1e6)
    .ceil();
  expect(ammCost([0, 0], 500, 0, 100, "BUY", prior)).toBe(
    BigInt(expected.toFixed(0)),
  );
  expect(probability([100, 0], 500, 0, prior)).toBeGreaterThan(0.63);
  expect(reserve(500, [10000, 990000])).toBeGreaterThanOrEqual(
    BigInt(new D(500).mul(new D(100).ln()).mul(1e6).ceil().toFixed(0)),
  );
});
it("preserves uniform Friends costs and prevents profitable rounding round trips", () => {
  for (const prior of [
    [10000, 990000],
    [200000, 800000],
    [500000, 500000],
    [990000, 10000],
  ] as [number, number][]) {
    for (let n = 1; n <= 20; n++) {
      const debit = ammCost([0, 0], 500, 0, n, "BUY", prior),
        payout = ammCost([n, 0], 500, 0, n, "SELL", prior);
      expect(debit).toBeGreaterThanOrEqual(payout);
      expect(
        probability([n, 0], 500, 0, prior) + probability([n, 0], 500, 1, prior),
      ).toBeCloseTo(1, 14);
    }
  }
  expect(ammCost([0, 0], 500, 0, 100, "BUY", [500000, 500000])).toBe(
    ammCost([0, 0], 500, 0, 100, "BUY"),
  );
});
it("covers winning-share exposure throughout nonuniform issuance and redemption paths", () => {
  let seed = 7129;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (const prior of [
    [10000, 990000],
    [160000, 840000],
    [630000, 370000],
    [990000, 10000],
  ] as [number, number][]) {
    const q = [0, 0];
    let net = 0n;
    for (let step = 0; step < 70; step++) {
      const i = rand() % 2,
        n = (rand() % 15) + 1,
        sell = rand() % 3 === 0 && q[i]! >= n;
      const cash = ammCost(q, 500, i, n, sell ? "SELL" : "BUY", prior);
      q[i]! += sell ? -n : n;
      net += sell ? -cash : cash;
      expect(reserve(500, prior) + net).toBeGreaterThanOrEqual(
        BigInt(Math.max(...q)) * 1000000n,
      );
    }
  }
});
it("rejects invalid priors", () => {
  for (const prior of [
    [0, 1000000],
    [-1, 1000001],
    [500000, 500001],
    [NaN, 1],
  ] as [number, number][])
    expect(() => ammCost([0, 0], 500, 0, 1, "BUY", prior)).toThrow();
});
