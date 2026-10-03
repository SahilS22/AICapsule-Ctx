import { describe, it, expect } from 'vitest';
import { normalizeMessages } from '../src/core/extraction/messages';
import { createCapsule, type ConversationExtraction } from '../src/core/capsule/create';
import { serializeCapsule, parseCapsuleText } from '../src/core/capsule/file';
import { validateCapsuleFile, CAPSULE_VERSION } from '../src/core/capsule/schema';

function extraction(texts: string[]): ConversationExtraction {
  return {
    platform: 'chatgpt',
    url: 'https://chatgpt.com/c/abc',
    title: 'NotebookLM Lite',
    messages: normalizeMessages(texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text, timestamp: null })))
  };
}

describe('capsule creation', () => {
  it('builds a versioned capsule with core context and archive', () => {
    const capsule = createCapsule(
      extraction([
        'My goal is to build a lightweight notebook summarizer.',
        'The app must run offline and must not use external APIs.',
        'We decided to use SQLite for local persistence.',
        'What should the data model look like?'
      ]),
      { projectName: 'NotebookLM Lite' }
    );
    expect(capsule.capsule_version).toBe(CAPSULE_VERSION);
    expect(capsule.project.name).toBe('NotebookLM Lite');
    expect(capsule.core_context.goals.length).toBeGreaterThan(0);
    expect(capsule.core_context.decisions.some((d) => /SQLite/.test(d))).toBe(true);
    expect(capsule.archive.messages).toHaveLength(4);
    expect(capsule.metadata.originalTokensEstimated).toBeGreaterThan(0);
    expect(capsule.metadata.coreTokensEstimated).toBeGreaterThan(0);
    expect(capsule.current_version).toBe(1);
  });
});

describe('capsule file roundtrip', () => {
  it('serializes and re-parses losslessly', () => {
    const capsule = createCapsule(extraction(['We decided to use ChromaDB for vector search.']));
    const text = serializeCapsule(capsule);
    expect(text.startsWith('CONTEXTCAPSULE 1')).toBe(true);
    const parsed = parseCapsuleText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.id).toBe(capsule.id);
      expect(parsed.file.archive.messages).toHaveLength(1);
    }
  });

  it('rejects invalid payloads with clear errors', () => {
    expect(parseCapsuleText('not json at all').ok).toBe(false);
    expect(parseCapsuleText('{"foo": 1}').ok).toBe(false);
    const tooNew = validateCapsuleFile({ capsule_version: 99, id: 'x' });
    expect(tooNew.ok).toBe(false);
    if (!tooNew.ok) expect(tooNew.error).toMatch(/newer than/);
  });

  it('keeps the project folder through a roundtrip', () => {
    const capsule = createCapsule(extraction(['We decided to use ChromaDB for vector search.']));
    expect('folder' in capsule).toBe(false); // unfiled capsules stay unfiled

    capsule.folder = 'Zephyr auth rewrite';
    const parsed = parseCapsuleText(serializeCapsule(capsule));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.folder).toBe('Zephyr auth rewrite');
  });

  it('collapses whitespace in folder names and caps their length', () => {
    const result = validateCapsuleFile({
      capsule_version: 1,
      id: 'cap_folder',
      folder: '  payment   service\n  ' + 'x'.repeat(200)
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.folder).toHaveLength(64);
      expect(result.file.folder).toMatch(/^payment service x+$/);
    }
    const blank = validateCapsuleFile({ capsule_version: 1, id: 'cap_blank', folder: '   ' });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect('folder' in blank.file).toBe(false);
  });

  it('sanitizes malformed memories instead of crashing', () => {
    const result = validateCapsuleFile({
      capsule_version: 1,
      id: 'cap_x',
      memories: [{ id: 'm1', type: 'nonsense', content: 42, confidence: 7 }]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.memories[0].type).toBe('note');
      expect(result.file.memories[0].content).toBe('');
      expect(result.file.memories[0].confidence).toBe(1);
    }
  });
});
