import type { ArchiveMessage, CapsuleFile, MemoryItem, MemoryType } from '../capsule/schema';
import { truncate, uid, nowIso } from '../../shared/helpers';
import { chatCompletion } from './ai';
import type { AISettings } from './aiSettings';

/**
 * Optional AI distillation layer. The heuristic engine always runs first; when
 * AI mode is enabled this produces a richer core + memory set from the same
 * transcript, and any failure silently falls back to the heuristic result.
 */

const MEMORY_TYPES: MemoryType[] = [
  'objective', 'requirement', 'constraint', 'decision', 'rejection',
  'issue', 'preference', 'artifact', 'note'
];

interface DistilledResult {
  goals?: string[];
  requirements?: string[];
  constraints?: string[];
  decisions?: string[];
  rejectedApproaches?: string[];
  knownIssues?: string[];
  importantPreferences?: string[];
  currentState?: string;
  currentTask?: string;
  memories?: { type?: string; content?: string; importance?: string }[];
}

function transcript(messages: ArchiveMessage[]): string {
  const perMsg = 900;
  let budget = 16_000;
  const lines: string[] = [];
  for (const m of messages) {
    const line = `${m.role.toUpperCase()}: ${truncate(m.text.replace(/\s+/g, ' '), perMsg)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
    if (budget <= 0) break;
  }
  return lines.join('\n');
}

const SYSTEM =
  'You compress AI chat transcripts into a compact "context capsule" for handoff to another AI. ' +
  'Reply with STRICT JSON only (no markdown fences, no commentary) using this shape: ' +
  '{"goals":[],"requirements":[],"constraints":[],"decisions":[],"rejectedApproaches":[],' +
  '"knownIssues":[],"importantPreferences":[],"currentState":"2-3 sentence summary",' +
  '"currentTask":"what to do next or empty","memories":[{"type":"decision|requirement|constraint|rejection|issue|preference|artifact|note","content":"one crisp standalone fact","importance":"critical|high|medium|low"}]}. ' +
  'Rules: keep every item under 220 characters; preserve exact numbers, file names, API endpoints and decisions; ' +
  'prefer 10-40 high-value memories; never invent content not present in the transcript.';

function parseJson(text: string): DistilledResult {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Provider did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1)) as DistilledResult;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : [];
}

export async function distillCapsule(
  settings: AISettings,
  messages: ArchiveMessage[],
  capsule: CapsuleFile
): Promise<void> {
  const raw = transcript(messages);
  const answer = await chatCompletion(
    settings,
    SYSTEM,
    `Conversation title: ${capsule.conversation.meta.title}\n\nTranscript:\n${raw}`,
    3000
  );
  const d = parseJson(answer);

  const core = capsule.core_context;
  const merge = (target: string[], incoming: string[]) => {
    if (incoming.length) {
      target.length = 0;
      target.push(...incoming.slice(0, 40));
    }
  };
  merge(core.goals, strArray(d.goals));
  merge(core.requirements, strArray(d.requirements));
  merge(core.constraints, strArray(d.constraints));
  merge(core.decisions, strArray(d.decisions));
  merge(core.rejectedApproaches, strArray(d.rejectedApproaches));
  merge(core.knownIssues, strArray(d.knownIssues));
  merge(core.importantPreferences, strArray(d.importantPreferences));
  if (typeof d.currentState === 'string' && d.currentState.trim()) {
    core.currentState.summary = truncate(d.currentState.trim(), 600);
  }
  if (typeof d.currentTask === 'string' && d.currentTask.trim()) {
    core.currentTask = truncate(d.currentTask.trim(), 400);
  }

  const aiMemories: MemoryItem[] = (Array.isArray(d.memories) ? d.memories : [])
    .filter((m) => typeof m?.content === 'string' && m.content.trim().length > 0)
    .slice(0, 60)
    .map((m) => ({
      id: uid('mem'),
      type: MEMORY_TYPES.includes((m.type ?? '') as MemoryType) ? (m.type as MemoryType) : 'note',
      content: truncate((m.content ?? '').trim(), 400),
      confidence: 0.9,
      importance: (['critical', 'high', 'medium', 'low'] as const).includes(m.importance as never)
        ? (m.importance as MemoryItem['importance'])
        : 'medium',
      sourceMessageIds: [],
      createdAt: nowIso(),
      supersededBy: null
    }));
  if (aiMemories.length) {
    const seen = new Set(aiMemories.map((m) => m.content.toLowerCase()));
    capsule.memories = [...aiMemories, ...capsule.memories.filter((m) => !seen.has(m.content.toLowerCase()))];
  }

  capsule.metadata.extractionMode = 'ai';
  capsule.metadata.extractionProvider = settings.provider;
}
