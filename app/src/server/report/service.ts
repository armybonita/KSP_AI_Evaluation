import { isCitableEvidence } from '../store/citable-evidence';
import { isReportTargetDocumentIncluded } from '../store/report-inclusion';
import { maskTextIfForbiddenSentenceOverlap } from '../store/citation-ban';
import crypto from 'node:crypto';
import { reportInputFingerprint } from './fingerprint';
import { AiEligibilityChangedError, createProjectEligibilityGuard } from '../documents/eligibility-fingerprint';
import { populateReportSummary } from './summary';
import { reportDocumentState, reportDraftCount, reportEvidenceDetails, reportEvidenceFacts, reportLatestIndicatorConfirmations, reportLatestNodeData, reportLatestNodeReviewStatuses, reportParagraphFacts, reportSnippetFacts } from '../store/report-input';
import { defaultReportTemplate, prepareTemplate } from './templates';
import type { ReportTemplate } from './types';
import {
  createForbiddenSentenceIndex,
  getAttributionsForProject,
  getBannedSentencesByProject,
  getDatabase,
  resolveProjectCitationContext,
  type ProjectCitationContext,
  listDocuments,
  getLatestReportDraft,
  getReportDraftById,
  listReportDraftRecords,
  getProject,
  getReportTargets,
  hasForbiddenSentenceOverlap,
  IndicatorAttributionRecord,
  isCitationBannedSentence,
  isEvidenceCitationBanned,
  ReportTargetIndicator,
  ReviewEvidence,
  saveReportDraft,
} from '../store';
import { getAiDocumentEligibilityForProvider } from '../documents/ai-eligibility';
import { isConfirmedNonPastReport } from '../documents/holdout';
import { AiClient, getAiClient, getAiProvider } from '../ai';
import { checkNumericConsistency } from '../numeric-check';
import { verifyQuote } from '../quote-verify';
import {
  ReportAchievementItem,
  ReportDraftData,
  ReportFootnote,
  ReportSection,
  ReportSentenceItem,
} from './types';

export interface CreateReportDraftOptions {
  template?: Exclude<ReportTemplate, 'legacy7'>;
  aiClient?: AiClient;
  db?: Parameters<typeof getProject>[1];
}

export function filterReportTargetsForAi(
  targets: ReportTargetIndicator[],
  documents: ReturnType<typeof listDocuments>,
  provider: string | null
): { eligibleTargets: ReportTargetIndicator[]; exclusions: Array<{ subject: string; reasons: string[] }> } {
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const exclusions = new Map<string, { subject: string; reasons: string[] }>();
  const exclude = (subject: string, reasons: string[]) => exclusions.set(JSON.stringify([subject, reasons]), { subject, reasons });
  const eligibleTargets = targets.filter((target) => {
    if (target.evidences.length === 0) {
      exclude(target.indicator.name, ['검증 통과 근거 없음']);
    }
    const sourceId = target.indicator.source_doc_id;
    if (!sourceId) {
      exclude(target.indicator.name, ['지표 원문 출처 문서 확인 불가']);
      return false;
    }
    const source = documentById.get(sourceId);
    if (!source) {
      exclude(sourceId, ['원문 출처 문서를 확인할 수 없음']);
      return false;
    }
    if (source.is_included !== 1) {
      exclude(source.file_name, ['평가자가 제외한 문서']);
      return false;
    }
    const sourceEligibility = getAiDocumentEligibilityForProvider(source, provider);
    if (!sourceEligibility.eligible) {
      exclude(source.file_name, sourceEligibility.reasons);
      return false;
    }
    if (target.evidences.length === 0) return false;
    for (const evidence of target.evidences) {
      const document = documentById.get(evidence.document_id);
      if (!document) {
        exclude(evidence.document_id, ['근거 출처 문서를 확인할 수 없음']);
        return false;
      }
      if (document.is_included !== 1) {
        exclude(document.file_name, ['평가자가 제외한 문서']);
        return false;
      }
      const eligibility = getAiDocumentEligibilityForProvider(document, provider);
      if (!eligibility.eligible) {
        exclude(document.file_name, eligibility.reasons);
        return false;
      }
    }
    return true;
  });
  return {
    eligibleTargets,
    exclusions: [...exclusions.values()],
  };
}

export function filterReportTargetsByDocumentInclusion(
  targets: ReportTargetIndicator[],
  documents: ReturnType<typeof listDocuments>
): ReportTargetIndicator[] {
  const documentById = new Map(documents.map((document) => [document.id, document]));
  return targets.filter((target) => isReportTargetDocumentIncluded(
    target.indicator.source_doc_id,
    target.evidences.map((evidence) => evidence.document_id),
    documentById,
  ));
}

export function getReportInclusionExclusions(
  targets: ReportTargetIndicator[],
  documents: ReturnType<typeof listDocuments>
): Array<{ subject: string; reasons: string[] }> {
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const excluded = new Map<string, string>();
  for (const target of targets) {
    const ids = new Set<string>();
    if (target.indicator.source_doc_id) ids.add(target.indicator.source_doc_id);
    for (const evidence of target.evidences) ids.add(evidence.document_id);
    for (const id of ids) {
      const document = documentById.get(id);
      if (document && document.is_included !== 1) excluded.set(document.file_name, document.file_name);
    }
  }
  return [...excluded.keys()].map((subject) => ({ subject, reasons: ['평가자가 제외한 문서'] }));
}
export const REPORT_FINGERPRINT_VERSION = 4;


/**
 * 보고서 내용에 영향을 주는 모든 입력을 포함하는 결정적 SHA-256 지문을 계산한다 (#22 검수 반영 1차 및 마지막 검수, Item 1)
 * 입력: 대상 지표 id, 최신 확정 id, 대상 지표들의 기여 귀속 내용(해시), 근거 id와 원문 문단 내용 해시
 */
