import { getDatabase } from '@/server/store/db';
import { safeOntologyError } from './error-safety';
import { synthesizeProject } from './synthesis';
import { abortSynthesisRun, assertRunEligibility, SynthesisEligibilityChanged, failSynthesisRun, finishSynthesisRun, markSynthesisRunning, saveSynthesisDiagnostics, saveSynthesisStage, startSynthesisRun } from '@/server/store/synthesis-store';

/**
 * A partial unique index reserves a project's run before any work is scheduled.
 * Restart recovery, like ontology generation, assumes one application process:
 * a second process opening the DB would mark the first process's runs failed.
 */
export class SynthesisQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue(job: () => Promise<void>): void {
    this.tail = this.tail.then(job, job).catch(() => {});
  }
}
const queue = new SynthesisQueue();

export function startProjectSynthesis(projectId: string) {
  const run = startSynthesisRun(projectId);
  if (!run) return null;
  setTimeout(() => queue.enqueue(() => execute(projectId, run.id)), 0);
  return run;
}

export async function execute(projectId: string, runId: string, options: Parameters<typeof synthesizeProject>[1] = {}): Promise<void> {
  const db = options.db ?? getDatabase();
  const provider = options.aiClient?.provider;
  try {
    const eligibilityFingerprint = markSynthesisRunning(runId, db, provider);
    const result = await synthesizeProject(projectId, { ...options, db, eligibilityFingerprint, onProgress: diagnostics => saveSynthesisDiagnostics(runId, diagnostics, db), onStageComplete: result => saveSynthesisStage(runId, result, db, provider) });
    finishSynthesisRun(runId, result, db, provider);
  } catch (error) {
    try { assertRunEligibility(runId, db, provider); } catch (eligibilityError) {
      if (eligibilityError instanceof SynthesisEligibilityChanged) error = eligibilityError;
    }
    if (error instanceof SynthesisEligibilityChanged) {
      abortSynthesisRun(runId, db);
      return;
    }
    const safe = safeOntologyError(error);
    console.error(`[ontology-synthesis] name=${safe.name} message=${safe.message}`);
    try {
      failSynthesisRun(runId, `항목 종합 중 오류: ${safe.message}`, db);
    } catch {
      console.error('[ontology-synthesis] 실행 실패 상태를 저장하지 못했습니다.');
    }
  }
}
