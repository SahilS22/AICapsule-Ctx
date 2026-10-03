import type { ArchiveMessage, Importance, MemoryItem, MemoryType } from '../capsule/schema';
import { nowIso, truncate, uid } from '../../shared/helpers';
import { splitIntoSections, splitSentences } from './sections';

/**
 * Local, rule-based memory extraction (Tier-0 engine — no network, no API keys).
 *
 * The heuristics intentionally favour precision over recall: a missed memory still
 * lives in the searchable archive, but a wrong memory pollutes the core context.
 * An LLM provider can later replace/augment this module behind the same interface.
 */

export interface RawMemory extends MemoryItem {
  /** position of the earliest source message — used for conflict resolution */
  ordinal: number;
}

interface Signal {
  re: RegExp;
  importance: Importance;
  confidence: number;
}

const SIGNALS: Record<MemoryType, Signal[]> = {
  objective: [
    { re: /\b(my goal is|our goal is|the goal is|the objective is|we('| a)re building|i('| a)m building|i want to build|we want to build|the aim is)\b/i, importance: 'critical', confidence: 0.85 }
  ],
  requirement: [
    { re: /\b(must|needs to|need to|required to|has to|should support|shall)\b/i, importance: 'high', confidence: 0.72 },
    { re: /\bthe (user|system|app|extension|api|ui) (must|needs|should)\b/i, importance: 'high', confidence: 0.78 }
  ],
  constraint: [
    { re: /\b(must not|should not|cannot|can't|do not|don't|never|avoid|without|no external|offline|local[- ]only)\b/i, importance: 'high', confidence: 0.68 },
    { re: /\b(limit(ed)? to|at most|no more than|budget of)\b/i, importance: 'medium', confidence: 0.6 }
  ],
  decision: [
    { re: /\b(we('|'ve| have| )decided|i('|'ve| have| )decided|decision:|final decision|agreed (to|on)|we('| )agreed|locked in|settled on)\b/i, importance: 'critical', confidence: 0.9 },
    { re: /\b(let's (go with|use|build|do)|we'll (use|go with|build)|we will use|going with|chose|chosen)\b/i, importance: 'high', confidence: 0.8 },
    { re: /\buse\s+[A-Z][\w.+#-]{1,}/, importance: 'medium', confidence: 0.62 } // "use SQLite", "use React"
  ],
  rejection: [
    { re: /\b(rejected|ruled out|decided against|not going with|won't use|dropped|scrapped|instead of)\b/i, importance: 'high', confidence: 0.78 },
    { re: /\b(too (slow|complex|expensive|heavy)|overkill|doesn't scale)\b/i, importance: 'medium', confidence: 0.55 }
  ],
  issue: [
    { re: /\b(bug|broken|fails?|failing|error|exception|crash|blocker|blocked|doesn't work|not working|regression)\b/i, importance: 'high', confidence: 0.6 },
    { re: /\b(todo|fixme|hack|workaround)\b/i, importance: 'medium', confidence: 0.65 }
  ],
  preference: [
    { re: /\b(i prefer|we prefer|i like|keep it|please (always|never)|from now on)\b/i, importance: 'medium', confidence: 0.6 }
  ],
  artifact: [], // artifacts are collected separately from code blocks / links
  note: []
};

const ROLE_WEIGHT: Record<ArchiveMessage['role'], number> = { user: 1, assistant: 0.85, system: 0.5 };
const MAX_PER_TYPE = 40;
const MAX_CONTENT_LEN = 200;

const FILLER_RE =
  /^(well,|ok,|okay,|alright,|sure,|so,|note:|note that,|also,|just,|basically,|simply put,|in short,|of course,|certainly,|great question[!,.]?\s+|i'?d be happy to[^.!]*[.!]\s*|happy to help[.,!]\s*)/i;

/** Strip conversational filler so memories carry only the fact itself. */
function tighten(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(FILLER_RE, '').trim();
  }
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function extractMemories(messages: ArchiveMessage[]): RawMemory[] {
  const out: RawMemory[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    const sections = splitIntoSections(msg.text);
    for (const section of sections) {
      if (section.kind === 'code') continue; // never mine code blocks for prose signals
      const units = section.kind === 'list' ? section.text.split('\n') : splitSentences(section.text);
      for (const unit of units) {
        const text = unit.replace(/^([-*•]|\d+[.)])\s+/, '').trim();
        if (text.length < 12 || text.length > 1200) continue;

        for (const [type, signals] of Object.entries(SIGNALS) as [MemoryType, Signal[]][]) {
          for (const sig of signals) {
            if (!sig.re.test(text)) continue;
            const lean = tighten(text);
            if (lean.length < 8) break;
            const key = `${type}:${lean.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 80)}`;
            if (seen.has(key)) break;
            seen.add(key);
            out.push({
              id: uid('mem'),
              type,
              content: truncate(lean, MAX_CONTENT_LEN),
              confidence: sig.confidence * ROLE_WEIGHT[msg.role],
              importance: sig.importance,
              sourceMessageIds: [msg.id],
              createdAt: nowIso(),
              supersededBy: null,
              ordinal: msg.index
            });
            break; // first matching signal per type wins
          }
        }
      }
    }
  }

  // Per-type caps: keep highest importance/confidence first.
  const rank: Record<Importance, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const byType = new Map<MemoryType, RawMemory[]>();
  for (const m of out) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }
  const capped: RawMemory[] = [];
  for (const list of byType.values()) {
    list.sort((a, b) => rank[b.importance] - rank[a.importance] || b.confidence - a.confidence || b.ordinal - a.ordinal);
    capped.push(...list.slice(0, MAX_PER_TYPE));
  }
  return capped.sort((a, b) => a.ordinal - b.ordinal);
}