export function computeReportFingerprint(
  targets: ReportTargetIndicator[],
  attributions: IndicatorAttributionRecord[] = [],
  documents: ReturnType<typeof listDocuments> = []
): string {
  const attrMap = new Map<string, string>();
  for (const a of attributions) {
    attrMap.set(a.indicator_id, a.attribution_text ?? '');
  }

  // 두 정렬은 해시 입력용이므로 순서가 결정적이면 된다.
  const sortedTargets = [...targets].sort((a, b) =>
    a.indicator.id.localeCompare(b.indicator.id)
  );
  const documentMap = new Map(documents.map((document) => [document.id, document]));

  const items = sortedTargets.map((t) => {
    const attrText = attrMap.get(t.indicator.id) ?? '';
    const attrHash = crypto.createHash('sha256').update(attrText).digest('hex');
    const sourceDocumentIds = new Set<string>();
    if (t.indicator.source_doc_id) sourceDocumentIds.add(t.indicator.source_doc_id);
    for (const evidence of t.evidences ?? []) sourceDocumentIds.add(evidence.document_id);
    const sourceState = [...sourceDocumentIds].sort().map((id) => {
      const source = documentMap.get(id);
      if (!source) return `${id}:missing`;
      const pastReportState = source.is_past_final_report == null ? 'unknown' : String(source.is_past_final_report);
      return `${id}:${source.is_included === 1}:${source.masked === true}:${source.approved_ai ?? ''}:${pastReportState}`;
    }).join(',');
    const evidenceHashes = (t.evidences ?? []).map((e) => {
      const paragraphContent = e.paragraph_context?.target?.content ?? '';
      const paragraphHash = crypto.createHash('sha256').update(paragraphContent).digest('hex');
      const paragraphId = e.paragraph_context?.target?.id ?? '';
      return `${e.id}:${paragraphId}:${paragraphHash}`;
    }).sort().join(',');
    return `${t.indicator.id}:${t.latestConfirmation.id}:${attrHash}:${evidenceHashes}:${sourceState}`;
  });

  // 제외 목록은 지표와 연결되지 않은 문서도 포함하므로 모든 문서의 자격을 지문에 반영한다.
  const documentStates = [...documents].sort((a, b) => a.id.localeCompare(b.id)).map((doc) => [
    doc.id, doc.file_name, doc.is_included, doc.masked ?? null, doc.approved_ai ?? null, doc.is_past_final_report ?? null,
  ]);
  return crypto.createHash('sha256').update(`report-fingerprint-v${REPORT_FINGERPRINT_VERSION}|${items.join('|')}|${JSON.stringify(documentStates)}`).digest('hex');
}

/**
 * 대상 판단 목록과 기여 귀속 목록으로부터 결정적 SHA-256 지문을 계산한다
 */
export function computeFingerprintFromTargets(
  targets: ReportTargetIndicator[],
  attributions: IndicatorAttributionRecord[] = []
): string {
  return computeReportFingerprint(targets, attributions);
}

/**
 * 특정 사업의 현재 대상 판단 지문을 계산한다 (#22 검수 반영 1차 및 마지막 검수, Item 1)
 */
export function computeJudgmentFingerprint(
  projectId: string,
  db?: Parameters<typeof getProject>[1],
  targets?: ReportTargetIndicator[]
): string {
  // Summary-format drafts use the canonical input fingerprint written by
  // createReportDraft. Keep the target-based fingerprint for legacy drafts.
  if (!targets) return reportInputFingerprint(projectId, db);
  return computeReportFingerprint(targets, getAttributionsForProject(projectId, db), listDocuments(projectId, db));
}

/**
 * 저장된 초안의 지문이 현재 사업의 최신 대상 판단 지문과 일치하는지 검증한다 (#22 검수 반영 1차, Item 1)
 */
export function isDraftValid(
  draft: ReportDraftData | null,
  projectId: string,
  db?: Parameters<typeof getProject>[1],
  targets?: ReportTargetIndicator[]
): boolean {
  if (!draft) return false;
  const currentFingerprint = draft.summary_format === 1
    ? reportInputFingerprint(projectId, db)
    : targets
      ? computeReportFingerprint(targets, getAttributionsForProject(projectId, db), listDocuments(projectId, db))
      : computeJudgmentFingerprint(projectId, db);
  const draftFingerprint = draft.fingerprint ?? draft.judgment_fingerprint;
  return Boolean(draft.fingerprint_version === REPORT_FINGERPRINT_VERSION && draftFingerprint && draftFingerprint === currentFingerprint);
}

/**
 * 종료평가보고서 초안 생성 서비스 (RQ-20, RQ-21, D04, D08, D33, D35, FE-11)
 */
