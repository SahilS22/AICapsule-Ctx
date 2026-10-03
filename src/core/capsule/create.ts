import { CAPSULE_VERSION, type ArchiveMessage, type CapsuleFile, type PlatformId } from './schema';
import { estimateMessagesTokens, estimateTokens } from '../tokenization/estimate';
import { extractMemories } from '../extraction/memories';
import { resolveConflicts } from '../memory/conflicts';
import {
  buildCoreContext,
  deriveArtifacts,
  deriveCurrentTask,
  deriveKeyEvents,
  deriveObjective,
  deriveSummary
} from '../compression/core';
import { nowIso, truncate, uid } from '../../shared/helpers';

export interface ConversationExtraction {
  platform: PlatformId;
  url: string;
  title: string;
  messages: ArchiveMessage[];
}

export interface CreateOptions {
  projectName?: string;
  compression?: CapsuleFile['metadata']['compression'];
}

export function createCapsule(extraction: ConversationExtraction, options: CreateOptions = {}): CapsuleFile {
  const { messages } = extraction;
  const memories = resolveConflicts(extractMemories(messages)).map(({ ordinal: _o, ...m }) => m);

  const objective = deriveObjective(memories, messages);
  const currentTask = deriveCurrentTask(messages);
  const core = buildCoreContext(memories, messages, objective, currentTask);

  const originalTokens = estimateMessagesTokens(messages.map((m) => m.text));
  const coreTokens = estimateTokens(JSON.stringify(core));
  const memoryTokens = estimateTokens(JSON.stringify(memories));

  const projectName =
    options.projectName?.trim() || truncate(extraction.title.replace(/\s+/g, ' '), 60) || 'Untitled capsule';
  const now = nowIso();

  return {
    capsule_version: CAPSULE_VERSION,
    id: uid('cap'),
    created_at: now,
    updated_at: now,
    source_platform: extraction.platform,
    project: {
      name: projectName,
      objective,
      description: core.currentState.summary
    },
    core_context: core,
    conversation: {
      meta: {
        url: extraction.url,
        title: extraction.title,
        messageCount: messages.length,
        estimatedTokens: originalTokens,
        extractedAt: now
      },
      summary: deriveSummary(messages),
      keyEvents: deriveKeyEvents(messages)
    },
    memories,
    artifacts: deriveArtifacts(messages),
    archive: { messages },
    history: [],
    current_version: 1,
    metadata: {
      compression: options.compression ?? 'balanced',
      originalTokensEstimated: originalTokens,
      coreTokensEstimated: coreTokens,
      memoryTokensEstimated: memoryTokens
    }
  };
}
