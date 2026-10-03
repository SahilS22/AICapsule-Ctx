import type { CapsuleFile, MemoryItem } from '../capsule/schema';
import { isCurrent } from '../memory/conflicts';
import { queryTokens } from './search';
import { recallExcerpts, formatExcerpts } from './recall';
import { estimateTokens, formatTokens } from '../tokenization/estimate';

/**
 * Context Router (§7): build the minimum sufficient context for the destination model.
 *
 * Tier 1 (core) is always included.
 * Tier 2 (relevant memories) is pulled in ONLY when the user supplies a query.
 * Tier 3 (archive) is included only as a few verbatim deep-recall excerpts,
 * when a recallQuery is supplied — token-budgeted, never the whole archive.
 */

export interface HandoffBudget {
  coreTokens: number;
  retrievedTokens: number;
  archiveTokens: number; // deep-recall excerpts, 0 when recall is off
  totalTokens: number;
  estimated: true;
}

export interface HandoffContext {
  text: string;
  budget: HandoffBudget;
  retrievedMemories: MemoryItem[];
}

export interface HandoffOptions {
  query?: string;
  /** Destination-conversation snippet — enables verbatim archive deep recall. */
  recallQuery?: string;
  budgetTokens?: number; // default 4000
}

function formatCore(capsule: CapsuleFile): string {
  const c = capsule.core_context;
  const lines: string[] = [];
  const push = (label: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`## ${label}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };

  // The [from …] tag lets the in-page card show the source chat's logo after a reload.
  lines.push(`# Context Capsule: ${capsule.project.name} [from ${capsule.source_platform}]`);
  lines.push('');
  lines.push(
    'You are continuing this project from an earlier AI chat \u2014 the context below is your own prior work. ' +
      'Reply to the user\u0027s next message directly and seamlessly; do not greet, summarize, acknowledge or ' +
      'ask questions about this block. If a detail is missing, ask them to search the capsule archive instead of guessing.'
  );
  lines.push('');
  push('Objective', c.goals);
  push('Requirements', c.requirements);
  push('Constraints', c.constraints);
  push('Decisions already made', c.decisions);
  push('Approaches already rejected', c.rejectedApproaches);
  push('Known issues', c.knownIssues);
  push('User preferences', c.importantPreferences);
  lines.push('## Current state');
  lines.push(c.currentState.summary);
  lines.push('');
  if (c.currentTask) {
    lines.push('## Current task');
    lines.push(c.currentTask);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildHandoff(capsule: CapsuleFile, options: HandoffOptions = {}): HandoffContext {
  const budgetTokens = options.budgetTokens ?? 4000;
  const parts: string[] = [formatCore(capsule)];
  const retrieved: MemoryItem[] = [];

  let used = estimateTokens(parts[0]);

  if (options.query?.trim()) {
    const tokens = queryTokens(options.query);
    const scored = capsule.memories
      .filter(isCurrent)
      .map((m) => {
        const lower = m.content.toLowerCase();
        let score = 0;
        for (const t of tokens) if (lower.includes(t)) score += 1;
        return { m, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.m.confidence - a.m.confidence);

    const selected: MemoryItem[] = [];
    for (const { m } of scored) {
      const cost = estimateTokens(m.content) + 8;
      if (used + cost > budgetTokens) break;
      selected.push(m);
      used += cost;
    }

    if (selected.length) {
      retrieved.push(...selected);
      const block = [
        `## Retrieved context relevant to: "${options.query}"`,
        ...selected.map((m) => `- [${m.type}] ${m.content}`),
        ''
      ].join('\n');
      parts.push(block);
    }
  }

  // Tier 3 deep recall: a few verbatim archive excerpts, budgeted after the core.
  let archiveTokens = 0;
  if (options.recallQuery?.trim()) {
    const room = Math.max(0, budgetTokens - used);
    const block = formatExcerpts(
      recallExcerpts(capsule, options.recallQuery, {
        maxTokens: Math.min(800, room),
        alreadyIncluded: parts.join('\n')
      })
    );
    if (block) {
      archiveTokens = estimateTokens(block);
      parts.push(block);
    }
  }

  parts.push(
    '---\nEnd of capsule context \u2014 reply to the next message without restating the above.'
  );

  const text = parts.join('\n');
  const coreTokens = estimateTokens(formatCore(capsule));
  const totalTokens = estimateTokens(text);

  return {
    text,
    retrievedMemories: retrieved,
    budget: {
      coreTokens,
      retrievedTokens: totalTokens - coreTokens - archiveTokens,
      archiveTokens,
      totalTokens,
      estimated: true
    }
  };
}

export function describeBudget(h: HandoffContext): string {
  return `~${formatTokens(h.budget.totalTokens)} estimated tokens (${formatTokens(h.budget.coreTokens)} core` +
    (h.budget.retrievedTokens > 0 ? ` + ${formatTokens(h.budget.retrievedTokens)} retrieved` : '') +
    (h.budget.archiveTokens > 0 ? ` + ${formatTokens(h.budget.archiveTokens)} excerpts` : '') + ')';
}
