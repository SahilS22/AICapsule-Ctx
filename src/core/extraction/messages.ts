import type { ArchiveMessage } from '../capsule/schema';
import { uid } from '../../shared/helpers';

export interface RawMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string | null;
}

/** Convert raw adapter output into stable archive messages with deterministic-ish ids. */
export function normalizeMessages(raw: RawMessage[]): ArchiveMessage[] {
  return raw
    .filter((m) => m.text.trim().length > 0)
    .map((m, index) => ({
      id: uid('m'),
      role: m.role,
      text: m.text,
      hasCode: /```/.test(m.text),
      timestamp: m.timestamp,
      index
    }));
}
