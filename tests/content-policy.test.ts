import { describe, expect, it } from "vitest";
import { validateMarketContent } from "../server/content-policy";

describe("private market content policy", () => {
  it.each([
    "Will Alice get pregnant this year?",
    "Will someone out Ben as gay?",
    "Will Chris attempt self-harm before Friday?",
    "Will Dana receive a cancer diagnosis?",
    "Will Eve overdose at the party?",
    "Will Frank cheat on his partner?",
  ])("blocks a harmful or sensitive private outcome: %s", (question) => {
    expect(() => validateMarketContent({ question })).toThrow(
      /sensitive|harmful/i,
    );
  });
  it("checks the condition and description as well as a harmless headline", () => {
    expect(() =>
      validateMarketContent({
        question: "Will the prediction come true?",
        rules: { condition: "Alice receives a cancer diagnosis" },
      }),
    ).toThrow();
  });
  it.each([
    "Will our open-source project ship version one before December 20?",
    "Will the official weather station record rain on Saturday?",
    "Will the city council publish its budget by Friday?",
  ])("allows observable non-sensitive questions: %s", (question) => {
    expect(() => validateMarketContent({ question })).not.toThrow();
  });
});