export async function createReportDraft(
  projectId: string,
  options?: CreateReportDraftOptions
): Promise<ReportDraftData> {
  const db = options?.db;
  const project = getProject(projectId, db);
  if (!project) {
    throw new Error(`사업 식별자 '${projectId}'를 찾을 수 없습니다.`);
  }
  const eligibilityGuard = createProjectEligibilityGuard(projectId, db);

  // Bind the report to the input set before any reads or AI work begin.
  const fingerprint = reportInputFingerprint(projectId, db);

  // 1. 보고서 대상 선별: 최신 확정이 '확정' 또는 '수정 후 확정'인 지표만 (RQ-20, D04)
  const sourceTargets: ReportTargetIndicator[] = getReportTargets(projectId, db);
  const documents = listDocuments(projectId, db);
  const inclusionExclusions = getReportInclusionExclusions(sourceTargets, documents);
  const targets = filterReportTargetsByDocumentInclusion(sourceTargets, documents);
  const reportAiFilter = filterReportTargetsForAi(sourceTargets, documents, options?.aiClient ? options.aiClient.provider : getAiProvider());
  const projectAttributions = getAttributionsForProject(projectId, db);
  const draftNumber = reportDraftCount(projectId, db) + 1;
  const bannedSentences = getBannedSentencesByProject(projectId, db).map(
    (s) => s.content
  );
  const bannedIndex = createForbiddenSentenceIndex(bannedSentences);
  const safeText = (value: string) => maskTextIfForbiddenSentenceOverlap(value, bannedSentences, 8);
  const citableEvidences = (target: ReportTargetIndicator) => target.evidences.filter(
    (evidence) => isCitableEvidence(evidence, evidence.paragraph_context?.target?.content, bannedSentences, bannedIndex)
  );
  const eligibleReportTargets = reportAiFilter.eligibleTargets
    .map((target) => ({ ...target, evidences: citableEvidences(target) }))
    .filter((target) => target.evidences.length > 0);
  const noVerifiedEvidenceExclusions = sourceTargets
    .filter((target) => citableEvidences(target).length === 0)
    .map((target) => ({ subject: target.indicator.name, reasons: ['검증 통과 근거 없음'] }));
  const aiExclusions = [...new Map([...inclusionExclusions, ...reportAiFilter.exclusions, ...noVerifiedEvidenceExclusions]
    .map((item) => [JSON.stringify([item.subject, item.reasons]), item])).values()];
  const evidenceMatchWarning = (evidences: ReviewEvidence[]) => {
    const eligibleForQuoteCheck = evidences.filter((evidence) => !isEvidenceCitationBanned(evidence, bannedSentences, bannedIndex));
    const unavailable = eligibleForQuoteCheck.some((evidence) => evidence.paragraph_context?.target?.content == null);
    const mismatched = eligibleForQuoteCheck.some((evidence) => evidence.paragraph_context?.target?.content != null && !verifyQuote(evidence.quote, evidence.paragraph_context.target.content));
    return [
      ...(unavailable ? ['원문 문단 미확인으로 근거를 인용에서 제외했습니다.'] : []),
      ...(mismatched ? ['원문 대조 실패: 인용문이 원문 문단과 일치하지 않아 근거를 인용에서 제외했습니다.'] : []),
    ].join(' ');
  };

  // 대상이 0건이면 빈 상태 안내 초안 반환 (UC-17)
  if (targets.length === 0) {
    const emptyDraft: ReportDraftData = {
      project_id: projectId,
      project_name: project.name,
      confirmed_count: 0,
      ai_exclusions: aiExclusions,
      created_at: new Date().toISOString(),
      fingerprint,
      judgment_fingerprint: fingerprint,
      fingerprint_version: REPORT_FINGERPRINT_VERSION,
      draft_number: draftNumber,
      sections: {
        achievement_table: {
          title: '성과지표 달성표',
          rows: [],
          empty_message: '확정한 판단이 없습니다',
        },
        performance_analysis: {
          title: '성과 분석',
          sentences: [],
          empty_message: '확정한 판단이 없습니다',
        },
        contributing_factors: {
          title: '기여요인',
          empty_message: '확정한 판단이 없습니다',
        },
        constraints_and_responses: {
          title: '제약요인과 대응',
          empty_message: '확정한 판단이 없습니다',
        },
        lessons_learned: {
          title: '교훈',
          empty_message: '확정한 판단이 없습니다',
        },
        monitoring_plan: {
          title: '모니터링 계획',
          empty_message: '확정한 판단이 없습니다',
        },
        overall_evaluation: {
          title: '종합평가',
          empty_message: '확정한 판단이 없습니다',
        },
      },
    };
    prepareTemplate(emptyDraft, options?.template ?? defaultReportTemplate(project.project_type || project.name), bannedSentences);
    await populateReportSummary(emptyDraft, projectId, options?.aiClient, bannedSentences, db, false, eligibilityGuard);
    eligibilityGuard();
    if (reportInputFingerprint(projectId, db) !== fingerprint) throw new Error('보고서 생성 중 입력 자료가 바뀌었습니다. 최신 자료로 다시 생성해 주세요.');
    emptyDraft.fingerprint = fingerprint;
    emptyDraft.judgment_fingerprint = fingerprint;
    saveReportDraft(projectId, JSON.stringify(emptyDraft), db);
    return emptyDraft;
  }

  // 2. 1절: 성과지표 달성표 규칙 조립 (D35, #22 Item 4)
  // D33: 판정이 "미확인"인 지표를 확정한 경우 달성표에 '근거 미확인'으로만 표기
  // #22: 수정 후 확정 지표는 수정본을 달성표에 표시
  const achievementRows: ReportAchievementItem[] = targets.map((t) => {
    const status_display = t.isUnverifiedVerdict ? '근거 미확인' : t.verdictStatus;
    const firstEv = citableEvidences(t)[0];
    const isEdited = t.latestConfirmation.confirmation_type === '수정 후 확정';
    const edited_text = isEdited && t.latestConfirmation.edited_text ? safeText(t.latestConfirmation.edited_text) : undefined;
    return {
      indicator_id: t.indicator.id,
      indicator_name: safeText(t.indicator.name),
      target_value: safeText(t.indicator.target_value ?? t.indicator.ovi),
      status_display,
      confirmation_type: t.latestConfirmation.confirmation_type,
      edited_text,
      is_orphaned: Boolean(t.indicator.is_orphaned),
      evidence_id: firstEv?.id,
      evidence_document_name: firstEv?.document_name,
      evidence_location: firstEv?.location,
      evidence_match_warning: evidenceMatchWarning(t.evidences) || undefined,
    };
  });

  // 3. 2절: 성과 분석 서술 문장 (D35, D33, RQ-21, RQ-12, RQ-14, #22 검수 2회차)
  // D33: '미확인'을 확정한 판단은 서술 절에 문장을 생성하지 않음 (서술 없음).
  const narrativeTargets = targets.filter(
    (t) => !t.isUnverifiedVerdict && t.evidences.length > 0
  );

  // #22 검수 2회차:
  // - AI는 '확정' 판단에만 쓴다.
  // - '수정 후 확정' 판단의 서술 문장은 AI 가 쓰지 않고 평가자 수정본을 그대로 쓴다.
  const confirmedNarrativeTargets = eligibleReportTargets.filter(
    (t) => t.latestConfirmation.confirmation_type === '확정' && !t.isUnverifiedVerdict && !isCitationBannedSentence(t.confirmedText) && !hasForbiddenSentenceOverlap(t.confirmedText, bannedSentences, 8)
  );

  const aiSentencesByIndicator = new Map<string, ReportSentenceItem[]>();
  let indicatorGenerationFailed = false;

  if (confirmedNarrativeTargets.length > 0) {
    const evidenceMap = new Map<string, ReviewEvidence>();
    const indicatorEvMap = new Map<string, Set<string>>();
    for (const t of confirmedNarrativeTargets) {
      const evSet = new Set(citableEvidences(t).map((e) => e.id));
      for (const ev of t.evidences) {
        evidenceMap.set(ev.id, ev);
      }
      indicatorEvMap.set(t.indicator.id, evSet);
    }
    const confirmedTargetMap = new Map(
      confirmedNarrativeTargets.map((t) => [t.indicator.id, t])
    );

    const promptPayload = {
      project_name: safeText(project.name),
      indicators: confirmedNarrativeTargets.map((t) => ({
        id: t.indicator.id,
        name: safeText(t.indicator.name),
        target_value: safeText(t.indicator.target_value ?? t.indicator.ovi),
        confirmed_text: t.confirmedText,
        confirmation_type: t.latestConfirmation.confirmation_type,
        verdict: t.verdictStatus,
        evidences: t.evidences.map((e) => ({
          id: e.id,
          quote: e.quote,
          location: e.location,
          document_name: e.document_name,
          speaker: e.speaker,
        })),
      })),
    };

    try {
    eligibilityGuard();
    const aiRes = await (options?.aiClient ?? getAiClient()).generateReportDraft([
      {
        role: 'system',
        content:
          '당신은 AiEAS 종료평가보고서 작성 지원 AI입니다. 확정된 판단과 근거만을 바탕으로 성과 분석 서술 문장을 작성하십시오. 문장마다 반드시 뒷받침하는 근거 ID(evidence_ids)를 명시해야 하며, 수치와 단위는 근거 원문과 정확히 일치해야 합니다.',
      },
      {
        role: 'user',
        content: JSON.stringify(promptPayload),
      },
    ], { guard: eligibilityGuard });

    for (const sent of aiRes.report.sentences) {
      const target = confirmedTargetMap.get(sent.indicator_id);
      if (!target) continue;

      // 검증 1: 근거 링크 유효성 검사 (RQ-21, D35: 근거 링크 없는 문장은 버림)
      const allowedEvSet = indicatorEvMap.get(sent.indicator_id);
      const validEvIds = (sent.evidence_ids || []).filter(
        (id) => allowedEvSet && allowedEvSet.has(id) && evidenceMap.has(id)
      );
      if (validEvIds.length === 0 || validEvIds.length !== sent.evidence_ids.length) {
        continue; // 근거 링크 없음 -> 버림
      }

      const linkedEvidences = validEvIds.map((id) => evidenceMap.get(id)!);

      // 검증 2: 수치 검사 (RQ-12, D03: 생성 문장의 수치가 근거에 없으면 버림)
      const allowedSources = linkedEvidences.map((e) => e.quote);
      const numCheck = checkNumericConsistency(sent.sentence, allowedSources);
      if (!numCheck.passed) {
        continue; // 수치 불일치 -> 버림
      }

      // 검증 3: 인용 금지 공용 검사 (main 의 공용 함수, 사업별, RQ-14, D01, FE-11)
      if (
        isCitationBannedSentence(sent.sentence) ||
        hasForbiddenSentenceOverlap(sent.sentence, bannedSentences, 8)
      ) {
        continue; // 인용 금지 글자 검출 -> 버림
      }

      // #22 Item 3: 문장마다 검증 통과한 근거 id 를 모두 보관·표시(첫 번째만이 아님)
      const primaryEv = linkedEvidences[0];
      const sentenceItem: ReportSentenceItem = {
        source: 'ai',
        indicator_id: sent.indicator_id,
        indicator_name: safeText(target.indicator.name),
        sentence: sent.sentence,
        evidence_id: primaryEv.id,
        evidence_ids: validEvIds,
        evidences: linkedEvidences.map((e) => ({
          id: e.id,
          quote: e.quote,
          location: e.location,
          speaker: e.speaker,
          document_name: e.document_name,
          is_citation_banned: e.is_citation_banned,
          document_id: e.document_id,
          review_status: target.latestConfirmation.confirmation_type,
          confirmer_role: target.latestConfirmation.confirmer_name,
          confirmed_at: target.latestConfirmation.created_at,
        })),
        evidence_match_warning: evidenceMatchWarning(target.evidences.filter((e) => (sent.evidence_ids ?? []).includes(e.id))) || undefined,
        evidence_quote: primaryEv?.quote,
        evidence_location: primaryEv?.location,
        evidence_speaker: primaryEv?.speaker,
        document_name: primaryEv?.document_name,
      };

      const existing = aiSentencesByIndicator.get(sent.indicator_id) ?? [];
      existing.push(sentenceItem);
      aiSentencesByIndicator.set(sent.indicator_id, existing);
    }
    } catch (error) {
      if (error instanceof AiEligibilityChangedError) throw error;
      // The other report sections remain available if this request fails.
      indicatorGenerationFailed = true;
    }
  }

  // 대상 지표 순서대로 최종 서술 문장 조립 (#22 검수 2회차, 3회차):
  // - '수정 후 확정': 수정본을 문장으로 나누지 않고 수정본 전체를 한 서술 항목으로 넣고 검증 통과 근거 id들을 링크한다 (#22 검수 3회차)
  // - '확정': 3중 검증을 통과한 AI 서술 문장 반영
  const validSentences: ReportSentenceItem[] = [];

  for (const t of narrativeTargets) {
    if (t.latestConfirmation.confirmation_type === '수정 후 확정') {
      const rawText = t.latestConfirmation.edited_text ?? t.confirmedText;
      if (
        isCitationBannedSentence(rawText) ||
        hasForbiddenSentenceOverlap(rawText, bannedSentences, 8)
      ) {
        continue;
      }
      const citedEvidences = citableEvidences(t);
      const primaryEv = citedEvidences[0];
      const validEvIds = citedEvidences.map((e) => e.id);
      const linkedEvidences = citedEvidences.map((e) => ({
        id: e.id,
        quote: e.quote,
        location: e.location,
        speaker: e.speaker,
        document_name: e.document_name,
        is_citation_banned: e.is_citation_banned,
        document_id: e.document_id,
        review_status: t.latestConfirmation.confirmation_type,
        confirmer_role: t.latestConfirmation.confirmer_name,
        confirmed_at: t.latestConfirmation.created_at,
      }));

      validSentences.push({
        source: 'human',
        indicator_id: t.indicator.id,
        indicator_name: safeText(t.indicator.name),
        sentence: rawText,
        evidence_id: primaryEv?.id ?? '',
        evidence_ids: validEvIds,
        evidences: linkedEvidences,
        evidence_quote: primaryEv?.quote,
        evidence_location: primaryEv?.location,
        evidence_speaker: primaryEv?.speaker,
        document_name: primaryEv?.document_name,
        evidence_match_warning: evidenceMatchWarning(t.evidences) || undefined,
      });
    } else {
      const aiSents = aiSentencesByIndicator.get(t.indicator.id) ?? [];
      validSentences.push(...aiSents);
    }
  }

  // 4. 3절: 기여요인 (평가자 기여 귀속 입력 연동, RQ-16, RQ-21, D08, #22)
  // - 보고서 대상 판단('확정'·'수정 후 확정')의 지표의 기여 귀속만 넣는다
  // - RQ-21: 검증 통과 근거가 없는 지표의 기여 귀속은 기여요인 절에 넣지 않는다 (#22 마지막 검수 Item 2)
  // - 인용 금지 공용 검사(main 의 함수)를 기여 귀속 문장에도 적용해 겹치면 넣지 않는다
  // - 기여 귀속 문장은 평가자 입력이므로 근거 링크는 그 지표의 검증 통과 근거 id 들로 단다
  const targetMap = new Map(targets.map((t) => [t.indicator.id, t]));
  const contributingSentences: ReportSentenceItem[] = [];
  let excludedNoEvidenceCount = 0;

  for (const attr of projectAttributions) {
    const target = targetMap.get(attr.indicator_id);
    if (!target) {
      continue;
    }

    const text = attr.attribution_text ? attr.attribution_text.trim() : '';
    if (!text) continue;

    // RQ-21: 검증 통과 근거가 없는 지표의 기여 귀속은 기여요인 절에 넣지 않는다 (#22 마지막 검수 Item 2)
    const citedEvidences = citableEvidences(target);
    if (citedEvidences.length === 0) {
      excludedNoEvidenceCount++;
      continue;
    }

    if (
      isCitationBannedSentence(text) ||
      hasForbiddenSentenceOverlap(text, bannedSentences, 8)
    ) {
      continue;
    }

    const validEvIds = citedEvidences.map((e) => e.id);
    const primaryEv = citedEvidences[0];
    const linkedEvidences = citedEvidences.map((e) => ({
      id: e.id,
      quote: e.quote,
      location: e.location,
      speaker: e.speaker,
      document_name: e.document_name,
      is_citation_banned: e.is_citation_banned,
      document_id: e.document_id,
      review_status: target.latestConfirmation.confirmation_type,
      confirmer_role: target.latestConfirmation.confirmer_name,
      confirmed_at: target.latestConfirmation.created_at,
    }));

    contributingSentences.push({
      source: 'human',
      indicator_id: target.indicator.id,
      indicator_name: safeText(target.indicator.name),
      sentence: text,
      evidence_id: primaryEv.id,
      evidence_ids: validEvIds,
      evidences: linkedEvidences,
      evidence_quote: primaryEv.quote,
      evidence_location: primaryEv.location,
      evidence_speaker: primaryEv.speaker,
      document_name: primaryEv.document_name,
      evidence_match_warning: evidenceMatchWarning(target.evidences) || undefined,
    });
  }

  const excludedNotice =
    excludedNoEvidenceCount > 0
      ? `근거가 없어 기여요인 절에서 뺀 기여 귀속 ${excludedNoEvidenceCount}건`
      : undefined;

  let contributingContent: string | undefined;
  if (contributingSentences.length > 0) {
    contributingContent = contributingSentences
      .map((s) => s.sentence)
      .join('\n\n');
  }

  const draft: ReportDraftData = {
    project_id: projectId,
    project_name: project.name,
    confirmed_count: targets.length,
    ai_exclusions: aiExclusions,
    created_at: new Date().toISOString(),
    fingerprint,
    judgment_fingerprint: fingerprint,
    fingerprint_version: REPORT_FINGERPRINT_VERSION,
    draft_number: draftNumber,
    sections: {
      achievement_table: {
        title: '성과지표 달성표',
        rows: achievementRows,
        empty_message:
          achievementRows.length === 0 ? '확정한 판단이 없습니다' : undefined,
      },
      performance_analysis: {
        title: '성과 분석',
        sentences: validSentences,
        empty_message:
          validSentences.length === 0 ? '확정한 판단이 없습니다' : undefined,
      },
      contributing_factors: {
        title: '기여요인',
        content: contributingContent,
        sentences: contributingSentences,
        empty_message: !contributingContent ? '확정한 판단이 없습니다' : undefined,
        excluded_notice: excludedNotice,
        excluded_count:
          excludedNoEvidenceCount > 0 ? excludedNoEvidenceCount : undefined,
      },
      constraints_and_responses: {
        title: '제약요인과 대응',
        empty_message: '확정한 판단이 없습니다',
      },
      lessons_learned: {
        title: '교훈',
        empty_message: '확정한 판단이 없습니다',
      },
      monitoring_plan: {
        title: '모니터링 계획',
        empty_message: '확정한 판단이 없습니다',
      },
      overall_evaluation: {
        title: '종합평가',
        empty_message: '확정한 판단이 없습니다',
      },
    },
  };

  prepareTemplate(draft, options?.template ?? defaultReportTemplate(project.project_type || project.name), bannedSentences);
  await populateReportSummary(draft, projectId, options?.aiClient, bannedSentences, db, indicatorGenerationFailed, eligibilityGuard);
  eligibilityGuard();
  if (reportInputFingerprint(projectId, db) !== fingerprint) throw new Error('보고서 생성 중 입력 자료가 바뀌었습니다. 최신 자료로 다시 생성해 주세요.');
  draft.fingerprint = fingerprint;
  draft.judgment_fingerprint = fingerprint;
  saveReportDraft(projectId, JSON.stringify(draft), db);
  return draft;
}

