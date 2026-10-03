import type { CapsuleFile } from '../capsule/schema';
import { queryTokens } from './search';
import { estimateTokens } from '../tokenization/estimate';

/**
 * Deep recall (RAG over Tier 3): pick the few archive messages that best match
 * the destination conversation and include them VERBATIM, within a hard token
 * budget. Only excerpts are trimmed — a message that fits is never truncated,
 * so code fences stay byte-for-byte intact.
 */

export interface Excerpt {
  messageIndex: number;
  role: string;
  text: string;
  score: number;
  tokens: number;
}

export interface RecallOptions {
  maxChunks?: number; // default 4
  maxTokens?: number; // default 800
  /** Handoff text already produced — chunks it can't add anything to are skipped. */
  alreadyIncluded?: string;
}

const WINDOW = 520; // chars of context kept when a long message must be trimmed

function normalize(s: string): string {
  return s.toLowerCase().replace(/\W+/g, ' ').trim();
}

function scoreChunk(text: string, tokens: string[], index: number, total: number, hasCode: boolean): number {
  const lower = text.toLowerCase();
  let matched = 0;
  for (const t of tokens) if (lower.includes(t)) matched += 1;
  if (!matched) return 0;
  const recency = total > 1 ? index / (total - 1) : 1; // 0..1 — later messages matter more
  return matched + recency * 2 + (hasCode ? 1 : 0);
}

/** Best contiguous window of a long message around the strongest query hit. */
function relevantWindow(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  let bestAt = -1;
  let bestLen = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (bestAt === -1 || i < bestAt)) {
      bestAt = i;
      bestLen = t.length;
    }
  }
  if (bestAt === -1) return text.slice(0, WINDOW) + '…';
  const start = Math.max(0, bestAt - 120);
  const end = Math.min(text.length, start + WINDOW);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function recallExcerpts(capsule: CapsuleFile, query: string, opts: RecallOptions = {}): Excerpt[] {
  const maxChunks = opts.maxChunks ?? 4;
  const maxTokens = opts.maxTokens ?? 800;
  const tokens = queryTokens(query);
  if (!tokens.length || !capsule.archive.messages.length) return [];
  const total = capsule.archive.messages.length;
  const included = opts.alreadyIncluded ? normalize(opts.alreadyIncluded) : '';

  const scored = capsule.archive.messages
    .filter((m) => m.text.trim().length >= 20)
    .map((m) => ({ m, s: scoreChunk(m.text, tokens, m.index, total, m.hasCode) }))
    .filter((x) => x.s >= 3)
    .sort((a, b) => b.s - a.s);

  const out: Excerpt[] = [];
  const seenChunks = new Set<string>();
  let usedTokens = 0;
  for (const { m, s } of scored) {
    if (out.length >= maxChunks || usedTokens >= maxTokens) break;
    const fitsWhole = estimateTokens(m.text) <= Math.ceil((maxTokens - usedTokens) / Math.max(1, maxChunks - out.length)) + 60;
    const text = m.text.length <= WINDOW || fitsWhole ? m.text : relevantWindow(m.text, tokens);
    const norm = normalize(text);
    if (!norm || seenChunks.has(norm)) continue;
    // Skip if this exact content is already in the core/memories handoff.
    if (included && included.includes(norm.slice(0, 120))) continue;
    const tokens_ = estimateTokens(text);
    if (usedTokens + tokens_ > maxTokens && out.length > 0) continue;
    seenChunks.add(norm);
    usedTokens += tokens_;
    out.push({ messageIndex: m.index, role: m.role, text, score: s, tokens: tokens_ });
  }
  return out.sort((a, b) => a.messageIndex - b.messageIndex);
}

export function formatExcerpts(excerpts: Excerpt[]): string {
  if (!excerpts.length) return '';
  const lines = ['## Key excerpts (verbatim from the original conversation)', ''];
  for (const e of excerpts) {
    lines.push(`[${e.role} #${e.messageIndex}]`);
    lines.push(e.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}
