/**
 * Context Capsule file format — versioned specification.
 *
 * A capsule is a portable, self-contained representation of an AI conversation:
 * a compact structured core, high-value extracted memories, and a full local archive.
 */

export const CAPSULE_VERSION = 1;
export const CAPSULE_FILE_EXTENSION = '.contextcapsule';

export const MAX_CAPSULE_FILE_BYTES = 25 * 1024 * 1024; // hard size limit on import
export const MAX_ARCHIVE_MESSAGES = 20_000;
export const MAX_MEMORIES = 5_000;

export type PlatformId =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'grok'
  | 'perplexity'
  | 'meta'
  | 'copilot'
  | 'mistral'
  | 'kimi'
  | 'poe'
  | 'duckduckgo'
  | 'generic'
  | 'unknown';

export const KNOWN_PLATFORMS: PlatformId[] = [
  'chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'perplexity', 'meta',
  'copilot', 'mistral', 'kimi', 'poe', 'duckduckgo', 'generic'
];

export type MemoryType =
  | 'objective'
  | 'requirement'
  | 'constraint'
  | 'decision'
  | 'rejection'
  | 'issue'
  | 'preference'
  | 'artifact'
  | 'note';

export type Importance = 'critical' | 'high' | 'medium' | 'low';

export interface MemoryItem {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number; // 0..1
  importance: Importance;
  sourceMessageIds: string[];
  createdAt: string;
  pinned?: boolean;
  excluded?: boolean;
  supersededBy?: string | null; // id of the memory that replaced this one
}

export interface ArchiveMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Full original text. Code fences are preserved verbatim — never summarised. */
  text: string;
  hasCode: boolean;
  timestamp: string | null;
  index: number;
}

export interface ConversationMeta {
  url: string;
  title: string;
  messageCount: number;
  estimatedTokens: number;
  extractedAt: string;
}

export interface CoreContext {
  goals: string[];
  requirements: string[];
  constraints: string[];
  decisions: string[];
  rejectedApproaches: string[];
  currentState: { summary: string; messageCount: number };
  currentTask: string;
  knownIssues: string[];
  importantPreferences: string[];
}

export interface Artifact {
  id: string;
  kind: 'code' | 'link' | 'file' | 'image' | 'other';
  name: string;
  content?: string; // inline content (e.g. short code); large artifacts stay in the archive
  language?: string;
  sourceMessageId?: string;
}

export interface CapsuleVersionSnapshot {
  version: number;
  createdAt: string;
  note?: string;
  coreContext: CoreContext;
  memories: MemoryItem[];
}

export interface CapsuleMetadata {
  compression: 'maximum_fidelity' | 'balanced' | 'maximum_compression';
  originalTokensEstimated: number;
  coreTokensEstimated: number;
  memoryTokensEstimated: number;
  [key: string]: unknown;
}

export interface CapsuleFile {
  capsule_version: number;
  id: string;
  created_at: string;
  updated_at: string;
  source_platform: PlatformId;
  project: { name: string; objective: string; description: string };
  /** Optional project grouping. Travels with the file so a re-import keeps order. */
  folder?: string;
  core_context: CoreContext;
  conversation: { meta: ConversationMeta; summary: string; keyEvents: string[] };
  memories: MemoryItem[];
  artifacts: Artifact[];
  archive: { messages: ArchiveMessage[] };
  history: CapsuleVersionSnapshot[];
  current_version: number;
  metadata: CapsuleMetadata;
}

// ---------------------------------------------------------------------------
// Validation (used on every import — capsule files are untrusted input)
// ---------------------------------------------------------------------------

