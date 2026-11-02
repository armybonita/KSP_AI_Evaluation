import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_REPORT_JSON_SCHEMA,
  AI_SUGGESTION_JSON_SCHEMA,
  AiCallMeta,
  AiReportResponseSchema,
  AiReportResult,
  AiSuggestion,
  AiSuggestionResult,
  AiSuggestionSchema,
  AiUsage,
  ChatMessage,
} from './types';
import { ONTOLOGY_GENERATION_JSON_SCHEMA, OntologyGenerationResponseSchema, OntologyGenerationResponse } from '../ontology/generator-types';

export interface AiClientConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  reasoningEffort?: string;
  fetchFn?: typeof fetch;
}

export type OntologyFailureKind = 'timeout' | 'invalid-response' | 'network' | `http-${number}`;
/** Reads a positive millisecond limit from the environment; falls back on anything missing or out of range. */
export function timeoutFromEnv(raw: string | undefined, fallback: number, max = 3_600_000): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1_000 && value <= max ? value : fallback;
}
const env = typeof process !== 'undefined' && process.env ? process.env : {} as Record<string, string | undefined>;
// Slow reasoning models can need longer than the defaults; operators raise these per server.
export const AI_CALL_TIMEOUT_MS = timeoutFromEnv(env.AIEAS_AI_CALL_TIMEOUT_MS, 180_000);
export const ONTOLOGY_BATCH_TIMEOUT_MS = timeoutFromEnv(env.AIEAS_ONTOLOGY_BATCH_TIMEOUT_MS, 300_000);

export class OntologyCallError extends Error {
  constructor(readonly kind: OntologyFailureKind) {
    super(kind);
    this.name = 'OntologyCallError';
  }
}

export async function runOntologyAttempts<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number; wait?: (ms: number) => Promise<void>; signal?: AbortSignal; guard?: () => void } = {},
): Promise<T> {
  const deadline = performance.now() + ONTOLOGY_BATCH_TIMEOUT_MS;
  const abortError = () => new DOMException('Aborted', 'AbortError');
  const waitForRetry = async () => {
    const remaining = deadline - performance.now();
    if (options.signal?.aborted) throw abortError();
    if (remaining <= 0) throw new OntologyCallError('timeout');
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        options.wait ? options.wait(500) : new Promise<void>((resolve) => { delayTimer = setTimeout(resolve, 500); }),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new OntologyCallError('timeout')), remaining);
          onAbort = () => reject(abortError());
          options.signal?.addEventListener('abort', onAbort, { once: true });
          if (options.signal?.aborted) onAbort();
        }),
      ]);
    } finally {
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    }
    if (options.signal?.aborted) throw abortError();
    if (performance.now() >= deadline) throw new OntologyCallError('timeout');
  };
  for (let index = 0; index < 2; index++) {
    options.guard?.();
    if (options.signal?.aborted) throw abortError();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new OntologyCallError('timeout');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const signal = controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        attempt(signal),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new OntologyCallError('timeout'));
            controller.abort();
          }, Math.min(options.timeoutMs ?? AI_CALL_TIMEOUT_MS, remaining));
        }),
      ]);
      if (performance.now() >= deadline) throw new OntologyCallError('timeout');
      return result;
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (options.signal?.aborted) throw error;
      if (performance.now() >= deadline) throw new OntologyCallError('timeout');
      const failure = error instanceof OntologyCallError ? error : new OntologyCallError('network');
      const status = failure.kind.startsWith('http-') ? Number(failure.kind.slice(5)) : 0;
      const retry = failure.kind === 'timeout' || failure.kind === 'invalid-response' || status === 429 || (status >= 500 && status <= 599);
      if (index === 1 || !retry) throw failure;
      if (status === 429 || (status >= 500 && status <= 599)) await waitForRetry();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
  throw new OntologyCallError('network');
}

export class AiCallError extends Error {
  readonly meta: AiCallMeta;

  constructor(message: string, meta: AiCallMeta) {
    super(message);
    this.name = 'AiCallError';
    this.meta = meta;
  }
}

