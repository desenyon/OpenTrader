import { describe, expect, it } from 'vitest';
import { ammCost, money, probability, reserve } from '../server/math.js';

// Fixed Mulberry32 seed: repeatable states, actions, and failing path coordinates.
const SEED = 0x4f545244;
const LIQUIDITIES = [10, 100, 500, 1000] as const;
const PATHS_PER_LIQUIDITY = 25;
const ACTIONS_PER_PATH = 40;
const MICRO = 1_000_000n;
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function finiteBinaryProbabilities(q: number[], b: number, context: string) {
  const values = [probability(q, b, 0), probability(q, b, 1)];
  for (const value of values) {
    expect(Number.isFinite(value), context).toBe(true);
    expect(value, context).toBeGreaterThan(0);
    expect(value, context).toBeLessThan(1);
  }
  expect(Math.abs(values[0]! + values[1]! - 1), context).toBeLessThanOrEqual(2 * Number.EPSILON);
  return values;
}

describe('deterministic binary LMSR property scenarios', () => {
  it('keeps normalized probabilities inside the supported log-odds domain, including large absolute inventories', () => {
    const rng = random(SEED);
    for (const b of LIQUIDITIES) {
      // Include both signs of the explicit supported log-odds boundary and exact symmetry.
      const differences = [-30 * b, -15 * b, -b, 0, b, 15 * b, 30 * b];
      for (let sample = 0; sample < 64; sample++) {
        const difference = sample < differences.length ? differences[sample]! : Math.floor((rng() * 60 - 30) * b);
        const base = sample % 2 === 0 ? 1_000_000 - Math.abs(difference) : Math.floor(rng() * 100_000);
        const q = [base + Math.max(0, difference), base + Math.max(0, -difference)];
        finiteBinaryProbabilities(q, b, `seed=${SEED} b=${b} sample=${sample} q=${q}`);
      }
    }
  });

  it('preserves directional pricing, inverse trades and funded settlement across 100 seeded paths', () => {
    const rng = random(SEED);
    let buys = 0;
    let sells = 0;
    let roundTrips = 0;
    const evidence: { b: number; paths: number; actions: number; worstFinalLoss: string; reserve: string; worstIntermediateLoss: string }[] = [];
    for (const b of LIQUIDITIES) {
      const funding = reserve(b);
      let worstFinal = 0n;
      let worstIntermediate = 0n;
      for (let path = 0; path < PATHS_PER_LIQUIDITY; path++) {
        let q = [0, 0];
        let netReceipts = 0n;
        let previousProbabilities = finiteBinaryProbabilities(q, b, `b=${b} path=${path} initial`);
        for (let action = 0; action < ACTIONS_PER_PATH; action++) {
          const index = rng() < 0.5 ? 0 : 1;
          const requested = 1 + Math.floor(rng() * Math.max(1, Math.floor(b * 0.8)));
          const side = q[index]! > 0 && rng() < 0.4 ? 'SELL' : 'BUY';
          const quantity = side === 'SELL' ? Math.min(requested, q[index]!) : requested;
          const before = [...q];
          const context = `seed=${SEED} b=${b} path=${path} action=${action} q=${before} ${side} ${quantity} outcome=${index}`;
          const next = [...before];
          next[index]! += side === 'BUY' ? quantity : -quantity;
          // The explicit scenario domain stays within 28, leaving room for inverse-trade checks.
          expect(Math.abs(next[0]! - next[1]!) / b, context).toBeLessThanOrEqual(28);
          const beforeProbability = previousProbabilities[index]!;
          const cash = ammCost(before, b, index, quantity, side);
          expect(cash, context).toBeGreaterThanOrEqual(0n);
          expect(cash, context).toBeLessThanOrEqual(BigInt(quantity) * MICRO);
          previousProbabilities = finiteBinaryProbabilities(next, b, context);
          const nextProbability = previousProbabilities[index]!;
          if (side === 'BUY') {
            buys++;
            expect(nextProbability, context).toBeGreaterThan(beforeProbability);
            // Sell exactly the newly acquired owned lot from the resulting inventory.
            const undoReceipts = ammCost(next, b, index, quantity, 'SELL');
            expect(undoReceipts, context).toBeLessThanOrEqual(cash);
            expect(cash - undoReceipts, context).toBeLessThanOrEqual(1n);
            const restored = [...next];
            restored[index]! -= quantity;
            expect(probability(restored, b, index), context).toBe(beforeProbability);
            roundTrips++;
            netReceipts += cash;
          } else {
            sells++;
            expect(nextProbability, context).toBeLessThan(beforeProbability);
            // Reacquiring that same lot cannot yield a cash profit either.
            const restoreCost = ammCost(next, b, index, quantity, 'BUY');
            expect(restoreCost, context).toBeGreaterThanOrEqual(cash);
            expect(restoreCost - cash, context).toBeLessThanOrEqual(1n);
            netReceipts -= cash;
            roundTrips++;
          }
          q = next;
          for (const winner of [0, 1]) {
            const deficit = BigInt(q[winner]!) * MICRO - netReceipts;
            expect(deficit, `${context} winner=${winner}`).toBeLessThanOrEqual(funding);
            if (deficit > worstIntermediate) worstIntermediate = deficit;
          }
        }
        // Settlement alternatives: each complete path is separately settled to each binary winner.
        for (const winner of [0, 1]) {
          const payout = BigInt(q[winner]!) * MICRO;
          const sponsorLoss = payout - netReceipts;
          expect(funding + netReceipts - payout, `b=${b} path=${path} winner=${winner}`).toBeGreaterThanOrEqual(0n);
          if (sponsorLoss > worstFinal) worstFinal = sponsorLoss;
        }
      }
      evidence.push({ b, paths: PATHS_PER_LIQUIDITY, actions: PATHS_PER_LIQUIDITY * ACTIONS_PER_PATH, worstFinalLoss: money(worstFinal), reserve: money(funding), worstIntermediateLoss: money(worstIntermediate) });
    }
    expect(buys + sells).toBe(4000);
    expect(buys).toBeGreaterThan(0);
    expect(sells).toBeGreaterThan(0);
    expect(roundTrips).toBe(4000);
    console.info('LMSR_PROPERTY_EVIDENCE', JSON.stringify({ seed: SEED, paths: 100, actions: buys + sells, buys, sells, inverseChecks: roundTrips, finalSettlementAlternatives: 200, evidence }));
  }, 30_000);
});
