# Binary LMSR scenario verification

Verified by `npm test -- tests/lmsr-properties.test.ts` on 2026-11-13. Both tests passed; the isolated run took **15.82 seconds**. The scenario test explicitly allows 30 seconds because it evaluates high-precision arithmetic repeatedly. Production math and the ordinary suite timeout are unchanged.

## Reproducible sample

- Generator: Mulberry32; seed `0x4f545244` (`1330926148`).
- Liquidity parameters: `b = 10, 100, 500, 1000`.
- Paths: 25 per liquidity parameter, 100 total; 40 actions per path, 4,000 total.
- Actions: 2,590 purchases and 1,410 covered sales; whole-share quantity is between 1 and `floor(0.8b)`, bounded by owned inventory for sales.
- Every path starts with zero outstanding shares and zero net trading receipts. The generated path states remain inside absolute binary log odds 28, asserted at each action.
- Probability checks also cover 256 separately generated inventory states, including both log-odds boundaries at 30, symmetric states, and absolute inventory reaching 1,000,000.

## Assertions

Every sampled probability is finite and strictly between zero and one; binary probabilities sum to one within two machine epsilons. Purchases increase the purchased outcome's probability; covered sales decrease it. Every action has a corresponding inverse-trade check: immediately reversing the same owned lot cannot produce a cash profit, and directional rounding costs at most one microcredit per round trip. Restoring a purchased lot's inventory restores its original indicative probability.

Cash is tracked in integer microcredits. At every action and for each possible binary winner, the funded balance `reserve(b) + net trading receipts` must cover all outstanding winning shares at one credit each. The final state of every path is separately tested against each winner: **200 final settlement alternatives**, plus **8,000 intermediate solvency checks**.

| b | Actions | Largest final sponsor loss | Largest intermediate sponsor loss | Funded reserve |
| --- | ---: | ---: | ---: | ---: |
| 10 | 1,000 | 6.840913 | 6.840913 | 7.931472 |
| 100 | 1,000 | 69.226245 | 69.233043 | 70.314719 |
| 500 | 1,000 | 345.468950 | 345.468950 | 347.573591 |
| 1000 | 1,000 | 682.349261 | 683.185240 | 694.147181 |

Amounts are fictional credits. Sponsor loss means winning-share payout minus net cash collected from all sampled purchases and sales. The two possible winners are alternative settlements of the same path, not cumulative obligations.

These deterministic scenarios provide regression evidence for the sampled binary domain. They are not an exhaustive numerical proof, an independent formal arithmetic audit, or verification of database transactions, matching, access controls, provider data, or multi-outcome payout rules. No database or network access is used by this test file.
