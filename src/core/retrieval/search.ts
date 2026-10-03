import type { ArchiveMessage, CapsuleFile, MemoryItem } from '../capsule/schema';
import { truncate } from '../../shared/helpers';

/**
 * Local lexical search over memories (Tier 2) and the archive (Tier 3).
 * Returns the smallest useful results; nothing here ever dumps the whole archive.
 */

const STOPWORDS = new Set(
  'the a an and or but if then else for to of in on at by with from as is are was were be been it this that we i you he she they do does did not no why how what when where which who'.split(' ')
);

export interface SearchHit {
  kind: 'memory' | 'archive';
  id: string;
  title: string;
  snippet: string;
  score: number;
  messageIndex?: number;
  memoryType?: string;
}

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_+#.-]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreText(text: string, tokens: string[], phrase: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const occurrences = lower.split(t).length - 1;
    if (occurrences > 0) score += Math.min(occurrences, 3);
  }
  if (phrase.length > 6 && lower.includes(phrase)) score += 4;
  return score;
}

function snippetAround(text: string, tokens: string[], max = 220): string {
  const lower = text.toLowerCase();
  let at = 0;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      at = i;
      break;
    }
  }
  const start = Math.max(0, at - 60);
  return (start > 0 ? '…' : '') + truncate(text.slice(start, start + max).replace(/\s+/g, ' '), max);
}

export function searchCapsule(capsule: CapsuleFile, query: string, limit = 12): SearchHit[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const phrase = query.toLowerCase().trim();

  const hits: SearchHit[] = [];

  for (const m of capsule.memories) {
    const s = scoreText(m.content, tokens, phrase) * 1.5; // memories outrank raw archive
    if (s <= 0) continue;
    hits.push({
      kind: 'memory',
      id: m.id,
      title: `${m.type}${m.supersededBy ? ' (superseded)' : ''}`,
      snippet: truncate(m.content, 220),
      score: s,
      memoryType: m.type
    });
  }

  for (const msg of capsule.archive.messages) {
    const s = scoreText(msg.text, tokens, phrase);
    if (s <= 0) continue;
    hits.push({
      kind: 'archive',
      id: msg.id,
      title: `${msg.role} message #${msg.index}`,
      snippet: snippetAround(msg.text, tokens),
      score: s,
      messageIndex: msg.index
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Find the single best memory matching a question, if any. */
export function bestMemoryFor(capsule: CapsuleFile, query: string): MemoryItem | null {
  const hit = searchCapsule(capsule, query, 1).find((h) => h.kind === 'memory');
  return hit ? capsule.memories.find((m) => m.id === hit.id) ?? null : null;
}

export function archiveMessageById(capsule: CapsuleFile, id: string): ArchiveMessage | null {
  return capsule.archive.messages.find((m) => m.id === id) ?? null;
}
