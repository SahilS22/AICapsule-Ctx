import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/core/extraction/messages';
import { createCapsule, type ConversationExtraction } from '../src/core/capsule/create';
import { updateCapsule } from '../src/core/capsule/update';

function extraction(platform: 'chatgpt' | 'claude', texts: [string, 'user' | 'assistant'][]): ConversationExtraction {
  return {
    platform,
    url: 'https://example/chat',
    title: 'Storage project',
    messages: normalizeMessages(texts.map(([text, role]) => ({ text, role, timestamp: null })))
  };
}

describe('incremental capsule updates', () => {
  it('merges new messages, bumps the version and snapshots history', () => {
    const v1 = createCapsule(extraction('chatgpt', [['We decided to use MongoDB for storage.', 'user']]));
    const v2result = updateCapsule(
      v1,
      extraction('claude', [
        ['We decided to use MongoDB for storage.', 'user'], // overlap — should dedupe
        ["Actually, we've decided to use PostgreSQL instead.", 'user'],
        ['The migration script must preserve existing rows.', 'user']
      ])
    );

    const v2 = v2result.capsule;
    expect(v2.current_version).toBe(2);
    expect(v2.history).toHaveLength(1);
    expect(v2.history[0].version).toBe(1);
    // dedupe: 1 shared message + 2 new = 3 total, not 4
    expect(v2.archive.messages).toHaveLength(3);
    // the old decision is superseded by the new one
    expect(v2result.diff.superseded.length).toBeGreaterThan(0);
    expect(v2.core_context.decisions.some((d) => /PostgreSQL/.test(d))).toBe(true);
    expect(v2.core_context.decisions.some((d) => /MongoDB/.test(d))).toBe(false);
    expect(v2result.diff.newMemories.length).toBeGreaterThan(0);
  });

  it('is a no-op-ish update when nothing changed', () => {
    const v1 = createCapsule(extraction('chatgpt', [['We decided to use Redis.', 'user']]));
    const result = updateCapsule(v1, extraction('chatgpt', [['We decided to use Redis.', 'user']]));
    expect(result.capsule.current_version).toBe(2);
    expect(result.diff.newMemories).toHaveLength(0);
    expect(result.capsule.archive.messages).toHaveLength(1);
  });
});
