import type { ArchiveMessage, Artifact, CoreContext, MemoryItem, MemoryType } from '../capsule/schema';
import { isCurrent } from '../memory/conflicts';
import { truncate } from '../../shared/helpers';

/**
 * Build Tier-1 CORE context from extracted memories.
 * The core is deliberately small — it is the always-included layer, so only
 * current (non-superseded, non-excluded) high-value information lands here.
 */

const CORE_LIMITS: Partial<Record<MemoryType, number>> = {
  objective: 3,
  requirement: 12,
  constraint: 12,
  decision: 12,
  rejection: 8,
  issue: 8,
  preference: 8
};

const IMPORTANCE_RANK = { critical: 3, high: 2, medium: 1, low: 0 } as const;

function normWords(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/\W+/g, ' ').trim().split(/\s+/).filter((w) => w.length > 1));
}

/** Merge bullets that restate each other (word-set overlap ≥ 0.72) — keep the richer phrasing. */
export function dedupeSimilar(items: string[]): string[] {
  const out: string[] = [];
  const sets: Set<string>[] = [];
  for (const item of items) {
    const set = normWords(item);
    if (!set.size) continue;
    let dupAt = -1;
    for (let i = 0; i < sets.length; i++) {
      const prev = sets[i];
      let inter = 0;
      for (const w of set) if (prev.has(w)) inter += 1;
      const smaller = Math.min(set.size, prev.size);
      if (smaller > 3 && inter / smaller >= 0.72) {
        dupAt = i;
        break;
      }
    }
    if (dupAt === -1) {
      out.push(item);
      sets.push(set);
    } else if (set.size > sets[dupAt].size) {
      out[dupAt] = item;
      sets[dupAt] = set;
    }
  }
  return out;
}

function topOfType(memories: MemoryItem[], type: MemoryType, limit: number): string[] {
  return dedupeSimilar(
    memories
      .filter((m) => m.type === type && isCurrent(m))
      .sort(
        (a, b) =>
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
          IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
          b.confidence - a.confidence
      )
      .map((m) => m.content)
  ).slice(0, limit);
}

export function deriveObjective(memories: MemoryItem[], messages: ArchiveMessage[]): string {
  const objectives = memories.filter((m) => m.type === 'objective' && isCurrent(m));
  if (objectives.length) {
    objectives.sort((a, b) => b.confidence - a.confidence);
    return objectives[0].content;
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return firstUser ? truncate(firstUser.text.replace(/\s+/g, ' '), 200) : '';
}

export function deriveCurrentTask(messages: ArchiveMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return lastUser ? truncate(lastUser.text.replace(/\s+/g, ' '), 280) : '';
}

export function deriveKeyEvents(messages: ArchiveMessage[], max = 8): string[] {
  const events: string[] = [];
  const step = Math.max(1, Math.floor(messages.length / max));
  for (let i = 0; i < messages.length && events.length < max; i += step) {
    const m = messages[i];
    events.push(`[${m.role} #${m.index}] ${truncate(m.text.replace(/\s+/g, ' '), 120)}`);
  }
  return events;
}

export function deriveSummary(messages: ArchiveMessage[]): string {
  const count = messages.length;
  const userCount = messages.filter((m) => m.role === 'user').length;
  const codeCount = messages.filter((m) => m.hasCode).length;
  const first = messages[0] ? truncate(messages[0].text.replace(/\s+/g, ' '), 160) : '';
  const last = messages[count - 1] ? truncate(messages[count - 1].text.replace(/\s+/g, ' '), 160) : '';
  return (
    `Conversation with ${count} messages (${userCount} from the user, ${codeCount} containing code). ` +
    `It opens with: "${first}" and most recently: "${last}".`
  );
}

export function deriveArtifacts(messages: ArchiveMessage[]): Artifact[] {
  const artifacts: Artifact[] = [];
  const fenceRe = /```([\w+-]*)\n([\s\S]*?)```/g;
  for (const m of messages) {
    let match: RegExpExecArray | null;
    while ((match = fenceRe.exec(m.text)) !== null) {
      const code = match[2];
      if (code.length > 4000) continue; // large code stays in the archive only
      artifacts.push({
        id: `art_${m.index}_${artifacts.length}`,
        kind: 'code',
        name: `code-${match[1] || 'block'}-msg${m.index}`,
        content: code,
        language: match[1] || undefined,
        sourceMessageId: m.id
      });
      if (artifacts.length >= 30) return artifacts;
    }
  }
  return artifacts;
}

export function buildCoreContext(
  memories: MemoryItem[],
  messages: ArchiveMessage[],
  objective: string,
  currentTask: string
): CoreContext {
  return {
    goals: objective ? [objective] : [],
    requirements: topOfType(memories, 'requirement', CORE_LIMITS.requirement!),
    constraints: topOfType(memories, 'constraint', CORE_LIMITS.constraint!),
    decisions: topOfType(memories, 'decision', CORE_LIMITS.decision!),
    rejectedApproaches: topOfType(memories, 'rejection', CORE_LIMITS.rejection!),
    currentState: { summary: deriveSummary(messages), messageCount: messages.length },
    currentTask,
    knownIssues: topOfType(memories, 'issue', CORE_LIMITS.issue!),
    importantPreferences: topOfType(memories, 'preference', CORE_LIMITS.preference!)
  };
}
