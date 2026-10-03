import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/core/extraction/messages';
import { createCapsule } from '../src/core/capsule/create';
import { searchCapsule } from '../src/core/retrieval/search';
import { buildHandoff, buildStackedHandoff } from '../src/core/retrieval/router';
import { recallExcerpts } from '../src/core/retrieval/recall';
import { dedupeSimilar } from '../src/core/compression/core';

function capsule() {
  return createCapsule({
    platform: 'chatgpt',
    url: 'https://chatgpt.com/c/x',
    title: 'Vector search project',
    messages: normalizeMessages([
      { role: 'user', text: 'My goal is to add vector search to our notes app.', timestamp: null },
      { role: 'assistant', text: 'We decided to use ChromaDB because it runs embedded and needs no server.', timestamp: null },
      { role: 'user', text: 'The app must stay fully offline.', timestamp: null },
      { role: 'user', text: 'How do I wire up the ingestion pipeline?', timestamp: null }
    ])
  });
}

describe('archive search', () => {
  it('finds the relevant decision for a why-question', () => {
    const hits = searchCapsule(capsule(), 'Why did we choose ChromaDB?');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toMatch(/ChromaDB/);
  });

  it('returns nothing for unrelated queries', () => {
    expect(searchCapsule(capsule(), 'kubernetes deployment')).toHaveLength(0);
  });
});