const SAFE_FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
  'end_turn',
  'stop_sequence',
]);

function safeFinishReason(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase();
  return SAFE_FINISH_REASONS.has(normalized) ? normalized : 'unknown';
}

export function mergeAiCallMeta(
  previous: AiCallMeta | undefined,
  current: AiCallMeta | undefined
): AiCallMeta {
  const previousUsage = previous?.usage;
  const currentUsage = current?.usage;
  const sumKnown = (left: number | undefined, right: number | undefined) =>
    left !== undefined && right !== undefined ? left + right : undefined;
  const usage: AiUsage | undefined = previous
    ? previousUsage && currentUsage
      ? {
          prompt_tokens: sumKnown(previousUsage.prompt_tokens, currentUsage.prompt_tokens),
          completion_tokens: sumKnown(
            previousUsage.completion_tokens,
            currentUsage.completion_tokens
          ),
          reasoning_tokens: sumKnown(
            previousUsage.reasoning_tokens,
            currentUsage.reasoning_tokens
          ),
          total_tokens: sumKnown(previousUsage.total_tokens, currentUsage.total_tokens),
        }
      : undefined
    : currentUsage;
  return {
    usage,
    duration_ms: (previous?.duration_ms ?? 0) + (current?.duration_ms ?? 0),
  };
}

