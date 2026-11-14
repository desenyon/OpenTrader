/** Frozen binary settlement policy, assigned when a new Friends draft is created. */
export const BINARY_VOID_POLICY =
  "Binary void settlement pays 0.5 play credits per share. Without a proposal, the market becomes void 72 hours after the observation deadline. Proposals are allowed only after trading closes and observation ends, followed by a 24-hour challenge window. Two impartial reviewers may confirm or void a disputed proposal after that window; without quorum, neutral void applies 48 hours after the challenge window ends.";
