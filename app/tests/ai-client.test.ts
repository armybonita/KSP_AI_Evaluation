import { describe, expect, it, afterEach, vi } from 'vitest';
import { AiCallError, AiClient, getAiClient, setAiClient, validateAiModelConfig, validateAiStartupConfig } from '../src/server/ai/client';
import { register } from '../src/instrumentation';
import { AI_SUGGESTION_JSON_SCHEMA } from '../src/server/ai/types';

describe('AI 클라이언트 단위 시험 (RQ-25, D30, D36)', () => {
  it('AIEAS_MODEL 이 비어 있으면 호출 전에 명확한 설정 오류로 실패한다', async () => {
    // 빈 문자열을 기본값으로 조용히 바꾸지 않고 실패해야 한다.
    expect(() => validateAiModelConfig('')).toThrow(/AIEAS_MODEL/);
    expect(() => new AiClient({ model: '' })).toThrow(/AIEAS_MODEL/);
  });

  it('AIEAS_MODEL 앞뒤 공백을 설정 오류로 거부한다', () => {
    expect(() => validateAiModelConfig(' solar-pro4')).toThrow(/앞뒤 공백/);
    expect(() => validateAiModelConfig('solar-pro4 ')).toThrow(/앞뒤 공백/);
    expect(() => new AiClient({ model: ' solar-pro4 ' })).toThrow(/앞뒤 공백/);
  });

  it('Node 앱 시작 설정 검사에서 빈 AIEAS_MODEL 을 거부한다', () => {
    expect(() => validateAiStartupConfig('nodejs', '')).toThrow(/AIEAS_MODEL/);
  });

  it('instrumentation register() 경로에서 NEXT_RUNTIME 과 무관하게 빈 모델을 거부한다', async () => {
    const originalModel = process.env.AIEAS_MODEL;
    const originalRuntime = process.env.NEXT_RUNTIME;
    delete process.env.NEXT_RUNTIME;
    process.env.AIEAS_MODEL = '';
    try {
      await expect(register()).rejects.toThrow(/AIEAS_MODEL/);
    } finally {
      if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = originalRuntime;
      if (originalModel === undefined) delete process.env.AIEAS_MODEL;
      else process.env.AIEAS_MODEL = originalModel;
    }
  });

  it('설정된 solar-pro4 모델 ID 를 게이트웨이에 그대로 보낸다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: test token for request assertion
      apiKey: 'mock-auth-token',
      model: 'solar-pro4',
      reasoningEffort: 'high',
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ verdict_status: '실현', sentence: '확인', evidences: [] }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    await client.generateSuggestion([{ role: 'user', content: 'test' }]);
    expect(capturedBody?.model).toBe('solar-pro4');
  });

  it('AIEAS_REASONING_EFFORT 가 비어 있으면 호출 전에 명확한 설정 오류로 실패한다', async () => {
    const noReasoningClient = new AiClient({
      baseUrl: 'https://llm.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'dummy',
      model: 'aieas-default',
      reasoningEffort: '',
      fetchFn: async () => new Response('{}'),
    });

    await expect(
      noReasoningClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrow(/AIEAS_REASONING_EFFORT/);
  });

  it('AIEAS_LLM_API_KEY 가 비어 있으면 호출 전에 명확한 설정 오류로 실패한다', async () => {
    const noKeyClient = new AiClient({
      baseUrl: 'https://llm.example.com/v1',
      apiKey: '',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () => new Response('{}'),
    });

    await expect(
      noKeyClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrow(/AIEAS_LLM_API_KEY/);
  });

  it('AIEAS_LLM_BASE_URL 이 비어 있으면 호출 전에 명확한 설정 오류로 실패한다', async () => {
    const noBaseUrlClient = new AiClient({
      baseUrl: '',
      // public-safety-allow: mock key for test
      apiKey: 'dummy',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () => new Response('{}'),
    });

    await expect(
      noBaseUrlClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrow(/AIEAS_LLM_BASE_URL/);
  });

  it('가짜 fetch 로 요청 URL, 본문 model·reasoning_effort·response_format, 두 인증 헤더를 단언한다', async () => {
    let capturedUrl = '';
    let capturedOptions: RequestInit | undefined;

    const fakeResponseContent = {
      verdict_status: '실현',
      sentence: '통합 플랫폼 구축 완료',
      evidences: [
        {
          quote: '통합 플랫폼 완료',
          document_id: 'doc-1',
          location: '1쪽 ¶1',
          speaker: '수행기관',
        },
      ],
    };

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedOptions = init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(fakeResponseContent),
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: test token for header assertion
      apiKey: 'mock-auth-token',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: fakeFetch,
    });

    const messages = [{ role: 'user' as const, content: '지표와 문단을 전달합니다' }];
    const { suggestion: result } = await client.generateSuggestion(messages);

    // 1. 요청 URL 단언 (.../chat/completions)
    expect(capturedUrl).toBe('https://mock-ai.example.com/v1/chat/completions');

    // 2. 인증 헤더 두 가지(Authorization: Bearer, api-key) 단언
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toBeDefined();
    // public-safety-allow: verifying asserted test headers
    expect(headers['Authorization']).toBe('Bearer mock-auth-token');
    expect(headers['api-key']).toBe('mock-auth-token');
    expect(headers['Content-Type']).toBe('application/json');

    // 3. 본문의 model, reasoning_effort, response_format 단언
    const parsedBody = JSON.parse(String(capturedOptions?.body));
    expect(parsedBody.model).toBe('aieas-default');
    expect(parsedBody.reasoning_effort).toBe('xhigh');
    expect(parsedBody.max_tokens).toBeUndefined();
    expect(parsedBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'verdict_suggestion',
        strict: true,
        schema: AI_SUGGESTION_JSON_SCHEMA,
      },
    });
    expect(parsedBody.messages).toEqual(messages);

    // 반환된 파싱 결과 확인
    expect(result.verdict_status).toBe('실현');
    expect(result.sentence).toBe('통합 플랫폼 구축 완료');
    expect(result.evidences).toHaveLength(1);
  });

  it('잘린 JSON 응답은 finish_reason과 토큰 수를 진단에 포함하고 응답 본문은 노출하지 않는다', async () => {
    const privateResponseFragment = 'private-response-fragment';
    let calls = 0;
    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            model: 'solar-pro4-260806',
            choices: [
              {
                finish_reason: 'length',
                message: { content: `{"sentence":"${privateResponseFragment}` },
              },
            ],
            usage: {
              completion_tokens: 8192,
              completion_tokens_details: { reasoning_tokens: 7000 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const error = await client
      .generateSuggestion([{ role: 'user', content: 'test' }])
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiCallError);
    expect((error as AiCallError).meta.usage).toMatchObject({
      completion_tokens: 16384,
      reasoning_tokens: 14000,
    });
    expect((error as AiCallError).meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect((error as Error).message).toMatch(
      /finish_reason=length, completion_tokens=8192, reasoning_tokens=7000, attempts=2, total_completion_tokens=16384/
    );
    expect((error as Error).message).not.toContain(privateResponseFragment);
    expect(calls).toBe(2);
  });

  it('첫 응답 JSON이 잘리면 한 번 재시도해 정상 제안을 반환한다', async () => {
    let calls = 0;
    const nowValues = [1000, 1010, 2000, 2030];
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowValues.shift() ?? 2030);
    const validSuggestion = {
      verdict_status: '추진 중',
      sentence: '확인된 근거에 따라 사업이 진행 중입니다.',
      evidences: [],
    };
    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        calls += 1;
        const content = calls === 1
          ? '{"verdict_status":"추진 중","sentence":"잘린 응답'
          : JSON.stringify(validSuggestion);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content } }],
            usage: {
              prompt_tokens: calls * 10,
              completion_tokens: calls * 4,
              total_tokens: calls * 14,
              completion_tokens_details: { reasoning_tokens: calls * 2 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    try {
      const result = await client.generateSuggestion([{ role: 'user', content: 'test' }]);
      expect(calls).toBe(2);
      expect(result.suggestion.verdict_status).toBe('추진 중');
      expect(result.suggestion.sentence).toBe(validSuggestion.sentence);
      expect(result.meta.usage).toEqual({
        prompt_tokens: 30,
        completion_tokens: 12,
        reasoning_tokens: 6,
        total_tokens: 42,
      });
      expect(result.meta.duration_ms).toBe(40);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('usage 누락 재시도는 합계를 unknown으로 남기고 최상위 reasoning_tokens를 읽는다', async () => {
    const validSuggestion = {
      verdict_status: '추진 중',
      sentence: '확인된 근거에 따라 사업이 진행 중입니다.',
      evidences: [],
    };
    let missingUsageCalls = 0;
    const missingUsageClient = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        missingUsageCalls += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    missingUsageCalls === 1
                      ? '{"verdict_status":"추진 중"'
                      : JSON.stringify(validSuggestion),
                },
              },
            ],
            ...(missingUsageCalls === 2
              ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
              : {}),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });
    const retried = await missingUsageClient.generateSuggestion([
      { role: 'user', content: 'test' },
    ]);
    expect(retried.meta.usage).toBeUndefined();

    const topLevelReasoningClient = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validSuggestion) } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              reasoning_tokens: 3,
              total_tokens: 15,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    });
    const topLevelReasoning = await topLevelReasoningClient.generateSuggestion([
      { role: 'user', content: 'test' },
    ]);
    expect(topLevelReasoning.meta.usage?.reasoning_tokens).toBe(3);
  });

  it('응답 스키마 오류는 필드값을 로그 진단에 포함하지 않는다', async () => {
    const privateValue = 'private-invalid-enum-value';
    const privateFinishReason = 'private-provider-finish-reason';
    let calls = 0;
    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: privateFinishReason,
                message: {
                  content: JSON.stringify({
                    verdict_status: privateValue,
                    sentence: 'private-response-text',
                    evidences: [],
                  }),
                },
              },
            ],
            usage: { completion_tokens: 20, total_tokens: 20 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const error = await client
      .generateSuggestion([{ role: 'user', content: 'test' }])
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('AI 응답 스키마 검증 실패');
    expect((error as Error).message).toContain('finish_reason=unknown');
    expect((error as Error).message).not.toContain(privateValue);
    expect((error as Error).message).not.toContain(privateFinishReason);
    expect((error as Error).message).not.toContain('private-response-text');
    expect(calls).toBe(2);
  });

  it('빈 응답 본문은 한 번 재시도한 뒤 안전한 오류로 실패한다', async () => {
    let calls = 0;
    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for unit test
      apiKey: 'mock-key',
      model: 'solar-pro4',
      reasoningEffort: 'xhigh',
      fetchFn: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    await expect(client.generateSuggestion([{ role: 'user', content: 'test' }])).rejects.toThrow(
      'AI 응답에 본문 내용이 없습니다.'
    );
    expect(calls).toBe(2);
  });

  it('호출 성공 시 응답의 결과와 meta(usage, duration_ms)를 단일 반환값으로 돌려준다', async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict_status: '실현',
                  sentence: '테스트 문장',
                  evidences: [
                    {
                      quote: '인용',
                      document_id: 'doc-1',
                      location: '¶1',
                      speaker: 'KDI',
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 150,
            completion_tokens: 80,
            total_tokens: 230,
            completion_tokens_details: {
              reasoning_tokens: 50,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'mock-key',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: fakeFetch,
    });

    const callResult = await client.generateSuggestion([
      { role: 'user', content: '지표 제안 요청' },
    ]);

    expect(callResult.suggestion.verdict_status).toBe('실현');
    expect(callResult.meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(callResult.meta.usage).toEqual({
      prompt_tokens: 150,
      completion_tokens: 80,
      reasoning_tokens: 50,
      total_tokens: 230,
    });
  });

  it('동시 호출 두 개가 서로의 메타(usage, duration_ms)를 받지 않고 격리된다 (RQ-25)', async () => {
    // 요청 1: 50ms 지연, prompt_tokens: 111
    // 요청 2: 10ms 지연, prompt_tokens: 222
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const isCall1 = String(body.messages[0].content).includes('call1');
      const delay = isCall1 ? 50 : 10;
      const tokens = isCall1 ? 111 : 222;

      await new Promise((resolve) => setTimeout(resolve, delay));

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict_status: isCall1 ? '실현' : '추진 중',
                  sentence: isCall1 ? 'call1 문장' : 'call2 문장',
                  evidences: [
                    {
                      quote: '인용',
                      document_id: 'doc-1',
                      location: '¶1',
                      speaker: 'KDI',
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: tokens,
            completion_tokens: tokens,
            total_tokens: tokens * 2,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const client = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'mock-key',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: fakeFetch,
    });

    const [res1, res2] = await Promise.all([
      client.generateSuggestion([{ role: 'user', content: 'call1' }]),
      client.generateSuggestion([{ role: 'user', content: 'call2' }]),
    ]);

    expect(res1.suggestion.sentence).toBe('call1 문장');
    expect(res1.meta.usage?.prompt_tokens).toBe(111);
    expect(res1.meta.duration_ms).toBeGreaterThanOrEqual(40);

    expect(res2.suggestion.sentence).toBe('call2 문장');
    expect(res2.meta.usage?.prompt_tokens).toBe(222);
    expect(res2.meta.duration_ms).toBeGreaterThanOrEqual(8);
  });

  it('HTTP 오류 발생 시 본문 전체를 예외 메시지에 넣지 않고 상태 코드와 error.code 만 남긴다', async () => {
    // Case 1: JSON 본문에 error.code 가 있는 경우 (민감한 메시지 본문은 마스킹/미포함)
    const errorWithCodeClient = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'mock-key',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              message:
                'This is a sensitive internal error details that must not leak into exceptions',
              details: { internal: 'do-not-reveal' },
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ),
    });

    await expect(
      errorWithCodeClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrowError('AI 호출 실패 (HTTP 400, code: context_length_exceeded)');

    // 민감한 본문 내용이 전혀 없음을 재확인
    try {
      await errorWithCodeClient.generateSuggestion([{ role: 'user', content: 'test' }]);
    } catch (err: any) {
      expect(err.message).not.toContain('sensitive internal error');
      expect(err.message).not.toContain('do-not-reveal');
    }

    const errorCodeWithDiagnosticTextClient = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'mock-key',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { code: 'completion_tokens=123456' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    await expect(
      errorCodeWithDiagnosticTextClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrowError('AI 호출 실패 (HTTP 500)');

    // Case 2: 본문이 HTML 또는 일반 텍스트이거나 error.code 가 없는 경우
    const errorPlainClient = new AiClient({
      baseUrl: 'https://mock-ai.example.com/v1',
      // public-safety-allow: mock key for test
      apiKey: 'mock-key',
      model: 'aieas-default',
      reasoningEffort: 'xhigh',
      fetchFn: async () =>
        new Response('<html><body>502 Bad Gateway with raw server paths</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    });

    await expect(
      errorPlainClient.generateSuggestion([{ role: 'user', content: 'test' }])
    ).rejects.toThrowError('AI 호출 실패 (HTTP 502)');

    try {
      await errorPlainClient.generateSuggestion([{ role: 'user', content: 'test' }]);
    } catch (err: any) {
      expect(err.message).not.toContain('502 Bad Gateway with raw server paths');
    }
  });

  describe('AIEAS_E2E_FAKE_AI 환경변수 격리 및 고정 응답 주입 지점 단위 시험 (D30)', () => {
    const originalEnv = process.env.AIEAS_E2E_FAKE_AI;
    const originalModel = process.env.AIEAS_MODEL;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.AIEAS_E2E_FAKE_AI;
      } else {
        process.env.AIEAS_E2E_FAKE_AI = originalEnv;
      }
      if (originalModel === undefined) {
        delete process.env.AIEAS_MODEL;
      } else {
        process.env.AIEAS_MODEL = originalModel;
      }
      setAiClient(null);
    });

    it('운영 경로(AIEAS_E2E_FAKE_AI 없음)에서는 가짜 응답이 쓰이지 않고 실제 AiClient 설정 규칙을 강제한다', async () => {
      delete process.env.AIEAS_E2E_FAKE_AI;
      process.env.AIEAS_MODEL = 'aieas-default';
      setAiClient(null);

      const client = getAiClient();
      // 가짜 응답이 아니라 실제 환경변수 검증으로 진입하여 필수 설정 누락 오류 발생
      await expect(
        client.generateSuggestion([{ role: 'user', content: 'test' }])
      ).rejects.toThrow(/AIEAS_LLM_BASE_URL/);

      // AIEAS_E2E_FAKE_AI 가 '0' 등 1이 아닌 값일 때도 동일하게 운영 경로 강제
      process.env.AIEAS_E2E_FAKE_AI = '0';
      process.env.AIEAS_MODEL = 'aieas-default';
      setAiClient(null);

      const client2 = getAiClient();
      await expect(
        client2.generateSuggestion([{ role: 'user', content: 'test' }])
      ).rejects.toThrow(/AIEAS_LLM_BASE_URL/);
    });

    it('AIEAS_E2E_FAKE_AI=1 일 때만 고정 응답을 사용하는 가짜 AI 클라이언트가 주입된다', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      setAiClient(null);

      const client = getAiClient();
      const result = await client.generateSuggestion([
        { role: 'user', content: JSON.stringify({ indicator: { id: 'ind-activity' } }) },
      ]);

      expect(result.suggestion.verdict_status).toBe('실현');
      expect(result.suggestion.sentence).toContain('교육 훈련 실적');
      expect(result.suggestion.evidences).toHaveLength(1);
    });

    it('AIEAS_E2E_FAKE_AI=1 일 때 고정 지표 id 가 아니더라도 요청 본문의 지표·근거 문단에서 결정적으로 응답을 생성한다 (RQ-28)', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      setAiClient(null);

      const client = getAiClient();
      const dynamicIndicator = {
        id: 'ind-dynamic-uuid-' + crypto.randomUUID(),
        level: '활동',
        name: '현지 공무원 교육',
        ovi: '공무원 500명 이수 달성',
        target_value: '500명',
      };
      const paragraphs = [
        {
          document_id: 'doc-dynamic-trip',
          location: '2쪽 ¶2',
          content: '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.',
        },
      ];

      const result = await client.generateSuggestion([
        {
          role: 'user',
          content: JSON.stringify({
            indicator: dynamicIndicator,
            paragraphs,
          }),
        },
      ]);

      expect(result.suggestion.verdict_status).toBe('실현');
      expect(result.suggestion.sentence).toContain('500명');
      expect(result.suggestion.evidences).toHaveLength(1);
      expect(result.suggestion.evidences[0].document_id).toBe('doc-dynamic-trip');
      expect(result.suggestion.evidences[0].location).toBe('2쪽 ¶2');
    });

    it('가짜 AI(E2E): 알 수 없는 지표에 대해 ind-activity 기본값 폴백 없이 요청 본문 지표 기반으로만 응답한다 (#23 검수)', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      setAiClient(null);

      const client = getAiClient();
      const unknownIndicator = {
        id: 'ind-custom-unknown',
        level: '산출물',
        name: '맞춤형 통합 플랫폼 구축',
        ovi: '플랫폼 개발',
        target_value: '1식',
      };
      const paragraphs = [
        {
          document_id: 'doc-report-1',
          location: '1쪽 ¶1',
          content: '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
        },
      ];

      const result = await client.generateSuggestion([
        {
          role: 'user',
          content: JSON.stringify({
            indicator: unknownIndicator,
            paragraphs,
          }),
        },
      ]);

      // ind-activity ('실현', '교육 훈련 실적') 기본값으로 대체되지 않고 본문 기반 ('기대', '통합 플랫폼') 으로 응답
      expect(result.suggestion.verdict_status).toBe('기대');
      expect(result.suggestion.sentence).toContain('통합 플랫폼');
      expect(result.suggestion.sentence).not.toContain('교육 훈련 실적');
    });

    it('가짜 AI(E2E): 알 수 없는 지표이며 요청 본문에서도 지표 정보를 파싱할 수 없으면 ind-activity 폴백 없이 오류를 던진다 (#23 검수)', async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      setAiClient(null);

      const client = getAiClient();

      await expect(
        client.generateSuggestion([
          { role: 'user', content: '알 수 없는 지표이며 지표 JSON 구조 없음' },
        ])
      ).rejects.toThrow(/알 수 없는 지표/);
    });

    it("가짜 AI(E2E): 지표 이름이나 근거 문구에 'ind-activity' 가 들어간 미지 지표는 fixture 응답을 받지 않는다 (#23)", async () => {
      process.env.AIEAS_E2E_FAKE_AI = '1';
      setAiClient(null);

      const client = getAiClient();

      // 1. 지표 이름에 'ind-activity' 가 포함된 미지 지표
      const unknownIndicatorWithName = {
        id: 'ind-unknown-named-activity',
        level: '산출물',
        name: '미지 지표 (ind-activity 지표 연계)',
        ovi: '신규 성과 체계',
        target_value: '1건',
      };

      const resultFromName = await client.generateSuggestion([
        {
          role: 'user',
          content: JSON.stringify({
            indicator: unknownIndicatorWithName,
            paragraphs: [],
          }),
        },
      ]);

      // ind-activity 고정 fixture('실현', '교육 훈련 실적') 응답을 받지 않아야 함
      expect(resultFromName.suggestion.verdict_status).not.toBe('실현');
      expect(resultFromName.suggestion.sentence).not.toContain('교육 훈련 실적');
      expect(resultFromName.suggestion.sentence).toBe('관련 증빙 문서를 확인하지 못함.');
      expect(resultFromName.suggestion.evidences).toHaveLength(0);

      // 2. 근거 문구(paragraphs)에 'ind-activity' 가 포함된 미지 지표
      const unknownIndicatorWithEvidence = {
        id: 'ind-unknown-evidence-activity',
        level: '산출물',
        name: '미지 지표 성과 관리',
        ovi: '운영 결과 집계',
        target_value: '1건',
      };
      const paragraphsWithEvidence = [
        {
          document_id: 'doc-unknown-ref',
          location: '1쪽 ¶1',
          content: '참고 지표 ind-activity 와 관련된 별도 근거 문구 내용입니다.',
        },
      ];

      const resultFromEvidence = await client.generateSuggestion([
        {
          role: 'user',
          content: JSON.stringify({
            indicator: unknownIndicatorWithEvidence,
            paragraphs: paragraphsWithEvidence,
          }),
        },
      ]);

      // ind-activity 고정 fixture('실현', '교육 훈련 실적') 응답을 받지 않아야 함
      expect(resultFromEvidence.suggestion.verdict_status).not.toBe('실현');
      expect(resultFromEvidence.suggestion.sentence).not.toContain('교육 훈련 실적');
      expect(resultFromEvidence.suggestion.sentence).toBe('관련 증빙 문서를 확인하지 못함.');
      expect(resultFromEvidence.suggestion.evidences).toHaveLength(0);
    });
  });
});

