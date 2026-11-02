import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import answers from '../fixtures/answers.json';
import { extractDocument } from '../src/server/extract';
import { AiClient, createE2EFakeAiClient } from '../src/server/ai';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  DbConnection,
  EvidenceRecord,
  getParagraphsByProject,
  IndicatorRecord,
  insertParagraphs,
  insertSentences,
  listIndicators,
  openDatabase,
  openReadonlyDatabase,
  ParagraphRecord,
  saveSuggestion,
  SentenceRecord,
  splitParagraphIntoSentences,
  SuggestionRecord,
} from '../src/server/store';
import {
  buildSuggestInput,
  suggestVerdictForIndicator,
} from '../src/server/suggest';
import { syncTocForProject } from '../src/server/toc';

export interface SeedDevOptions {
  fakeAi?: boolean;
  dbPath?: string;
  projectId?: string;
}

export const SEED_PROJECT_ID = 'proj-dev-seed';

export const SEED_INDICATORS: Omit<IndicatorRecord, 'project_id' | 'created_at'>[] = [
  {
    id: 'ind-activity',
    level: '활동',
    name: '공무원 디지털 직무 교육',
    ovi: '공무원 대상 디지털 역량 강화 교육',
    mov: '교육 수료 대장',
    target_value: '핵심 공무원 500명 이수',
    is_baseline: 0,
  },
  {
    id: 'ind-shortterm',
    level: '단기성과',
    name: '디지털 행정 서비스 이용 확산',
    ovi: '디지털 공공 포털 가입자 수',
    mov: '포털 운영 실적 통계',
    target_value: '가입자 100만명 확보',
    is_baseline: 0,
  },
  {
    id: 'ind-output',
    level: '산출물',
    name: '디지털 행정 기반 구축',
    ovi: '디지털 행정 공통 플랫폼 구축',
    mov: '시스템 인수 검사 확인서',
    target_value: '통합 플랫폼 1식 개발 완료',
    is_baseline: 0,
  },
  {
    id: 'ind-conflict',
    level: '영향',
    name: '대국민 행정 편의 증진',
    ovi: '대국민 전자정부 서비스 체감 만족도',
    mov: '대국민 설문조사 보고서',
    target_value: '5점 척도 3.5점 달성',
    is_baseline: 0,
  },
  {
    id: 'ind-unsupported',
    level: '단기성과',
    name: '디지털 법제 정비',
    ovi: '가상국 디지털 법제 정비율',
    mov: '가상국 법제처 공보',
    target_value: '100% 달성',
    is_baseline: 0,
  },
  {
    id: 'ind-midterm',
    level: '중기성과',
    name: '행정 효율성 증대',
    ovi: '행정 업무 처리 시간 단축률',
    mov: '업무 시스템 로그 분석 보고서',
    target_value: '행정 업무 처리 시간 30% 단축',
    is_baseline: 0,
  },
  {
    id: 'ind-schema-violation',
    level: '산출물',
    name: '시스템 보안 체계 수립',
    ovi: '보안성 검토 기준 수립',
    mov: '보안성 검토 보고서',
    target_value: '보안 기준 1식 수립',
    is_baseline: 0,
  },
];

