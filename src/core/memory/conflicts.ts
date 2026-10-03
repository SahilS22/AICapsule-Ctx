import type { MemoryItem } from '../capsule/schema';
import type { RawMemory } from '../extraction/memories';

/**
 * Conflict detection between decisions.
 *
 * If a conversation first says "use MongoDB" and later "we've decided to use
 * PostgreSQL instead", both must not survive as current decisions. A later
 * decision wins over an earlier one when:
 *   a) they share a subject (named technology/topic) AND the later one carries
 *      a superseding hint or strictly higher confidence, or
 *   b) the later decision carries an explicit superseding hint ("instead",
 *      "actually", "changed my mind", "settled on"…) and the earlier one names
 *      a candidate technology — the classic "we chose X instead" pivot.
 * Superseded decisions stay in memories/archive as project history; they just
 * drop out of the tier-1 core.
 */

const TECH_TOKEN_RE = /\b[A-Z][\w.+#-]{1,}(?:\.[\w.-]+)?\b/g;
export const SUPERSEDING_HINT =
  /\b(instead|actually|changed (our|my) mind|rather|switch(ing|ed)? (to|over)|no longer|final decision|settled on|going with)\b/i;

/** Leading discourse words that look like capitalized "subjects" but aren't. */
const SUBJECT_STOPWORDS = new Set([
  'we', 'i', 'actually', 'understood', 'so', 'then', 'the', 'final', 'let', 'lets', "let's",
  'yes', 'no', 'ok', 'okay', 'great', 'thanks', 'also', 'now', 'first', 'second', 'note',
  'update', 'decision', 'decided', 'use', 'using', 'used', 'instead', 'agreed', 'done'
]);

export function decisionSubjects(content: string): string[] {
  const tokens = content.match(TECH_TOKEN_RE) ?? [];
  return [
    ...new Set(
      tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 1 && !SUBJECT_STOPWORDS.has(t))
    )
  ];
}

export function resolveConflicts(memories: RawMemory[]): RawMemory[] {
  const decisions = memories
    .filter((m) => m.type === 'decision')
    .sort((a, b) => a.ordinal - b.ordinal || a.createdAt.localeCompare(b.createdAt));

  for (let i = 1; i < decisions.length; i++) {
    const winner = decisions[i];
    const hint = SUPERSEDING_HINT.test(winner.content);
    const winnerSubjects = decisionSubjects(winner.content);

    for (let j = 0; j < i; j++) {
      const loser = decisions[j];
      if (loser.supersededBy) continue;
      const loserSubjects = decisionSubjects(loser.content);
      const shared = winnerSubjects.some((s) => loserSubjects.includes(s));

      const override =
        (shared && (hint || winner.confidence > loser.confidence)) ||
        (hint && !shared && loserSubjects.length > 0);

      if (override) loser.supersededBy = winner.id;
    }
  }
  return memories;
}

export function isCurrent(memory: MemoryItem): boolean {
  return !memory.excluded && !memory.supersededBy;
}