/**
 * 최신 저장된 보고서 초안 조회 (없으면 null)
 */
export interface ReportDraftVersionOption {
  id: string;
  draft_number?: number;
  created_at: string;
  isFinalized: boolean;
  finalizedAt?: string;
  finalizedRole?: string;
}

/** Metadata only: saved report JSON can contain evaluation content. */
export function listReportDrafts(projectId: string, db?: Parameters<typeof getProject>[1]): ReportDraftVersionOption[] {
  return listReportDraftRecords(projectId, db).map(record => ({
    id: record.id,
    draft_number: record.draft_number ?? undefined,
    created_at: record.created_at,
    isFinalized: record.is_finalized === 1,
    finalizedAt: record.finalized_at ?? undefined,
    finalizedRole: record.finalized_role ?? undefined,
  }));
}

function redactStaleSummary(draft: ReportDraftData): ReportDraftData {
  const redactSection = (section: ReportSection): void => {
    section.sentences = [];
    section.rows = [];
    section.content = undefined;
    if (section.table) section.table.rows = section.table.rows.map(row => row.map(() => ({ text: '※ 근거 자료 미확보', source: 'missing' as const })));
    section.children?.forEach(redactSection);
  };
  draft.report_sections?.forEach(redactSection);
  draft.footnotes = [];
  draft.ai_exclusions = [];
  draft.sections.achievement_table.rows = [];
  draft.sections.performance_analysis.sentences = [];
  draft.sections.contributing_factors.sentences = [];
  draft.sections.contributing_factors.content = '';
  draft.sections.constraints_and_responses.content = '';
  draft.sections.lessons_learned.content = '';
  draft.sections.monitoring_plan.content = '';
  draft.sections.overall_evaluation.content = '';
  return draft;
}

