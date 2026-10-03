import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/core/extraction/messages';
import { extractMemories } from '../src/core/extraction/memories';

function msgs(texts: [string, 'user' | 'assistant'][]) {
  return normalizeMessages(texts.map(([text, role]) => ({ text, role, timestamp: null })));
}

describe('memory extraction (local heuristics)', () => {
  it('extracts objectives, requirements, decisions and constraints', () => {
    const memories = extractMemories(
      msgs([
        ['My goal is to build a portable context tool for AI chats.', 'user'],
        ['The extension must work offline and must not send data to any server.', 'user'],
        ["We decided to use IndexedDB for local persistence.", 'assistant'],
        ["Let's use React for the popup UI.", 'user']
      ])
    );
    const types = new Set(memories.map((m) => m.type));
    expect(types.has('objective')).toBe(true);
    expect(types.has('requirement')).toBe(true);
    expect(types.has('decision')).toBe(true);
  });

  it('never mines code fences for prose signals', () => {
    const memories = extractMemories(
      msgs([['```ts\n// we decided to use MongoDB here\nconst x = 1;\n```', 'user']])
    );
    expect(memories.filter((m) => m.type === 'decision')).toHaveLength(0);
  });

  it('skips very short fragments and dedupes repeats', () => {
    const memories = extractMemories(
      msgs([
        ['ok', 'user'],
        ['We decided to use SQLite. We decided to use SQLite.', 'user']
      ])
    );
    expect(memories.filter((m) => m.content === 'ok')).toHaveLength(0);
    expect(memories.filter((m) => m.type === 'decision' && /SQLite/.test(m.content))).toHaveLength(1);
  });

  it('preserves code verbatim in the archive (never summarises raw messages)', () => {
    const code = '```py\ndef f():\n    return 42\n```';
    const [m] = msgs([[code, 'user']]);
    expect(m.hasCode).toBe(true);
    expect(m.text).toBe(code);
  });
});
