import type { CapsuleFile, MemoryItem } from './schema';
import type { ConversationExtraction } from './create';
import { extractMemories } from '../extraction/memories';
import { resolveConflicts, isCurrent, SUPERSEDING_HINT, decisionSubjects } from '../memory/conflicts';
import { buildCoreContext, deriveCurrentTask, deriveObjective, deriveSummary } from '../compression/core';
import { estimateMessagesTokens, estimateTokens } from '../tokenization/estimate';
import { nowIso } from '../../shared/helpers';

export interface UpdateResult {
  capsule: CapsuleFile;
  diff: {
    newMemories: MemoryItem[];
    superseded: { from: MemoryItem; to: MemoryItem }[];
    version: number;
  };
}

const MAX_HISTORY = 20;
const MAX_ARCHIVE_MESSAGES = 20_000;

/**
 * Incremental capsule update (§23): merge a new conversation extraction into an
 * existing capsule instead of rebuilding from scratch.
 *  - Archive is merged by message text-fingerprint (dedupes the overlap).
 *  - New memories are extracted from new messages only and merged with
 *    conflict detection against existing ones.
 *  - The current core is snapshotted into history before being replaced.
 */
export function updateCapsule(existing: CapsuleFile, extraction: ConversationExtraction): UpdateResult {
  const seen = new Set(existing.archive.messages.map((m) => `${m.role}:${m.text.trim()}`));
  const newMessages = extraction.messages.filter((m) => !seen.has(`${m.role}:${m.text.trim()}`));

  const mergedArchive = [...existing.archive.messages, ...newMessages].slice(-MAX_ARCHIVE_MESSAGES);

  const freshlyExtracted = resolveConflicts(extractMemories(newMessages)).map(({ ordinal: _o, ...m }) => m);
  const existingKeys = new Set(
    existing.memories.map((m) => `${m.type}:${m.content.toLowerCase().replace(/\W+/g, ' ').slice(0, 80)}`)
  );
  const newMemories = freshlyExtracted.filter(
    (m) => !existingKeys.has(`${m.type}:${m.content.toLowerCase().replace(/\W+/g, ' ').slice(0, 80)}`)
  );

  // Supersede: a new decision kills an older current decision when they share a
  // subject, or when the new one carries an explicit superseding hint
  // ("…use PostgreSQL instead") against an older technology-bearing decision.
  const superseded: { from: MemoryItem; to: MemoryItem }[] = [];
  for (const fresh of newMemories.filter((m) => m.type === 'decision')) {
    const freshSubjects = decisionSubjects(fresh.content);
    const hint = SUPERSEDING_HINT.test(fresh.content);
    for (const old of existing.memories) {
      if (old.type !== 'decision' || !isCurrent(old)) continue;
      if (old.content === fresh.content) continue;
      const oldSubjects = decisionSubjects(old.content);
      const overlap = oldSubjects.some((t) => freshSubjects.includes(t));
      if (overlap || (hint && oldSubjects.length > 0)) {
        old.supersededBy = fresh.id;
        superseded.push({ from: old, to: fresh });
      }
    }
  }

  const mergedMemories = [...existing.memories, ...newMemories];

  const objective = existing.project.objective || deriveObjective(mergedMemories, mergedArchive);
  const currentTask = newMessages.length ? deriveCurrentTask(newMessages) : existing.core_context.currentTask;
  const core = buildCoreContext(mergedMemories, mergedArchive, objective, currentTask);

  const snapshot = {
    version: existing.current_version,
    createdAt: existing.updated_at,
    note: `Snapshot before update (+${newMessages.length} messages)`,
    coreContext: existing.core_context,
    memories: existing.memories
  };
  const history = [...existing.history, snapshot].slice(-MAX_HISTORY);

  const originalTokens = estimateMessagesTokens(mergedArchive.map((m) => m.text));
  const now = nowIso();

  const capsule: CapsuleFile = {
    ...existing,
    updated_at: now,
    core_context: core,
    conversation: {
      meta: {
        ...existing.conversation.meta,
        url: extraction.url || existing.conversation.meta.url,
        title: extraction.title || existing.conversation.meta.title,
        messageCount: mergedArchive.length,
        estimatedTokens: originalTokens,
        extractedAt: now
      },
      summary: deriveSummary(mergedArchive),
      keyEvents: existing.conversation.keyEvents
    },
    memories: mergedMemories,
    archive: { messages: mergedArchive },
    history,
    current_version: existing.current_version + 1,
    metadata: {
      ...existing.metadata,
      originalTokensEstimated: originalTokens,
      coreTokensEstimated: estimateTokens(JSON.stringify(core)),
      memoryTokensEstimated: estimateTokens(JSON.stringify(mergedMemories))
    }
  };

  return { capsule, diff: { newMemories, superseded, version: capsule.current_version } };
}
