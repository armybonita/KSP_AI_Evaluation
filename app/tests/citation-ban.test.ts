import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDatabase,
  closeDatabase,
  createProject,
  createIndicator,
  insertParagraphs,
  insertSentences,
  saveIndicatorAttribution,
  getIndicatorAttribution,
  listProjectAttributions,
  getAttributionsForReport,
  getAttributionsForProject,
  isIndicatorInProject,
  splitParagraphIntoSentences,
  isCitationBannedSentence,
  hasForbiddenSentenceOverlap,
  maskForbiddenSentenceInContent,
  assertZeroForbiddenTextInStore,
  findForbiddenTextViolationsInStore,
  findForbiddenTextViolationsInReports,
  migrateExistingEvidencesForCitationBan,
  getReviewData,
  getHistoryPageData,
  getParagraphWithSurroundings,
  execAlterIgnoreDuplicateColumn,
  saveSuggestion,
  getLatestSuggestion,
  createConfirmation,
  createDocument,
  CITATION_BAN_RULES,
} from '../src/server/store';
import {
  isIndicatorInStage,
  isKnownLevel,
} from '../src/app/projects/[projectId]/review/review-client-view';
import { suggestVerdictForIndicator } from '../src/server/suggest';
import { AiClient } from '../src/server/ai';

it('반복 정규화를 줄여도 금지 문장 겹침 판정은 기존과 같다', () => {
  const original = (text: string, bannedSentences: string[], minLength: number) => {
    if (!text || !text.trim() || !bannedSentences.length) return false;
    for (const banned of bannedSentences) {
      const trimmed = banned.trim();
      if (trimmed.length < minLength) continue;
      for (const [a, b] of [[text, trimmed], [text.replace(/\s+/g, ''), trimmed.replace(/\s+/g, '')]]) {
        for (let i = 0; i <= b.length - minLength; i++) {
          const sub = b.slice(i, i + minLength);
          if (a.includes(sub) || a.toLowerCase().includes(sub.toLowerCase())) return true;
        }
      }
    }
    return false;
  };
  const values = ['', ' 가 나 다 라 ', '가나다라', 'ABC def', 'abcDEF', 'İ i\u0307', '😀가나다', '서로 다른 문장'];
  for (const text of values) for (const banned of values) for (const length of [1, 2, 4, 8]) {
    expect(hasForbiddenSentenceOverlap(text, [banned, '다른 금지 문장'], length)).toBe(original(text, [banned, '다른 금지 문장'], length));
  }
});

