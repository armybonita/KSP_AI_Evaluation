import { createHash } from 'node:crypto';
import { getDatabase } from '@/server/store/db';
import type { DbConnection } from '@/server/store/db';
import { getProjectEligibilityFingerprintInputs } from '@/server/store/eligibility-fingerprint';

export const AI_ELIGIBILITY_CHANGED_MESSAGE = '자료 자격이 바뀌어 멈췄습니다. 다시 생성해 주세요';

export class AiEligibilityChangedError extends Error {
  constructor() {
    super(AI_ELIGIBILITY_CHANGED_MESSAGE);
    this.name = 'AiEligibilityChangedError';
  }
}

/** A compact, deterministic snapshot of every project input that controls AI eligibility. */
export function projectEligibilityFingerprint(projectId: string, db: DbConnection = getDatabase()): string {
  const inputs = getProjectEligibilityFingerprintInputs(projectId, db);
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

export function createProjectEligibilityGuard(projectId: string, db: DbConnection = getDatabase()): () => void {
  const expected = projectEligibilityFingerprint(projectId, db);
  return () => {
    if (projectEligibilityFingerprint(projectId, db) !== expected) throw new AiEligibilityChangedError();
  };
}
