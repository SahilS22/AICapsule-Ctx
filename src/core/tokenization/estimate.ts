/**
 * Token estimation.
 *
 * We deliberately do NOT ship a full BPE tokenizer (a cl100k vocab is ~1–2 MB and
 * platform tokenizers differ). Instead we use the well-known ~4 chars/token heuristic
 * with small adjustments for code and CJK text, and we ALWAYS label results as
 * estimates in the UI. Never present these as exact counts.
 */

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const nonCjk = text.length - cjkCount;
  // CJK chars are roughly 1 token each; latin text ~4 chars/token; code skews denser.
  const codeBoost = /```/.test(text) ? 0.3 : 0;
  return Math.ceil(cjkCount + (nonCjk / 4) * (1 - codeBoost));
}

export function estimateMessagesTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + estimateTokens(t) + 4, 0); // +4 ≈ per-message framing overhead
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
