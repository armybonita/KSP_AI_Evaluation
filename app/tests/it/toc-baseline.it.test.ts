import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractDocument } from '../../src/server/extract';
import { suggestVerdictForIndicator, buildSuggestInput } from '../../src/server/suggest';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  getLatestSuggestion,
  insertParagraphs,
  openDatabase,
  saveIndicatorBaseline,
  saveIndicatorConflict,
  type IndicatorRecord,
} from '../../src/server/store';
import answers from '../../fixtures/answers.json';

// ============================================================================
// 필수 환경변수 사전 검사 (통합 시험 IT: 게이트웨이 실제 호출)
// ============================================================================
function checkRequiredEnvironment(): void {
  const requiredKeys = [
    'AIEAS_LLM_BASE_URL',
    // public-safety-allow: checking presence of required env vars for IT
    'AIEAS_LLM_API_KEY',
    'AIEAS_MODEL',
    'AIEAS_REASONING_EFFORT',
  ];

  const missing = requiredKeys.filter((k) => {
    const val = process.env[k];
    return !val || val.trim().length === 0;
  });

  if (missing.length > 0) {
    throw new Error(
      `[IT 환경변수 누락] 필수 환경변수가 설정되지 않았습니다: ${missing.join(', ')}. ` +
        `통합 시험(IT)은 실제 AI 호출을 관통하므로 건너뛰지 않고 즉시 실패합니다.`
    );
  }

  if (process.env.AIEAS_MODEL !== 'aieas-default') {
    throw new Error(
      `[IT 환경변수 오류] AIEAS_MODEL 은 'aieas-default' 이어야 합니다 (현재: '${process.env.AIEAS_MODEL}').`
    );
  }
}

describe('기준 선택 뒤 AI 요청 및 판정 제안 통합 시험 (IT) (#19, RQ-08)', () => {
  let tempDbDir: string;
  let tempDbPath: string;
  const projectId = 'proj-it-baseline';

  beforeAll(() => {
    checkRequiredEnvironment();

    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-it-baseline-'));
    tempDbPath = path.join(tempDbDir, 'test.db');
    openDatabase(tempDbPath);

    createProject({
      id: projectId,
      name: answers.project_name,
      created_at: new Date().toISOString(),
    });
  });

  afterAll(() => {
    closeDatabase();
    if (tempDbDir && fs.existsSync(tempDbDir)) {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    }
  });

  it('기준 지표를 선택한 뒤 AI 제안을 호출하면 그 기준 지표가 반영되어 제안이 생성된다 (RQ-08)', async () => {
    const fixturesDir = path.resolve(__dirname, '../../fixtures');

    // 1. 사업계획서 추출 및 등록
    const planBuf = fs.readFileSync(path.join(fixturesDir, '01_project_plan.hwpx'));
    const planExt = await extractDocument(planBuf, 'hwpx');
    const planDocId = 'doc-plan-it';
    createDocument({
      id: planDocId,
      project_id: projectId,
      file_name: '01_project_plan.hwpx',
      file_type: 'hwpx',
      status: planExt.status,
      doc_type: '사업계획서',
      is_included: 1,
      excluded_reason: null,
      created_at: new Date().toISOString(),
    });
    insertParagraphs(
      planExt.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: planDocId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
      }))
    );

    // 2. 성과관리표 추출 및 등록
    const pdmBuf = fs.readFileSync(path.join(fixturesDir, '02_pdm.docx'));
    const pdmExt = await extractDocument(pdmBuf, 'docx');
    const pdmDocId = 'doc-pdm-it';
    createDocument({
      id: pdmDocId,
      project_id: projectId,
      file_name: '02_pdm.docx',
      file_type: 'docx',
      status: pdmExt.status,
      doc_type: '성과관리표',
      is_included: 1,
      excluded_reason: null,
      created_at: new Date().toISOString(),
    });
    insertParagraphs(
      pdmExt.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: pdmDocId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
      }))
    );

    // 3. 영향 지표 등록 (충돌 대상: 사업계획서 80% vs 성과관리표 5점 척도 3.5점)
    const pw = answers.performance_pathway;
    const indicator: IndicatorRecord = {
      id: 'ind-impact-it',
      project_id: projectId,
      level: '영향',
      name: pw.impact.name,
      ovi: pw.impact.ovi,
      mov: pw.impact.mov,
      target_value: pw.impact.target_value,
      source_doc_id: pdmDocId,
      source_location: '¶3',
      sort_order: 1,
      is_baseline: 0,
      created_at: new Date().toISOString(),
    };
    createIndicator(indicator);

    // 4. 지표 충돌 등록
    saveIndicatorConflict({
      id: 'conflict-it-1',
      project_id: projectId,
      indicator_id: indicator.id,
      doc_a_id: planDocId,
      doc_a_name: '사업계획서',
      doc_a_value: '80%',
      doc_a_location: '¶4',
      doc_b_id: pdmDocId,
      doc_b_name: '성과관리표',
      doc_b_value: '5점 척도 3.5점',
      doc_b_location: '¶3',
      created_at: new Date().toISOString(),
    });

    // 5. 기준 지표 선택: 사업계획서(80%) 선택 저장
    saveIndicatorBaseline({
      id: 'baseline-it-1',
      project_id: projectId,
      indicator_id: indicator.id,
      document_id: planDocId,
      document_name: '사업계획서',
      target_value: '80%',
      selected_at: new Date().toISOString(),
    });

    // 6. suggest 입력 문단 구성 및 AI 호출 (실제 게이트웨이)
    const paragraphs = buildSuggestInput(projectId);
    const result = await suggestVerdictForIndicator(indicator, paragraphs, {
      saveToStore: true,
    });

    expect(result.saved).toBe(true);
    expect(result.suggestion.verdict_status).toBeDefined();

    const saved = getLatestSuggestion(indicator.id);
    expect(saved).toBeDefined();
    expect(saved!.verdict_status).toBe(result.suggestion.verdict_status);
  });
});