function removeNumericallyUnsafeSummarySentences(draft: ReportDraftData, db?: Parameters<typeof getProject>[1]): void {
  const database = db ?? getDatabase();
  const sentenceItems: ReportSentenceItem[] = [];
  const nodeIds = new Set<string>();
  const snippetIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const paragraphIds = new Set<string>();
  const collectIds = (ids: string[]) => ids.forEach(id => {
    if (id.startsWith('paragraph-')) paragraphIds.add(id.slice('paragraph-'.length));
    else snippetIds.add(id);
  });
  const collectSection = (section: ReportSection) => {
    for (const sentence of section.sentences ?? []) {
      sentenceItems.push(sentence);
      if (sentence.indicator_id) nodeIds.add(sentence.indicator_id);
      collectIds(sentence.evidence_ids?.length ? sentence.evidence_ids : sentence.evidence_id ? [sentence.evidence_id] : []);
    }
    for (const row of section.table?.rows ?? []) for (const cell of row) {
      const ids = cell.evidence_ids ?? [];
      if (ids.length) {
        if (cell.indicator_id) nodeIds.add(cell.indicator_id);
        collectIds(ids);
      }
    }
    section.children?.forEach(collectSection);
  };
  draft.report_sections?.forEach(collectSection);
  for (const note of draft.footnotes ?? []) collectIds([note.evidence_id]);
  sentenceItems.push(...draft.sections.performance_analysis.sentences, ...(draft.sections.contributing_factors.sentences ?? []));
  for (const sentence of sentenceItems) {
    if (sentence.indicator_id) nodeIds.add(sentence.indicator_id);
    collectIds(sentence.evidence_ids?.length ? sentence.evidence_ids : sentence.evidence_id ? [sentence.evidence_id] : []);
  }
  for (const row of draft.sections.achievement_table.rows) {
    if (row.indicator_id) nodeIds.add(row.indicator_id);
    if (row.evidence_id) {
      if (row.evidence_id.startsWith('paragraph-')) paragraphIds.add(row.evidence_id.slice('paragraph-'.length));
      else evidenceIds.add(row.evidence_id);
    }
  }
  // Separate true indicator evidence UUIDs from ontology snippet IDs by asking
  // the current-project evidence table in one bounded batch.
  const liveEvidences = reportEvidenceFacts(draft.project_id, [...new Set([...snippetIds, ...evidenceIds])], database);
  const evidenceById = new Map(liveEvidences.map(item => [item.id, item]));
  for (const id of [...snippetIds]) if (evidenceById.has(id)) {
    evidenceIds.add(id);
    snippetIds.delete(id);
  }
  const liveSnippets = reportSnippetFacts(draft.project_id, [...snippetIds], database);
  const snippetById = new Map(liveSnippets.map(item => [item.id, item]));
  const paragraphs = reportParagraphFacts(draft.project_id, [...paragraphIds], database);
  const paragraphById = new Map(paragraphs.map(item => [item.id, item]));
  const nodeData = new Map(reportLatestNodeData(draft.project_id, [...nodeIds], database).map(item => [item.id, item.data_json]));
  const ontologyNodeIds = [...nodeData.keys()];
  const indicatorIds = [...nodeIds].filter(id => !nodeData.has(id));
  const liveNodeStatuses = new Map(reportLatestNodeReviewStatuses(draft.project_id, ontologyNodeIds, database).map(item => [item.node_id, item.status]));
  const liveIndicatorStatuses = new Map(reportLatestIndicatorConfirmations(draft.project_id, indicatorIds, database).map(item => [item.indicator_id, item.confirmation_type]));
  const banned = getBannedSentencesByProject(draft.project_id, database).map(item => item.content);
  const blocked = new Set<string>();
  const provider = getAiProvider();
  for (const id of snippetIds) {
    const fact = snippetById.get(id);
    if (!fact) { blocked.add(id); continue; }
    let snippet: { quote?: string } = {};
    try { snippet = JSON.parse(fact.snippet_json); JSON.parse(fact.source_json); } catch { blocked.add(id); continue; }
    const quote = typeof snippet.quote === 'string' ? snippet.quote : '';
    const sourceDocument = fact.document_id ? {
      masked: fact.masked === 1,
      approved_ai: fact.approved_ai ?? undefined,
      is_past_final_report: fact.is_past_final_report == null ? null : fact.is_past_final_report === 1,
    } : null;
    const eligible = sourceDocument && getAiDocumentEligibilityForProvider(sourceDocument, provider).eligible;
    if (!fact.document_id || fact.is_included !== 1 || fact.cache_verified !== 1 || !eligible || !isConfirmedNonPastReport(fact) || !quote || isCitationBannedSentence(quote) || hasForbiddenSentenceOverlap(quote, banned, 8)) blocked.add(id);
  }
  for (const id of evidenceIds) {
    const fact = evidenceById.get(id);
    const eligible = fact && getAiDocumentEligibilityForProvider({ masked: fact.masked === 1, approved_ai: fact.approved_ai ?? undefined, is_past_final_report: fact.is_past_final_report == null ? null : fact.is_past_final_report === 1 }, provider).eligible;
    if (!fact || fact.is_included !== 1 || fact.verified !== 1 || !eligible || !isConfirmedNonPastReport(fact) || fact.is_citation_banned || isCitationBannedSentence(fact.quote) || hasForbiddenSentenceOverlap(fact.quote, banned, 8)) blocked.add(id);
  }
  for (const id of paragraphIds) {
    const fact = paragraphById.get(id);
    if (!fact || fact.is_included !== 1 || !isConfirmedNonPastReport(fact) || isCitationBannedSentence(fact.content) || hasForbiddenSentenceOverlap(fact.content, banned, 8)) blocked.add(`paragraph-${id}`);
  }
  const invalidNodes = new Set<string>();
  for (const nodeId of nodeIds) {
    const status = nodeData.has(nodeId) ? liveNodeStatuses.get(nodeId) : liveIndicatorStatuses.get(nodeId);
    if (!status || !['확정', '수정 후 확정'].includes(status)) {
      invalidNodes.add(nodeId);
      for (const sentence of sentenceItems.filter(item => item.indicator_id === nodeId)) {
        for (const id of sentence.evidence_ids ?? (sentence.evidence_id ? [sentence.evidence_id] : [])) blocked.add(id);
      }
    }
  }
  for (const row of draft.sections.achievement_table.rows) {
    if (invalidNodes.has(row.indicator_id) || (row.evidence_id && blocked.has(row.evidence_id))) {
      if (row.evidence_id) blocked.add(row.evidence_id);
    }
  }
  const paragraphByFootnoteId = new Map(paragraphs.map(item => [`paragraph-${item.id}`, item]));
  const noteIsCurrent = (note: ReportFootnote) => {
    if (note.evidence_id.startsWith('paragraph-')) {
      const fact = paragraphByFootnoteId.get(note.evidence_id);
      return Boolean(fact && fact.is_included === 1 && isConfirmedNonPastReport(fact) && fact.document_id === note.document_id && fact.content === note.quote && !isCitationBannedSentence(fact.content) && !hasForbiddenSentenceOverlap(fact.content, banned, 8));
    }
    const snippet = snippetById.get(note.evidence_id);
    if (snippet) {
      try {
        const current = JSON.parse(snippet.snippet_json) as { quote?: string };
        return current.quote === note.quote && snippet.document_id === note.document_id && snippet.cache_verified === 1 && !blocked.has(note.evidence_id);
      } catch { return false; }
    }
    const evidence = evidenceById.get(note.evidence_id);
    return Boolean(evidence && evidence.is_included === 1 && evidence.verified === 1 && evidence.document_id === note.document_id && evidence.quote === note.quote && !blocked.has(note.evidence_id));
  };
  const validFootnoteIds = new Set((draft.footnotes ?? []).filter(noteIsCurrent).map(note => note.evidence_id));
  for (const note of draft.footnotes ?? []) if (!validFootnoteIds.has(note.evidence_id)) blocked.add(note.evidence_id);
  const sentenceAllowed = (sentence: ReportSentenceItem) => {
    const ids = sentence.evidence_ids?.length ? sentence.evidence_ids : sentence.evidence_id ? [sentence.evidence_id] : [];
    const currentQuote = (id: string) => {
      const snippet = snippetById.get(id);
      if (snippet) { try { return (JSON.parse(snippet.snippet_json) as { quote?: string }).quote ?? ''; } catch { return ''; } }
      return evidenceById.get(id)?.quote ?? '';
    };
    const currentDocumentId = (id: string) => snippetById.get(id)?.document_id ?? evidenceById.get(id)?.document_id;
    const quotes = ids.map(currentQuote);
    const snapshotMatches = Boolean(sentence.evidences?.length) && ids.every(id => sentence.evidences?.some(evidence => evidence.id === id && evidence.quote === currentQuote(id) && evidence.document_id === currentDocumentId(id)));
    return ids.length > 0 && !invalidNodes.has(sentence.indicator_id) && ids.every(id => !blocked.has(id)) && snapshotMatches && !hasForbiddenSentenceOverlap(sentence.sentence, banned, 8) && checkNumericConsistency(sentence.sentence, quotes).passed;
  };
  const visit = (section: ReportSection): void => {
    section.sentences = section.sentences?.filter(sentenceAllowed);
    for (const row of section.table?.rows ?? []) for (const cell of row) if (cell.source === 'ai' && cell.evidence_ids?.length) {
      const ids = cell.evidence_ids;
      const quotes = ids.map(id => {
        const snippet = snippetById.get(id);
        if (snippet) { try { return (JSON.parse(snippet.snippet_json) as { quote?: string }).quote ?? ''; } catch { return ''; } }
        return evidenceById.get(id)?.quote ?? '';
      });
      if ((cell.indicator_id && invalidNodes.has(cell.indicator_id)) || ids.some(id => blocked.has(id)) || !checkNumericConsistency(cell.text, quotes).passed) {
        cell.text = '※ 근거 자료 미확보'; cell.source = 'missing'; cell.evidence_ids = [];
      }
    }
    if (section.sentences?.length === 0 && section.source === 'ai') {
      section.source = 'missing';
      section.empty_message = '※ 근거 자료 미확보';
    }
    section.children?.forEach(visit);
  };
  draft.report_sections?.forEach(visit);
  draft.sections.performance_analysis.sentences = draft.sections.performance_analysis.sentences.filter(sentenceAllowed);
  if (draft.sections.contributing_factors.sentences) {
    draft.sections.contributing_factors.sentences = draft.sections.contributing_factors.sentences.filter(sentenceAllowed);
    draft.sections.contributing_factors.content = draft.sections.contributing_factors.sentences.map(item => item.sentence).join('\n\n');
  }
  draft.sections.achievement_table.rows = draft.sections.achievement_table.rows.map(row => {
    if (!row.evidence_id || invalidNodes.has(row.indicator_id) || blocked.has(row.evidence_id)) {
      return { ...row, evidence_id: undefined, target_value: '※ 근거 자료 미확보', status_display: '※ 근거 자료 미확보', edited_text: undefined };
    }
    return row;
  });
  const used = new Set<string>();
  const collect = (section: ReportSection) => {
    for (const sentence of section.sentences ?? []) for (const id of sentence.evidence_ids ?? []) used.add(id);
    for (const row of section.table?.rows ?? []) for (const cell of row) for (const id of cell.evidence_ids ?? []) used.add(id);
    section.children?.forEach(collect);
  };
  draft.report_sections?.forEach(collect);
  for (const sentence of draft.sections.performance_analysis.sentences) for (const id of sentence.evidence_ids ?? []) used.add(id);
  for (const sentence of draft.sections.contributing_factors.sentences ?? []) for (const id of sentence.evidence_ids ?? []) used.add(id);
  draft.footnotes = draft.footnotes?.filter(note => used.has(note.evidence_id));
}