export async function seedDev(options: SeedDevOptions = {}): Promise<{
  projectId: string;
  dbPath: string;
}> {
  const isFakeAi = options.fakeAi ?? false;
  const projectId = options.projectId ?? SEED_PROJECT_ID;
  const dbPath = options.dbPath ?? process.env.AIEAS_DB_PATH ?? path.resolve(process.cwd(), 'aieas-dev.db');

  console.log(`[시드] DB 경로: ${dbPath}`);
  console.log(`[시드] 모드: ${isFakeAi ? '결정적 가짜 AI (--fake-ai)' : '실제 AI 모드'}`);

  const db = openDatabase(dbPath);

  // 1. 사업 등록
  createProject(
    {
      id: projectId,
      name: answers.project_name,
      created_at: new Date().toISOString(),
    },
    db
  );

  // 2. 가상 자료 추출 및 저장
  const fixturesDir = path.resolve(__dirname, '../fixtures');
  for (const docMeta of answers.documents) {
    const filePath = path.join(fixturesDir, docMeta.file_name);
    const fileBuffer = fs.readFileSync(filePath);
    const fileExt = path.extname(docMeta.file_name).replace('.', '');

    const extraction = await extractDocument(fileBuffer, fileExt);
    const docId = `doc-${docMeta.file_name}`;

    createDocument(
      {
        id: docId,
        project_id: projectId,
        file_name: docMeta.file_name,
        file_type: fileExt as any,
        status: extraction.status,
        doc_type: docMeta.doc_type as any,
        is_included: docMeta.is_excluded ? 0 : 1,
        excluded_reason: docMeta.excluded_reason,
        masked: true,
        approved_ai: 'solar',
        is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );

    if (extraction.paragraphs.length > 0) {
      const paragraphsToInsert = extraction.paragraphs.map((p) => ({
        id: crypto.randomUUID(),
        document_id: docId,
        sequence_no: p.sequence_no,
        location: p.location,
        content: p.content,
        table_index: p.table_index ?? null,
      table_cols: p.table_cols ?? null,
        table_row: p.table_row ?? null,
        table_col: p.table_col ?? null,
      }));
      insertParagraphs(paragraphsToInsert, db);

      const sentencesToInsert: SentenceRecord[] = [];
      let sentenceSeq = 1;
      for (const p of paragraphsToInsert) {
        const splitItems = splitParagraphIntoSentences(p.content, p.location, sentenceSeq);
        for (const item of splitItems) {
          sentencesToInsert.push({
            id: crypto.randomUUID(),
            document_id: docId,
            paragraph_id: p.id,
            sequence_no: item.sequence_no,
            location: item.location,
            content: item.content,
            is_citation_banned: item.is_citation_banned,
          });
        }
        sentenceSeq += splitItems.length;
      }
      insertSentences(sentencesToInsert, db);
    }

    if (docMeta.file_name === '02_pdm.docx') {
      const tableParas: ParagraphRecord[] = [
        // Row 1: 헤더
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 101, location: '¶101', content: '구분', table_index: 0, table_cols: 5, table_row: 1, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 102, location: '¶102', content: '지표명', table_index: 0, table_cols: 5, table_row: 1, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 103, location: '¶103', content: '성과지표', table_index: 0, table_cols: 5, table_row: 1, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 104, location: '¶104', content: '검증수단', table_index: 0, table_cols: 5, table_row: 1, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 105, location: '¶105', content: '목표값', table_index: 0, table_cols: 5, table_row: 1, table_col: 5 },
        // Row 2: 영향
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 106, location: '¶106', content: '영향', table_index: 0, table_cols: 5, table_row: 2, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 107, location: '¶107', content: '대국민 행정 편의 증진', table_index: 0, table_cols: 5, table_row: 2, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 108, location: '¶3', content: '대국민 전자정부 서비스 체감 만족도', table_index: 0, table_cols: 5, table_row: 2, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 109, location: '¶109', content: '대국민 설문조사 보고서', table_index: 0, table_cols: 5, table_row: 2, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 110, location: '¶110', content: '5점 척도 3.5점', table_index: 0, table_cols: 5, table_row: 2, table_col: 5 },
        // Row 3: 중기성과
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 111, location: '¶111', content: '중기성과', table_index: 0, table_cols: 5, table_row: 3, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 112, location: '¶112', content: '행정 효율성 증대', table_index: 0, table_cols: 5, table_row: 3, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 113, location: '¶4', content: '행정 업무 처리 시간 단축률', table_index: 0, table_cols: 5, table_row: 3, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 114, location: '¶114', content: '업무 시스템 로그 분석 보고서', table_index: 0, table_cols: 5, table_row: 3, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 115, location: '¶115', content: '행정 업무 처리 시간 30% 단축', table_index: 0, table_cols: 5, table_row: 3, table_col: 5 },
        // Row 4: 단기성과
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 116, location: '¶116', content: '단기성과', table_index: 0, table_cols: 5, table_row: 4, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 117, location: '¶117', content: '디지털 행정 서비스 이용 확산', table_index: 0, table_cols: 5, table_row: 4, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 118, location: '¶5', content: '디지털 공공 포털 가입자 수', table_index: 0, table_cols: 5, table_row: 4, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 119, location: '¶119', content: '포털 운영 실적 통계', table_index: 0, table_cols: 5, table_row: 4, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 120, location: '¶120', content: '가입자 100만명 확보', table_index: 0, table_cols: 5, table_row: 4, table_col: 5 },
        // Row 5: 산출물
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 121, location: '¶121', content: '산출물', table_index: 0, table_cols: 5, table_row: 5, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 122, location: '¶122', content: '디지털 행정 기반 구축', table_index: 0, table_cols: 5, table_row: 5, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 123, location: '¶6', content: '디지털 행정 공통 플랫폼 구축', table_index: 0, table_cols: 5, table_row: 5, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 124, location: '¶124', content: '시스템 인수 검사 확인서', table_index: 0, table_cols: 5, table_row: 5, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 125, location: '¶125', content: '통합 플랫폼 1식 개발 완료', table_index: 0, table_cols: 5, table_row: 5, table_col: 5 },
        // Row 6: 활동
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 126, location: '¶126', content: '활동', table_index: 0, table_cols: 5, table_row: 6, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 127, location: '¶127', content: '공무원 디지털 직무 교육', table_index: 0, table_cols: 5, table_row: 6, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 128, location: '¶7', content: '공무원 대상 디지털 역량 강화 교육', table_index: 0, table_cols: 5, table_row: 6, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 129, location: '¶129', content: '교육 수료 대장', table_index: 0, table_cols: 5, table_row: 6, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 130, location: '¶130', content: '핵심 공무원 500명 이수', table_index: 0, table_cols: 5, table_row: 6, table_col: 5 },
        // Row 7: 함정지표
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 131, location: '¶131', content: '단기성과', table_index: 0, table_cols: 5, table_row: 7, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 132, location: '¶132', content: '디지털 법제 정비', table_index: 0, table_cols: 5, table_row: 7, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 133, location: '¶8', content: '가상국 디지털 법제 정비율', table_index: 0, table_cols: 5, table_row: 7, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 134, location: '¶134', content: '가상국 법제처 공보', table_index: 0, table_cols: 5, table_row: 7, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 135, location: '¶135', content: '100% 달성', table_index: 0, table_cols: 5, table_row: 7, table_col: 5 },
        // Row 8: 스키마 위반 테스트용 지표
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 136, location: '¶136', content: '산출물', table_index: 0, table_cols: 5, table_row: 8, table_col: 1 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 137, location: '¶137', content: '시스템 보안 체계 수립', table_index: 0, table_cols: 5, table_row: 8, table_col: 2 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 138, location: '¶138', content: '보안성 검토 기준 수립', table_index: 0, table_cols: 5, table_row: 8, table_col: 3 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 139, location: '¶139', content: '보안성 검토 보고서', table_index: 0, table_cols: 5, table_row: 8, table_col: 4 },
        { id: crypto.randomUUID(), document_id: docId, sequence_no: 140, location: '¶140', content: '보안 기준 1식 수립', table_index: 0, table_cols: 5, table_row: 8, table_col: 5 },
      ];
      insertParagraphs(tableParas, db);
    }
  }

  // 2-1. 국문 PCP 자료 시드 등록
  const pcpDocId = 'doc-korean-pcp';
  createDocument(
    {
      id: pcpDocId,
      project_id: projectId,
      file_name: '00_korean_pcp.pdf',
      file_type: 'pdf' as any,
      status: '추출 완료',
      doc_type: '국문 PCP' as any,
      is_included: 1,
      excluded_reason: null,
      masked: true,
      approved_ai: 'solar',
      is_past_final_report: false,
      created_at: new Date().toISOString(),
    },
    db
  );
  insertParagraphs(
    [
      {
        id: crypto.randomUUID(),
        document_id: pcpDocId,
        sequence_no: 1,
        location: '1쪽 ¶1',
        content: '본 사업의 국문 사업제안서(PCP) 내용으로 디지털 행정 기반 구축 및 핵심 공무원 500명 직무 교육 계획을 명시한다.',
        table_index: null,
        table_cols: null,
        table_row: null,
        table_col: null,
      },
    ],
    db
  );

  // 3. 지표 등록 및 ToC 계층·충돌 동기화
  for (const ind of SEED_INDICATORS) {
    const record: IndicatorRecord = {
      ...ind,
      project_id: projectId,
      created_at: new Date().toISOString(),
    };
    createIndicator(record, db);
  }

  // ToC 계층 및 충돌 동기화 (#19)
  syncTocForProject(projectId);
  const indicators = listIndicators(projectId, db);

  // 4. AI 판정 제안 생성 및 저장
  const fakeAiClient: AiClient | undefined = isFakeAi ? createE2EFakeAiClient() : undefined;
  const paragraphs = buildSuggestInput(projectId, db, fakeAiClient?.provider);

  for (const indicator of indicators) {
    const result = await suggestVerdictForIndicator(indicator, paragraphs, {
      aiClient: fakeAiClient,
      saveToStore: true,
    });

    // 스키마 위반 등으로 suggest 내부에서 저장되지 않은 경우 DB에 '미확인'+오류사유 제안으로 기록
    if (!result.saved && result.suggestion.error_reason) {
      saveSuggestion(result.suggestion, result.evidences, db);
    }

    console.log(
      `  - 지표 [${indicator.level}] ${indicator.name}: 판정 '${result.suggestion.verdict_status}' (근거 ${result.evidences.length}건, 저장: true)`
    );
  }

  console.log(`[시드 완료] 프로젝트 '${projectId}' 초기화 및 판정 제안 생성 완료`);

  // 5. E2E 및 개발용 복수 충돌 시드 프로젝트 (proj-multi-conflict) (#19 검수 4회차 2번)
  if (!options.projectId) {
    const mcProjectId = 'proj-multi-conflict';
    createProject(
      {
        id: mcProjectId,
        name: '복수 충돌 테스트 사업',
        created_at: new Date().toISOString(),
      },
      db
    );

    createDocument(
      {
        id: 'doc-mc-plan-1',
        project_id: mcProjectId,
        file_name: '01_project_plan.hwpx',
        file_type: 'hwpx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        masked: true,
        approved_ai: 'solar',
        is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: crypto.randomUUID(),
          document_id: 'doc-mc-plan-1',
          sequence_no: 1,
          location: '¶1',
          content: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-mc-plan-2',
        project_id: mcProjectId,
        file_name: '05_other_project.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '사업계획서',
        is_included: 1,
        excluded_reason: null,
        masked: true,
        approved_ai: 'solar',
        is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    insertParagraphs(
      [
        {
          id: crypto.randomUUID(),
          document_id: 'doc-mc-plan-2',
          sequence_no: 1,
          location: '¶1',
          content: '연계 사업 추진 결과 행정 시스템 이용 만족도 90% 달성을 목표로 한다.',
        },
      ],
      db
    );

    createDocument(
      {
        id: 'doc-mc-pdm',
        project_id: mcProjectId,
        file_name: '02_pdm.docx',
        file_type: 'docx',
        status: '추출 완료',
        doc_type: '성과관리표',
        is_included: 1,
        excluded_reason: null,
        masked: true,
        approved_ai: 'solar',
        is_past_final_report: false,
        created_at: new Date().toISOString(),
      },
      db
    );
    const mcTableParas: ParagraphRecord[] = [
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 1, location: '¶1', content: '구분', table_row: 1, table_col: 1 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 2, location: '¶2', content: '지표명', table_row: 1, table_col: 2 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 3, location: '¶3', content: '성과지표', table_row: 1, table_col: 3 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 4, location: '¶4', content: '검증수단', table_row: 1, table_col: 4 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 5, location: '¶5', content: '목표값', table_row: 1, table_col: 5 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 6, location: '¶6', content: '영향', table_row: 2, table_col: 1 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 7, location: '¶7', content: '대국민 행정 편의 증진', table_row: 2, table_col: 2 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 8, location: '¶3', content: '대국민 전자정부 서비스 체감 만족도', table_row: 2, table_col: 3 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 9, location: '¶9', content: '대국민 설문조사 보고서', table_row: 2, table_col: 4 },
      { id: crypto.randomUUID(), document_id: 'doc-mc-pdm', sequence_no: 10, location: '¶10', content: '5점 척도 3.5점', table_row: 2, table_col: 5 },
    ];
    insertParagraphs(mcTableParas, db);

    syncTocForProject(mcProjectId);
  }

  return { projectId, dbPath };
}

