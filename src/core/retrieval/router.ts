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

/** Told once per handoff — repeating it per capsule wastes tokens and reads oddly. */
export const SEAMLESS_DIRECTIVE =
  'You are continuing this project from an earlier AI chat \u2014 the context below is your own prior work. ' +
  'Reply to the user\u0027s next message directly and seamlessly; do not greet, summarize, acknowledge or ' +
  'ask questions about this block. If a detail is missing, ask them to search the capsule archive instead of guessing.';

export const HANDOFF_FOOTER =
  '---\nEnd of capsule context \u2014 reply to the next message without restating the above.';

function formatCore(capsule: CapsuleFile, withDirective = true): string {
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
  if (withDirective) {
    lines.push(SEAMLESS_DIRECTIVE);
    lines.push('');
  }
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

interface AssembleOpts {
  directive: boolean;
  footer: boolean;
}

function assemble(capsule: CapsuleFile, options: HandoffOptions, shape: AssembleOpts): HandoffContext {
  const budgetTokens = options.budgetTokens ?? 4000;
  const parts: string[] = [formatCore(capsule, shape.directive)];
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

  if (shape.footer) parts.push(HANDOFF_FOOTER);

  const text = parts.join('\n');
  const coreTokens = estimateTokens(formatCore(capsule, shape.directive));
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

export function buildHandoff(capsule: CapsuleFile, options: HandoffOptions = {}): HandoffContext {
  return assemble(capsule, options, { directive: true, footer: true });
}

/**
 * Several capsules as one handoff: a block per capsule, the seamless directive
 * stated once, and bullets another capsule already gave dropped — the same
 * decision sealed in two chats should cost one line, not two.
 */
export function buildStackedHandoff(capsules: CapsuleFile[], options: HandoffOptions = {}): HandoffContext {
  const list = capsules.filter(Boolean);
  if (!list.length) throw new Error('No capsules to stack');
  if (list.length === 1) return buildHandoff(list[0], options);

  const budgetTokens = options.budgetTokens ?? 4000;
  const share = Math.max(700, Math.floor(budgetTokens / list.length));
  const blocks = list.map((c) =>
    assemble(c, { ...options, budgetTokens: share }, { directive: false, footer: false })
  );

  const seen = new Set<string>();
  const parts: string[] = [];
  let core = 0;
  let ret = 0;
  let arch = 0;

  blocks.forEach((b, i) => {
    const kept = b.text
      .split('\n')
      .filter((line) => {
        const key = line.trim();
        if (!key.startsWith('- ')) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!kept) return;
    if (i === 0) {
      const nl = kept.indexOf('\n');
      const head = nl === -1 ? kept : kept.slice(0, nl);
      const rest = nl === -1 ? '' : kept.slice(nl + 1).trimStart();
      parts.push(`${head}\n\n${SEAMLESS_DIRECTIVE}\n\n${rest}`);
    } else {
      parts.push(kept);
    }
    core += b.budget.coreTokens;
    ret += b.budget.retrievedTokens;
    arch += b.budget.archiveTokens;
  });

  const text = `${parts.join('\n\n')}\n\n${HANDOFF_FOOTER}`;
  const totalTokens = estimateTokens(text);
  // Dedupe and joins shrink the merged text below the sum of its parts, so scale
  // the breakdown to match instead of reporting numbers that don't add up.
  const k = core + ret + arch > 0 ? totalTokens / (core + ret + arch) : 1;
  let coreTokens = Math.round(core * k);
  let retrievedTokens = Math.round(ret * k);
  let archiveTokens = Math.round(arch * k);
  coreTokens += totalTokens - coreTokens - retrievedTokens - archiveTokens; // absorb rounding drift
  if (coreTokens < 0) coreTokens = 0;

  return {
    text,
    retrievedMemories: blocks.flatMap((b) => b.retrievedMemories),
    budget: { coreTokens, retrievedTokens, archiveTokens, totalTokens, estimated: true }
  };
}

export function describeBudget(h: HandoffContext): string {
  return `~${formatTokens(h.budget.totalTokens)} estimated tokens (${formatTokens(h.budget.coreTokens)} core` +
    (h.budget.retrievedTokens > 0 ? ` + ${formatTokens(h.budget.retrievedTokens)} retrieved` : '') +
    (h.budget.archiveTokens > 0 ? ` + ${formatTokens(h.budget.archiveTokens)} excerpts` : '') + ')';
}
