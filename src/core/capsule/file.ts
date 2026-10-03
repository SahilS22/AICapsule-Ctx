import { CAPSULE_FILE_EXTENSION, MAX_CAPSULE_FILE_BYTES, validateCapsuleFile, type CapsuleFile } from './schema';

/**
 * .contextcapsule wire format:
 *   line 1: magic header (format identifier, human-visible in text editors)
 *   rest  : UTF-8 JSON payload
 * Plain JSON (without the header) is also accepted on import for forward tooling.
 */
export const CAPSULE_MAGIC = 'CONTEXTCAPSULE 1';

export function serializeCapsule(capsule: CapsuleFile): string {
  return `${CAPSULE_MAGIC}\n${JSON.stringify(capsule, null, 2)}`;
}

export function capsuleFilename(capsule: CapsuleFile): string {
  const base = capsule.project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'capsule';
  return `${base}.v${capsule.current_version}${CAPSULE_FILE_EXTENSION}`;
}

export function parseCapsuleText(text: string): { ok: true; file: CapsuleFile } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).byteLength > MAX_CAPSULE_FILE_BYTES) {
    return { ok: false, error: 'Capsule file exceeds the 25 MB size limit' };
  }
  let payload = text.trimStart();
  if (payload.startsWith(CAPSULE_MAGIC)) payload = payload.slice(CAPSULE_MAGIC.length).trimStart();

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, error: 'Capsule file is not valid JSON — it may be corrupted or incomplete' };
  }
  return validateCapsuleFile(raw);
}