export interface SavedReportDraftWithStatus {
  draft: ReportDraftData | null;
  isOutdated: boolean;
  reportId?: string;
}

export function getSavedReportDraftWithStatus(
  projectId: string,
  db?: Parameters<typeof getProject>[1],
  targets?: ReportTargetIndicator[],
  citationContext?: ProjectCitationContext,
  reportId?: string
): SavedReportDraftWithStatus {
  const record = reportId ? getReportDraftById(projectId, reportId, db) : getLatestReportDraft(projectId, db);
  if (!record) return { draft: null, isOutdated: false, ...(reportId ? { reportId } : {}) };
  try {
    const draft = JSON.parse(record.content_json) as ReportDraftData;
    if (record.project_id !== projectId || draft.project_id !== projectId) throw new Error('Saved report project scope mismatch');
    if (draft.summary_format === 1) {
      if (!isDraftValid(draft, projectId, db, targets)) return { draft: redactStaleSummary(draft), isOutdated: true, reportId: record.id };
      // Inputs are immutable at this revision. Validate the generated numeric
      // claims from their stored quotes without querying or assembling the graph.
      removeNumericallyUnsafeSummarySentences(draft, db);
      return { draft, isOutdated: false, reportId: record.id };
    }
    if (draft.version !== 2) {
      // Older formats have no reliable input fingerprint. Do not expose a saved
      // footnote once its source document has been marked as a holdout.
      const hasHoldoutFootnote = (draft.footnotes ?? []).some(note => {
        const documentId = reportEvidenceDetails(note.evidence_id, db)?.document_id ?? note.document_id;
        const document = documentId ? reportDocumentState(projectId, documentId, db) : undefined;
        return document ? !isConfirmedNonPastReport(document) : false;
      });
      return hasHoldoutFootnote ? { draft: null, isOutdated: true, reportId: record.id } : { draft, isOutdated: false, reportId: record.id };
    }
    const context = resolveProjectCitationContext(projectId, db ?? getDatabase(), citationContext);
    const legacyTargets = targets ?? getReportTargets(projectId, db, context);
    if (!isDraftValid(draft, projectId, db, legacyTargets)) {
      // Preserve only format metadata needed by the legacy page to load its
      // review context; no stale report text or footnotes leave storage.
      const metadata: ReportDraftData = {
        project_id: draft.project_id,
        project_name: draft.project_name,
        version: draft.version,
        created_at: draft.created_at,
        confirmed_count: draft.confirmed_count,
        sections: {} as ReportDraftData['sections'],
        footnotes: [],
      };
      return { draft: metadata, isOutdated: true, reportId: record.id };
    }
    const { sentences: bannedSentences, index: bannedIndex } = context;
    const bannedIds = new Set(legacyTargets.flatMap((target) => target.evidences
      .filter((evidence) => isEvidenceCitationBanned(evidence, bannedSentences, bannedIndex))
      .map((evidence) => evidence.id)));
    for (const note of draft.footnotes ?? []) {
      const evidence = reportEvidenceDetails(note.evidence_id, db);
      const documentId = evidence?.document_id ?? note.document_id;
      const document = documentId ? reportDocumentState(projectId, documentId, db) : undefined;
      if ((evidence && (evidence.is_citation_banned || !document)) || (document && (document.is_included !== 1 || !isConfirmedNonPastReport(document)))) bannedIds.add(note.evidence_id);
    }
    const collectBannedSentence = (sentence: ReportSentenceItem) => {
      for (const evidence of sentence.evidences ?? []) {
        if (isEvidenceCitationBanned(evidence, bannedSentences, bannedIndex)) bannedIds.add(evidence.id);
      }
    };
    const collectBannedSection = (section: ReportSection) => {
      section.sentences?.forEach(collectBannedSentence);
      section.children?.forEach(collectBannedSection);
    };
    draft.sections.performance_analysis.sentences.forEach(collectBannedSentence);
    draft.sections.contributing_factors.sentences?.forEach(collectBannedSentence);
    draft.report_sections?.forEach(collectBannedSection);
    const oldFootnotes = draft.footnotes ?? [];
    const keptFootnotes = oldFootnotes.filter((note) => !bannedIds.has(note.evidence_id)).map((note, index) => ({ ...note, number: index + 1 }));

    const sanitizeSentence = (sentence: ReportSentenceItem) => {
      const linkedIds = new Set(sentence.evidence_ids ?? (sentence.evidence_id ? [sentence.evidence_id] : []));
      for (const id of linkedIds) if (bannedIds.has(id)) linkedIds.delete(id);
      sentence.evidence_ids = [...linkedIds];
      sentence.evidences = sentence.evidences?.filter((evidence) => !bannedIds.has(evidence.id));
      const firstId = sentence.evidence_ids[0];
      if (!firstId) {
        sentence.evidence_id = '';
        delete sentence.evidence_quote;
        delete sentence.evidence_location;
        delete sentence.evidence_speaker;
        delete sentence.document_name;
      } else {
        sentence.evidence_id = firstId;
      }
    };
    const allowedSentence = (sentence: ReportSentenceItem) => !hasForbiddenSentenceOverlap(sentence.sentence, bannedSentences, 8) && !(sentence.evidence_ids ?? (sentence.evidence_id ? [sentence.evidence_id] : [])).some(id => bannedIds.has(id));
    const sanitizeSection = (section: ReportSection) => {
      for (const row of section.rows ?? []) {
        row.indicator_name = maskTextIfForbiddenSentenceOverlap(row.indicator_name, bannedSentences, 8);
        row.target_value = maskTextIfForbiddenSentenceOverlap(row.target_value, bannedSentences, 8);
        if (row.edited_text) row.edited_text = maskTextIfForbiddenSentenceOverlap(row.edited_text, bannedSentences, 8);
        if (row.evidence_id && bannedIds.has(row.evidence_id)) { row.evidence_id = undefined; row.target_value = '※ 근거 자료 미확보'; row.status_display = '※ 근거 자료 미확보'; delete row.edited_text; }
      }
      const count = section.sentences?.length ?? 0;
      section.sentences = section.sentences?.filter(allowedSentence);
      if (count && !section.sentences?.length) section.empty_message = '※ 근거 자료 미확보';
      section.sentences?.forEach(sanitizeSentence);
      if (section.content) section.content = maskTextIfForbiddenSentenceOverlap(section.content, bannedSentences, 8);
      section.title = maskTextIfForbiddenSentenceOverlap(section.title, bannedSentences, 8);
      section.children?.forEach(sanitizeSection);
    };
    if (draft.report_sections) draft.report_sections.forEach(sanitizeSection);
    draft.sections.performance_analysis.sentences = draft.sections.performance_analysis.sentences.filter(allowedSentence);
    if (draft.sections.contributing_factors.sentences) draft.sections.contributing_factors.sentences = draft.sections.contributing_factors.sentences.filter(allowedSentence);
    draft.sections.performance_analysis.sentences.forEach(sanitizeSentence);
    draft.sections.contributing_factors.sentences?.forEach(sanitizeSentence);
    draft.sections.contributing_factors.content = draft.sections.contributing_factors.sentences?.map(s => s.sentence).join('\n\n');
    draft.sections.achievement_table.rows.forEach((row) => {
      row.indicator_name = maskTextIfForbiddenSentenceOverlap(row.indicator_name, bannedSentences, 8);
      row.target_value = maskTextIfForbiddenSentenceOverlap(row.target_value, bannedSentences, 8);
      if (row.edited_text) row.edited_text = maskTextIfForbiddenSentenceOverlap(row.edited_text, bannedSentences, 8);
      if (row.evidence_id && bannedIds.has(row.evidence_id)) { row.evidence_id = undefined; row.target_value = '※ 근거 자료 미확보'; row.status_display = '※ 근거 자료 미확보'; delete row.edited_text; }
    });
    draft.footnotes = keptFootnotes;
    return { draft, isOutdated: false, reportId: record.id };
  } catch {
    return { draft: null, isOutdated: true, reportId: record.id };
  }
}

/** Compatibility wrapper for callers that only need the decoded draft. */
export function getSavedReportDraft(
  projectId: string,
  db?: Parameters<typeof getProject>[1],
  targets?: ReportTargetIndicator[],
  citationContext?: ProjectCitationContext,
  reportId?: string
): ReportDraftData | null {
  return getSavedReportDraftWithStatus(projectId, db, targets, citationContext, reportId).draft;
}