const MEMORY_TYPES: MemoryType[] = [
  'objective', 'requirement', 'constraint', 'decision', 'rejection',
  'issue', 'preference', 'artifact', 'note'
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

export function validateCapsuleFile(raw: unknown): { ok: true; file: CapsuleFile } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'Capsule is not a JSON object' };

  const version = asNum(raw.capsule_version, NaN);
  if (!Number.isInteger(version) || version < 1) return { ok: false, error: 'Missing or invalid capsule_version' };
  if (version > CAPSULE_VERSION) {
    return { ok: false, error: `Capsule version ${version} is newer than this extension supports (v${CAPSULE_VERSION})` };
  }
  if (typeof raw.id !== 'string' || !raw.id) return { ok: false, error: 'Missing capsule id' };

  const project = isObj(raw.project) ? raw.project : {};
  const core = isObj(raw.core_context) ? raw.core_context : {};
  const currentState = isObj(core.currentState) ? core.currentState : {};
  const conv = isObj(raw.conversation) ? raw.conversation : {};
  const meta = isObj(conv.meta) ? conv.meta : {};
  const archive = isObj(raw.archive) ? raw.archive : {};
  const metadata = isObj(raw.metadata) ? raw.metadata : {};

  const rawMessages = Array.isArray(archive.messages) ? archive.messages.slice(0, MAX_ARCHIVE_MESSAGES) : [];
  const messages: ArchiveMessage[] = rawMessages
    .filter(isObj)
    .map((m, i) => ({
      id: asStr(m.id, `m_${i}`),
      role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
      text: asStr(m.text),
      hasCode: m.hasCode === true || /```/.test(asStr(m.text)),
      timestamp: typeof m.timestamp === 'string' ? m.timestamp : null,
      index: asNum(m.index, i)
    }));

  const rawMemories = Array.isArray(raw.memories) ? raw.memories.slice(0, MAX_MEMORIES) : [];
  const memories: MemoryItem[] = rawMemories.filter(isObj).map((m, i) => ({
    id: asStr(m.id, `mem_${i}`),
    type: MEMORY_TYPES.includes(m.type as MemoryType) ? (m.type as MemoryType) : 'note',
    content: asStr(m.content),
    confidence: Math.min(1, Math.max(0, asNum(m.confidence, 0.5))),
    importance: (['critical', 'high', 'medium', 'low'] as Importance[]).includes(m.importance as Importance)
      ? (m.importance as Importance)
      : 'medium',
    sourceMessageIds: asStrArray(m.sourceMessageIds),
    createdAt: asStr(m.createdAt, new Date().toISOString()),
    pinned: m.pinned === true,
    excluded: m.excluded === true,
    supersededBy: typeof m.supersededBy === 'string' ? m.supersededBy : null
  }));

  const rawArtifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  const artifacts: Artifact[] = rawArtifacts.filter(isObj).map((a, i) => ({
    id: asStr(a.id, `art_${i}`),
    kind: (['code', 'link', 'file', 'image', 'other'] as const).includes(a.kind as never) ? (a.kind as Artifact['kind']) : 'other',
    name: asStr(a.name, `artifact-${i}`),
    content: typeof a.content === 'string' ? a.content : undefined,
    language: typeof a.language === 'string' ? a.language : undefined,
    sourceMessageId: typeof a.sourceMessageId === 'string' ? a.sourceMessageId : undefined
  }));

  const file: CapsuleFile = {
    capsule_version: version,
    id: raw.id,
    created_at: asStr(raw.created_at, new Date().toISOString()),
    updated_at: asStr(raw.updated_at, new Date().toISOString()),
    source_platform: KNOWN_PLATFORMS.includes(raw.source_platform as PlatformId)
      ? (raw.source_platform as PlatformId)
      : 'unknown',
    project: {
      name: asStr(project.name, 'Untitled capsule'),
      objective: asStr(project.objective),
      description: asStr(project.description)
    },
    core_context: {
      goals: asStrArray(core.goals),
      requirements: asStrArray(core.requirements),
      constraints: asStrArray(core.constraints),
      decisions: asStrArray(core.decisions),
      rejectedApproaches: asStrArray(core.rejectedApproaches),
      currentState: { summary: asStr(currentState.summary), messageCount: asNum(currentState.messageCount) },
      currentTask: asStr(core.currentTask),
      knownIssues: asStrArray(core.knownIssues),
      importantPreferences: asStrArray(core.importantPreferences)
    },
    conversation: {
      meta: {
        url: asStr(meta.url),
        title: asStr(meta.title),
        messageCount: asNum(meta.messageCount, messages.length),
        estimatedTokens: asNum(meta.estimatedTokens),
        extractedAt: asStr(meta.extractedAt, new Date().toISOString())
      },
      summary: asStr(conv.summary),
      keyEvents: asStrArray(conv.keyEvents)
    },
    memories,
    artifacts,
    archive: { messages },
    history: [], // history snapshots are validated lazily on restore
    current_version: asNum(raw.current_version, 1),
    metadata: {
      compression: (['maximum_fidelity', 'balanced', 'maximum_compression'] as const).includes(
        metadata.compression as never
      )
        ? (metadata.compression as CapsuleMetadata['compression'])
        : 'balanced',
      originalTokensEstimated: asNum(metadata.originalTokensEstimated),
      coreTokensEstimated: asNum(metadata.coreTokensEstimated),
      memoryTokensEstimated: asNum(metadata.memoryTokensEstimated)
    }
  };

  const folder = asStr(raw.folder).replace(/\s+/g, ' ').trim().slice(0, 64);
  if (folder) file.folder = folder;

  return { ok: true, file };
}
