import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDatabase,
  closeDatabase,
  createProject,
  createDocument,
  createIndicator,
  insertParagraphs,
  insertSentences,
  getLatestSuggestion,
  saveSuggestion,
  assertZeroForbiddenTextInStore,
  findForbiddenTextViolationsInStore,
} from '../../src/server/store';
import { suggestVerdictForIndicator } from '../../src/server/suggest';
import { AiClient } from '../../src/server/ai';

describe('인용 금지 저장 영역 0건 통합 시험 (IT: RQ-14, D01)', () => {
  let db: Database.Database;
  const PROJECT_ID = 'it-proj-citation-ban';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createProject(
      {
        id: PROJECT_ID,
        name: '인용 금지 IT 검증 사업',
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );
  });

  afterEach(() => {
    closeDatabase();
  });

  it('가짜 AI 응답에 금지 문장을 일부러 넣어도 suggest 실행 후 저장 영역(suggestions, evidences)에 금지 문장 0건이어야 한다', async () => {
    const forbiddenSentence =
      '면담에 참여한 현지 실무관은 이름을 밝히지 말아 달라고 요청하며 초기 시스템 도입 과정에서 부서 간 이견이 상당했다고 진술함.';

    createDocument(
      {
        id: 'doc-it-report',
        project_id: PROJECT_ID,
        file_name: '03_trip_report.pdf',
        file_type: 'pdf',
        status: '추출 완료',
        doc_type: '출장결과보고서',
        is_included: 1,
        excluded_reason: null,
        created_at: '2026-10-09T00:00:00.000Z',
      },
      db
    );

    const paragraph = {
      id: 'p-it-1',
      document_id: 'doc-it-report',
      sequence_no: 1,
      location: '2쪽 ¶3',
      content: forbiddenSentence,
    };
    insertParagraphs([paragraph], db);
    insertSentences(
      [
        {
          id: 's-it-1',
          document_id: 'doc-it-report',
          paragraph_id: 'p-it-1',
          sequence_no: 1,
          location: '2쪽 ¶3',
          content: forbiddenSentence,
          is_citation_banned: 1,
        },
      ],
      db
    );

    const indicator = {
      id: 'ind-it-ban',
      project_id: PROJECT_ID,
      level: '산출물' as const,
      name: '플랫폼 구축 완료 현황',
      ovi: '플랫폼 검수 보고서',
      mov: '검수 확인서',
      target_value: '1식 완료',
      is_baseline: 0,
      created_at: '2026-10-09T00:00:00.000Z',
    };
    createIndicator(indicator, db);

    // 가짜 AI: 제안 문장과 근거 인용 둘 다에 금지 문장을 고의로 삽입
    const maliciousAiClient = new AiClient({
      baseUrl: 'https://example.com/v1',
      // public-safety-allow: unit test dummy key
      apiKey: 'dummy-key-for-it',
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
                    sentence: `현지 보고에 따르면 ${forbiddenSentence}을 바탕으로 검수가 완료되었다고 판단됨.`,
                    evidences: [
                      {
                        quote: forbiddenSentence,
                        document_id: 'doc-it-report',
                        location: '2쪽 ¶3',
                        speaker: '협력국',
                      },
                    ],
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const result = await suggestVerdictForIndicator(indicator, [paragraph], {
      aiClient: maliciousAiClient,
      saveToStore: true,
      db,
    });

    // Server action persists a failed generation as an error record, not as a successful suggestion.
    if (!result.saved && result.suggestion.error_reason) {
      saveSuggestion(result.suggestion, result.evidences, db);
    }

    // 1. suggest 결과에서 제안 문장은 완전히 null로 버려졌는지 단언
    expect(result.suggestion.proposal_text).toBeNull();

    // 2. 근거 인용은 원문 대신 "인용 금지 문장 있음"과 위치만 남았는지 단언
    expect(result.evidences).toHaveLength(1);
    expect(result.evidences[0].quote).toBe('인용 금지 문장 있음');
    expect(result.evidences[0].location).toBe('2쪽 ¶3');
    expect(result.evidences[0].is_citation_banned).toBe(1);

    // The direct action audit path persists failed generation data with its masked evidence.
    const persisted = getLatestSuggestion(indicator.id, db);
    expect(persisted).toBeDefined();
    expect(persisted?.id).toBe(result.suggestion.id);
    expect(persisted?.verdict_status).toBe('미확인');
    expect(persisted?.proposal_text).toBeNull();
    expect(persisted?.error_reason).toContain('초기 생성 단계 실패');
    expect(persisted?.error_reason).toContain('의미 재시도 단계 실패');
    expect(persisted?.evidences).toHaveLength(1);
    expect(persisted?.evidences[0].quote).toBe('인용 금지 문장 있음');
    expect(persisted?.evidences[0].speaker).toBe('—');
    expect(persisted?.evidences[0].location).toBe('2쪽 ¶3');
    expect(persisted?.evidences[0].is_citation_banned).toBe(1);

    // 2-1. IT 단언: 저장 0건 검사 전에 제안·근거 행이 실제로 저장됐는지(행 수 > 0) 단언 (#20 검수 9번)
    const suggCountRow = db
      .prepare('SELECT count(*) as count FROM suggestions WHERE indicator_id = ?')
      .get(indicator.id) as { count: number };
    const evCountRow = db
      .prepare('SELECT count(*) as count FROM evidences WHERE suggestion_id = ?')
      .get(result.suggestion.id) as { count: number };
    expect(suggCountRow.count).toBeGreaterThan(0);
    expect(evCountRow.count).toBeGreaterThan(0);

    // 3. DB 저장 영역 전수 검사 (suggestions, evidences, confirmations, reports)
    const violations = findForbiddenTextViolationsInStore(db, PROJECT_ID);
    expect(violations).toHaveLength(0);
    expect(() => assertZeroForbiddenTextInStore(db, PROJECT_ID)).not.toThrow();
  });
});
