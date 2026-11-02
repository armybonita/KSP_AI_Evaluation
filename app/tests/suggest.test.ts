import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AiCallError, AiClient } from '../src/server/ai';
import {
  closeDatabase,
  getDatabase,
  getLatestSuggestion,
  IndicatorRecord,
  openDatabase,
  ParagraphRecord,
  ProjectRecord,
  saveIndicatorBaseline,
  updateDocumentInclusion,
} from '../src/server/store';
import {
  buildSuggestInput,
  buildSuggestRequestBody,
  suggestVerdictForIndicator,
} from '../src/server/suggest';

describe('판정 제안 서비스 단위 시험 (RQ-09, RQ-10, RQ-11, RQ-12, RQ-27, D30)', () => {
  let db: Database.Database;

  const mockProject: ProjectRecord = {
    id: 'proj-1',
    name: '가상국 디지털 행정 사업',
    created_at: '2026-01-01T00:00:00Z',
  };

  const mockIndicator: IndicatorRecord = {
    id: 'ind-1',
    project_id: 'proj-1',
    source_doc_id: 'doc-1',
    level: '산출물',
    name: '플랫폼 구축',
    ovi: '디지털 행정 공통 플랫폼 구축',
    mov: '시스템 검수 확인서',
    target_value: '통합 플랫폼 1식 개발 완료',
    is_baseline: 0,
    created_at: '2026-01-01T00:00:00Z',
  };

  const mockParagraphs: ParagraphRecord[] = [
    {
      id: 'p-1',
      document_id: 'doc-1',
      sequence_no: 5,
      location: '1쪽 ¶5',
      content: '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
    },
    {
      id: 'p-2',
      document_id: 'doc-2',
      sequence_no: 4,
      location: '¶4',
      content: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
    },
  ];

  beforeEach(() => {
    // 인메모리 DB로 초기화
    db = openDatabase(':memory:');
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('${mockProject.id}', '${mockProject.name}', '${mockProject.created_at}')`);
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, masked, approved_ai, is_past_final_report, created_at) VALUES ('doc-1', 'proj-1', '03_trip.pdf', 'pdf', '추출 완료', 1, 'solar', 0, '2026-01-01')`);
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, masked, approved_ai, is_past_final_report, created_at) VALUES ('doc-2', 'proj-1', '01_plan.hwpx', 'hwpx', '추출 완료', 1, 'solar', 0, '2026-01-01')`);
    db.exec(`
      INSERT INTO indicators (id, project_id, source_doc_id, level, name, ovi, mov, target_value, is_baseline, created_at)
      VALUES ('${mockIndicator.id}', '${mockIndicator.project_id}', '${mockIndicator.source_doc_id}', '${mockIndicator.level}', '${mockIndicator.name}', '${mockIndicator.ovi}', '${mockIndicator.mov}', '${mockIndicator.target_value}', ${mockIndicator.is_baseline}, '${mockIndicator.created_at}')
    `);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('출처 없는 지표는 AI 호출을 막는다', async () => {
    let called = false;
    const aiClient = { provider: 'solar', generateSuggestion: async () => { called = true; throw new Error('unexpected'); } } as unknown as AiClient;
    const result = await suggestVerdictForIndicator({ ...mockIndicator, source_doc_id: undefined }, mockParagraphs, { aiClient, saveToStore: false });
    expect(called).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.suggestion.error_reason).toContain('AI 입력 자격');
  });

  it('정상적인 AI 제안은 검증을 통과하여 저장된다', async () => {
    // 가짜 AI 클라이언트 주입
    const mockAiClient = {
      provider: 'solar',
      generateSuggestion: async () => ({
        suggestion: {
          verdict_status: '실현' as const,
          sentence: '통합 플랫폼 1식 개발 완료가 확인되었습니다.',
          evidences: [
            {
              quote: '통합 플랫폼 1식 개발 완료',
              document_id: 'doc-1',
              location: '1쪽 ¶5',
              speaker: '수행기관' as const,
            },
          ],
        },
        meta: { duration_ms: 10 },
      }),
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: mockAiClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(true);
    expect(result.suggestion.verdict_status).toBe('실현');
    expect(result.evidences.length).toBe(1);
    expect(result.evidences[0].quote).toBe('통합 플랫폼 1식 개발 완료');

    // DB 확인
    const saved = getLatestSuggestion(mockIndicator.id);
    expect(saved).toBeDefined();
    expect(saved!.verdict_status).toBe('실현');
    expect(saved!.evidences.length).toBe(1);
  });

  it('근거에서 탈락한 제안 문장은 보정 지시 후 한 번 재생성한다', async () => {
    let calls = 0;
    const retryingAiClient = {
      provider: 'solar',
      generateSuggestion: async () => {
        calls += 1;
        return {
          suggestion: {
            verdict_status: '실현' as const,
            sentence:
              calls === 1
                ? '플랫폼 구축이 2030년 100% 완료되었습니다.'
                : '통합 플랫폼 1식 개발 완료가 확인되었습니다.',
            evidences:
              calls === 1
                ? [
                    {
                      quote: '80% 달성을 최종 목표로 설정한다',
                      document_id: 'doc-2',
                      location: '¶4',
                      speaker: 'KDI' as const,
                    },
                  ]
                : [
                    {
                      quote: '통합 플랫폼 1식 개발 완료',
                      document_id: 'doc-1',
                      location: '1쪽 ¶5',
                      speaker: '수행기관' as const,
                    },
                  ],
          },
          meta: { duration_ms: 10 },
        };
      },
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: retryingAiClient,
      saveToStore: true,
    });

    expect(calls).toBe(2);
    expect(result.saved).toBe(true);
    expect(result.meta?.duration_ms).toBe(20);
    expect(result.meta?.usage).toBeUndefined();
    expect(result.suggestion.proposal_text).toBe('통합 플랫폼 1식 개발 완료가 확인되었습니다.');
    expect(result.evidences).toHaveLength(1);
    expect(result.evidences[0].document_id).toBe('doc-1');
    expect(getLatestSuggestion(mockIndicator.id)?.proposal_text).toBe(
      '통합 플랫폼 1식 개발 완료가 확인되었습니다.'
    );
  });

  it('같은 위치의 서로 다른 인용 근거를 모두 보존한다', async () => {
    const multipleEvidenceClient = {
      provider: 'solar',
      generateSuggestion: async () => ({
        suggestion: {
          verdict_status: '실현' as const,
          sentence: '행정 시스템 이용 만족도는 80%로 확인되었습니다.',
          evidences: [
            {
              quote: '행정 시스템 이용 만족도',
              document_id: 'doc-2',
              location: '¶4',
              speaker: 'KDI' as const,
            },
            {
              quote: '80% 달성을 최종 목표로 설정한다',
              document_id: 'doc-2',
              location: '¶4',
              speaker: 'KDI' as const,
            },
          ],
        },
        meta: { duration_ms: 10 },
      }),
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: multipleEvidenceClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(true);
    expect(result.evidences.map((evidence) => evidence.quote)).toEqual([
      '행정 시스템 이용 만족도',
      '80% 달성을 최종 목표로 설정한다',
    ]);
  });

  it('AI 재시도 예외에서도 이전 인용 금지 위치 안내를 보존한다', async () => {
    const failingAiClient = {
      provider: 'solar',
      generateSuggestion: async () => {
        throw new Error('AI 게이트웨이 오류');
      },
    } as unknown as AiClient;
    const restrictedEvidence = {
      quote: '인용 금지 문장 있음',
      document_id: 'doc-1',
      location: '1쪽 ¶5',
      speaker: '—',
      is_citation_banned: 1,
    } as const;
    const ordinaryEvidence = {
      quote: '검증된 일반 근거',
      document_id: 'doc-2',
      location: '¶4',
      speaker: 'KDI',
      is_citation_banned: 0,
    } as const;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: failingAiClient,
      saveToStore: true,
      semanticRetry: true,
      preservedEvidences: [restrictedEvidence, ordinaryEvidence],
    });

    expect(result.evidences).toHaveLength(2);
    expect(result.evidences[0]).toMatchObject(restrictedEvidence);
    expect(result.evidences[0].location).toBe('1쪽 ¶5');
    expect(result.evidences[1]).toMatchObject(ordinaryEvidence);
  });

  it('성공한 의미 재시도에는 이전 실패 응답의 금지 인용 근거를 붙이지 않는다', async () => {
    const retryClient = {
      provider: 'solar',
      generateSuggestion: async () => ({
        suggestion: {
          verdict_status: '실현' as const,
          sentence: '통합 플랫폼 1식 개발 완료가 확인되었습니다.',
          evidences: [
            {
              quote: '통합 플랫폼 1식 개발 완료',
              document_id: 'doc-1',
              location: '1쪽 ¶5',
              speaker: '수행기관' as const,
            },
          ],
        },
        meta: { duration_ms: 8 },
      }),
    } as unknown as AiClient;
    const restrictedEvidence = {
      quote: '인용 금지 문장 있음',
      document_id: 'doc-2',
      location: '5쪽 ¶7',
      speaker: '—',
      is_citation_banned: 1,
    } as const;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: retryClient,
      saveToStore: true,
      semanticRetry: true,
      preservedEvidences: [restrictedEvidence],
    });

    expect(result.saved).toBe(true);
    expect(result.evidences).toHaveLength(1);
    expect(result.evidences[0].quote).toBe('통합 플랫폼 1식 개발 완료');
    expect(result.evidences.some((evidence) => evidence.is_citation_banned === 1)).toBe(false);
  });

  it('의미 재시도 API 오류에도 초기 검증 실패와 재시도 실패를 안전한 서로 다른 범주로 기록하고 총 시도를 표시한다', async () => {
    let calls = 0;
    const rawRetryError = 'AI 호출 실패 (HTTP 503, code: solar-pro4-private-detail)';
    const failingRetryClient = {
      provider: 'solar',
      generateSuggestion: async () => {
        calls += 1;
        if (calls === 2) {
          throw new AiCallError(rawRetryError, {
            duration_ms: 7,
            usage: { prompt_tokens: 3, completion_tokens: 2, reasoning_tokens: 1, total_tokens: 5 },
          });
        }
        return {
          suggestion: {
            verdict_status: '실현' as const,
            sentence: '플랫폼 구축이 2030년 100% 완료되었습니다.',
            evidences: [
              {
                quote: '통합 플랫폼 1식 개발 완료',
                document_id: 'doc-1',
                location: '1쪽 ¶5',
                speaker: '수행기관' as const,
              },
            ],
          },
          meta: {
            duration_ms: 10,
            usage: { prompt_tokens: 5, completion_tokens: 4, reasoning_tokens: 2, total_tokens: 9 },
          },
        };
      },
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: failingRetryClient,
      saveToStore: true,
    });

    expect(calls).toBe(2);
    expect(result.saved).toBe(false);
    expect(result.meta?.duration_ms).toBe(17);
    expect(result.meta?.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 6,
      reasoning_tokens: 3,
      total_tokens: 14,
    });
    expect(result.suggestion.error_reason).toContain(
      '초기 생성 단계 실패: 제안 문장이 근거 수치 검증을 통과하지 못했습니다'
    );
    expect(result.suggestion.error_reason).toContain('의미 재시도 단계 실패: AI 호출 실패');
    expect(result.suggestion.error_reason).toContain('총 2회 생성 시도, 의미 재시도 1회');
    expect(result.suggestion.error_reason).toContain('generation_rounds=2, semantic_retries=1');
    expect(result.suggestion.error_reason).not.toContain('HTTP 503');
    expect(result.suggestion.error_reason).not.toContain('solar-pro4-private-detail');
    expect(result.suggestion.error_reason).toContain('operation_duration_ms=17');
    expect(result.suggestion.error_reason).toContain('operation_completion_tokens=6');
  });

  it('초기 수치 검증과 의미 재시도 인용 금지 검증 실패를 서로 다른 안전한 사유로 보존한다', async () => {
    let calls = 0;
    const twoValidationFailures = {
      provider: 'solar',
      generateSuggestion: async () => {
        calls += 1;
        return {
          suggestion: {
            verdict_status: '실현' as const,
            sentence:
              calls === 1
                ? '플랫폼 구축이 2030년 100% 완료되었습니다.'
                : '익명을 요청한 관계자가 사업 추진 상황을 설명했습니다.',
            evidences: [
              {
                quote: '통합 플랫폼 1식 개발 완료',
                document_id: 'doc-1',
                location: '1쪽 ¶5',
                speaker: '수행기관' as const,
              },
            ],
          },
          meta: { duration_ms: 10 },
        };
      },
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: twoValidationFailures,
      saveToStore: true,
    });

    expect(calls).toBe(2);
    expect(result.saved).toBe(false);
    expect(result.suggestion.error_reason).toContain(
      '초기 생성 단계 실패: 제안 문장이 근거 수치 검증을 통과하지 못했습니다'
    );
    expect(result.suggestion.error_reason).toContain(
      '의미 재시도 단계 실패: 제안 문장이 인용 금지 검증을 통과하지 못했습니다'
    );
    expect(result.suggestion.error_reason).toContain('총 2회 생성 시도, 의미 재시도 1회');
    expect(result.suggestion.error_reason).not.toContain('익명을 요청');
  });

  it('AI 호출이 실패한 경우 저장되지 않고 미확인과 오류 사유를 반환한다 (RQ-27, D30)', async () => {
    const failingAiClient = {
      provider: 'solar',
      generateSuggestion: async () => {
        throw new Error('AI 게이트웨이 타임아웃 오류: model=private-solar response=Bearer hidden');
      },
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: failingAiClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(false);
    expect(result.suggestion.verdict_status).toBe('미확인');
    expect(result.suggestion.error_reason).toContain('AI 게이트웨이 타임아웃 오류');
    expect(result.suggestion.error_reason).toContain('총 1회 생성 시도, 의미 재시도 0회');
    expect(result.suggestion.error_reason).not.toContain('private-solar');
    expect(result.suggestion.error_reason).not.toContain('Bearer hidden');
    expect(result.evidences.length).toBe(0);

    // DB에 아무것도 저장되지 않았는지 확인
    const saved = getLatestSuggestion(mockIndicator.id);
    expect(saved).toBeUndefined();
  });

  it('AI 출력이 스키마를 위반한 경우 저장되지 않고 미확인과 오류 사유를 반환한다 (RQ-27, D12)', async () => {
    const schemaViolatingClient = {
      provider: 'solar',
      generateSuggestion: async () => {
        throw new Error('ZodError: Invalid verdict_status "완료"');
      },
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: schemaViolatingClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(false);
    expect(result.suggestion.verdict_status).toBe('미확인');
    expect(result.suggestion.error_reason).toContain('AI 응답 스키마 검증 실패');
    expect(result.suggestion.error_reason).not.toContain('완료');
    expect(result.suggestion.error_reason).not.toMatch(/ZodError/i);

    // DB 저장 없음
    const saved = getLatestSuggestion(mockIndicator.id);
    expect(saved).toBeUndefined();
  });

  it('원문에 없는 수치를 넣은 제안 문장은 버려지고 판정이 미확인이 된다 (RQ-12, D03)', async () => {
    const hallucinatedNumberClient = {
      provider: 'solar',
      generateSuggestion: async () => ({
        suggestion: {
          verdict_status: '실현' as const,
          // 원문은 80% 인데 85% 로 왜곡된 수치
          sentence: '행정 시스템 만족도가 85%에 도달하였습니다.',
          evidences: [
            {
              quote: '행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
              document_id: 'doc-2',
              location: '¶4',
              speaker: 'KDI' as const,
            },
          ],
        },
        meta: { duration_ms: 10 },
      }),
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: hallucinatedNumberClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(false);
    // 문장이 두 번 검증에서 탈락해 실패 사유를 반환하고 저장하지 않는다.
    expect(result.suggestion.proposal_text).toBeNull();
    expect(result.suggestion.verdict_status).toBe('미확인');
    expect(result.suggestion.error_reason).toContain('근거 수치 검증을 통과하지 못했습니다');
  });

  it('지어낸 인용문만 있는 경우 근거가 버려지고 판정이 미확인이 된다 (RQ-11)', async () => {
    const fakeQuoteClient = {
      provider: 'solar',
      generateSuggestion: async () => ({
        suggestion: {
          verdict_status: '실현' as const,
          sentence: '성과가 달성되었습니다.',
          evidences: [
            {
              quote: '원문에 전혀 없는 허위 인용 내용입니다.',
              document_id: 'doc-1',
              location: '1쪽 ¶5',
              speaker: '협력국' as const,
            },
          ],
        },
        meta: { duration_ms: 10 },
      }),
    } as unknown as AiClient;

    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: fakeQuoteClient,
      saveToStore: true,
    });

    expect(result.saved).toBe(true);
    expect(result.suggestion.verdict_status).toBe('미확인');
    expect(result.evidences.length).toBe(0);
  });

  it('응답 본문 JSON에 정의되지 않은 추가 필드가 있으면 스키마 위반으로 거부하고 저장 없이 미확인+오류사유를 반환한다 (RQ-27)', async () => {
    // 가짜 클라이언트가 오류를 던지는 방식이 아니라, 잘못된 응답 본문(추가 필드 포함)을 돌려주는 방식
    const extraFieldResponseBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict_status: '실현',
              sentence: '통합 플랫폼 1식 개발 완료가 확인되었습니다.',
              evidences: [
                {
                  quote: '통합 플랫폼 1식 개발 완료',
                  document_id: 'doc-1',
                  location: '1쪽 ¶5',
                  speaker: '수행기관',
                },
              ],
              unexpected_extra_property: '정의되지 않은 추가 필드',
            }),
          },
        },
      ],
    };

    const clientWithExtraField = new AiClient({
      baseUrl: 'https://llm.example.com/v1',
      // public-safety-allow: dummy key for unit test
      apiKey: 'dummy',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response(JSON.stringify(extraFieldResponseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    Object.defineProperty(clientWithExtraField, 'provider', { value: 'solar' });
    const result = await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: clientWithExtraField,
      saveToStore: true,
    });

    // 1. 저장이 없어야 함 (RQ-27)
    expect(result.saved).toBe(false);
    // 2. 미확인 판정이어야 함
    expect(result.suggestion.verdict_status).toBe('미확인');
    // 3. 오류 사유가 존재해야 함
    expect(result.suggestion.error_reason).toBeTruthy();
    expect(result.suggestion.error_reason).toContain('AI 응답 스키마 검증 실패');
    expect(result.suggestion.error_reason).not.toMatch(/unrecognized_keys/i);

    // 4. DB에 실제로 저장되지 않았는지 단언
    const savedInDb = getLatestSuggestion(mockIndicator.id);
    expect(savedInDb).toBeUndefined();
  });

  // ---------------- 7. suggest 입력 구성 함수 단위 시험 (#18 검수) ----------------
  it('(suggest 입력 구성) 제외 문서 문단이 빠지고 포함으로 바꾸면 들어가는지 검증한다 (AI 미호출)', () => {
    // 1. 포함 문서 및 제외 문서 생성
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, masked, approved_ai, is_past_final_report, created_at)
      VALUES ('doc-included', 'proj-1', 'included.pdf', 'pdf', '추출 완료', '사업계획서', 1, 1, 'solar', 0, '2026-01-01')`);
    db.exec(`INSERT INTO documents (id, project_id, file_name, file_type, status, doc_type, is_included, excluded_reason, masked, approved_ai, is_past_final_report, created_at)
      VALUES ('doc-excluded', 'proj-1', 'excluded.docx', 'docx', '추출 완료', '기타', 0, '무관 문서', 1, 'solar', 0, '2026-01-01')`);

    db.exec(`INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('p-inc-1', 'doc-included', 1, '¶1', '포함된 문서의 첫 번째 문단')`);
    db.exec(`INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('p-exc-1', 'doc-excluded', 1, '¶1', '제외된 문서의 첫 번째 문단')`);

    // 2. buildSuggestInput 호출 시 제외 문서 문단은 빠져야 함
    const input1 = buildSuggestInput('proj-1', db, 'solar');
    expect(input1.some((p) => p.document_id === 'doc-excluded')).toBe(false);
    expect(input1.some((p) => p.document_id === 'doc-included')).toBe(true);
    expect(input1.some((p) => p.id === 'p-inc-1')).toBe(true);
    expect(input1.some((p) => p.id === 'p-exc-1')).toBe(false);

    // 3. 제외 문서를 [포함]으로 변경
    updateDocumentInclusion('doc-excluded', true, null);

    // 4. 다시 buildSuggestInput 호출 시 이제 포함되어야 함
    const input2 = buildSuggestInput('proj-1', db, 'solar');
    expect(input2.some((p) => p.document_id === 'doc-excluded')).toBe(true);
    expect(input2.some((p) => p.id === 'p-exc-1')).toBe(true);

    // 5. 포함 문서를 [제외]로 변경
    updateDocumentInclusion('doc-included', false, '평가자 직접 제외');

    // 6. 다시 buildSuggestInput 호출 시 빠져야 함
    const input3 = buildSuggestInput('proj-1', db, 'solar');
    expect(input3.some((p) => p.document_id === 'doc-included')).toBe(false);
    expect(input3.some((p) => p.id === 'p-inc-1')).toBe(false);
    expect(input3.some((p) => p.document_id === 'doc-excluded')).toBe(true);
  });

  // ---------------- 8. suggest 입력 구성 및 AI 요청 본문 기준 지표 포함 단위 시험 (#19, RQ-08) ----------------
  it('(suggest 입력 구성) 기준 지표가 설정되어 있으면 buildSuggestRequestBody 에 baseline 이 포함된다 (#19, RQ-08)', () => {
    // 1. 기준 지표가 없는 경우
    const bodyWithoutBaseline = buildSuggestRequestBody(mockIndicator, mockParagraphs, null);
    expect(bodyWithoutBaseline.indicator.baseline).toBeUndefined();

    // 2. 기준 지표가 있는 경우
    const baseline = {
      id: 'base-1',
      project_id: 'proj-1',
      indicator_id: mockIndicator.id,
      document_id: 'doc-2',
      document_name: '사업계획서',
      target_value: '80%',
      selected_at: '2026-01-01',
    };

    const bodyWithBaseline = buildSuggestRequestBody(mockIndicator, mockParagraphs, baseline);
    expect(bodyWithBaseline.indicator.baseline).toBeDefined();
    expect(bodyWithBaseline.indicator.baseline).toEqual({
      document_name: '사업계획서',
      target_value: '80%',
    });
    expect(bodyWithBaseline.paragraphs.length).toBe(2);
  });

  it('(suggest 판정 제안) DB 에 저장된 기준 지표가 AI 요청 본문(messages)에 실제로 전달된다 (#19, RQ-08)', async () => {
    // 1. 기준 지표 저장
    saveIndicatorBaseline({
      id: 'base-ind-1',
      project_id: 'proj-1',
      indicator_id: mockIndicator.id,
      document_id: 'doc-2',
      document_name: '사업계획서',
      target_value: '80%',
      selected_at: '2026-01-01',
    });

    // 2. 요청 본문(messages)을 가로채는 AI 클라이언트
    let capturedMessages: any = null;
    const capturingAiClient = {
      provider: 'solar',
      generateSuggestion: async (messages: any) => {
        capturedMessages = messages;
        return {
          suggestion: {
            verdict_status: '실현' as const,
            sentence: '사업계획서 기준(80%) 만족 달성을 확인했습니다.',
            evidences: [
              {
                quote: '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.',
                document_id: 'doc-2',
                location: '¶4',
                speaker: 'KDI' as const,
              },
            ],
          },
          meta: { duration_ms: 15 },
        };
      },
    } as unknown as AiClient;

    await suggestVerdictForIndicator(mockIndicator, mockParagraphs, {
      aiClient: capturingAiClient,
      saveToStore: false,
    });

    expect(capturedMessages).not.toBeNull();
    expect(capturedMessages.length).toBe(2);
    expect(capturedMessages[1].role).toBe('user');

    const parsedContent = JSON.parse(capturedMessages[1].content);
    expect(parsedContent.indicator).toBeDefined();
    expect(parsedContent.indicator.baseline).toBeDefined();
    expect(parsedContent.indicator.baseline.document_name).toBe('사업계획서');
    expect(parsedContent.indicator.baseline.target_value).toBe('80%');
  });
});

