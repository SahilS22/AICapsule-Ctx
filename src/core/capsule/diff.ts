import type { CapsuleFile } from './schema';
import type { UpdateDiffEntry } from '../../types/messages';
import type { UpdateResult } from './update';

/** Human-readable change summary shown after an incremental update. */
export function summarizeUpdate(result: UpdateResult): UpdateDiffEntry {
  return {
    newMemories: result.diff.newMemories.map((m) => ({ type: m.type, content: m.content })),
    superseded: result.diff.superseded.map((s) => ({ from: s.from.content, to: s.to.content })),
    version: result.diff.version
  };
}

export function capsuleStats(capsule: CapsuleFile) {
  const counts: Record<string, number> = {};
  for (const m of capsule.memories) counts[m.type] = (counts[m.type] ?? 0) + 1;
  const original = capsule.metadata.originalTokensEstimated;
  const core = capsule.metadata.coreTokensEstimated;
  return {
    originalTokens: original,
    coreTokens: core,
    archivedTokens: original,
    reductionPct: original > 0 ? Math.round((1 - core / original) * 1000) / 10 : 0,
    memoryCount: capsule.memories.length,
    counts
  };
}