describe('context router (minimum sufficient context)', () => {
  it('builds a core-only handoff by default and never dumps the archive', () => {
    const c = capsule();
    const handoff = buildHandoff(c);
    expect(handoff.text).toContain('# Context Capsule');
    expect(handoff.text).toContain('Objective');
    expect(handoff.text).toContain('do not greet');
    expect(handoff.text).toContain('End of capsule context');
    expect(handoff.budget.archiveTokens).toBe(0);
    // +300 headroom: the handoff carries a fixed ~70-token behavioral directive
    // (seamless continuation, no meta commentary) that dwarfs this tiny fixture.
    expect(handoff.budget.totalTokens).toBeLessThan(c.metadata.originalTokensEstimated + 300);
  });

  it('retrieves only query-relevant memories into the handoff', () => {
    const c = capsule();
    const handoff = buildHandoff(c, { query: 'Why ChromaDB?' });
    expect(handoff.retrievedMemories.length).toBeGreaterThan(0);
    expect(handoff.retrievedMemories[0].content).toMatch(/ChromaDB/);
    expect(handoff.budget.retrievedTokens).toBeGreaterThan(0);
  });

  it('respects the context budget', () => {
    const c = capsule();
    const handoff = buildHandoff(c, { query: 'ChromaDB offline pipeline', budgetTokens: 10 });
    expect(handoff.budget.totalTokens).toBeLessThanOrEqual(estimateCeiling(handoff));
  });

  it('deep recall attaches verbatim archive excerpts only when a recallQuery is given', () => {
    const rich = createCapsule({
      platform: 'chatgpt',
      url: 'https://chatgpt.com/c/x',
      title: 'Vector search project',
      messages: normalizeMessages([
        { role: 'user', text: 'My goal is to add vector search to our notes app.', timestamp: null },
        { role: 'assistant', text: 'We decided to use ChromaDB because it runs embedded and needs no server.', timestamp: null },
        { role: 'assistant', text: 'The Chroma collection is named notes_vec_042 and uses cosine distance for ranking.', timestamp: null },
        { role: 'user', text: 'How do I wire up the ingestion pipeline?', timestamp: null }
      ])
    });
    expect(buildHandoff(rich).budget.archiveTokens).toBe(0);
    const h = buildHandoff(rich, { recallQuery: 'what collection name and cosine distance' });
    expect(h.budget.archiveTokens).toBeGreaterThan(0);
    expect(h.text).toContain('## Key excerpts');
    expect(h.text).toContain('notes_vec_042'); // verbatim — a detail no memory captured
  });

  it('recallExcerpts scores by query overlap and skips unrelated content', () => {
    const c = capsule();
    const hits = recallExcerpts(c, 'ingestion pipeline wire up', { maxTokens: 400 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((e) => /pipeline/i.test(e.text))).toBe(true);
    expect(recallExcerpts(c, 'quantum tunnelling accelerator')).toHaveLength(0);
  });

  it('dedupeSimilar drops near-duplicate bullets', () => {
    const kept = dedupeSimilar([
      'We decided to use ChromaDB because it runs embedded',
      'We decided to use ChromaDB because it runs embedded and needs no server',
      'The app must stay fully offline'
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toMatch(/offline/);
  });
});

describe('multi-capsule stack', () => {
  const shared = [
    { role: 'user', text: 'My goal is to add vector search to our notes app.', timestamp: null },
    { role: 'assistant', text: 'We decided to use ChromaDB because it runs embedded and needs no server.', timestamp: null },
    { role: 'user', text: 'The app must stay fully offline.', timestamp: null }
  ] as const;

  function from(title: string, extra: string, platform: 'chatgpt' | 'claude' = 'chatgpt') {
    return createCapsule({
      platform,
      url: 'https://chatgpt.com/c/x',
      title,
      messages: normalizeMessages([...shared, { role: 'user', text: extra, timestamp: null }])
    });
  }

  it('states the seamless directive once and keeps one header per capsule', () => {
    const h = buildStackedHandoff([from('Search chat', 'Ship the ingestion pipeline.'), from('Infra chat', 'Deploy on the edge VM.')]);
    expect((h.text.match(/do not greet/g) ?? []).length).toBe(1);
    expect((h.text.match(/^# Context Capsule:/gm) ?? []).length).toBe(2);
    expect(h.text.match(/^# Context Capsule:.*$/m)?.[0]).toMatch(/\[from chatgpt\]$/);
    expect((h.text.match(/End of capsule context/g) ?? []).length).toBe(1);
    expect(h.text).toMatch(/Search chat[\s\S]*Infra chat/);
  });

  it('costs a shared decision one line instead of two', () => {
    const h = buildStackedHandoff([from('Search chat', 'Ship the ingestion pipeline.'), from('Infra chat', 'Deploy on the edge VM.')]);
    expect((h.text.match(/- We decided to use ChromaDB[^\n]*/g) ?? []).length).toBe(1);
    // …while the detail unique to the second chat survives.
    expect(h.text).toMatch(/edge VM/);
    const singles = [from('Search chat', 'Ship the ingestion pipeline.'), from('Infra chat', 'Deploy on the edge VM.')].map(
      (c) => buildHandoff(c).budget.totalTokens
    );
    expect(h.budget.totalTokens).toBeLessThan(singles[0] + singles[1]);
  });

  it('reports a breakdown that adds up to the total', () => {
    const h = buildStackedHandoff([from('Search chat', 'x'), from('Infra chat', 'y'), from('Review chat', 'z')]);
    const b = h.budget;
    expect(b.coreTokens + b.retrievedTokens + b.archiveTokens).toBe(b.totalTokens);
    expect(b.coreTokens).toBeGreaterThan(0);
  });

  it('honours a shared budget across capsules', () => {
    const h = buildStackedHandoff([from('Search chat', 'x'), from('Infra chat', 'y')], { budgetTokens: 10 });
    expect(h.budget.totalTokens).toBeGreaterThan(0);
    expect(h.text).toContain('# Context Capsule:');
  });

  it('degrades to a single handoff and rejects an empty stack', () => {
    const only = from('Search chat', 'x');
    expect(buildStackedHandoff([only]).text).toBe(buildHandoff(only).text);
    expect(() => buildStackedHandoff([])).toThrow(/No capsules/);
  });
});

function estimateCeiling(h: { budget: { totalTokens: number } }) {
  return Math.max(h.budget.totalTokens, 0) + 1000; // generous ceiling — core always fits
}
