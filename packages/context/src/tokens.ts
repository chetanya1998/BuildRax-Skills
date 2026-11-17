/**
 * Rough token estimate (about 4 characters per token for code and English). It is an estimate for
 * budgeting, not a measurement; real tokenizers differ by model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