export const SEED_RESET_INDICATOR_ID = 'ind-output';

export interface BuildSeedIndicatorSuggestionOptions {
  db?: DbConnection;
  dbPath?: string;
  projectId?: string;
  indicatorId?: string;
  now?: string;
}

/**
 * seed-dev.ts 의 가짜 AI 시드 생성 경로를 그대로 써서
 * 고정 대상 지표(proj-dev-seed / ind-output)의 초기 시드 제안과 근거(및 인용 금지 알림 상태)를 계산한다.
 * 읽기 전용 DB 연결만 사용하며 DB 에 쓰지 않고(saveToStore: false) 계산된 레코드만 돌려준다.
 */
export async function buildSeedIndicatorSuggestion(
  options: BuildSeedIndicatorSuggestionOptions = {}
): Promise<{
  projectId: string;
  indicator: IndicatorRecord;
  suggestion: SuggestionRecord;
  evidences: EvidenceRecord[];
}> {
  const projectId = options.projectId ?? SEED_PROJECT_ID;
  const indicatorId = options.indicatorId ?? SEED_RESET_INDICATOR_ID;
  if (projectId !== SEED_PROJECT_ID || indicatorId !== SEED_RESET_INDICATOR_ID) {
    throw new Error(
      `초기 시드 제안 복원 대상은 '${SEED_PROJECT_ID}' / '${SEED_RESET_INDICATOR_ID}' 으로 고정되어 있습니다.`
    );
  }

  const dbPath =
    options.dbPath ?? process.env.AIEAS_DB_PATH ?? path.resolve(process.cwd(), 'aieas-dev.db');

  const ownedReadonlyDb = options.db ? null : openReadonlyDatabase(dbPath);
  const db = options.db ?? ownedReadonlyDb!;
  try {
    const indicators = listIndicators(projectId, db);
    const indicator = indicators.find((i) => i.id === indicatorId);
    if (!indicator) {
      throw new Error(`사업 '${projectId}' 에서 지표 '${indicatorId}' 를 찾을 수 없습니다.`);
    }

    const fakeAiClient = createE2EFakeAiClient();
    const paragraphs = buildSuggestInput(projectId, db, fakeAiClient.provider);
    const result = await suggestVerdictForIndicator(indicator, paragraphs, {
      aiClient: fakeAiClient,
      saveToStore: false,
      now: options.now,
      db,
    });

    return {
      projectId,
      indicator,
      suggestion: result.suggestion,
      evidences: result.evidences,
    };
  } finally {
    if (ownedReadonlyDb) {
      ownedReadonlyDb.close();
    }
  }
}

// CLI 실행 처리
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('seed-dev.ts') ||
    (typeof import.meta !== 'undefined' &&
      import.meta.url === fileURLToPath(import.meta.url)));

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const fakeAi = args.includes('--fake-ai');
  const dbIndex = args.indexOf('--db');
  const dbPath = dbIndex !== -1 && args[dbIndex + 1] ? args[dbIndex + 1] : undefined;
  const projIndex = args.indexOf('--project-id');
  const projectId = projIndex !== -1 && args[projIndex + 1] ? args[projIndex + 1] : undefined;

  seedDev({ fakeAi, dbPath, projectId })
    .then(() => {
      closeDatabase();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[시드 오류]', err);
      closeDatabase();
      process.exit(1);
    });
}
