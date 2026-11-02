import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiClient, createE2EFakeAiClient, getAiGatewayProvider, getAiProvider, setAiClient, OntologyCallError, runOntologyAttempts, validateAiStartupConfig } from './client';

afterEach(() => vi.useRealTimers());

describe('AiClient ontology request cancellation', () => {
  it('propagates caller cancellation through the attempt signal without retrying', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn });
    const pending = client.generateOntology([{ role: 'user', content: '가상 시험 요청' }], controller.signal);
    await Promise.resolve();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(receivedSignal).not.toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('ontology attempt limits and retries', () => {
  it('limits the second attempt to the remaining batch time after a timeout', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const attempt = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    });
    const pending = runOntologyAttempts(attempt);
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signals[1].aborted).toBe(true);
  });

  it('counts retry waiting against the batch limit', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValue(new OntologyCallError('http-429'));
    const pending = runOntologyAttempts(attempt, { wait: () => new Promise<void>(() => {}) });
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(300_000);
    await rejection;
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries an invalid response and succeeds with the next response', async () => {
    const empty = { snippets: [], nodes: [], edges: [] };
    const response = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ snippets: 'invalid', nodes: [], edges: [] })).mockResolvedValueOnce(response(empty));
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn });
    await expect(client.generateOntology([{ role: 'user', content: '가상 시험 요청' }])).resolves.toEqual(empty);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('checks eligibility before an internal malformed-response retry', async () => {
    let eligible = true;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      // The first physical request was eligible. Its response wait ends after
      // the source becomes ineligible, so the same raw prompt must not retry.
      eligible = false;
      return Response.json({ choices: [{ message: { content: '{' } }] });
    });
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn });
    const guard = vi.fn(() => { if (!eligible) throw new Error('eligibility changed'); });
    const raw = '가상 적격 상태에서만 허용되는 고유 원문';
    await expect(client.generateSuggestion([{ role: 'user', content: raw }], { guard })).rejects.toThrow('eligibility changed');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(fetchFn.mock.calls[0][1]?.body)).toContain(raw);
  });

  it('aborts an in-progress retry wait immediately without another request', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'fixture-model', reasoningEffort: 'low', fetchFn });
    let waitStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { waitStarted = resolve; });
    const wait = vi.fn(() => { waitStarted(); return new Promise<void>(() => {}); });
    const pending = runOntologyAttempts((signal) => client.generateOntology([], signal, { singleAttempt: true }), { signal: controller.signal, wait });
    await waiting;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});


describe('AI provider identity', () => {
  it('가짜 온톨로지 분석은 입력 문단을 근거로 각 검토 단계의 노트를 생성한다', async () => {
    const fake = createE2EFakeAiClient();
    const generated = await fake.generateOntology([
      { role: 'system', content: '가상 온톨로지 분석' },
      { role: 'user', content: JSON.stringify({ document: { id: 'doc' }, paragraphs: [{ id: 'p', content: '가상 사업 문단' }] }) },
    ]);
    expect(generated.snippets[0]).toMatchObject({ paragraph_id: 'p', quote: '가상 사업 문단' });
    expect(generated.nodes.map((node) => node.type)).toEqual(['output', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint']);
  });

  it('identifies only the selected in-memory fake while a gateway remains unknown', () => {
    const previousFake = process.env.AIEAS_E2E_FAKE_AI;
    const previousProvider = process.env.AIEAS_AI_PROVIDER;
    const previousModel = process.env.AIEAS_MODEL;
    try {
      delete process.env.AIEAS_E2E_FAKE_AI;
      delete process.env.AIEAS_AI_PROVIDER;
      process.env.AIEAS_MODEL = 'aieas-default';
      setAiClient(null);
      expect(getAiProvider()).toBeNull();
      const fake = createE2EFakeAiClient();
      expect(fake.provider).toBe('solar');
      setAiClient(fake);
      expect(getAiProvider()).toBe('solar');
      const gateway = new AiClient({ model: 'aieas-default' });
      setAiClient(gateway);
      process.env.AIEAS_E2E_FAKE_AI = '1';
      expect(gateway.provider).toBeNull();
      expect(getAiProvider()).toBeNull();
    } finally {
      if (previousFake === undefined) delete process.env.AIEAS_E2E_FAKE_AI;
      else process.env.AIEAS_E2E_FAKE_AI = previousFake;
      if (previousProvider === undefined) delete process.env.AIEAS_AI_PROVIDER;
      else process.env.AIEAS_AI_PROVIDER = previousProvider;
      if (previousModel === undefined) delete process.env.AIEAS_MODEL;
      else process.env.AIEAS_MODEL = previousModel;
      setAiClient(null);
    }
  });
});

describe('deployment AI provider declaration', () => {
  const withProviderEnv = (provider: string | undefined, model: string | undefined, run: () => void) => {
    const previousProvider = process.env.AIEAS_AI_PROVIDER;
    const previousModel = process.env.AIEAS_MODEL;
    try {
      if (provider === undefined) delete process.env.AIEAS_AI_PROVIDER;
      else process.env.AIEAS_AI_PROVIDER = provider;
      if (model === undefined) delete process.env.AIEAS_MODEL;
      else process.env.AIEAS_MODEL = model;
      run();
    } finally {
      if (previousProvider === undefined) delete process.env.AIEAS_AI_PROVIDER;
      else process.env.AIEAS_AI_PROVIDER = previousProvider;
      if (previousModel === undefined) delete process.env.AIEAS_MODEL;
      else process.env.AIEAS_MODEL = previousModel;
    }
  };

  it('uses an explicit supported provider declaration', () => {
    withProviderEnv('solar', 'unmapped-model', () => {
      expect(getAiGatewayProvider()).toBe('solar');
      setAiClient(null);
      expect(getAiProvider()).toBe('solar');
    });
  });

  it('maps a solar model prefix case-insensitively when provider is unset', () => {
    withProviderEnv(undefined, 'SoLaR-pro2', () => {
      expect(getAiGatewayProvider()).toBe('solar');
      setAiClient(null);
      expect(getAiProvider()).toBe('solar');
    });
  });

  it('keeps unknown model providers unresolved', () => {
    withProviderEnv(undefined, 'aieas-default', () => {
      expect(getAiGatewayProvider()).toBeNull();
      setAiClient(null);
      expect(getAiProvider()).toBeNull();
    });
  });

  it('rejects unsupported provider declarations at startup', () => {
    for (const provider of ['unknown-provider', 'Solar', ' solar ', ' ']) {
      withProviderEnv(provider, 'solar-pro2', () => {
        expect(() => validateAiStartupConfig('nodejs')).toThrow(/AIEAS_AI_PROVIDER/);
        expect(getAiGatewayProvider()).toBeNull();
      });
    }
  });

  it('warns and continues when the declaration differs from the mapped model', () => {
    withProviderEnv('local-only', 'solar-pro2', () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() => validateAiStartupConfig('nodejs')).not.toThrow();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('선언한 제공자를 사용합니다'));
        expect(getAiGatewayProvider()).toBe('local-only');
      } finally {
        warning.mockRestore();
      }
    });
  });
});
