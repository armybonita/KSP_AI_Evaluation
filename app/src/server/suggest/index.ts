import crypto from 'node:crypto';
import { selectParagraphsForIndicator } from './paragraph-selection';
export { selectParagraphsForIndicator } from './paragraph-selection';
import {
  AiCallError,
  AiCallMeta,
  AiClient,
  AiSuggestion,
  getAiClient,
  getAiProvider,
  mergeAiCallMeta,
} from '../ai';
import { checkNumericConsistency } from '../numeric-check';
import { verifyEvidencesAndResolveVerdict } from '../quote-verify';
import { getAiDocumentEligibilityForProvider } from '../documents/ai-eligibility';
import { AiEligibilityChangedError, AI_ELIGIBILITY_CHANGED_MESSAGE, createProjectEligibilityGuard } from '../documents/eligibility-fingerprint';
import {
  assertVerdictStatus,
  DbConnection,
  EvidenceRecord,
  getBannedSentencesByProject,
  getIndicatorBaseline,
  listDocuments,
  getParagraphsByProject,
  hasForbiddenSentenceOverlap,
  IndicatorBaselineRecord,
  IndicatorRecord,
  isCitationBannedSentence,
  isSpeaker,
  ParagraphRecord,
  saveSuggestion,
  splitParagraphIntoSentences,
  SuggestionRecord,
  VerdictStatus,
} from '../store';

/**
 * suggest 가 실제로 사용하는 입력 문단 집합 구성 함수 (#18 검수)
 * - 제외된 문서의 문단은 배제하고, 포함된 문서의 문단만 조회하여 반환
 */
export function buildSuggestInput(projectId: string, db?: DbConnection, provider?: string | null): ParagraphRecord[] {
  const currentProvider = provider === undefined ? getAiProvider() : provider;
  const eligibleIds = new Set(listDocuments(projectId, db).filter((doc) => doc.is_included === 1 && getAiDocumentEligibilityForProvider(doc, currentProvider).eligible).map((doc) => doc.id));
  return getParagraphsByProject(projectId, true, db).filter((paragraph) => eligibleIds.has(paragraph.document_id));
}

export interface SuggestRequestBody {
  indicator: {
    id: string;
    level: string;
    name: string;
    ovi: string;
    mov: string | null;
    target_value: string | null;
    baseline?: {
      document_name: string;
      target_value: string;
    };
  };
  paragraphs: Array<{
    document_id: string;
    location: string;
    content: string;
  }>;
}

/**
 * suggest 입력 및 AI 요청 본문 구성 함수 (#19)
 * - 고른 기준 지표(baseline)가 있으면 요청 본문 indicator.baseline 에 포함
 */
export function buildSuggestRequestBody(
  indicator: IndicatorRecord,
  paragraphs: ParagraphRecord[],
  baseline?: IndicatorBaselineRecord | null,
  db?: DbConnection
): SuggestRequestBody {
  const resolvedBaseline =
    baseline !== undefined ? baseline : getIndicatorBaseline(indicator.id, db);
  return {
    indicator: {
      id: indicator.id,
      level: indicator.level,
      name: indicator.name,
      ovi: indicator.ovi,
      mov: indicator.mov,
      target_value: indicator.target_value,
      ...(resolvedBaseline
        ? {
            baseline: {
              document_name: resolvedBaseline.document_name,
              target_value: resolvedBaseline.target_value,
            },
          }
        : {}),
    },
    paragraphs: paragraphs.map((p) => ({
      document_id: p.document_id,
      location: p.location,
      content: p.content,
    })),
  };
}

export interface SuggestOptions {
  aiClient?: AiClient;
  saveToStore?: boolean;
  now?: string;
  baseline?: IndicatorBaselineRecord | null;
  db?: DbConnection;
  semanticRetry?: boolean;
  preservedEvidences?: Array<
    Pick<EvidenceRecord, 'quote' | 'document_id' | 'location' | 'speaker' | 'is_citation_banned'>
    & { identityKey?: string }
  >;
  failureHistory?: SuggestFailure[];
  guard?: () => void;
}

type SuggestFailureCode =
  | 'numeric_check'
  | 'citation_ban'
  | 'empty_proposal'
  | 'ai_json_parse'
  | 'ai_schema_validation'
  | 'ai_empty_response'
  | 'ai_timeout'
  | 'ai_request'
  | 'ai_configuration'
  | 'ai_unknown';

type SuggestFailure = {
  stage: 'initial' | 'semantic_retry';
  code: SuggestFailureCode;
};

