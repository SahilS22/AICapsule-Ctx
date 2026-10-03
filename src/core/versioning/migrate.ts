import { CAPSULE_VERSION, type CapsuleFile } from '../capsule/schema';

/**
 * Capsule format migrations. Each entry upgrades a payload from version N to N+1.
 * v1 is current, so the registry is empty — the machinery exists so future
 * format changes never break older capsule files.
 */
type Migration = (file: CapsuleFile) => CapsuleFile;

const MIGRATIONS: Record<number, Migration> = {
  // 1: (file) => ({ ...file, capsule_version: 2, ... })
};

export function migrateCapsule(file: CapsuleFile): { file: CapsuleFile; migrated: boolean } {
  let current = file;
  let migrated = false;
  while (current.capsule_version < CAPSULE_VERSION) {
    const step = MIGRATIONS[current.capsule_version];
    if (!step) {
      throw new Error(`No migration path from capsule version ${current.capsule_version}`);
    }
    current = step(current);
    migrated = true;
  }
  return { file: current, migrated };
}