function finiteNumber(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUsage(usageRaw: any): AiUsage | undefined {
  if (!usageRaw || typeof usageRaw !== 'object') return undefined;
  const usage: AiUsage = {
    prompt_tokens: finiteNumber(usageRaw.prompt_tokens),
    completion_tokens: finiteNumber(usageRaw.completion_tokens),
    reasoning_tokens: finiteNumber(
      usageRaw.completion_tokens_details?.reasoning_tokens ?? usageRaw.reasoning_tokens
    ),
    total_tokens: finiteNumber(usageRaw.total_tokens),
  };
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}

function responseDiagnostics(
  response: any,
  finishReason: unknown,
  contentLength: number,
  previousMeta?: AiCallMeta
): string {
  const usage = response?.usage;
  const completionTokens = finiteNumber(usage?.completion_tokens) ?? 'unknown';
  const reasoningTokens =
    finiteNumber(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens) ??
    'unknown';
  const currentMeta: AiCallMeta = {
    usage: parseUsage(usage),
    duration_ms: 0,
  };
  const totalMeta = mergeAiCallMeta(previousMeta, currentMeta);
  return (
    `finish_reason=${safeFinishReason(finishReason)}, ` +
    `completion_tokens=${completionTokens}, reasoning_tokens=${reasoningTokens}, ` +
    `attempts=${previousMeta ? 2 : 1}, total_completion_tokens=${totalMeta.usage?.completion_tokens ?? 'unknown'}, ` +
    `total_reasoning_tokens=${totalMeta.usage?.reasoning_tokens ?? 'unknown'}, content_chars=${contentLength}`
  );
}

export function validateAiModelConfig(model = process.env.AIEAS_MODEL ?? ''): void {
  if (!model) {
    throw new Error('AIEAS_MODEL 환경변수가 설정되지 않았거나 비어 있습니다. 기본값으로 조용히 대체하지 않습니다.');
  }
  if (model !== model.trim()) {
    throw new Error('AIEAS_MODEL 앞뒤 공백은 설정 오류입니다.');
  }
}

export function validateAiStartupConfig(
  runtime?: string,
  model?: string
): void {
  const hasProcessEnv = typeof process !== 'undefined' && typeof process.env !== 'undefined';
  const activeRuntime = runtime ?? (hasProcessEnv ? process.env.NEXT_RUNTIME : undefined);
  if (model !== undefined) {
    validateAiModelConfig(model);
  } else if (hasProcessEnv) {
    validateAiModelConfig(process.env.AIEAS_MODEL ?? '');
  } else if (activeRuntime === 'edge') {
    // Next Edge may not expose process.env; only that runtime cannot read the model setting.
    return;
  } else {
    validateAiModelConfig('');
  }
  const activeModel = model ?? (hasProcessEnv ? process.env.AIEAS_MODEL ?? '' : '');
  const declaredProvider = process.env.AIEAS_AI_PROVIDER;
  if (declaredProvider !== undefined && declaredProvider !== '' && declaredProvider !== 'solar' && declaredProvider !== 'local-only') {
    throw new Error('AIEAS_AI_PROVIDER 는 solar 또는 local-only 여야 합니다.');
  }
  const inferredProvider = providerForModel(activeModel);
  if (declaredProvider && inferredProvider && declaredProvider !== inferredProvider) {
    console.warn(`AIEAS_AI_PROVIDER=${declaredProvider} 와 AIEAS_MODEL=${activeModel}의 제공자 대응(${inferredProvider})이 다릅니다. 선언한 제공자를 사용합니다.`);
  }
}

const MODEL_PROVIDER_PREFIXES: ReadonlyArray<{ prefix: string; provider: string }> = [
  { prefix: 'solar', provider: 'solar' },
];

function providerForModel(model: string): string | null {
  const normalized = model.toLowerCase();
  return MODEL_PROVIDER_PREFIXES.find(({ prefix }) => normalized.startsWith(prefix))?.provider ?? null;
}

export function getAiGatewayProvider(model = process.env.AIEAS_MODEL ?? ''): string | null {
  const declaredProvider = process.env.AIEAS_AI_PROVIDER;
  if (declaredProvider === 'solar' || declaredProvider === 'local-only') return declaredProvider;
  if (declaredProvider !== undefined && declaredProvider !== '') return null;
  return providerForModel(model);
}

// Production provider identity comes from the deployment declaration, with a fixed model-prefix fallback.
export function getAiProvider(): string | null {
  if (defaultClient) return defaultClient.provider;
  return process.env.AIEAS_E2E_FAKE_AI === '1' ? getAiClient().provider : getAiGatewayProvider();
}

/**
 * Node's built-in fetch gives up after 300 s without response headers (undici headersTimeout), whatever
 * AIEAS_AI_CALL_TIMEOUT_MS says. Reasoning models answer non-streamed requests only when done, so long calls
 * were cut at 300.7 s on the dev server. AI calls use undici's fetch with timeouts just above the configured
 * per-call limit, so the app's own timeout (with its clearer error) always fires first.
 */
const aiAgent = new UndiciAgent({ headersTimeout: AI_CALL_TIMEOUT_MS + 30_000, bodyTimeout: AI_CALL_TIMEOUT_MS + 30_000 });
export const aiFetch = ((input: string | URL | Request, init?: RequestInit) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as object), dispatcher: aiAgent } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;