type ProcessedEvidence = Pick<
  EvidenceRecord,
  'quote' | 'document_id' | 'location' | 'speaker' | 'is_citation_banned'
> & { identityKey: string };

function evidenceIdentity(
  evidence: Pick<EvidenceRecord, 'quote' | 'document_id' | 'location' | 'speaker'>
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([evidence.document_id, evidence.location, evidence.quote, evidence.speaker]))
    .digest('hex');
}

function uniqueProcessedEvidences(
  evidences: Array<
    Pick<EvidenceRecord, 'quote' | 'document_id' | 'location' | 'speaker' | 'is_citation_banned'>
    & { identityKey?: string }
  >
): ProcessedEvidence[] {
  const seen = new Set<string>();
  return evidences.filter((evidence) => {
    const identityKey = evidence.identityKey ?? evidenceIdentity(evidence);
    if (seen.has(identityKey)) return false;
    seen.add(identityKey);
    return true;
  }) as ProcessedEvidence[];
}

function safeAiFailureCode(error: unknown): SuggestFailureCode {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('AI 응답 JSON 파싱 실패')) return 'ai_json_parse';
  if (message.includes('AI 응답 스키마 검증 실패') || /zoderror|schema validation/i.test(message)) {
    return 'ai_schema_validation';
  }
  if (message.includes('AI 응답에 본문 내용이 없습니다')) return 'ai_empty_response';
  if (/timeout|timed out|타임아웃|시간 초과/i.test(message)) return 'ai_timeout';
  if (message.includes('AI 호출 실패')) return 'ai_request';
  if (/AIEAS_(?:LLM_BASE_URL|LLM_API_KEY|REASONING_EFFORT).*설정/.test(message)) {
    return 'ai_configuration';
  }
  return 'ai_unknown';
}

function proposalFailureCode(reason: 'numeric_check' | 'citation_ban' | null): SuggestFailureCode {
  if (reason === 'numeric_check') return 'numeric_check';
  if (reason === 'citation_ban') return 'citation_ban';
  return 'empty_proposal';
}

function formatFailureReason(failures: SuggestFailure[], attemptedRounds: number): string {
  const categoryLabels: Record<SuggestFailureCode, string> = {
    numeric_check: '제안 문장이 근거 수치 검증을 통과하지 못했습니다',
    citation_ban: '제안 문장이 인용 금지 검증을 통과하지 못했습니다',
    empty_proposal: '제안 문장이 비어 있습니다',
    ai_json_parse: 'AI 응답 JSON 파싱 실패',
    ai_schema_validation: 'AI 응답 스키마 검증 실패',
    ai_empty_response: 'AI 응답에 본문 내용이 없습니다',
    ai_timeout: 'AI 게이트웨이 타임아웃 오류',
    ai_request: 'AI 호출 실패',
    ai_configuration: 'AI 환경 설정 오류',
    ai_unknown: 'AI 요청 처리 오류',
  };
  const stageLabels = { initial: '초기 생성', semantic_retry: '의미 재시도' };
  const safeFailures = failures.map(
    ({ stage, code }) => `${stageLabels[stage]} 단계 실패: ${categoryLabels[code]}`
  );
  const semanticRetries = Math.max(0, attemptedRounds - 1);
  return (
    `${safeFailures.join('; ')} ` +
    `(총 ${attemptedRounds}회 생성 시도, 의미 재시도 ${semanticRetries}회)`
  );
}

export interface SuggestResult {
  saved: boolean;
  sentParagraphCount: number;
  totalParagraphCount: number;
  sentCharacterCount: number;
  suggestion: SuggestionRecord;
  evidences: EvidenceRecord[];
  diagnostics?: string[];
  meta?: AiCallMeta;
}

export async function suggestVerdictForIndicator(
  indicator: IndicatorRecord,
  paragraphs: ParagraphRecord[],
  options?: SuggestOptions
): Promise<SuggestResult> {
  const guard = options?.guard ?? createProjectEligibilityGuard(indicator.project_id, options?.db);
  guard();
  return suggestWithSelection(indicator, paragraphs, { ...options, guard });
}

