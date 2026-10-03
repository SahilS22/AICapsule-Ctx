import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/core/extraction/messages';
import { extractMemories } from '../src/core/extraction/memories';
import { resolveConflicts, isCurrent } from '../src/core/memory/conflicts';

describe('conflict detection', () => {
  it('supersedes an earlier decision when a later one overrides it', () => {
    const messages = normalizeMessages([
      { role: 'user', text: 'We decided to use MongoDB for storage.', timestamp: null },
      { role: 'assistant', text: 'Understood, setting up MongoDB.', timestamp: null },
      { role: 'user', text: "Actually, we've decided to use PostgreSQL instead.", timestamp: null }
    ]);
    const memories = resolveConflicts(extractMemories(messages));

    const mongo = memories.find((m) => /MongoDB/.test(m.content) && m.type === 'decision');
    const postgres = memories.find((m) => /PostgreSQL/.test(m.content) && m.type === 'decision');

    expect(mongo).toBeDefined();
    expect(postgres).toBeDefined();
    expect(mongo!.supersededBy).toBe(postgres!.id);
    expect(isCurrent(postgres!)).toBe(true);
    expect(isCurrent(mongo!)).toBe(false);
  });

  it('leaves unrelated decisions untouched', () => {
    const messages = normalizeMessages([
      { role: 'user', text: 'We decided to use Redis for caching.', timestamp: null },
      { role: 'user', text: 'We decided to use Vitest for testing.', timestamp: null }
    ]);
    const memories = resolveConflicts(extractMemories(messages));
    expect(memories.every((m) => !m.supersededBy)).toBe(true);
  });
});
