import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens, formatTokens } from '../src/core/tokenization/estimate';

describe('token estimation', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('estimates ~4 chars per token for latin text', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
  it('counts CJK characters closer to 1 token each', () => {
    expect(estimateTokens('日本語のテキスト')).toBeGreaterThan(6);
  });
  it('adds per-message framing overhead', () => {
    expect(estimateMessagesTokens(['hello world'])).toBeGreaterThan(estimateTokens('hello world'));
  });
  it('formats large counts compactly', () => {
    expect(formatTokens(5284)).toBe('5.3k');
    expect(formatTokens(842)).toBe('842');
  });
});