async function suggestWithSelection(
  indicator: IndicatorRecord,
  paragraphs: ParagraphRecord[],
  options?: SuggestOptions,
  selectedInput?: ReturnType<typeof selectParagraphsForIndicator>,
): Promise<SuggestResult> {
  const now = options?.now ?? new Date().toISOString();
  const shouldSave = options?.saveToStore ?? true;

  const documents = listDocuments(indicator.project_id, options?.db);
  const provider = options?.aiClient ? options.aiClient.provider : getAiProvider();
  const eligibleIds = new Set(documents.filter((doc) => doc.is_included === 1 && getAiDocumentEligibilityForProvider(doc, provider).eligible).map((doc) => doc.id));
  const eligibleParagraphs = paragraphs.filter((paragraph) => eligibleIds.has(paragraph.document_id));
  if (!indicator.source_doc_id || !eligibleIds.has(indicator.source_doc_id)) {
    const source = documents.find((doc) => doc.id === indicator.source_doc_id);
    const reasons = source ? getAiDocumentEligibilityForProvider(source, provider).reasons : [];
    return {
      saved: false,
      sentParagraphCount: 0, totalParagraphCount: paragraphs.length, sentCharacterCount: 0,
      suggestion: { id: crypto.randomUUID(), indicator_id: indicator.id, verdict_status: '미확인', error_reason: ['지표 출처 문서의 AI 입력 자격을 확인할 수 없습니다.', ...reasons].join(' '), proposal_text: null, created_at: now },
      evidences: [],
    };
  }
  const baseline = options?.baseline !== undefined ? options.baseline : getIndicatorBaseline(indicator.id, options?.db);
  const eligibleBaseline = baseline && eligibleIds.has(baseline.document_id) ? baseline : null;

  let selection = selectedInput ?? { ...selectParagraphsForIndicator(indicator, eligibleParagraphs, eligibleBaseline), totalParagraphCount: paragraphs.length };
  let inputStats = { sentParagraphCount: selection.sentParagraphCount, totalParagraphCount: selection.totalParagraphCount, sentCharacterCount: selection.sentCharacterCount };

  // 2. AI 호출 및 스키마 검증
  let client: AiClient;
  let aiOutput: AiSuggestion;
  let callMeta: AiCallMeta | undefined;
  try {
    client = options?.aiClient ?? getAiClient();
    const guard = options?.guard ?? createProjectEligibilityGuard(indicator.project_id, options?.db);
    guard();
    if (!selection.paragraphs.length) throw new Error('생성 요청에 적격 문단이 없습니다.');
    const requestBody = buildSuggestRequestBody(indicator, selection.paragraphs, eligibleBaseline, options?.db);
    const messages = [
      {
        role: 'system' as const,
        content: '당신은 AiEAS 성과평가 지원 AI입니다. 지표와 사업 문서 문단을 바탕으로 성과 판정(실현, 추진 중, 기대, 미확인, 근거 충돌)과 원문 근거를 제안하십시오. 원문에 없는 수치나 사실을 지어내지 마십시오.',
      },
      { role: 'user' as const, content: JSON.stringify(requestBody) },
    ];
    const aiResult = await client.generateSuggestion(messages, { guard });
    guard();
    aiOutput = aiResult.suggestion;
    callMeta = aiResult.meta;
  } catch (err) {
    if (err instanceof AiEligibilityChangedError) {
      return {
        saved: false, ...inputStats,
        suggestion: { id: crypto.randomUUID(), indicator_id: indicator.id, verdict_status: '미확인', error_reason: AI_ELIGIBILITY_CHANGED_MESSAGE, proposal_text: null, created_at: now },
        evidences: [], diagnostics: [AI_ELIGIBILITY_CHANGED_MESSAGE],
      };
    }
    // RQ-27, D30: 스키마 위반 또는 AI 호출 실패 시 저장하지 않고 "미확인" + 오류 사유 반환
    const failureReasons: SuggestFailure[] = [
      ...(options?.failureHistory ?? []),
      {
        stage: options?.semanticRetry ? 'semantic_retry' : 'initial',
        code: safeAiFailureCode(err),
      },
    ];
    const failedSuggestion: SuggestionRecord = {
      id: crypto.randomUUID(),
      indicator_id: indicator.id,
      verdict_status: '미확인',
      error_reason: formatFailureReason(failureReasons, options?.semanticRetry ? 2 : 1),
      proposal_text: null,
      created_at: now,
    };
    const failedEvidenceRecords: EvidenceRecord[] = (options?.preservedEvidences ?? []).map(
      (evidence) => ({
        id: crypto.randomUUID(),
        suggestion_id: failedSuggestion.id,
        quote: evidence.quote,
        document_id: evidence.document_id,
        location: evidence.location,
        speaker: evidence.speaker,
        is_citation_banned: evidence.is_citation_banned,
      })
    );
    return {
      saved: false,
      ...inputStats,
      suggestion: failedSuggestion,
      evidences: failedEvidenceRecords,
      diagnostics: [],
      meta: err instanceof AiCallError ? err.meta : undefined,
    };
  }

  // 3. 근거 네 항목(인용, 문서 id, 위치, 말한 사람) 유효성 검사 (RQ-10)
  // 하나라도 비면 그 근거 무효
  const validFourItemEvidences = aiOutput.evidences.filter((ev) => {
    return (
      typeof ev.quote === 'string' &&
      ev.quote.trim().length > 0 &&
      typeof ev.document_id === 'string' &&
      ev.document_id.trim().length > 0 &&
      typeof ev.location === 'string' &&
      ev.location.trim().length > 0 &&
      typeof ev.speaker === 'string' &&
      ev.speaker.trim().length > 0 &&
      isSpeaker(ev.speaker)
    );
  });

  // 4. 인용 대조 (RQ-11, D11)
  const lookupParagraph = (docId: string, loc: string) => {
    const found = selection.paragraphs.find((p) => p.document_id === docId && p.location === loc);
    return found?.content;
  };

  const quoteVerifyResult = verifyEvidencesAndResolveVerdict(
    validFourItemEvidences,
    aiOutput.verdict_status,
    lookupParagraph
  );

  const passedEvidences = quoteVerifyResult.passedEvidences;
  let finalVerdict: VerdictStatus = quoteVerifyResult.finalVerdictStatus;

  // 5. 수치 검사 (RQ-12, D03)
  // 제안 문장의 숫자+단위가 그 문장의 인용 원문에 그대로 없으면 그 문장을 버린다
  let sentenceToSave: string | null = aiOutput.sentence;
  let proposalFailureReason: 'numeric_check' | 'citation_ban' | null = null;
  if (sentenceToSave && sentenceToSave.trim().length > 0) {
    const passedQuotes = passedEvidences.map((e) => e.quote);
    const numericCheck = checkNumericConsistency(sentenceToSave, passedQuotes);
    if (!numericCheck.passed) {
      // 수치가 원문 인용에 없으므로 문장을 버린다
      sentenceToSave = null;
      proposalFailureReason = 'numeric_check';
      // 검증된 문장이 없으므로 판정도 미확인으로 내린다
      finalVerdict = '미확인';
    }
  }

  // 5-1. 인용 금지 문장 검사 및 제거 (RQ-14, D01)
  // 저장할 제안 문장·근거 인용에 금지 문장과 8자 이상 겹치는 부분이 있으면 그 문장/근거를 버리고
  // "인용 금지 문장 있음" + 위치 표시용 기록만 남긴다.
  let bannedSentences: string[] = [];
  try {
    const bannedRecords = getBannedSentencesByProject(indicator.project_id, options?.db);
    bannedSentences = bannedRecords.map((r) => r.content);
  } catch {}

  if (bannedSentences.length === 0) {
    for (const p of eligibleParagraphs) {
      const sentences = splitParagraphIntoSentences(p.content, p.location);
      for (const s of sentences) {
        if (s.is_citation_banned === 1) {
          bannedSentences.push(s.content);
        }
      }
    }
  }

  // 제안 문장에 인용 금지 문장과 8자 이상 겹치는 부분이 있거나 금지 문장 취지이면 문장을 버린다
  if (
    sentenceToSave &&
    (isCitationBannedSentence(sentenceToSave) ||
      hasForbiddenSentenceOverlap(sentenceToSave, bannedSentences, 8))
  ) {
    sentenceToSave = null;
    proposalFailureReason = 'citation_ban';
  }

  // 인용 금지 근거는 문장을 다시 생성해도 위치 안내를 잃지 않도록 안전하게 마스킹한다.
  const processedEvidences: ProcessedEvidence[] = passedEvidences.map((ev) => {
    const identityKey = evidenceIdentity(ev);
    const isBanned =
      isCitationBannedSentence(ev.quote) ||
      isCitationBannedSentence(ev.speaker) ||
      hasForbiddenSentenceOverlap(ev.quote, bannedSentences, 8) ||
      hasForbiddenSentenceOverlap(ev.speaker, bannedSentences, 8);
    if (isBanned) {
      return {
        ...ev,
        quote: '인용 금지 문장 있음',
        speaker: '—',
        is_citation_banned: 1,
        identityKey,
      };
    }
    return {
      ...ev,
      is_citation_banned: 0,
      identityKey,
    };
  });
  const allProcessedEvidences = uniqueProcessedEvidences([
    ...(options?.preservedEvidences ?? []),
    ...processedEvidences,
  ]);

  if (!sentenceToSave) {
    if (!options?.semanticRetry) {
      const firstRoundFailure: SuggestFailure[] = [
        ...(options?.failureHistory ?? []),
        { stage: 'initial', code: proposalFailureCode(proposalFailureReason) },
      ];
      const retryClient: AiClient = {
        provider: client.provider,
        generateSuggestion: (retryMessages) =>
          client.generateSuggestion([
            ...retryMessages,
            {
              role: 'user',
              content:
                '앞선 제안 문장이 근거 검증을 통과하지 못했습니다. 이번에는 제안 문장에 숫자, 날짜, 퍼센트, 수량, 단위를 하나도 쓰지 말고 제공된 근거에 직접 뒷받침되는 정성적 문장만 작성하십시오. 원문의 문장을 그대로 옮기지 말고 인용 금지 문구를 피하십시오.',
            },
          ], { guard: options?.guard }),
      } as AiClient;
      const retryResult = await suggestWithSelection(indicator, eligibleParagraphs, {
        ...options,
        aiClient: retryClient,
        semanticRetry: true,
        preservedEvidences: allProcessedEvidences,
        failureHistory: firstRoundFailure,
      }, selection);
      const combinedMeta = mergeAiCallMeta(callMeta, retryResult.meta);
      if (!retryResult.saved && retryResult.suggestion.error_reason && retryResult.suggestion.error_reason !== AI_ELIGIBILITY_CHANGED_MESSAGE) {
        retryResult.suggestion.error_reason +=
          ` (generation_rounds=2, semantic_retries=1, operation_duration_ms=${combinedMeta.duration_ms}, ` +
          `operation_completion_tokens=${combinedMeta.usage?.completion_tokens ?? 'unknown'}, ` +
          `operation_reasoning_tokens=${combinedMeta.usage?.reasoning_tokens ?? 'unknown'})`;
      }
      return {
        ...retryResult,
        meta: combinedMeta,
      };
    }

    const failedSuggestion: SuggestionRecord = {
      id: crypto.randomUUID(),
      indicator_id: indicator.id,
      verdict_status: '미확인',
      error_reason: formatFailureReason(
        [
          ...(options?.failureHistory ?? []),
          {
            stage: 'semantic_retry',
            code: proposalFailureCode(proposalFailureReason),
          },
        ],
        2
      ),
      proposal_text: null,
      created_at: now,
    };
    const failedEvidenceRecords: EvidenceRecord[] = allProcessedEvidences.map((ev) => ({
      id: crypto.randomUUID(),
      suggestion_id: failedSuggestion.id,
      quote: ev.quote,
      document_id: ev.document_id,
      location: ev.location,
      speaker: ev.speaker,
      is_citation_banned: ev.is_citation_banned,
    }));
    return {
      saved: false,
      ...inputStats,
      suggestion: failedSuggestion,
      evidences: failedEvidenceRecords,
      diagnostics: [],
      meta: callMeta,
    };
  }

  assertVerdictStatus(finalVerdict);

  const suggestionRecord: SuggestionRecord = {
    id: crypto.randomUUID(),
    indicator_id: indicator.id,
    verdict_status: finalVerdict,
    error_reason: null,
    proposal_text: sentenceToSave,
    created_at: now,
  };

  const successfulEvidence = uniqueProcessedEvidences([
    ...processedEvidences,
  ]);
  const evidenceRecords: EvidenceRecord[] = successfulEvidence.map((ev) => ({
    id: crypto.randomUUID(),
    suggestion_id: suggestionRecord.id,
    quote: ev.quote,
    document_id: ev.document_id,
    location: ev.location,
    speaker: ev.speaker,
    is_citation_banned: ev.is_citation_banned,
  }));

  // 6. 정상 통과한 경우에만 저장 (RQ-27, RQ-09)
  try { options?.guard?.(); } catch (error) {
    if (!(error instanceof AiEligibilityChangedError)) throw error;
    return {
      saved: false, ...inputStats,
      suggestion: { id: crypto.randomUUID(), indicator_id: indicator.id, verdict_status: '미확인', error_reason: AI_ELIGIBILITY_CHANGED_MESSAGE, proposal_text: null, created_at: now },
      evidences: [], diagnostics: [AI_ELIGIBILITY_CHANGED_MESSAGE],
    };
  }
  if (shouldSave) {
    saveSuggestion(suggestionRecord, evidenceRecords, options?.db);
  }

  return {
    saved: shouldSave,
    ...inputStats,
    suggestion: suggestionRecord,
    evidences: evidenceRecords,
    diagnostics: [],
    meta: callMeta,
  };
}
