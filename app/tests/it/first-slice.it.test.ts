import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractDocument } from '../../src/server/extract';
import { suggestVerdictForIndicator } from '../../src/server/suggest';
import {
  closeDatabase,
  createDocument,
  createIndicator,
  createProject,
  getParagraph,
  getParagraphsByProject,
  getLatestSuggestion,
  insertParagraphs,
  openDatabase,
  VERDICT_STATUSES,
  type IndicatorRecord,
  type EvidenceRecord,
  type SuggestionRecord,
} from '../../src/server/store';
import { verifyQuote } from '../../src/server/quote-verify';
import { isSpeaker } from '../../src/server/store/types';
import answers from '../../fixtures/answers.json';

// ============================================================================
// 1. 필수 환경변수 사전 검사 (환경변수 없으면 즉시 실패, 건너뛰지 않는다)
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

function getNGrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - n; i++) {
    grams.add(text.slice(i, i + n));
  }
  return grams;
}

function get8Grams(text: string): Set<string> {
  return getNGrams(text, 8);
}

function get15Grams(text: string): Set<string> {
  return getNGrams(text, 15);
}

describe('첫 슬라이스 통합 시험 (실제 저장, 실제 추출, 실제 AI) (RQ-03, RQ-09~12, RQ-25~27)', () => {
  const hadOriginal = 'AIEAS_DB_PATH' in process.env;
  const originalDbPath = process.env.AIEAS_DB_PATH;
  let tempDbPath: string;
  const fixturesDir = path.resolve(__dirname, '../../fixtures');
  const projectId = 'proj-it-first-slice';

  // 검사 대상 지표 목록 정의
  const testIndicators: IndicatorRecord[] = [
    // (1) 근거 있는 지표 1 (활동: 핵심 공무원 500명 이수 달성 증빙 포함)
    {
      id: 'ind-supported-activity',
      project_id: projectId,
      level: answers.performance_pathway.activity.level as any,
      name: answers.performance_pathway.activity.name,
      ovi: answers.performance_pathway.activity.ovi,
      mov: answers.performance_pathway.activity.mov,
      target_value: answers.performance_pathway.activity.target_value,
      is_baseline: 0,
      created_at: new Date().toISOString(),
    },
    // (2) "근거 없는 판단" 함정 지표 1 (문서에 아무런 근거가 없는 지표 -> 기대 판정: 미확인)
    {
      id: 'ind-trap-unsupported',
      project_id: projectId,
      level: '단기성과',
      name: '디지털 법제 정비',
      ovi: '가상국 디지털 법제 정비율',
      mov: '가상국 법제처 공보',
      target_value: '100% 달성',
      is_baseline: 0,
      created_at: new Date().toISOString(),
    },
    // (3) 수치 충돌 함정 지표 1 (영향: 5점 척도 3.5점 vs 80% 수치 충돌)
    {
      id: 'ind-trap-conflict',
      project_id: projectId,
      level: answers.performance_pathway.impact.level as any,
      name: answers.performance_pathway.impact.name,
      ovi: answers.performance_pathway.impact.ovi,
      mov: answers.performance_pathway.impact.mov,
      target_value: answers.performance_pathway.impact.target_value,
      is_baseline: 0,
      created_at: new Date().toISOString(),
    },
  ];

  beforeAll(async () => {
    // 환경변수 부재 시 즉시 예외를 던져 테스트 전체가 실패하도록 함
    checkRequiredEnvironment();

    // 1. 실제 저장 계층 관통: 임시 SQLite 파일 준비
    tempDbPath = path.join(
      os.tmpdir(),
      `aieas-first-slice-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`
    );
    process.env.AIEAS_DB_PATH = tempDbPath;
    openDatabase(tempDbPath);

    // 2. 가상 사업 저장
    createProject({
      id: projectId,
      name: answers.project_name,
      created_at: new Date().toISOString(),
    });

    // 3. 포함 문서 추출 및 문단 저장 (제외 대상 함정 문서는 빼고, answers.json 의 제외 목록 사용)
    const includedDocs = answers.documents.filter((d) => !d.is_excluded);
    for (const docMeta of includedDocs) {
      const filePath = path.join(fixturesDir, docMeta.file_name);
      const fileBuffer = fs.readFileSync(filePath);
      const fileExt = path.extname(docMeta.file_name).replace('.', '');

      const extraction = await extractDocument(fileBuffer, fileExt);
      const docId = `doc-${docMeta.file_name}`;

      createDocument({
        id: docId,
        project_id: projectId,
        file_name: docMeta.file_name,
        file_type: fileExt as any,
        status: extraction.status,
        doc_type: docMeta.doc_type as any,
        is_included: 1,
        excluded_reason: null,
        created_at: new Date().toISOString(),
      });

      if (extraction.paragraphs.length > 0) {
        insertParagraphs(
          extraction.paragraphs.map((p) => ({
            id: crypto.randomUUID(),
            document_id: docId,
            sequence_no: p.sequence_no,
            location: p.location,
            content: p.content,
          }))
        );
      }
    }

    // 4. 지표 저장
    for (const ind of testIndicators) {
      createIndicator(ind);
    }
  }, 300000);

  afterAll(() => {
    closeDatabase();
    if (tempDbPath && fs.existsSync(tempDbPath)) {
      try {
        fs.rmSync(tempDbPath, { force: true });
      } catch {
        // 무시
      }
    }
    if (hadOriginal && originalDbPath !== undefined) {
      process.env.AIEAS_DB_PATH = originalDbPath;
    } else {
      delete process.env.AIEAS_DB_PATH;
    }
  });

  it(
    '가상 사업의 지표들에 대해 suggest 실행 후 저장 결과를 전수 검증한다',
    async () => {
      const paragraphs = getParagraphsByProject(projectId, true);
      expect(paragraphs.length).toBeGreaterThan(0);

      const allSavedSuggestions: SuggestionRecord[] = [];
      const allSavedEvidences: EvidenceRecord[] = [];
      const executionReceipts: Array<Record<string, unknown>> = [];

      for (const indicator of testIndicators) {
        // 실제 AI 호출 및 관통 실행
        const result = await suggestVerdictForIndicator(indicator, paragraphs);

        // 호출 기록(영수증): 지표별 토큰 수·시간·판정 상태·근거 수를 표준출력 JSON 한 줄로 출력
        // (키·주소·응답 본문 전체는 절대로 출력하지 않음)
        const receipt = {
          indicator_id: indicator.id,
          indicator_name: indicator.name,
          level: indicator.level,
          verdict_status: result.suggestion.verdict_status,
          duration_ms: result.meta?.duration_ms ?? 0,
          tokens: {
            prompt_tokens: result.meta?.usage?.prompt_tokens ?? 0,
            completion_tokens: result.meta?.usage?.completion_tokens ?? 0,
            reasoning_tokens: result.meta?.usage?.reasoning_tokens ?? 0,
            total_tokens: result.meta?.usage?.total_tokens ?? 0,
          },
          evidences_count: result.evidences.length,
        };
        executionReceipts.push(receipt);
        console.log(`IT-RECEIPT ${JSON.stringify(receipt)}`);

        // DB에서 실제로 저장된 결과를 다시 조회
        const latestFromDb = getLatestSuggestion(indicator.id);
        expect(latestFromDb).toBeDefined();
        if (latestFromDb) {
          allSavedSuggestions.push(latestFromDb);
          allSavedEvidences.push(...latestFromDb.evidences);
        }
      }

      // ------------------------------------------------------------------------
      // (a) 모든 저장 판정이 다섯 상태 중 하나
      // ------------------------------------------------------------------------
      for (const suggestion of allSavedSuggestions) {
        expect(VERDICT_STATUSES).toContain(suggestion.verdict_status);
      }

      // ------------------------------------------------------------------------
      // (b) 저장된 모든 근거가 원문 문단 대조를 다시 통과 (저장 후 DB 에서 읽어 재대조)
      // ------------------------------------------------------------------------
      for (const ev of allSavedEvidences) {
        const dbParagraph = getParagraph(ev.document_id, ev.location);
        expect(
          dbParagraph,
          `근거에 해당하는 문단이 DB에 존재해야 함 (문서: ${ev.document_id}, 위치: ${ev.location})`
        ).toBeDefined();

        expect(
          verifyQuote(ev.quote, dbParagraph!.content),
          `근거 인용("${ev.quote}")이 DB 원문 문단에 포함되어야 함`
        ).toBe(true);
      }

      // ------------------------------------------------------------------------
      // (c) 근거 네 항목(인용, 문서 ID, 위치, 말한 사람) 비어 있지 않음
      // ------------------------------------------------------------------------
      for (const ev of allSavedEvidences) {
        expect(ev.quote.trim().length).toBeGreaterThan(0);
        expect(ev.document_id.trim().length).toBeGreaterThan(0);
        expect(ev.location.trim().length).toBeGreaterThan(0);
        expect(ev.speaker.trim().length).toBeGreaterThan(0);
        expect(isSpeaker(ev.speaker)).toBe(true);
      }

      // ------------------------------------------------------------------------
      // (d) "근거 없는 판단" 함정 지표는 "미확인"
      // ------------------------------------------------------------------------
      const unsupportedSuggestion = allSavedSuggestions.find(
        (s) => s.indicator_id === 'ind-trap-unsupported'
      );
      expect(unsupportedSuggestion).toBeDefined();
      expect(unsupportedSuggestion!.verdict_status).toBe('미확인');

      // ------------------------------------------------------------------------
      // (e) 제외 문서 검사: 저장된 각 근거 인용(정규화 뒤)이 어떤 제외 문서 문단의
      //     부분 문자열이면 실패. 또 저장된 각 근거의 문서 id 가 제외 문서 id 가 아님을 단언.
      //     저장된 제안 문장(proposal_text, 정규화)과 각 제외 문서 문단(정규화) 사이에
      //     길이 15자 이상 공통 부분 문자열이 없음을 단언(문자 15-gram 교집합).
      // ------------------------------------------------------------------------
      const excludedDocs = answers.documents.filter((d) => d.is_excluded);
      const excludedParagraphs: string[] = [];
      for (const exDoc of excludedDocs) {
        const filePath = path.join(fixturesDir, exDoc.file_name);
        const fileBuffer = fs.readFileSync(filePath);
        const fileExt = path.extname(exDoc.file_name).replace('.', '');
        const extraction = await extractDocument(fileBuffer, fileExt);
        for (const p of extraction.paragraphs) {
          const norm = p.content.replace(/\s+/g, ' ').trim();
          if (norm.length > 0) {
            excludedParagraphs.push(norm);
          }
        }
      }
      expect(
        excludedParagraphs.length,
        '제외 문서에서 추출된 문단이 존재해야 함'
      ).toBeGreaterThan(0);

      for (const ev of allSavedEvidences) {
        const normQuote = ev.quote.replace(/\s+/g, ' ').trim();
        for (const exPara of excludedParagraphs) {
          expect(
            exPara.includes(normQuote),
            `저장된 각 근거 인용("${normQuote}")이 제외 문서 문단("${exPara}")의 부분 문자열이면 안 됨`
          ).toBe(false);
        }

        for (const exDoc of excludedDocs) {
          expect(ev.document_id).not.toBe(`doc-${exDoc.file_name}`);
          expect(ev.document_id).not.toBe(exDoc.file_name);
        }
      }

      // 저장된 제안 문장(proposal_text, 정규화)과 각 제외 문서 문단(정규화) 사이에
      // 길이 15자 이상 공통 부분 문자열이 없음을 단언한다(문자 15-gram 교집합). 공통 일반 어구 오탐을 줄이려 15자로 한다.
      for (const suggestion of allSavedSuggestions) {
        if (suggestion.proposal_text) {
          const normProposal = suggestion.proposal_text.replace(/\s+/g, ' ').trim();
          const proposalGrams = get15Grams(normProposal);

          for (const exPara of excludedParagraphs) {
            const exParaGrams = get15Grams(exPara);
            const commonGramsWithProposal = [...proposalGrams].filter((g) =>
              exParaGrams.has(g)
            );
            expect(
              commonGramsWithProposal,
              `저장된 제안 문장("${normProposal}")과 제외 문서 문단("${exPara}") 사이에 15자 이상 공통 부분 문자열이 없어야 함 (공통 15-gram: ${commonGramsWithProposal.join(', ')})`
            ).toEqual([]);
          }
        }
      }

      // ------------------------------------------------------------------------
      // (f) 인용 금지 검사: 인용 금지 문단에서 찾은 금지 문장(정규화)과,
      //     저장된 모든 제안 문장·근거 인용(정규화) 사이에 길이 8자 이상 공통 부분 문자열이
      //     하나도 없음을 단언한다(문자 8-gram 집합 교집합이 비어 있음).
      // ------------------------------------------------------------------------
      const doNotQuoteParagraph = paragraphs.find((p) =>
        p.content.includes('이름을 밝히지 말아 달라고 요청')
      );
      expect(
        doNotQuoteParagraph,
        '추출 결과에서 인용 금지 문단 전체(이름을 밝히지 말아 달라고 요청)를 찾을 수 있어야 함'
      ).toBeDefined();

      const forbiddenParagraphContent = doNotQuoteParagraph!.content;
      // 마침표 기준 분할, 정규화 뒤 8자 이상인 모든 문장
      const forbiddenSentences = forbiddenParagraphContent
        .split('.')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 8);

      expect(
        forbiddenSentences.length,
        '인용 금지 문단에서 분할된 8자 이상의 문장이 존재해야 함'
      ).toBeGreaterThan(0);

      for (const sentence of forbiddenSentences) {
        const normForbidden = sentence.replace(/\s+/g, ' ').trim();
        const forbiddenGrams = get8Grams(normForbidden);

        // 저장된 모든 근거 인용(정규화)과 비교: 공통 8-gram 집합이 비어 있어야 함
        for (const ev of allSavedEvidences) {
          const normQuote = ev.quote.replace(/\s+/g, ' ').trim();
          const quoteGrams = get8Grams(normQuote);
          const commonGramsWithQuote = [...forbiddenGrams].filter((g) => quoteGrams.has(g));
          expect(
            commonGramsWithQuote,
            `금지 문장("${normForbidden}")과 저장된 근거 인용("${normQuote}") 사이에 8자 이상 공통 부분 문자열이 없어야 함 (공통 8-gram: ${commonGramsWithQuote.join(', ')})`
          ).toEqual([]);
        }

        // 저장된 모든 제안 문장(정규화)과 비교: 공통 8-gram 집합이 비어 있어야 함
        for (const suggestion of allSavedSuggestions) {
          if (suggestion.proposal_text) {
            const normProposal = suggestion.proposal_text.replace(/\s+/g, ' ').trim();
            const proposalGrams = get8Grams(normProposal);
            const commonGramsWithProposal = [...forbiddenGrams].filter((g) =>
              proposalGrams.has(g)
            );
            expect(
              commonGramsWithProposal,
              `금지 문장("${normForbidden}")과 저장된 제안 문장("${normProposal}") 사이에 8자 이상 공통 부분 문자열이 없어야 함 (공통 8-gram: ${commonGramsWithProposal.join(', ')})`
            ).toEqual([]);
          }
        }
      }

      // ------------------------------------------------------------------------
      // (g) 근거 있는 지표는 저장 근거 1개 이상, 근거 충돌 함정 지표는 근거 2개 이상 단언
      // ------------------------------------------------------------------------
      const supportedSuggestion = allSavedSuggestions.find(
        (s) => s.indicator_id === 'ind-supported-activity'
      );
      expect(supportedSuggestion).toBeDefined();
      const supportedEvidences = allSavedEvidences.filter(
        (e) => e.suggestion_id === supportedSuggestion!.id
      );
      expect(
        supportedEvidences.length,
        '근거 있는 지표(ind-supported-activity)는 저장 근거가 1개 이상이어야 함'
      ).toBeGreaterThanOrEqual(1);

      const conflictSuggestion = allSavedSuggestions.find(
        (s) => s.indicator_id === 'ind-trap-conflict'
      );
      expect(conflictSuggestion).toBeDefined();
      const conflictEvidences = allSavedEvidences.filter(
        (e) => e.suggestion_id === conflictSuggestion!.id
      );
      expect(
        conflictEvidences.length,
        '근거 충돌 함정 지표(ind-trap-conflict)는 저장 근거가 2개 이상이어야 함'
      ).toBeGreaterThanOrEqual(2);

      // VERDICT_STATUSES 에 속하는 것만 확인(위의 (a)에서 검증 완료), 값 자체는 단언 없이 기록
      console.log(
        `[IT RECORD] 근거 있는 지표 판정 결과: ${supportedSuggestion!.verdict_status} (근거 수: ${supportedEvidences.length})`
      );
      console.log(
        `[IT RECORD] 근거 충돌 지표 판정 결과: ${conflictSuggestion!.verdict_status} (근거 수: ${conflictEvidences.length})`
      );
    },
    1800000 // 3개 지표 전체 30분
  );
});
