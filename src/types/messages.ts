import type { CapsuleFile, MemoryType, PlatformId } from '../core/capsule/schema';

/** Messages exchanged between content scripts / UI pages and the background worker. */
export type ExtMessage =
  | { type: 'GET_PAGE_INFO' }
  | { type: 'CREATE_CAPSULE' }
  | { type: 'LIST_CAPSULES' }
  | { type: 'GET_CAPSULE'; capsuleId: string }
  | { type: 'UPDATE_CAPSULE'; capsuleId: string }
  | { type: 'IMPORT_CAPSULE'; file: CapsuleFile }
  | { type: 'DELETE_CAPSULE'; capsuleId: string }
  | { type: 'RENAME_CAPSULE'; capsuleId: string; name: string }
  | { type: 'RESTORE_VERSION'; capsuleId: string; version: number }
  | { type: 'REMOVE_MEMORY'; capsuleId: string; memoryId: string }
  | { type: 'TOGGLE_PIN_MEMORY'; capsuleId: string; memoryId: string }
  | { type: 'GET_HANDOFF'; capsuleId: string; query?: string }
  | { type: 'APPLY_HANDOFF'; text: string }
  | { type: 'TEST_AI_PROVIDER' }
  | { type: 'LIST_AI_MODELS' }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'CLEAR_ALL' };

export interface PageInfo {
  supported: boolean;
  platform?: PlatformId;
  messageCount: number;
  estimatedTokens: number;
}

export interface CapsuleListItem {
  id: string;
  projectName: string;
  updatedAt: string;
  sourcePlatform: PlatformId;
  currentVersion: number;
  coreTokens: number;
  memoryCount: number;
  versions: number[];
}

export interface CapsuleStats {
  originalTokens: number;
  coreTokens: number;
  archivedTokens: number;
  reductionPct: number; // 0..100, derived from estimates — always labelled "estimated" in UI
  memoryCount: number;
  counts: Partial<Record<MemoryType, number>>;
}

export interface UpdateDiffEntry {
  newMemories: { type: MemoryType; content: string }[];
  superseded: { from: string; to: string }[];
  version: number;
}

export type ExtResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
