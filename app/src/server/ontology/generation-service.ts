import { getDatabase, getProject, listDocuments, getParagraphsByDocument } from '@/server/store';
import type { DbConnection } from '@/server/store/db';
import { MAX_PARAGRAPHS_PER_REQUEST, generateProjectOntology } from './generator';
import type { GeneratedOntologyResult } from './generator';
import { replaceProjectOntology } from './store';
import { isAiDocumentEligible } from '@/server/documents/ai-eligibility';
import { getAiGatewayProvider } from '@/server/ai/client';
import { safeOntologyError } from './error-safety';
import { forceFailGenerationRun, getActiveGenerationRun, startGenerationRun, updateGenerationRun } from './generation-store';
import { AiEligibilityChangedError, AI_ELIGIBILITY_CHANGED_MESSAGE, createProjectEligibilityGuard } from '@/server/documents/eligibility-fingerprint';

export function startProjectOntologyGeneration(projectId: string, executor: string) {
  if (getActiveGenerationRun(projectId)) return null;
  const docs = listDocuments(projectId).filter((doc) => doc.is_included === 1 && doc.status === '추출 완료' && isAiDocumentEligible(doc, getAiGatewayProvider()));
  const totalCount = docs.reduce((sum, doc) => sum + Math.ceil(getParagraphsByDocument(doc.id).length / MAX_PARAGRAPHS_PER_REQUEST), 0);
  const run = startGenerationRun(projectId, totalCount);
  if (!run) return null;
  void execute(projectId, executor, run.id);
  return run;
}

async function execute(projectId: string, executor: string, runId: string): Promise<void> {
  let stage: 'generate' | 'assemble' | 'save' = 'generate';
  try {
    const guard = createProjectEligibilityGuard(projectId, getDatabase());
    updateGenerationRun(runId, { state: 'running' });
    const project = getProject(projectId);
    if (!project) throw new Error('사업을 찾을 수 없습니다.');
    const result = await generateProjectOntology(projectId, {
      project,
      guard,
      onProgress: (completed, total) => updateGenerationRun(runId, { completed_count: completed, total_count: total }),
    });
    stage = 'save';
    guard();
    finishGenerationRun(projectId, result, executor, runId);
  } catch (error) {
    finalizeFailedGenerationRun(runId, error, updateGenerationRun, getDatabase(), stage);
  }
}

export function shouldPreserveOntology(result: GeneratedOntologyResult): boolean {
  return result.documentSuccessCount === 0 || Object.keys(result.graph.nodes).length === 0 || Object.keys(result.graph.snippets).length === 0;
}

export function finishGenerationRun(projectId: string, result: GeneratedOntologyResult, executor: string, runId: string, db?: DbConnection): void {
  const preserved = shouldPreserveOntology(result);
  if (!preserved) {
    replaceProjectOntology(projectId, result.graph, executor, db, new Date().toISOString(), {
      sourceKind: 'generated', modelName: result.modelName, documentSuccessCount: result.documentSuccessCount,
      documentFailureCount: result.documentFailureCount, discardedQuoteCount: result.discardedQuoteCount,
    });
  }
  const exclusions = result.excludedDocuments.map(({ documentId, reasons }) => `문서 ${documentId}: ${reasons.join(' · ')}`).join('; ');
  const failures = result.failedDocuments.map(({ documentId, reason }) => `문서 ${documentId}: ${reason}`).join('; ');
  updateGenerationRun(runId, {
    state: preserved ? 'failed' : 'completed',
    error_message: preserved ? `생성 결과가 없어 기존 온톨로지를 보존했습니다.${failures ? ` 생성 실패: ${failures}` : ''}${exclusions ? ` AI 입력 제외: ${exclusions}` : ''}` : null,
    result_json: generationResultJson(result),
  }, db);
}

export function generationResultJson(result: GeneratedOntologyResult): string {
  return JSON.stringify({ nodeCount: Object.keys(result.graph.nodes).length, edgeCount: result.graph.edges.length,
    documentSuccessCount: result.documentSuccessCount, documentFailureCount: result.documentFailureCount,
    ontologyPreserved: shouldPreserveOntology(result), discardedQuoteCount: result.discardedQuoteCount, failedDocuments: result.failedDocuments, excludedDocuments: result.excludedDocuments, failureKinds: result.failureKinds });
}

export function finalizeFailedGenerationRun(
  runId: string,
  error: unknown,
  update: typeof updateGenerationRun = updateGenerationRun,
  db: DbConnection = getDatabase(),
  stage: 'generate' | 'assemble' | 'save' = 'generate',
): void {
  if (error instanceof AiEligibilityChangedError) {
    const diagnostic = '실행 중 자료 자격 변경으로 작업 전체를 중단했습니다. 정확한 제외 문단 수는 계산하지 않았습니다.';
    const values = {
      state: 'failed' as const,
      error_message: `${AI_ELIGIBILITY_CHANGED_MESSAGE} (${diagnostic})`,
      result_json: JSON.stringify({ eligibilityChanged: true, diagnosis: AI_ELIGIBILITY_CHANGED_MESSAGE, executionDiagnostic: diagnostic }),
    };
    try {
      update(runId, values);
    } catch {
      forceFailGenerationRun(runId, values.error_message, db, values.result_json);
    }
    return;
  }
  const { name, message } = safeOntologyError(error);
  console.error(`[ontology-generation] stage=${stage} name=${name} message=${message}`);
  const stageName = stage === 'assemble' ? '조립' : stage === 'save' ? '저장' : '생성';
  const values = { state: 'failed' as const, error_message: `온톨로지 생성 중 내부 오류(${stageName}: ${message})` };
  try {
    update(runId, values);
  } catch {
    forceFailGenerationRun(runId, values.error_message, db);
  }
}