export class AiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reasoningEffort?: string;
  private readonly fetchFn: typeof fetch;

  constructor(config?: AiClientConfig) {
    this.baseUrl = config?.baseUrl ?? process.env.AIEAS_LLM_BASE_URL ?? '';
    // public-safety-allow: reading environment variable AIEAS_LLM_API_KEY, not a hardcoded secret
    this.apiKey = config?.apiKey ?? process.env['AIEAS_LLM_API_KEY'] ?? '';
    this.model = config?.model ?? process.env.AIEAS_MODEL ?? '';
    validateAiModelConfig(this.model);
    this.reasoningEffort = config?.reasoningEffort ?? process.env.AIEAS_REASONING_EFFORT ?? '';
    this.fetchFn = config?.fetchFn ?? aiFetch;
  }

  get modelName(): string { return this.model; }

  // Prefer the deployment declaration; infer only through the fixed model-prefix table.
  get provider(): string | null { return getAiGatewayProvider(this.model); }

  /** Measures the exact JSON body sent by generateSynthesis, including the envelope. */
  synthesisRequestBytes(messages: ChatMessage[]): number {
    return Buffer.byteLength(JSON.stringify({ model: this.model, messages, reasoning_effort: this.reasoningEffort, response_format: { type: 'json_object' } }), 'utf8');
  }

  /** The synthesis layer validates each returned item independently. */
  async generateSynthesis(messages: ChatMessage[], signal?: AbortSignal): Promise<unknown> {
    if (!this.baseUrl.trim() || !this.apiKey.trim() || !this.reasoningEffort?.trim()) throw new Error('AI 설정이 완전하지 않습니다.');
    const response = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, 'api-key': this.apiKey },
      signal,
      body: JSON.stringify({ model: this.model, messages, reasoning_effort: this.reasoningEffort, response_format: { type: 'json_object' } }),
    });
    if (!response.ok) throw new OntologyCallError(`http-${response.status}`);
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) throw new Error('empty');
      return JSON.parse(content) as unknown;
    } catch { throw new OntologyCallError('invalid-response'); }
  }

  async generateOntology(messages: ChatMessage[], signal?: AbortSignal, options?: { singleAttempt?: boolean; guard?: () => void }): Promise<OntologyGenerationResponse> {
    if (options?.singleAttempt) { options.guard?.(); return this.generateOntologyAttempt(messages, signal, options?.guard); }
    return runOntologyAttempts((attemptSignal) => this.generateOntologyAttempt(messages, attemptSignal, options?.guard), { signal, guard: options?.guard });
  }

  private async generateOntologyAttempt(messages: ChatMessage[], signal?: AbortSignal, guard?: () => void): Promise<OntologyGenerationResponse> {
    if (!this.baseUrl.trim()) throw new Error('AIEAS_LLM_BASE_URL 환경변수가 설정되지 않았거나 비어 있습니다.');
    if (!this.apiKey.trim()) throw new Error('AIEAS_LLM_API_KEY 환경변수가 설정되지 않았거나 비어 있습니다.');
    if (!this.reasoningEffort?.trim()) throw new Error('AIEAS_REASONING_EFFORT 환경변수가 설정되지 않았거나 비어 있습니다.');
    guard?.();
    const response = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, 'api-key': this.apiKey },
      signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        reasoning_effort: this.reasoningEffort,
        response_format: { type: 'json_schema', json_schema: { name: 'ontology_generation', strict: true, schema: ONTOLOGY_GENERATION_JSON_SCHEMA } },
      }),
    });
    if (!response.ok) throw new OntologyCallError(`http-${response.status}`);
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.length) throw new Error('empty');
      return OntologyGenerationResponseSchema.parse(JSON.parse(content));
    } catch {
      throw new OntologyCallError('invalid-response');
    }
  }

  async generateSuggestion(messages: ChatMessage[], options?: { guard?: () => void }): Promise<AiSuggestionResult> {
    options?.guard?.();
    return this.generateSuggestionAttempt(messages, true, undefined, options?.guard);
  }

  private async generateSuggestionAttempt(
    messages: ChatMessage[],
    retryMalformedResponse: boolean,
    previousMeta?: AiCallMeta,
    guard?: () => void,
  ): Promise<AiSuggestionResult> {
    if (!this.baseUrl || this.baseUrl.trim().length === 0) {
      throw new Error('AIEAS_LLM_BASE_URL 환경변수가 설정되지 않았거나 비어 있습니다.');
    }
    // public-safety-allow: checking presence of AIEAS_LLM_API_KEY env var
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error('AIEAS_LLM_API_KEY 환경변수가 설정되지 않았거나 비어 있습니다.');
    }
    if (!this.reasoningEffort || this.reasoningEffort.trim().length === 0) {
      throw new Error('AIEAS_REASONING_EFFORT 환경변수가 설정되지 않았거나 비어 있습니다.');
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'verdict_suggestion',
          strict: true,
          schema: AI_SUGGESTION_JSON_SCHEMA,
        },
      },
    };

    if (this.reasoningEffort) {
      requestBody.reasoning_effort = this.reasoningEffort;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      // 게이트웨이는 선택된 공급자 인증 방식으로 전달한다. 클라이언트는 양쪽 호환 헤더를 보낸다.
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['api-key'] = this.apiKey;
    }

    const startTime = Date.now();

    guard?.();
    let res: Response;
    try {
      res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new AiCallError(
        error instanceof TypeError
          ? 'AI 호출 실패 (네트워크 요청)'
          : error instanceof Error
            ? error.message
            : 'AI 호출 실패 (네트워크 요청)',
        mergeAiCallMeta(previousMeta, { duration_ms: Date.now() - startTime })
      );
    }

    if (!res.ok) {
      let errorCode: string | undefined;
      try {
        const errorJson = (await res.json().catch(() => null)) as any;
        if (
          errorJson &&
          typeof errorJson === 'object' &&
          errorJson.error &&
          typeof errorJson.error === 'object' &&
          (typeof errorJson.error.code === 'string' || typeof errorJson.error.code === 'number')
        ) {
          const candidate = String(errorJson.error.code);
          if (/^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) errorCode = candidate;
        }
      } catch {
        // 본문 파싱 실패 시 무시
      }

      const message = errorCode
        ? `AI 호출 실패 (HTTP ${res.status}, code: ${errorCode})`
        : `AI 호출 실패 (HTTP ${res.status})`;
      throw new AiCallError(
        message,
        mergeAiCallMeta(previousMeta, { duration_ms: Date.now() - startTime })
      );
    }

    // duration_ms 는 응답 본문을 다 읽은(await res.json() 이후) 뒤에 잰다
    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new AiCallError(
        'AI 응답 JSON 파싱 실패',
        mergeAiCallMeta(previousMeta, { duration_ms: Date.now() - startTime })
      );
    }
    const duration_ms = Date.now() - startTime;

    const usage = parseUsage(data.usage);

    const meta = mergeAiCallMeta(previousMeta, { usage, duration_ms });

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      if (retryMalformedResponse) {
        return this.generateSuggestionAttempt(messages, false, meta, guard);
      }
      throw new AiCallError(
        `AI 응답에 본문 내용이 없습니다. (${responseDiagnostics(data, choice?.finish_reason, 0, previousMeta)})`,
        meta
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (error) {
      if (retryMalformedResponse) {
        return this.generateSuggestionAttempt(messages, false, meta, guard);
      }
      const errorPosition =
        error instanceof Error ? error.message.match(/position (\d+)/i)?.[1] : undefined;
      throw new AiCallError(
        `AI 응답 JSON 파싱 실패${errorPosition ? ` at position ${errorPosition}` : ''} ` +
          `(${responseDiagnostics(data, choice?.finish_reason, content.length, previousMeta)})`,
        meta
      );
    }

    // zod 스키마 검증
    let suggestion: AiSuggestion;
    try {
      suggestion = AiSuggestionSchema.parse(parsedJson);
    } catch (e) {
      if (retryMalformedResponse) {
        return this.generateSuggestionAttempt(messages, false, meta, guard);
      }
      throw new AiCallError(
        `AI 응답 스키마 검증 실패 (${responseDiagnostics(data, choice?.finish_reason, content.length, previousMeta)})`,
        meta
      );
    }

    return {
      suggestion,
      meta,
    };
  }

  async generateReportDraft(messages: ChatMessage[], options?: { guard?: () => void }): Promise<AiReportResult> {
    if (!this.baseUrl || this.baseUrl.trim().length === 0) {
      throw new Error('AIEAS_LLM_BASE_URL 환경변수가 설정되지 않았거나 비어 있습니다.');
    }
    // public-safety-allow: checking presence of AIEAS_LLM_API_KEY env var
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new Error('AIEAS_LLM_API_KEY 환경변수가 설정되지 않았거나 비어 있습니다.');
    }
    if (!this.reasoningEffort || this.reasoningEffort.trim().length === 0) {
      throw new Error('AIEAS_REASONING_EFFORT 환경변수가 설정되지 않았거나 비어 있습니다.');
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'report_draft',
          strict: true,
          schema: AI_REPORT_JSON_SCHEMA,
        },
      },
    };

    if (this.reasoningEffort) {
      requestBody.reasoning_effort = this.reasoningEffort;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['api-key'] = this.apiKey;
    }

    const startTime = Date.now();

    options?.guard?.();
    const res = await this.fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      throw new Error(`AI 호출 실패 (HTTP ${res.status})`);
    }

    const duration_ms = Date.now() - startTime;
    const json = (await res.json()) as any;
    const choice = json.choices?.[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') {
      throw new Error('AI 응답에 choices 또는 message.content 가 없습니다.');
    }

    const content = choice.message.content.trim();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (e) {
      throw new Error(`AI 응답 JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
    }

    const report = AiReportResponseSchema.parse(parsedJson);

    return {
      report,
      meta: {
        usage: json.usage,
        duration_ms,
      },
    };
  }
}

let defaultClient: AiClient | null = null;

export function createE2EFakeAiClient(): AiClient {
  const candidates = [
    path.resolve(process.cwd(), 'tests/e2e/fixtures'),
    path.resolve(process.cwd(), 'app/tests/e2e/fixtures'),
    path.resolve(__dirname, '../../../tests/e2e/fixtures'),
    path.resolve(__dirname, '../../tests/e2e/fixtures'),
    path.resolve(__dirname, '../tests/e2e/fixtures'),
  ];
  let fixturesDir = candidates[0];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      fixturesDir = c;
      break;
    }
  }

  const fixtureMap: Record<string, string> = {
    'ind-activity': path.join(fixturesDir, 'activity-supported.json'),
    'ind-shortterm': path.join(fixturesDir, 'shortterm-progress.json'),
    'ind-output': path.join(fixturesDir, 'output-expected.json'),
    'ind-conflict': path.join(fixturesDir, 'impact-conflict.json'),
    'ind-unsupported': path.join(fixturesDir, 'unsupported-trap.json'),
    'ind-midterm': path.join(fixturesDir, 'midterm-unconfirmed.json'),
    'ind-schema-violation': path.join(fixturesDir, 'schema-violation.json'),
  };

  return new (class extends AiClient {
    get provider(): string { return 'solar'; }
  })({
    baseUrl: 'https://example.com/v1',
    // public-safety-allow: deterministic fake AI client dummy key for E2E
    apiKey: 'dummy',
    model: 'aieas-default',
    reasoningEffort: 'xhigh',
    fetchFn: async (_endpoint, options) => {
      const bodyStr = String(options?.body ?? '');

      if (bodyStr.includes('ontology_generation')) {
        const request = JSON.parse(bodyStr);
        const input = JSON.parse(request.messages.find((message: { role: string }) => message.role === 'user').content);
        const paragraph = input.paragraphs?.find((entry: { content: string }) => entry.content.trim());
        const names = [
          ['output', '가상산출물A'], ['output', '가상 다른 산출물 노트 workflow'],
          ['outcome-short', '가상 단기 다음 노트 workflow'], ['outcome-mid', '가상 중기 다음 노트 workflow'],
          ['enabler', '가상 기여 다음 노트 workflow'], ['constraint', '가상 제약 다음 노트 workflow'],
        ];
        const generated = paragraph ? {
          snippets: [{ paragraph_id: paragraph.id, quote: paragraph.content.trim().slice(0, 200), speaker: '수행기관', evidence_kind: '활동결과보고서', evidence_level: '관측', category: '산출물', fact: '', interpretation: '', uncertainty: '', observed_date: '', proves_indices: names.map((_, index) => index), supports_indices: [], contradicts_indices: [] }],
          nodes: names.map(([type, name]) => ({ type, name, description: '', evidence_indices: [0], outcome_family: '', outcome_type: '', outcome_state_ai: '미확인', timing: '', pdm_stage: '', factor_scope: '', factor_class: '', response: '', output_type: '', institution_type: '', date_start: '', date_end: '', place: '', baseline: null, target: null, actual: null, verification_source: '' })),
          edges: [],
        } : { snippets: [], nodes: [], edges: [] };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(generated) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (bodyStr.includes('report_draft')) {
        let sentences: Array<{ indicator_id: string; sentence: string; evidence_ids: string[] }> = [];
        try {
          const reqBody = JSON.parse(bodyStr);
          const userMsg = reqBody.messages?.find((m: any) => m.role === 'user')?.content ?? '';
          const parsedData = JSON.parse(userMsg);
          if (Array.isArray(parsedData.indicators)) {
            for (const ind of parsedData.indicators) {
              if (ind.evidences && ind.evidences.length > 0) {
                // #22 Item 4: 서술 문장은 수정본을 입력으로 씀
                const sentenceText =
                  ind.confirmation_type === '수정 후 확정' && ind.edited_text
                    ? ind.edited_text
                    : ind.confirmed_text && ind.confirmed_text.trim().length > 0
                    ? ind.confirmed_text
                    : ind.evidences[0].quote;
                const allEvIds = ind.evidences.map((e: any) => e.id);
                sentences.push({
                  indicator_id: ind.id,
                  sentence: String(sentenceText),
                  evidence_ids: allEvIds,
                });
              }
            }
          }
        } catch (e) {
          throw new Error(
            `가짜 AI 보고서 생성 요청 파싱 실패: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        // #22 Item 5: 파싱 실패나 문장 부재 시 고정 문장으로 대체하지 말고 오류를 던진다.
        if (sentences.length === 0) {
          throw new Error('가짜 AI 보고서 생성 대상 문장이 없습니다 (문장 부재).');
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ sentences }),
                },
              },
            ],
            usage: {
              prompt_tokens: 150,
              completion_tokens: 70,
              total_tokens: 220,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // 판정 제안 요청 처리: 본문의 지표와 근거 문단으로부터 결정적으로 응답 생성 (RQ-28, D30)
      let parsedIndicator: any = null;
      let parsedParagraphs: Array<{ document_id: string; location: string; content: string }> = [];
      try {
        const reqBody = JSON.parse(bodyStr);
        const userMsg = reqBody.messages?.find((m: any) => m.role === 'user')?.content ?? '';
        const parsed = JSON.parse(userMsg);
        if (parsed && typeof parsed === 'object') {
          parsedIndicator = parsed.indicator;
          parsedParagraphs = Array.isArray(parsed.paragraphs) ? parsed.paragraphs : [];
        }
      } catch {}

      const indicatorId =
        typeof parsedIndicator?.id === 'string'
          ? parsedIndicator.id
          : typeof parsedIndicator === 'string'
          ? parsedIndicator
          : undefined;

      const matchedFixtureId =
        indicatorId && Object.prototype.hasOwnProperty.call(fixtureMap, indicatorId)
          ? indicatorId
          : undefined;

      if (matchedFixtureId) {
        const fixtureFile = fixtureMap[matchedFixtureId];
        const fixtureRaw = fs.readFileSync(fixtureFile, 'utf8');

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: fixtureRaw,
                },
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 60,
              total_tokens: 180,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      if (parsedIndicator) {
        const name = String(parsedIndicator.name ?? '');
        const level = String(parsedIndicator.level ?? '');
        const ovi = String(parsedIndicator.ovi ?? '');
        const targetVal = String(parsedIndicator.target_value ?? '');

        const conflictPlanPara = parsedParagraphs.find((p) => p.content.includes('80%'));
        const conflictPdmPara = parsedParagraphs.find((p) => p.content.includes('3.5점'));
        const bannedPara = parsedParagraphs.find((p) => p.content.includes('이름을 밝히지 말아'));
        const activityPara =
          parsedParagraphs.find((p) => p.content.includes('교육 훈련 실적')) ||
          parsedParagraphs.find((p) => p.content.includes('500명'));
        const shorttermPara =
          parsedParagraphs.find((p) => p.content.includes('포털 운영 현황')) ||
          parsedParagraphs.find((p) => p.content.includes('100만명'));
        const outputPara =
          parsedParagraphs.find((p) => p.content.includes('현지 점검 결과')) ||
          parsedParagraphs.find((p) => p.content.includes('통합 플랫폼'));
        const isConflictIndicator = Boolean(
          name.includes('편의 증진') ||
          name.includes('만족도') ||
          targetVal.includes('3.5점') ||
          level === '영향'
        );

        let verdict: string = '미확인';
        let sentence: string | null = null;
        let evidences: Array<{ quote: string; document_id: string; location: string; speaker: string }> = [];

        if (isConflictIndicator) {
          verdict = '근거 충돌';
          sentence = '사업계획서(80%)와 성과관리표(5점 척도 3.5점)의 목표치가 상충함.';
          if (conflictPlanPara) {
            evidences.push({
              quote: conflictPlanPara.content.includes('80%')
                ? '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.'
                : conflictPlanPara.content,
              document_id: conflictPlanPara.document_id,
              location: conflictPlanPara.location,
              speaker: '수행기관',
            });
          }
          if (conflictPdmPara) {
            evidences.push({
              quote: conflictPdmPara.content.includes('3.5점')
                ? '영향 단계 성과지표로 대국민 전자정부 서비스 체감 만족도 5점 척도 3.5점 달성을 설정함.'
                : conflictPdmPara.content,
              document_id: conflictPdmPara.document_id,
              location: conflictPdmPara.location,
              speaker: '수행기관',
            });
          }
        } else if (name.includes('공무원') || name.includes('직무 교육') || targetVal.includes('500명')) {
          verdict = '실현';
          sentence = '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';
          if (activityPara) {
            evidences.push({
              quote: activityPara.content.includes('교육 훈련 실적')
                ? '교육 훈련 실적: 핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.'
                : activityPara.content,
              document_id: activityPara.document_id,
              location: activityPara.location,
              speaker: '수행기관',
            });
          }
        } else if (name.includes('포털') || name.includes('가입자') || name.includes('이용 확산') || targetVal.includes('100만명')) {
          verdict = '추진 중';
          sentence = '디지털 공공 포털 가입자 100만명 확보 달성이 양호하게 추진 중임.';
          if (shorttermPara) {
            evidences.push({
              quote: shorttermPara.content.includes('포털 운영 현황')
                ? '포털 운영 현황: 단기성과인 디지털 공공 포털 가입자 100만명 확보 달성이 양호하게 추진 중임.'
                : shorttermPara.content,
              document_id: shorttermPara.document_id,
              location: shorttermPara.location,
              speaker: '수행기관',
            });
          }
        } else if (name.includes('플랫폼') || name.includes('기반 구축')) {
          verdict = '기대';
          sentence = '통합 플랫폼 구축에 따른 성과가 기대됩니다.';
          if (outputPara) {
            evidences.push({
              quote: outputPara.content.includes('현지 점검 결과')
                ? '현지 점검 결과: 통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.'
                : outputPara.content,
              document_id: outputPara.document_id,
              location: outputPara.location,
              speaker: '수행기관',
            });
          }
          if (bannedPara) {
            evidences.push({
              quote: bannedPara.content,
              document_id: bannedPara.document_id,
              location: bannedPara.location,
              speaker: '협력국',
            });
          }
        } else {
          verdict = '미확인';
          sentence = '관련 증빙 문서를 확인하지 못함.';
          evidences = [];
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdict_status: verdict,
                    sentence: sentence ?? '',
                    evidences,
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 60,
              total_tokens: 180,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      throw new Error(
        '가짜 AI: 알 수 없는 지표이며 요청 본문에서 유효한 지표 정보를 파싱할 수 없습니다.'
      );
    },
  });
}

export function getAiClient(config?: AiClientConfig): AiClient {
  if (config) {
    return new AiClient(config);
  }
  if (!defaultClient) {
    if (process.env.AIEAS_E2E_FAKE_AI === '1') {
      defaultClient = createE2EFakeAiClient();
    } else {
      defaultClient = new AiClient();
    }
  }
  return defaultClient;
}

export function setAiClient(client: AiClient | null): void {
  defaultClient = client;
}