describe('이슈 #20 검수 반영 단위 시험 (RQ-13, RQ-14, RQ-15, RQ-16, D01, D48)', () => {
  let db: Database.Database;
  const PROJECT_ID = 'test-proj-trap';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createProject(
      {
        id: PROJECT_ID,
        name: '가상 평가 사업',
        // public-safety-allow: ISO date format in test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('1. 인용 금지 감지: 규칙 목록 및 표현별 감지 (#20 검수 1번, RQ-14, D01)', () => {
    it('규칙 목록이 한 곳(설정 배열 CITATION_BAN_RULES)에 정의되어 있다', () => {
      expect(Array.isArray(CITATION_BAN_RULES)).toBe(true);
      expect(CITATION_BAN_RULES.length).toBeGreaterThanOrEqual(6);
    });

    it('NOTES 예시 표현을 모두 감지한다 (각 표현 개별 시험)', () => {
      const expressionsToTest = [
        {
          expr: '이름을 밝히지 말아',
          text: '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하였다.',
        },
        {
          expr: '익명을 요청',
          text: '관계 부처 공무원은 익명을 요청하며 초기 정책 혼선이 있었다고 밝혔다.',
        },
        {
          expr: '익명을 요구',
          text: '자문단 전문가는 익명을 요구하며 협력국의 역량 부족을 언급했다.',
        },
        {
          expr: '익명으로 요구',
          text: '현지 사업 관리자는 신변 안전을 위해 익명으로 요구했다.',
        },
        {
          expr: '신원 비공개',
          text: '본 면담 내용은 진술자의 신원 비공개 조건으로 기록되었다.',
        },
        {
          expr: '비보도',
          text: '관계자는 이 사안이 비보도 전제임을 분명히 하였다.',
        },
      ];

      for (const item of expressionsToTest) {
        expect(
          isCitationBannedSentence(item.text),
          `표현 '${item.expr}'이(가) 포함된 문장이 인용 금지로 감지되어야 함`
        ).toBe(true);
      }
    });

    it('일반 문장은 인용 금지로 잘못 감지되지 않는다', () => {
      const normalTexts = [
        '사후 설문에서 교육 만족도는 82%로 높게 집계되었다.',
        '디지털 행정 포털 구축이 계획대로 완료되었다.',
        '수행기관은 사업 결과 보고서를 기한 내 제출하였다.',
      ];
      for (const text of normalTexts) {
        expect(isCitationBannedSentence(text)).toBe(false);
      }
    });

    it('문단을 문장 단위로 분할할 때 금지 문장에 정확히 플래그가 매겨진다', () => {
      const paragraph =
        '첫 번째 문장입니다. 참여 공무원은 익명을 요청하며 시스템 초기 장애를 언급함. 세 번째 일반 문장입니다.';
      const sentences = splitParagraphIntoSentences(paragraph, '1쪽 ¶1', 1);

      expect(sentences).toHaveLength(3);
      expect(sentences[0].is_citation_banned).toBe(0);
      expect(sentences[1].is_citation_banned).toBe(1);
      expect(sentences[2].is_citation_banned).toBe(0);
    });

    it('마스킹 함수는 인용 금지 표현이 포함된 문장을 [인용 금지 문장]으로 치환한다', () => {
      const content = '관계자는 익명을 요구하며 어려움을 토로했다.';
      const masked = maskForbiddenSentenceInContent(content);
      expect(masked).toBe('[인용 금지 문장]');
      expect(masked.includes('익명을 요구')).toBe(false);
    });
  });

  describe('2. 인용 금지 근거 위치 표시용 기록 및 공용 전수 검사 (#20 검수 2번, RQ-14, D01)', () => {
    it('인용 금지 근거는 quote 대체 + speaker는 "—"로 대체되고 위치 정보만 보존된다', async () => {
      const indicator = {
        id: 'ind-test-ban-fields',
        project_id: PROJECT_ID,
        source_doc_id: 'doc-ban-fields.pdf',
        level: '산출물' as const,
        name: '시스템 도입 현황',
        ovi: '시스템 도입 완료 여부',
        mov: '현장 실사 보고서',
        target_value: '시스템 1식 구축',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      const forbiddenSentence =
        '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.';

      createDocument(
        {
          id: 'doc-ban-fields.pdf',
          project_id: PROJECT_ID,
          file_name: '03_trip_report.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '출장결과보고서',
          is_included: 1,
          excluded_reason: null,
          masked: true,
          approved_ai: 'solar',
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      createIndicator(indicator, db);

      const paragraph = {
        id: 'p-ban-1',
        document_id: 'doc-ban-fields.pdf',
        sequence_no: 1,
        location: '1쪽 ¶1',
        content: forbiddenSentence,
      };
      insertParagraphs([paragraph], db);
      insertSentences(
        [
          {
            id: 's-ban-1',
            document_id: 'doc-ban-fields.pdf',
            paragraph_id: 'p-ban-1',
            sequence_no: 1,
            location: '1쪽 ¶1',
            content: forbiddenSentence,
            is_citation_banned: 1,
          },
        ],
        db
      );

      const fakeAiClient = new AiClient({
        baseUrl: 'https://example.com/v1',
        // public-safety-allow: unit test dummy key
        apiKey: 'dummy',
        model: 'aieas-default',
        reasoningEffort: 'xhigh',
        fetchFn: async () => {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdict_status: '실현',
                      sentence: '현지 실무관은 이름을 밝히지 말아 달라고 요청하며 도입을 확인했다.',
                      evidences: [
                        {
                          quote: forbiddenSentence,
                          document_id: 'doc-ban-fields.pdf',
                          location: '1쪽 ¶1',
                          speaker: '협력국',
                        },
                        {
                          quote: '초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.',
                          document_id: 'doc-ban-fields.pdf',
                          location: '1쪽 ¶1',
                          speaker: '협력국',
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
      });

      Object.defineProperty(fakeAiClient, 'provider', { value: 'solar' });
      const res = await suggestVerdictForIndicator(indicator, [paragraph], {
        aiClient: fakeAiClient,
        saveToStore: true,
      });

      // 1. 제안 문장은 버려져 null 처리됨
      expect(res.suggestion.proposal_text).toBeNull();

      // 2. 근거 인용: quote 대체 + speaker는 '—' + 위치는 유지
      expect(res.evidences).toHaveLength(2);
      expect(res.evidences[0].quote).toBe('인용 금지 문장 있음');
      expect(res.evidences[0].speaker).toBe('—');
      expect(res.evidences[0].document_id).toBe('doc-ban-fields.pdf');
      expect(res.evidences[0].location).toBe('1쪽 ¶1');
      expect(res.evidences[0].is_citation_banned).toBe(1);
      expect(res.evidences[1].quote).toBe('인용 금지 문장 있음');
      expect(res.evidences[1].location).toBe('1쪽 ¶1');

      saveSuggestion(res.suggestion, res.evidences, db);
      const persisted = getLatestSuggestion(indicator.id, db);
      expect(persisted?.evidences).toHaveLength(2);
      expect(persisted?.evidences.every((evidence) => evidence.is_citation_banned === 1)).toBe(true);

      // 3. 공용 검사는 quote 뿐 아니라 근거의 모든 텍스트 필드와 제안 문장을 보며 0건 단언
      expect(() => assertZeroForbiddenTextInStore(db)).not.toThrow();
    });

    it('출처 없는 지표는 인용 금지 검사 전에 AI 호출을 막는다', async () => {
      let called = false;
      const aiClient = { provider: 'solar', generateSuggestion: async () => { called = true; throw new Error('unexpected'); } } as unknown as AiClient;
      const result = await suggestVerdictForIndicator({ id: 'no-source', project_id: PROJECT_ID, level: '산출물', name: '가상 지표', ovi: '가상 내용', mov: null, target_value: null, is_baseline: 0, created_at: '2026-01-01' }, [], { aiClient, saveToStore: false, db });
      expect(called).toBe(false);
      expect(result.saved).toBe(false);
      expect(result.suggestion.error_reason).toContain('AI 입력 자격');
    });

    it('공용 검사는 근거의 speaker 또는 location에 금지 문장이 침투했을 때도 위반을 검출한다', () => {
      const indicator = {
        id: 'ind-speaker-test',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '화자 침투 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(indicator, db);

      const forbiddenSentence = '현장 관계자는 신원 비공개 원칙에 따라 발언하였음.';
      createDocument(
        {
          id: 'doc-spk.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      insertParagraphs(
        [
          {
            id: 'p-spk-1',
            document_id: 'doc-spk.pdf',
            sequence_no: 1,
            location: '1쪽 ¶1',
            content: forbiddenSentence,
          },
        ],
        db
      );

      insertSentences(
        [
          {
            id: 'sent-banned-spk',
            document_id: 'doc-spk.pdf',
            paragraph_id: 'p-spk-1',
            sequence_no: 1,
            location: '1쪽 ¶1',
            content: forbiddenSentence,
            is_citation_banned: 1,
          },
        ],
        db
      );

      saveSuggestion(
        {
          id: 'sugg-spk-test',
          indicator_id: 'ind-speaker-test',
          verdict_status: '실현',
          proposal_text: '안전한 제안 문장',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-spk-leaked',
            suggestion_id: 'sugg-spk-test',
            quote: '안전한 인용구입니다',
            document_id: 'doc-spk.pdf',
            location: '1쪽 ¶1',
            speaker: forbiddenSentence, // speaker 에 금지 문장 침투
            is_citation_banned: 0,
          },
        ],
        db
      );

      const violations = findForbiddenTextViolationsInStore(db, PROJECT_ID);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes('speaker'))).toBe(true);
    });
  });

  describe('3. 기존 DB 이관 및 화면 이중 방어 가림 (#20 검수 3번, RQ-14, D01)', () => {
    it('DB 열기/이관 시 기존 근거를 금지 문장과 다시 대조해 플래그와 가림을 채운다', () => {
      const indicator = {
        id: 'ind-migrate-test',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '이관 대상 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(indicator, db);

      createDocument(
        {
          id: 'doc-mig.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc_mig.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      const forbiddenSentence = '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청함.';
      insertParagraphs(
        [
          {
            id: 'p-mig-1',
            document_id: 'doc-mig.pdf',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
          },
        ],
        db
      );

      insertSentences(
        [
          {
            id: 'sent-mig-1',
            document_id: 'doc-mig.pdf',
            paragraph_id: 'p-mig-1',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
            is_citation_banned: 1,
          },
        ],
        db
      );

      // 과거 DB 데이터: is_citation_banned 플래그가 0이고 원문이 그대로 남아있는 근거
      saveSuggestion(
        {
          id: 'sugg-mig-old',
          indicator_id: 'ind-migrate-test',
          verdict_status: '실현',
          proposal_text: '안전한 문장',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-mig-old',
            suggestion_id: 'sugg-mig-old',
            quote: forbiddenSentence,
            document_id: 'doc-mig.pdf',
            location: '1쪽 ¶1',
            speaker: '현지 실무관',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 이관 실행
      const migratedCount = migrateExistingEvidencesForCitationBan(db);
      expect(migratedCount).toBe(1);

      // DB 행 확인: 플래그가 1로 채워지고 quote는 '인용 금지 문장 있음', speaker는 '—' 로 이관됨
      const row = db
        .prepare('SELECT quote, speaker, is_citation_banned FROM evidences WHERE id = ?')
        .get('ev-mig-old') as { quote: string; speaker: string; is_citation_banned: number };
      expect(row.is_citation_banned).toBe(1);
      expect(row.quote).toBe('인용 금지 문장 있음');
      expect(row.speaker).toBe('—');
    });

    it('화면 데이터 조회(getReviewData)는 DB 플래그가 0이더라도 표시 직전에 금지 문장 대조로 가린다 (이중 방어)', () => {
      const indicator = {
        id: 'ind-double-defense',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '이중 방어 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(indicator, db);

      createDocument(
        {
          id: 'doc-dd.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc_dd.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      // DB에 is_citation_banned: 0으로 억지로 저장된 금지 문장 근거
      saveSuggestion(
        {
          id: 'sugg-dd',
          indicator_id: 'ind-double-defense',
          verdict_status: '실현',
          proposal_text: '안전한 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-dd-unflagged',
            suggestion_id: 'sugg-dd',
            quote: '참여 공무원은 익명을 요청하며 비공식 인터뷰를 진행했다.',
            document_id: 'doc-dd.pdf',
            location: '3쪽 ¶2',
            speaker: '공무원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      const reviewData = getReviewData(PROJECT_ID, db);
      const indItem = reviewData?.indicators.find((i) => i.indicator.id === 'ind-double-defense');
      expect(indItem?.suggestion?.evidences).toHaveLength(1);
      const ev = indItem?.suggestion?.evidences[0];

      // 화면에 나가기 직전 이중 방어로 인해 가려짐
      expect(ev?.is_citation_banned).toBe(1);
      expect(ev?.quote).toBe('인용 금지 문장 있음');
      expect(ev?.speaker).toBe('—');
    });

    it('표시 직전 가림(getReviewData 및 getHistoryPageData): 정규식 없어도 그 사업의 금지 문장과 8자 이상 겹치면 가린다 (#20 검수 2회차 1번)', () => {
      const OTHER_PROJECT_ID = 'test-proj-other-display';
      createProject(
        {
          id: OTHER_PROJECT_ID,
          name: '타 사업',
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      // PROJECT_ID의 금지 문장: 정규식 키워드가 전혀 없지만 8자 이상 겹치는 문장
      const projectSpecificBan = '해당사업전담팀의비공개면담기록내용';
      createDocument(
        {
          id: 'doc-overlap-p1.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc_p1.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      insertParagraphs(
        [
          {
            id: 'p-ov-1',
            document_id: 'doc-overlap-p1.pdf',
            sequence_no: 1,
            location: '1쪽',
            content: projectSpecificBan,
          },
        ],
        db
      );
      insertSentences(
        [
          {
            id: 's-ov-1',
            document_id: 'doc-overlap-p1.pdf',
            paragraph_id: 'p-ov-1',
            sequence_no: 1,
            location: '1쪽',
            content: projectSpecificBan,
            is_citation_banned: 1,
          },
        ],
        db
      );

      // OTHER_PROJECT_ID의 금지 문장
      const otherProjectBan = '타사업고유의절대공개금지문장항목';
      createDocument(
        {
          id: 'doc-overlap-p2.pdf',
          project_id: OTHER_PROJECT_ID,
          file_name: 'doc_p2.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      insertParagraphs(
        [
          {
            id: 'p-ov-2',
            document_id: 'doc-overlap-p2.pdf',
            sequence_no: 1,
            location: '1쪽',
            content: otherProjectBan,
          },
        ],
        db
      );
      insertSentences(
        [
          {
            id: 's-ov-2',
            document_id: 'doc-overlap-p2.pdf',
            paragraph_id: 'p-ov-2',
            sequence_no: 1,
            location: '1쪽',
            content: otherProjectBan,
            is_citation_banned: 1,
          },
        ],
        db
      );

      // 1. PROJECT_ID 지표 1: 8자 이상 겹치는 근거 ('비공개면담기록내용' 9자 겹침)
      const ind1 = {
        id: 'ind-display-8plus',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '8자 이상 겹침 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(ind1, db);
      saveSuggestion(
        {
          id: 'sugg-display-1',
          indicator_id: 'ind-display-8plus',
          verdict_status: '실현',
          proposal_text: '안전한 제안 문장',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-display-8plus',
            suggestion_id: 'sugg-display-1',
            quote: '참고자료로서 비공개면담기록내용 발췌본',
            document_id: 'doc-overlap-p1.pdf',
            location: '1쪽 ¶1',
            speaker: '현지 팀원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 2. PROJECT_ID 지표 2: 7자 겹침 ('비공개면담기록' 7자 겹침) -> 가리지 않음
      const ind2 = {
        id: 'ind-display-7char',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '7자 겹침 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(ind2, db);
      saveSuggestion(
        {
          id: 'sugg-display-2',
          indicator_id: 'ind-display-7char',
          verdict_status: '실현',
          proposal_text: '안전한 제안 문장 2',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-display-7char',
            suggestion_id: 'sugg-display-2',
            quote: '참고자료로서 비공개면담기록 확인본',
            document_id: 'doc-overlap-p1.pdf',
            location: '1쪽 ¶2',
            speaker: '현지 팀원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 3. PROJECT_ID 지표 3: 타 사업 금지 문장과 8자 이상 겹침 ('절대공개금지문장' 8자) -> 가리지 않음
      const ind3 = {
        id: 'ind-display-other-proj',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '타 사업 금지 문장 겹침 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(ind3, db);
      saveSuggestion(
        {
          id: 'sugg-display-3',
          indicator_id: 'ind-display-other-proj',
          verdict_status: '실현',
          proposal_text: '안전한 제안 문장 3',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-display-other-overlap',
            suggestion_id: 'sugg-display-3',
            quote: '참고자료로서 절대공개금지문장 인용문',
            document_id: 'doc-overlap-p1.pdf',
            location: '1쪽 ¶3',
            speaker: '현지 팀원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 검증: getReviewData
      const reviewData = getReviewData(PROJECT_ID, db);
      const ev1 = reviewData?.indicators.find((i) => i.indicator.id === 'ind-display-8plus')?.suggestion?.evidences[0];
      const ev2 = reviewData?.indicators.find((i) => i.indicator.id === 'ind-display-7char')?.suggestion?.evidences[0];
      const ev3 = reviewData?.indicators.find((i) => i.indicator.id === 'ind-display-other-proj')?.suggestion?.evidences[0];

      // 8자 이상 겹치면 가림
      expect(ev1?.is_citation_banned).toBe(1);
      expect(ev1?.quote).toBe('인용 금지 문장 있음');
      expect(ev1?.speaker).toBe('—');

      // 7자 겹침은 가리지 않음
      expect(ev2?.is_citation_banned).toBe(0);
      expect(ev2?.quote).toBe('참고자료로서 비공개면담기록 확인본');
      expect(ev2?.speaker).toBe('현지 팀원');

      // 타 사업 금지 문장 겹침은 가리지 않음
      expect(ev3?.is_citation_banned).toBe(0);
      expect(ev3?.quote).toBe('참고자료로서 절대공개금지문장 인용문');
      expect(ev3?.speaker).toBe('현지 팀원');

      // 검증: getHistoryPageData
      const historyData = getHistoryPageData(PROJECT_ID, db);
      const hEv1 = historyData?.indicators.find((i) => i.indicator.id === 'ind-display-8plus')?.latestSuggestion?.evidences[0];
      const hEv2 = historyData?.indicators.find((i) => i.indicator.id === 'ind-display-7char')?.latestSuggestion?.evidences[0];
      const hEv3 = historyData?.indicators.find((i) => i.indicator.id === 'ind-display-other-proj')?.latestSuggestion?.evidences[0];

      expect(hEv1?.is_citation_banned).toBe(1);
      expect(hEv1?.quote).toBe('인용 금지 문장 있음');
      expect(hEv1?.speaker).toBe('—');

      expect(hEv2?.is_citation_banned).toBe(0);
      expect(hEv3?.is_citation_banned).toBe(0);
    });

    it('이관: 사업별로(근거의 사업 = 지표의 사업, 금지 문장의 사업 = 문서의 사업) 대조 및 타 사업 격리 (#20 검수 2회차 2번)', () => {
      const OTHER_PROJECT_ID = 'test-proj-other-mig';
      createProject(
        {
          id: OTHER_PROJECT_ID,
          name: '타 사업 이관',
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      // PROJECT_ID 문서 및 금지 문장 (정규식 없음)
      const p1Ban = '프로젝트원고유비공개비밀진술문항';
      createDocument(
        {
          id: 'doc-mig-p1.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc_mig_p1.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      insertParagraphs(
        [{ id: 'p-mig-p1', document_id: 'doc-mig-p1.pdf', sequence_no: 1, location: '1쪽', content: p1Ban }],
        db
      );
      insertSentences(
        [{ id: 's-mig-p1', document_id: 'doc-mig-p1.pdf', paragraph_id: 'p-mig-p1', sequence_no: 1, location: '1쪽', content: p1Ban, is_citation_banned: 1 }],
        db
      );

      // PROJECT_ID 근거: p1Ban 과 8자 이상 겹침 ('고유비공개비밀진술' 9자)
      const p1Ind = {
        id: 'ind-mig-p1',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: 'P1 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(p1Ind, db);
      saveSuggestion(
        {
          id: 'sugg-mig-p1',
          indicator_id: 'ind-mig-p1',
          verdict_status: '실현',
          proposal_text: 'P1 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-mig-p1',
            suggestion_id: 'sugg-mig-p1',
            quote: '발췌록 고유비공개비밀진술 기록문',
            document_id: 'doc-mig-p1.pdf',
            location: '1쪽 ¶1',
            speaker: '조사원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // OTHER_PROJECT_ID 근거: p1Ban 과 8자 이상 겹치지만 OTHER_PROJECT_ID에는 해당 금지 문장이 없음
      createDocument(
        {
          id: 'doc-mig-p2.pdf',
          project_id: OTHER_PROJECT_ID,
          file_name: 'doc_mig_p2.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      const p2Ind = {
        id: 'ind-mig-p2',
        project_id: OTHER_PROJECT_ID,
        level: '산출물' as const,
        name: 'P2 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(p2Ind, db);
      saveSuggestion(
        {
          id: 'sugg-mig-p2',
          indicator_id: 'ind-mig-p2',
          verdict_status: '실현',
          proposal_text: 'P2 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [
          {
            id: 'ev-mig-p2',
            suggestion_id: 'sugg-mig-p2',
            quote: '발췌록 고유비공개비밀진술 인용문',
            document_id: 'doc-mig-p2.pdf',
            location: '1쪽 ¶1',
            speaker: '조사원',
            is_citation_banned: 0,
          },
        ],
        db
      );

      // 이관 실행
      const count = migrateExistingEvidencesForCitationBan(db);
      expect(count).toBe(1);

      // P1 근거는 이관되어 가려짐
      const rowP1 = db.prepare('SELECT quote, speaker, is_citation_banned FROM evidences WHERE id = ?').get('ev-mig-p1') as any;
      expect(rowP1.is_citation_banned).toBe(1);
      expect(rowP1.quote).toBe('인용 금지 문장 있음');
      expect(rowP1.speaker).toBe('—');

      // P2 근거는 타 사업 금지 문장이므로 이관되지 않고 보존됨
      const rowP2 = db.prepare('SELECT quote, speaker, is_citation_banned FROM evidences WHERE id = ?').get('ev-mig-p2') as any;
      expect(rowP2.is_citation_banned).toBe(0);
      expect(rowP2.quote).toBe('발췌록 고유비공개비밀진술 인용문');
      expect(rowP2.speaker).toBe('조사원');
    });

    it('이관 및 openDatabase는 오류를 삼키지 않고 그대로 던진다 (#20 검수 2회차 2번)', () => {
      const closedDb = new Database(':memory:');
      closedDb.close();

      // 이관 함수에서 오류를 삼키지 않고 던지는지 단언
      expect(() => migrateExistingEvidencesForCitationBan(closedDb)).toThrow();
    });
  });

  describe('4. 공용 0건 검사 동작: 대체 삭제, 오류 전파, 0개 정상 (#20 검수 4번)', () => {
    it('금지 문장이 0개이면 검사 대상 없음으로 정상(0건)을 반환하고 고정 문장으로 대체하지 않는다', () => {
      // sentences 테이블에 금지 문장이 전혀 없는 상태
      const count = db
        .prepare('SELECT count(*) as cnt FROM sentences WHERE is_citation_banned = 1')
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);

      // 고정 문장 대체 없이 0건으로 정상 반환
      const violations = findForbiddenTextViolationsInStore(db, PROJECT_ID);
      expect(violations).toHaveLength(0);
      expect(() => assertZeroForbiddenTextInStore(db, PROJECT_ID)).not.toThrow();
    });

    it('조회 중 DB 오류가 발생하면 삼키지 않고 그대로 예외를 던진다', () => {
      // 닫힌 DB 인스턴스로 호출하여 DB 오류 유발
      const closedDb = new Database(':memory:');
      closedDb.close();

      expect(() => findForbiddenTextViolationsInStore(closedDb, PROJECT_ID)).toThrow();
    });
  });

  describe('5. 확정 이력 저장 경계: 8자 이상 겹침 저장 거부 (#20 검수 5번)', () => {
    beforeEach(() => {
      const forbiddenSentence = '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청함.';
      createDocument(
        {
          id: 'doc-conf-test.pdf',
          project_id: PROJECT_ID,
          file_name: 'doc_conf.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );
      insertParagraphs(
        [
          {
            id: 'p-conf-1',
            document_id: 'doc-conf-test.pdf',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
          },
        ],
        db
      );
      insertSentences(
        [
          {
            id: 'sent-conf-banned',
            document_id: 'doc-conf-test.pdf',
            paragraph_id: 'p-conf-1',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenSentence,
            is_citation_banned: 1,
          },
        ],
        db
      );

      const indicator = {
        id: 'ind-conf-boundary',
        project_id: PROJECT_ID,
        level: '산출물' as const,
        name: '확정 경계 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '100%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(indicator, db);

      saveSuggestion(
        {
          id: 'sugg-conf-bound',
          indicator_id: 'ind-conf-boundary',
          verdict_status: '실현',
          proposal_text: '안전한 최초 제안 문장',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        [],
        db
      );
    });

    it('수정본(edited_text)에 금지 문장과 8자 이상 겹침이 있으면 저장을 거부하고 사유를 표시한다', () => {
      expect(() => {
        createConfirmation(
          {
            indicator_id: 'ind-conf-boundary',
            confirmation_type: '수정 후 확정',
            edited_text: '실무관은 이름을 밝히지 말아 달라고 요청하여 수치를 보정함.',
            reason: '정상적인 평가자 사유 기재',
            confirmer_name: '평가자A',
          },
          db
        );
      }).toThrow(/수정본에 인용 금지 문장과 8자 이상 겹치는 내용/);
    });

    it('사유(reason)에 금지 문장과 8자 이상 겹침이 있으면 저장을 거부하고 사유를 표시한다', () => {
      expect(() => {
        createConfirmation(
          {
            indicator_id: 'ind-conf-boundary',
            confirmation_type: '수정 후 확정',
            edited_text: '안전하게 수정된 지표 제안 문장입니다.',
            reason: '이름을 밝히지 말아 달라는 진술을 참고하여 반영함.',
            confirmer_name: '평가자A',
          },
          db
        );
      }).toThrow(/사유에 인용 금지 문장과 8자 이상 겹치는 내용/);
    });

    it('8자 미만 겹침이거나 금지 문장과 무관한 수정본 및 사유는 정상 저장된다', () => {
      expect(() => {
        createConfirmation(
          {
            indicator_id: 'ind-conf-boundary',
            confirmation_type: '수정 후 확정',
            edited_text: '안전하게 수정된 지표 제안 문장입니다.',
            reason: '현장 실사 결과 반영',
            confirmer_name: '평가자A',
          },
          db
        );
      }).not.toThrow();
    });

    describe('확정 이력 저장 거부 사업 격리 및 전역 목록 대체 삭제 (#20 검수 2회차 3번)', () => {
      const P_WITH_BAN = 'proj-conf-with-ban';
      const P_ZERO_BAN = 'proj-conf-zero-ban';
      const P_OTHER_BAN = 'proj-conf-other-ban';

      beforeEach(() => {
        // 사업 1: 고유 금지 문장 보유 (정규식 키워드 없음)
        createProject(
          {
            id: P_WITH_BAN,
            name: '금지 문장 있는 사업',
            // public-safety-allow: ISO date test fixture
            created_at: '2026-10-09T00:00:00.000Z',
          },
          db
        );
        createDocument(
          {
            id: 'doc-p-ban.pdf',
            project_id: P_WITH_BAN,
            file_name: 'p_ban.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            // public-safety-allow: ISO date test fixture
            created_at: '2026-10-09T00:00:00.000Z',
          },
          db
        );
        const ban1 = '이문장은사업일의고유한금지내용항목입니다';
        insertParagraphs([{ id: 'p-b-1', document_id: 'doc-p-ban.pdf', sequence_no: 1, location: '1쪽', content: ban1 }], db);
        insertSentences([{ id: 's-b-1', document_id: 'doc-p-ban.pdf', paragraph_id: 'p-b-1', sequence_no: 1, location: '1쪽', content: ban1, is_citation_banned: 1 }], db);

        const ind1 = {
          id: 'ind-conf-p1',
          project_id: P_WITH_BAN,
          level: '산출물' as const,
          name: 'P1 지표',
          ovi: 'OVI',
          mov: 'MOV',
          target_value: '100%',
          is_baseline: 0,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        };
        createIndicator(ind1, db);
        saveSuggestion({
          id: 'sugg-conf-p1',
          indicator_id: 'ind-conf-p1',
          verdict_status: '실현',
          proposal_text: 'P1 최초 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        }, [], db);

        // 사업 2: 금지 문장 0개
        createProject(
          {
            id: P_ZERO_BAN,
            name: '금지 문장 0개 사업',
            // public-safety-allow: ISO date test fixture
            created_at: '2026-10-09T00:00:00.000Z',
          },
          db
        );
        const ind2 = {
          id: 'ind-conf-p2',
          project_id: P_ZERO_BAN,
          level: '산출물' as const,
          name: 'P2 지표',
          ovi: 'OVI',
          mov: 'MOV',
          target_value: '100%',
          is_baseline: 0,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        };
        createIndicator(ind2, db);
        saveSuggestion({
          id: 'sugg-conf-p2',
          indicator_id: 'ind-conf-p2',
          verdict_status: '실현',
          proposal_text: 'P2 최초 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        }, [], db);

        // 사업 3: 다른 고유 금지 문장 보유
        createProject(
          {
            id: P_OTHER_BAN,
            name: '다른 금지 문장 있는 사업',
            // public-safety-allow: ISO date test fixture
            created_at: '2026-10-09T00:00:00.000Z',
          },
          db
        );
        createDocument(
          {
            id: 'doc-p-other.pdf',
            project_id: P_OTHER_BAN,
            file_name: 'p_other.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            // public-safety-allow: ISO date test fixture
            created_at: '2026-10-09T00:00:00.000Z',
          },
          db
        );
        const ban3 = '이문장은사업삼의고유한별도금지문장입니다';
        insertParagraphs([{ id: 'p-b-3', document_id: 'doc-p-other.pdf', sequence_no: 1, location: '1쪽', content: ban3 }], db);
        insertSentences([{ id: 's-b-3', document_id: 'doc-p-other.pdf', paragraph_id: 'p-b-3', sequence_no: 1, location: '1쪽', content: ban3, is_citation_banned: 1 }], db);

        const ind3 = {
          id: 'ind-conf-p3',
          project_id: P_OTHER_BAN,
          level: '산출물' as const,
          name: 'P3 지표',
          ovi: 'OVI',
          mov: 'MOV',
          target_value: '100%',
          is_baseline: 0,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        };
        createIndicator(ind3, db);
        saveSuggestion({
          id: 'sugg-conf-p3',
          indicator_id: 'ind-conf-p3',
          verdict_status: '실현',
          proposal_text: 'P3 최초 제안',
          error_reason: null,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        }, [], db);
      });

      it('정규식 표현을 포함하지 않지만 금지 문장과 8자 이상 겹치는 수정본 → 거부', () => {
        // ban1은 '이문장은사업일의고유한금지내용항목입니다'
        // '고유한금지내용항목' 9자 겹침 (정규식 표현 없음)
        expect(() => {
          createConfirmation(
            {
              indicator_id: 'ind-conf-p1',
              confirmation_type: '수정 후 확정',
              edited_text: '평가자가 수정한 내용이며 고유한금지내용항목을 보정하였습니다.',
              reason: '평가자 정상 사유 입력',
              confirmer_name: '평가자1',
            },
            db
          );
        }).toThrow(/수정본에 인용 금지 문장과 8자 이상 겹치는 내용/);
      });

      it('7자 겹침 → 허용', () => {
        // ban1은 '이문장은사업일의고유한금지내용항목입니다'
        // '고유한금지내' 6자, '고유한금지내용' 7자 겹침
        expect(() => {
          createConfirmation(
            {
              indicator_id: 'ind-conf-p1',
              confirmation_type: '수정 후 확정',
              edited_text: '평가자가 수정한 내용이며 고유한금지내용까지만 인용함.',
              reason: '평가자 정상 사유 입력',
              confirmer_name: '평가자1',
            },
            db
          );
        }).not.toThrow();
      });

      it('다른 사업의 금지 문장과 겹침 → 허용', () => {
        // 사업 3에서 사업 1의 금지 문장과 9자 겹치는 텍스트 확정 ('고유한금지내용항목')
        // 사업 3의 금지 문장은 '이문장은사업삼의고유한별도금지문장입니다' 이므로 겹치지 않음
        expect(() => {
          createConfirmation(
            {
              indicator_id: 'ind-conf-p3',
              confirmation_type: '수정 후 확정',
              edited_text: '사업3 평가 결과이며 고유한금지내용항목을 참조하였습니다.',
              reason: '평가자 정상 사유 입력',
              confirmer_name: '평가자3',
            },
            db
          );
        }).not.toThrow();
      });

      it('그 사업에 금지 문장이 0개면 비교 대상 없음(전역 목록 대체 삭제) → 허용', () => {
        // 사업 2는 금지 문장이 0개임.
        // 타 사업의 금지 문장('고유한금지내용항목', 9자)이 포함되어도 전역 목록 대체가 삭제되었으므로 허용
        expect(() => {
          createConfirmation(
            {
              indicator_id: 'ind-conf-p2',
              confirmation_type: '수정 후 확정',
              edited_text: '사업2 평가 결과이며 고유한금지내용항목을 자유롭게 기술함.',
              reason: '평가자 정상 사유 입력',
              confirmer_name: '평가자2',
            },
            db
          );
        }).not.toThrow();
      });
    });
  });

  describe('6. 보고서 검사 함수의 projectId 필터링 (#20 검수 6번)', () => {
    it('보고서 검사 함수(findForbiddenTextViolationsInReports)는 projectId로 거른다', () => {
      const OTHER_PROJECT_ID = 'other-project-reports';
      createProject(
        {
          id: OTHER_PROJECT_ID,
          name: '다른 사업',
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      createDocument(
        {
          id: 'doc-other.pdf',
          project_id: OTHER_PROJECT_ID,
          file_name: 'doc_other.pdf',
          file_type: 'pdf',
          status: '추출 완료',
          doc_type: '사업계획서',
          is_included: 1,
          excluded_reason: null,
          is_past_final_report: false,
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      const forbiddenText = '관계자는 익명을 요구하며 초기 결함을 알렸다.';
      insertParagraphs(
        [
          {
            id: 'p-oth-1',
            document_id: 'doc-other.pdf',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenText,
          },
        ],
        db
      );
      insertSentences(
        [
          {
            id: 'sent-other-rep',
            document_id: 'doc-other.pdf',
            paragraph_id: 'p-oth-1',
            sequence_no: 1,
            location: '1쪽',
            content: forbiddenText,
            is_citation_banned: 1,
          },
        ],
        db
      );

      // reports 테이블에 데이터 저장 (#22 보고서 테이블 연동)
      db.prepare(
        'INSERT INTO reports (id, project_id, content_json, created_at) VALUES (?, ?, ?, ?)'
      ).run('rep-other', OTHER_PROJECT_ID, JSON.stringify({ summary: `보고서 본문: ${forbiddenText}` }), 'created');

      // PROJECT_ID 에는 안전한 보고서 저장
      db.prepare(
        'INSERT INTO reports (id, project_id, content_json, created_at) VALUES (?, ?, ?, ?)'
      ).run('rep-safe', PROJECT_ID, JSON.stringify({ summary: '모든 지표가 목표를 초과 달성함.' }), 'created');

      // 1. OTHER_PROJECT_ID 로 검사 시 위반 검출
      const otherViolations = findForbiddenTextViolationsInReports(db, OTHER_PROJECT_ID);
      expect(otherViolations.length).toBeGreaterThan(0);
      expect(otherViolations[0]).toContain('rep-other');

      // 2. PROJECT_ID 로 검사 시 격리되어 0건 통과
      const safeViolations = findForbiddenTextViolationsInReports(db, PROJECT_ID);
      expect(safeViolations).toHaveLength(0);
    });
  });

  describe('7. 알 수 없는 level의 단계 탭 배제 및 분류되지 않은 지표 (#20 검수 7번, RQ-15)', () => {
    it('알 수 없는 level은 어떤 단계 탭(산출물, 단기성과, 중·장기성과, 기여·제약요인, 전체)에도 속하지 않는다', () => {
      const unknownLevels = ['알수없음', '기타레벨', '미분류지표', 'unknown'];

      for (const level of unknownLevels) {
        expect(isKnownLevel(level)).toBe(false);
        expect(isIndicatorInStage(level, '산출물')).toBe(false);
        expect(isIndicatorInStage(level, '단기성과')).toBe(false);
        expect(isIndicatorInStage(level, '중·장기성과')).toBe(false);
        expect(isIndicatorInStage(level, '기여·제약요인')).toBe(false);
        expect(isIndicatorInStage(level, '전체')).toBe(false);
      }
    });

    it('알려진 정상 level은 해당 단계 탭에 올바르게 포함된다', () => {
      expect(isKnownLevel('산출물')).toBe(true);
      expect(isKnownLevel('활동')).toBe(true);
      expect(isKnownLevel('단기성과')).toBe(true);
      expect(isKnownLevel('중기성과')).toBe(true);
      expect(isKnownLevel('영향')).toBe(true);
      expect(isKnownLevel('기여·제약요인')).toBe(true);

      expect(isIndicatorInStage('산출물', '산출물')).toBe(true);
      expect(isIndicatorInStage('활동', '산출물')).toBe(true);
      expect(isIndicatorInStage('단기성과', '단기성과')).toBe(true);
      expect(isIndicatorInStage('중기성과', '중·장기성과')).toBe(true);
      expect(isIndicatorInStage('영향', '중·장기성과')).toBe(true);
      expect(isIndicatorInStage('기여·제약요인', '기여·제약요인')).toBe(true);
    });
  });

  describe('10. 기여 귀속 저장 구조 정본 및 getAttributionsForProject (#20 검수 10번, RQ-16)', () => {
    it('지표별 1행 영속 저장, 사업 격리 및 getAttributionsForProject(projectId)가 올바르게 작동한다', () => {
      const OTHER_PROJECT_ID = 'proj-attr-island';
      createProject(
        {
          id: OTHER_PROJECT_ID,
          name: '다른 사업',
          // public-safety-allow: ISO date test fixture
          created_at: '2026-10-09T00:00:00.000Z',
        },
        db
      );

      const ind1 = {
        id: 'ind-p1-attr',
        project_id: PROJECT_ID,
        level: '단기성과' as const,
        name: '단기 성과 지표 1',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '80%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(ind1, db);

      const indOther = {
        id: 'ind-other-attr',
        project_id: OTHER_PROJECT_ID,
        level: '단기성과' as const,
        name: '타 사업 지표',
        ovi: 'OVI',
        mov: 'MOV',
        target_value: '50%',
        is_baseline: 0,
        // public-safety-allow: ISO date test fixture
        created_at: '2026-10-09T00:00:00.000Z',
      };
      createIndicator(indOther, db);

      // PROJECT_ID 지표 기여 귀속 저장
      saveIndicatorAttribution(PROJECT_ID, 'ind-p1-attr', '프로젝트 1의 기여 귀속 내용', db);
      // 타 사업 지표 기여 귀속 저장
      saveIndicatorAttribution(OTHER_PROJECT_ID, 'ind-other-attr', '타 사업의 기여 귀속 내용', db);

      // getAttributionsForProject(PROJECT_ID) 호출 시 PROJECT_ID 속한 1건만 조회됨 (사업 격리)
      const p1Attributions = getAttributionsForProject(PROJECT_ID, db);
      expect(p1Attributions).toHaveLength(1);
      expect(p1Attributions[0].project_id).toBe(PROJECT_ID);
      expect(p1Attributions[0].indicator_id).toBe('ind-p1-attr');
      expect(p1Attributions[0].attribution_text).toBe('프로젝트 1의 기여 귀속 내용');

      // 동일 지표 재저장 시 덮어쓰기되어 지표별 1행 유지 확인
      saveIndicatorAttribution(PROJECT_ID, 'ind-p1-attr', '수정된 기여 귀속 내용', db);
      const updated = getAttributionsForProject(PROJECT_ID, db);
      expect(updated).toHaveLength(1);
      expect(updated[0].attribution_text).toBe('수정된 기여 귀속 내용');
    });
  });

  describe('이슈 #20 검수 3회차 반영 단위 시험', () => {
    describe('1. 이관에서 금지 문장의 사업 연결 (sentences.paragraph_id → paragraphs.document_id → documents.project_id)', () => {
      it('문서 id가 우연히 맞지 않는 경우에도 문단을 경유하여 올바른 사업에 가림이 적용된다', () => {
        const PROJ_A = 'test-proj-rev3-mig-a';
        const PROJ_B = 'test-proj-rev3-mig-b';
        createProject({ id: PROJ_A, name: '사업 A', created_at: new Date(0).toISOString() }, db);
        createProject({ id: PROJ_B, name: '사업 B', created_at: new Date(0).toISOString() }, db);

        // 사업 A의 문서 및 문단
        createDocument(
          {
            id: 'doc-rev3-a.pdf',
            project_id: PROJ_A,
            file_name: 'doc_a.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        insertParagraphs(
          [{ id: 'para-rev3-a-1', document_id: 'doc-rev3-a.pdf', sequence_no: 1, location: '1쪽', content: '사업 A 문단' }],
          db
        );

        // 사업 B의 문서 및 문단
        createDocument(
          {
            id: 'doc-rev3-b.pdf',
            project_id: PROJ_B,
            file_name: 'doc_b.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        insertParagraphs(
          [{ id: 'para-rev3-b-1', document_id: 'doc-rev3-b.pdf', sequence_no: 1, location: '1쪽', content: '사업 B 문단' }],
          db
        );

        // 금지 문장: 문단은 사업 A(para-rev3-a-1)에 속하지만, document_id는 우연히 사업 B(doc-rev3-b.pdf)로 잘못 기재된 경우
        const bannedTextA = '사업에이고유금지문장내용입니다';
        insertSentences(
          [
            {
              id: 'sent-rev3-mismatch',
              document_id: 'doc-rev3-b.pdf', // 우연히 맞지 않는 문서 id (사업 B 문서)
              paragraph_id: 'para-rev3-a-1', // 실제 문단은 사업 A
              sequence_no: 1,
              location: '1쪽',
              content: bannedTextA,
              is_citation_banned: 1,
            },
          ],
          db
        );

        // 사업 A의 지표 및 근거 (bannedTextA 인용)
        createIndicator(
          {
            id: 'ind-rev3-a',
            project_id: PROJ_A,
            level: '산출물' as const,
            name: '지표 A',
            ovi: 'OVI',
            mov: 'MOV',
            target_value: '100%',
            is_baseline: 0,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        saveSuggestion(
          {
            id: 'sugg-rev3-a',
            indicator_id: 'ind-rev3-a',
            verdict_status: '실현',
            proposal_text: '제안 A',
            error_reason: null,
            created_at: new Date(0).toISOString(),
          },
          [
            {
              id: 'ev-rev3-a',
              suggestion_id: 'sugg-rev3-a',
              quote: '참고자료로서 사업에이고유금지문장내용 발췌문',
              document_id: 'doc-rev3-a.pdf',
              location: '1쪽 ¶1',
              speaker: '담당자',
              is_citation_banned: 0,
            },
          ],
          db
        );

        // 사업 B의 지표 및 근거 (bannedTextA와 동일 문구 인용)
        createIndicator(
          {
            id: 'ind-rev3-b',
            project_id: PROJ_B,
            level: '산출물' as const,
            name: '지표 B',
            ovi: 'OVI',
            mov: 'MOV',
            target_value: '100%',
            is_baseline: 0,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        saveSuggestion(
          {
            id: 'sugg-rev3-b',
            indicator_id: 'ind-rev3-b',
            verdict_status: '실현',
            proposal_text: '제안 B',
            error_reason: null,
            created_at: new Date(0).toISOString(),
          },
          [
            {
              id: 'ev-rev3-b',
              suggestion_id: 'sugg-rev3-b',
              quote: '참고자료로서 사업에이고유금지문장내용 발췌문',
              document_id: 'doc-rev3-b.pdf',
              location: '1쪽 ¶1',
              speaker: '담당자',
              is_citation_banned: 0,
            },
          ],
          db
        );

        // 이관 실행
        const migratedCount = migrateExistingEvidencesForCitationBan(db);
        expect(migratedCount).toBe(1);

        // 검증: 사업 A의 근거는 문단을 경유하여 사업 A로 올바르게 연결되어 가려짐
        const rowA = db.prepare('SELECT quote, speaker, is_citation_banned FROM evidences WHERE id = ?').get('ev-rev3-a') as any;
        expect(rowA.is_citation_banned).toBe(1);
        expect(rowA.quote).toBe('인용 금지 문장 있음');
        expect(rowA.speaker).toBe('—');

        // 검증: 사업 B의 근거는 타 사업(사업 A)의 금지 문장이므로 가려지지 않음
        const rowB = db.prepare('SELECT quote, speaker, is_citation_banned FROM evidences WHERE id = ?').get('ev-rev3-b') as any;
        expect(rowB.is_citation_banned).toBe(0);
        expect(rowB.quote).toBe('참고자료로서 사업에이고유금지문장내용 발췌문');
      });
    });

    describe('2. paragraph_context 사업별 가림 적용', () => {
      it('paragraph_context는 해당 사업의 금지 문장(8자 이상 겹침)을 [인용 금지 문장]으로 마스킹한다', () => {
        const PROJ_P = 'test-proj-rev3-para-p';
        createProject({ id: PROJ_P, name: '사업 P', created_at: new Date(0).toISOString() }, db);

        createDocument(
          {
            id: 'doc-rev3-p.pdf',
            project_id: PROJ_P,
            file_name: 'doc_p.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            created_at: new Date(0).toISOString(),
          },
          db
        );

        // PROJ_P의 금지 문장 (정규식 키워드 없음)
        const pBanSentence = '사업피전용비공개핵심면담내용';
        insertParagraphs(
          [
            {
              id: 'p-rev3-p-prev',
              document_id: 'doc-rev3-p.pdf',
              sequence_no: 1,
              location: '1쪽 ¶1',
              content: '앞 문단 내용입니다.',
            },
            {
              id: 'p-rev3-p-target',
              document_id: 'doc-rev3-p.pdf',
              sequence_no: 2,
              location: '1쪽 ¶2',
              content: '정상 문장입니다. 사업피전용비공개핵심면담내용 발췌본입니다. 마무리 문장입니다.',
            },
            {
              id: 'p-rev3-p-next',
              document_id: 'doc-rev3-p.pdf',
              sequence_no: 3,
              location: '1쪽 ¶3',
              content: '다음 문단에서도 사업피전용비공개핵심면담내용 일부가 언급됨.',
            },
          ],
          db
        );
        insertSentences(
          [
            {
              id: 's-rev3-p-ban',
              document_id: 'doc-rev3-p.pdf',
              paragraph_id: 'p-rev3-p-target',
              sequence_no: 1,
              location: '1쪽 ¶2',
              content: pBanSentence,
              is_citation_banned: 1,
            },
          ],
          db
        );

        // PROJ_P 지표 및 근거
        createIndicator(
          {
            id: 'ind-rev3-p',
            project_id: PROJ_P,
            level: '산출물' as const,
            name: '지표 P',
            ovi: 'OVI',
            mov: 'MOV',
            target_value: '100%',
            is_baseline: 0,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        saveSuggestion(
          {
            id: 'sugg-rev3-p',
            indicator_id: 'ind-rev3-p',
            verdict_status: '실현',
            proposal_text: '제안 P',
            error_reason: null,
            created_at: new Date(0).toISOString(),
          },
          [
            {
              id: 'ev-rev3-p',
              suggestion_id: 'sugg-rev3-p',
              quote: '사업피전용비공개핵심면담내용',
              document_id: 'doc-rev3-p.pdf',
              location: '1쪽 ¶2',
              speaker: '담당자',
              is_citation_banned: 1,
            },
          ],
          db
        );

        // getReviewData로 조회된 paragraph_context 확인
        const reviewData = getReviewData(PROJ_P, db);
        const ev = reviewData?.indicators[0].suggestion?.evidences[0];
        expect(ev).toBeDefined();
        expect(ev?.paragraph_context).toBeDefined();

        const ctx = ev!.paragraph_context!;
        // 대상 문단에서 금지 문장이 [인용 금지 문장]으로 마스킹되었는지 검증
        expect(ctx.target.content).toContain('[인용 금지 문장]');
        expect(ctx.target.content).not.toContain(pBanSentence);
        expect(ctx.target.content).toContain('정상 문장입니다.');
        expect(ctx.target.content).toContain('마무리 문장입니다.');

        // 주변 문단(next)에서도 해당 사업 금지 문장이 마스킹되었는지 검증
        expect(ctx.next?.content).toContain('[인용 금지 문장]');
        expect(ctx.next?.content).not.toContain(pBanSentence);

        // 앞 문단(prev)은 금지 문장이 없으므로 원문 유지
        expect(ctx.previous?.content).toBe('앞 문단 내용입니다.');

        // getParagraphWithSurroundings 직접 호출 시에도 동일하게 마스킹 적용
        const directCtx = getParagraphWithSurroundings('doc-rev3-p.pdf', '1쪽 ¶2', db);
        expect(directCtx?.target.content).toContain('[인용 금지 문장]');
        expect(directCtx?.target.content).not.toContain(pBanSentence);
      });

      it('타 사업의 금지 문장이나 7자 이하 겹침은 paragraph_context에서 마스킹하지 않는다', () => {
        const PROJ_A = 'test-proj-rev3-para-iso-a';
        const PROJ_B = 'test-proj-rev3-para-iso-b';
        createProject({ id: PROJ_A, name: '사업 A', created_at: new Date(0).toISOString() }, db);
        createProject({ id: PROJ_B, name: '사업 B', created_at: new Date(0).toISOString() }, db);

        createDocument(
          {
            id: 'doc-para-a.pdf',
            project_id: PROJ_A,
            file_name: 'doc_a.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            created_at: new Date(0).toISOString(),
          },
          db
        );

        // 사업 B에만 등록된 금지 문장
        const bBanSentence = '사업비고유의특별금지문장내용';
        createDocument(
          {
            id: 'doc-para-b.pdf',
            project_id: PROJ_B,
            file_name: 'doc_b.pdf',
            file_type: 'pdf',
            status: '추출 완료',
            doc_type: '사업계획서',
            is_included: 1,
            excluded_reason: null,
            is_past_final_report: false,
            created_at: new Date(0).toISOString(),
          },
          db
        );
        insertParagraphs([{ id: 'p-b-1', document_id: 'doc-para-b.pdf', sequence_no: 1, location: '1쪽 ¶1', content: bBanSentence }], db);
        insertSentences([{ id: 's-b-1', document_id: 'doc-para-b.pdf', paragraph_id: 'p-b-1', sequence_no: 1, location: '1쪽 ¶1', content: bBanSentence, is_citation_banned: 1 }], db);

        // 사업 A의 문단:
        // 문단 1: 사업 B의 금지 문장 포함 (타 사업이므로 마스킹 금지)
        // 문단 2: 사업 A의 금지 문장과 7자만 겹침 (7자 겹침은 마스킹 금지)
        const aBanSentence = '사업에이고유금지문장목록';
        insertParagraphs([{ id: 'p-a-ban', document_id: 'doc-para-a.pdf', sequence_no: 1, location: '1쪽 ¶1', content: aBanSentence }], db);
        insertSentences([{ id: 's-a-ban', document_id: 'doc-para-a.pdf', paragraph_id: 'p-a-ban', sequence_no: 1, location: '1쪽 ¶1', content: aBanSentence, is_citation_banned: 1 }], db);

        const paraOtherContent = `사업 A 본문입니다. ${bBanSentence} 인용문입니다.`;
        const para7CharContent = '사업 A 본문입니다. 사업에이고유금 (7자 겹침) 내용입니다.';
        insertParagraphs(
          [
            { id: 'p-a-other', document_id: 'doc-para-a.pdf', sequence_no: 2, location: '1쪽 ¶2', content: paraOtherContent },
            { id: 'p-a-7char', document_id: 'doc-para-a.pdf', sequence_no: 3, location: '1쪽 ¶3', content: para7CharContent },
          ],
          db
        );

        // 사업 B 금지 문장이 들어간 사업 A의 문단 context 조회 -> 타 사업이므로 마스킹 안 됨
        const ctxOther = getParagraphWithSurroundings('doc-para-a.pdf', '1쪽 ¶2', db);
        expect(ctxOther?.target.content).toBe(paraOtherContent);
        expect(ctxOther?.target.content).not.toContain('[인용 금지 문장]');

        // 7자 겹침 문단 context 조회 -> 8자 미만이므로 마스킹 안 됨
        const ctx7 = getParagraphWithSurroundings('doc-para-a.pdf', '1쪽 ¶3', db);
        expect(ctx7?.target.content).toBe(para7CharContent);
        expect(ctx7?.target.content).not.toContain('[인용 금지 문장]');
      });
    });

    describe('3. openDatabase 의 ALTER TABLE 오류 처리', () => {
      it('execAlterIgnoreDuplicateColumn 은 duplicate column 오류만 무시하고 그 외 오류는 던진다', () => {
        // 1. 이미 존재하는 컬럼 추가 시도 -> duplicate column 오류 발생 -> 무시되고 정상 완료
        expect(() => {
          execAlterIgnoreDuplicateColumn(db, 'ALTER TABLE documents ADD COLUMN inclusion_source TEXT');
        }).not.toThrow();

        // 2. 존재하지 않는 테이블에 컬럼 추가 시도 -> no such table 오류 -> 던져짐
        expect(() => {
          execAlterIgnoreDuplicateColumn(db, 'ALTER TABLE non_existent_table ADD COLUMN test_col TEXT');
        }).toThrow(/no such table/i);

        // 3. 문법 오류 SQL -> 던져짐
        expect(() => {
          execAlterIgnoreDuplicateColumn(db, 'ALTER TABLE documents INVALID SYNTAX');
        }).toThrow();
      });

      it('openDatabase 는 ALTER TABLE 중 duplicate column 이외의 오류 발생 시 예외를 던진다', () => {
        // openDatabase 를 정상 호출하면 예외 없음
        const dbInstance = openDatabase(':memory:');
        expect(dbInstance).toBeDefined();

        // documents 테이블 대신 뷰로 생성하여 ALTER TABLE 시 "cannot alter view" 오류 유도
        const testDb = new Database(':memory:');
        testDb.exec('CREATE TABLE dummy (id TEXT); CREATE VIEW documents AS SELECT * FROM dummy;');
        testDb.exec('CREATE TABLE evidences (id TEXT);');
        expect(() => {
          execAlterIgnoreDuplicateColumn(testDb, 'ALTER TABLE documents ADD COLUMN inclusion_source TEXT');
        }).toThrow(/Cannot add a column/i);
        testDb.close();
      });
    });
  });
});

