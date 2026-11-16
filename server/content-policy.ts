export class ContentPolicyError extends Error {
  readonly statusCode = 422;
  readonly code = "CONTENT_POLICY";
}

// Conservative first-line screening supplements group controls and member
// reporting. It is not represented as comprehensive semantic
// moderation or a substitute for the subject's informed consent.
const sensitive = [
  /\b(?:suicid\w*|self[\s-]?harm|overdos\w*|murder\w*|rape\w*|doxx?\w*)\b/i,
  /\b(?:pregnan\w*|cancer|medical\s+condition|diagnos\w*|sex(?:ual(?:ity|\s+orientation)?)?|gay|lesbian|outing)\b/i,
  /\b(?:cheat(?:s|ing)?\s+on|intimate\s+relationship|private\s+finances|personal\s+debt|humiliat\w*|criminal\s+accusation)\b/i,
  /\b(?:kill(?:ed|ing)?|die|dies|death|abuse|assault|injur(?:y|ed|ies))\b/i,
];

export function validateMarketContent(input: {
  question: string;
  description?: string;
  rules?: { condition?: string; evidence?: string };
}): void {
  const text = [
    input.question,
    input.description,
    input.rules?.condition,
    input.rules?.evidence,
  ]
    .filter(Boolean)
    .join("\n")
    .normalize("NFKC");
  if (sensitive.some((pattern) => pattern.test(text)))
    throw new ContentPolicyError(
      "This question may target sensitive private information or a harmful outcome. Choose a non-sensitive, observable group question.",
    );
}
