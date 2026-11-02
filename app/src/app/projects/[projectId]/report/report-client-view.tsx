'use client';

import React, { useState, useTransition } from 'react';
import { omissionReason } from '@/lib/visibility-reasons';
import { OmittedItems } from '../omitted-items';
import Link from 'next/link';
import { DocumentExclusionNotice } from '@/app/projects/document-exclusion-notice';
import type { ExcludedDocumentSummary } from '@/server/store/excluded-documents';
import { FailureMessage } from '../failure-message';
import { ProjectTabs } from '../project-tabs';
import { WorkflowNextAction } from '@/app/workflow-next-action';
import { guestSpeakerLabel } from '../review/review-client-view';
import { isEvidenceCitationBanned } from '@/server/store/citation-ban';
import { verifyQuote } from '@/server/quote-verify';
import type { ProjectRecord, ReportTargetIndicator } from '@/server/store/types';
import type { ReportDraftData, ReportSentenceItem } from '@/server/report/types';
import { TemplateSections } from './template-sections';
import { defaultReportTemplate } from '@/server/report/templates';
import { finalizeReportAction, generateReportDraftAction, generateReportDownloadAction, getReportVersionAction, getReportVersionsAction, type ReportVersionOption } from './actions';

interface ReportClientViewProps {
  exclusionSummary?: ExcludedDocumentSummary;
  project: ProjectRecord;
  initialTargets: ReportTargetIndicator[];
  initialConfirmedCount?: number;
  initialNoteConfirmedCount?: number;
  initialDraft: ReportDraftData | null;
  initialReportId?: string | null;
  initialLatestReportId?: string | null;
  initialVersions?: ReportVersionOption[];
  initialOutdated?: boolean;
  initialBannedSentences?: string[];
  // #53 후속(fix-r1): 손님은 AI 호출 단추(초안 만들기, 저장된 초안 없을 때 내려받기)를 비활성화한다.
  isGuest?: boolean;
  canGenerate?: boolean;
  canFinalize?: boolean;
  reportFinalizationRequired?: boolean;
}

export function getStatusBadgeClass(status: string): {
  container: string;
  dot: string;
} {
  switch (status) {
    case '실현':
      return {
        container: 'bg-emerald-50 text-emerald-800 border-emerald-300',
        dot: 'bg-emerald-500',
      };
    case '추진 중':
      return {
        container: 'bg-blue-50 text-blue-800 border-blue-300',
        dot: 'bg-blue-500',
      };
    case '기대':
      return {
        container: 'bg-amber-50 text-amber-800 border-amber-300',
        dot: 'bg-amber-500',
      };
    case '근거 충돌':
      return {
        container: 'bg-orange-50 text-orange-800 border-orange-300',
        dot: 'bg-orange-500',
      };
    case '근거 미확인':
    case '미확인':
      return {
        container: 'bg-slate-100 text-slate-800 border-slate-300',
        dot: 'bg-slate-400',
      };
    default:
      return {
        container: 'bg-gray-100 text-gray-700 border-gray-300',
        dot: 'bg-gray-400',
      };
  }
}

export function EvidencePanel({
  projectId,
  sentence,
  target,
  bannedSentences = [],
  isOutdated = false,
  isGuest = false,
  allowSnapshot = false,
}: {
  projectId: string;
  sentence: ReportSentenceItem | null;
  target?: ReportTargetIndicator;
  bannedSentences?: string[];
  isOutdated?: boolean;
  isGuest?: boolean;
  allowSnapshot?: boolean;
}) {
  if (!sentence) {
    return <p className="text-sm text-gray-500">보고서 문단을 선택하면 연결된 근거와 검토 정보가 표시됩니다.</p>;
  }

  if (isOutdated || (!target && !allowSnapshot)) {
    return <p className="text-sm font-semibold text-amber-800" data-testid="outdated-evidence-panel-notice">확정 내용이 바뀌어 이 초안의 근거를 현재 검토 정보와 대조할 수 없습니다. 새 초안을 만드세요.</p>;
  }

  const evidences = (sentence.evidences ?? []).filter((evidence) => {
    const storedEvidence = target?.evidences.find((item) => item.id === evidence.id);
    if (target && !storedEvidence) return false;
    return !isEvidenceCitationBanned({
      quote: evidence.quote,
      speaker: evidence.speaker,
      is_citation_banned: evidence.is_citation_banned === 1 || storedEvidence?.is_citation_banned === 1 ? 1 : 0,
    }, bannedSentences);
  });
  return (
    <div className="space-y-4" data-testid="report-evidence-panel">
      <div className="rounded-md bg-slate-50 p-3 text-sm text-gray-800">{sentence.sentence}</div>
      {evidences.length === 0 ? (
        <p className="text-sm font-semibold text-slate-700" data-testid="report-unverified-evidence">
          근거 미확인
        </p>
      ) : (
        evidences.map((evidence) => {
          const storedEvidence = target?.evidences.find((item) => item.id === evidence.id);
          const originalParagraph = storedEvidence?.paragraph_context?.target.content;
          const matchStatus = originalParagraph
            ? verifyQuote(evidence.quote, originalParagraph)
              ? '일치 확인'
              : '불일치'
            : '미확인';
          return (
            <article key={evidence.id} className="space-y-2 border-t border-gray-200 pt-3" data-testid={`report-evidence-${evidence.id}`}>
              <blockquote className="text-sm text-gray-800">“{evidence.quote}”</blockquote>
              <p className="text-xs text-gray-600">
                {evidence.document_name || '문서명 미확인'} · {evidence.location || '위치 미확인'}
                {evidence.speaker ? ` · ${guestSpeakerLabel(evidence.speaker, isGuest)}` : ''}
              </p>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                <dt>신뢰 수준</dt><dd>{[evidence.evidence_level, evidence.confidence ? `신뢰도 ${evidence.confidence}` : ''].filter(Boolean).join(' · ') || '미확인'}</dd>
                <dt>검토 상태</dt><dd>{evidence.review_status || target?.latestConfirmation?.confirmation_type || '미확인'}</dd>
                <dt>검토자</dt><dd>{evidence.confirmer_role || target?.latestConfirmation?.confirmer_name || '미확인'}</dd>
                <dt>확정일</dt><dd>{evidence.confirmed_at || target?.latestConfirmation?.created_at || '미확인'}</dd>
                <dt>원문 일치도</dt><dd>{matchStatus}</dd>
              </dl>
              <Link
                href={`/projects/${projectId}/review?indicatorId=${encodeURIComponent(sentence.indicator_id)}&snippet=${encodeURIComponent(evidence.id)}&open=source#evidence-${encodeURIComponent(evidence.id)}`}
                data-testid={`open-source-context-${evidence.id}`}
                className="inline-flex text-xs font-semibold text-blue-700 underline underline-offset-2"
              >
                검토 화면에서 원문 문맥 보기
              </Link>
            </article>
          );
        })
      )}
      <div className="border-t border-gray-200 pt-3">
        <h4 className="text-xs font-bold text-gray-700">연결 항목의 검토 상태</h4>
        {target?.latestConfirmation ? (
          <p className="mt-2 text-xs text-gray-700" data-testid={`report-review-ref-${sentence.indicator_id}`}>
            {sentence.indicator_name} · {target.latestConfirmation.confirmation_type}
            <span className="block text-gray-500">{target.latestConfirmation.confirmer_name || '검토자 미확인'} · {target.latestConfirmation.created_at || '시각 미확인'}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function TemplateMismatchNotice({
  hasDraft,
  savedTemplate,
  selectedTemplate,
}: {
  hasDraft: boolean;
  savedTemplate: 'ksp' | 'eipp' | 'legacy7' | undefined;
  selectedTemplate: 'ksp' | 'eipp';
}) {
  if (!hasDraft || (savedTemplate !== undefined && savedTemplate !== 'legacy7' && savedTemplate === selectedTemplate)) return null;
  const savedTemplateLabel = savedTemplate === 'ksp' || savedTemplate === 'eipp' ? savedTemplate.toUpperCase() : '기존 7절';
  return (
    <div data-testid="report-template-mismatch-notice" role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      저장된 초안은 {savedTemplateLabel} 서식입니다. 선택한 {selectedTemplate.toUpperCase()} 서식은 다음 초안 생성부터 적용됩니다. 현재 Word 파일은 저장된 초안 기준입니다.
    </div>
  );
}

export function ReportClientView({
  project,
  exclusionSummary = { unconfirmed: 0, past: 0 },
  initialTargets,
  initialConfirmedCount = initialTargets.length,
  initialNoteConfirmedCount = 0,
  initialDraft,
  initialReportId = null,
  initialLatestReportId = initialReportId,
  initialVersions = [],
  initialOutdated = false,
  initialBannedSentences = [],
  isGuest = false,
  canGenerate = true,
  canFinalize = false,
  reportFinalizationRequired = false,
}: ReportClientViewProps) {
  const [template, setTemplate] = useState<'ksp' | 'eipp'>(initialDraft?.template === 'ksp' || initialDraft?.template === 'eipp' ? initialDraft.template : defaultReportTemplate(project.project_type || project.name));
  const [draft, setDraft] = useState<ReportDraftData | null>(initialDraft);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(initialReportId);
  const [latestReportId, setLatestReportId] = useState<string | null>(initialLatestReportId);
  const [versions, setVersions] = useState<ReportVersionOption[]>(initialVersions);
  const selectedVersion = versions.find(version => version.id === selectedReportId);
  const [isOutdated, setIsOutdated] = useState<boolean>(initialOutdated);
  const [isPending, startTransition] = useTransition();
  const [isDownloading, setIsDownloading] = useState(false);
  const [showFinalWarning, setShowFinalWarning] = useState(false);
  const [selectedSentence, setSelectedSentence] = useState<ReportSentenceItem | null>(null);
  const [actionFailure, setActionFailure] = useState<{
    message: string;
    operation: 'generate' | 'download';
  } | null>(null);

  const hasConfirmedTargets = initialConfirmedCount + initialNoteConfirmedCount > 0 || Boolean(draft?.report_sections);
  const selectedEvidenceIds = selectedSentence?.evidence_ids?.length
    ? selectedSentence.evidence_ids
    : selectedSentence?.evidence_id
      ? [selectedSentence.evidence_id]
      : [];
  const selectedTarget = selectedSentence && !isOutdated && selectedEvidenceIds.length > 0
    ? initialTargets.find(
        (target) =>
          selectedEvidenceIds.every((evidenceId) =>
            target.evidences.some((evidence) => evidence.id === evidenceId)
          )
      )
    : undefined;

  // 초안 만들기 (D35)
  const handleGenerateDraft = () => {
    setActionFailure(null);
    startTransition(async () => {
      try {
        const res = await generateReportDraftAction(project.id, template);
        if (res.success && res.draft) {
          setDraft(res.draft);
          setIsOutdated(false);
          if (res.reportId) {
            setSelectedReportId(res.reportId);
            setLatestReportId(res.reportId);
          }
          const listed = await getReportVersionsAction(project.id);
          if (listed.success && listed.versions) setVersions(listed.versions);
        } else {
          setActionFailure({
            message: res.error ?? '보고서 초안 생성 중 오류가 발생했습니다.',
            operation: 'generate',
          });
        }
      } catch (err) {
        setActionFailure({
          message: err instanceof Error ? err.message : String(err),
          operation: 'generate',
        });
      }
    });
  };

  const handleDownload = async () => {
    setActionFailure(null);
    setIsDownloading(true);
    try {
      const result = await generateReportDownloadAction(project.id, selectedReportId ?? undefined);
      if (!result.success || !result.contentBase64 || !result.fileName) {
        throw new Error(result.error ?? 'Word 파일을 내려받지 못했습니다.');
      }

      const binary = window.atob(result.contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const objectUrl = URL.createObjectURL(
        new Blob([bytes.buffer as ArrayBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
      );
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setActionFailure({
        message: err instanceof Error ? err.message : String(err),
        operation: 'download',
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleFinalize = (acknowledgePending: boolean) => {
    if (!draft || selectedReportId !== latestReportId) return;
    if ((draft.review_pending_count ?? 1) > 0 && !acknowledgePending) {
      setShowFinalWarning(true);
      return;
    }
    startTransition(async () => {
      const result = await finalizeReportAction(project.id, draft.created_at, acknowledgePending);
      if (result.success && result.draft) {
        setDraft(result.draft);
        setShowFinalWarning(false);
        if (result.reportId) {
          setSelectedReportId(result.reportId);
          setLatestReportId(result.reportId);
          const listed = await getReportVersionsAction(project.id);
          if (listed.success && listed.versions) setVersions(listed.versions);
        }
      }
      else setActionFailure({ message: result.error ?? '문안을 확정하지 못했습니다.', operation: 'generate' });
    });
  };

  const handleSelectVersion = (reportId: string) => {
    const previousReportId = selectedReportId;
    setSelectedReportId(reportId);
    setSelectedSentence(null);
    setActionFailure(null);
    startTransition(async () => {
      const result = await getReportVersionAction(project.id, reportId);
      if (result.success && result.reportId) {
        setDraft(result.draft ?? null);
        setIsOutdated(result.isOutdated ?? false);
      } else {
        setSelectedReportId(previousReportId);
        setActionFailure({ message: result.error ?? '보고서 판을 불러오지 못했습니다.', operation: 'generate' });
      }
    });
  };

  // D47 다시 시도: 실패한 초안 생성이나 다운로드 요청만 다시 실행한다.
  const handleRetry = () => {
    if (actionFailure?.operation === 'generate') {
      handleGenerateDraft();
    } else if (actionFailure?.operation === 'download') {
      void handleDownload();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <DocumentExclusionNotice projectId={project.id} summary={exclusionSummary} />
        {/* 상단 헤더 */}
        <header className="border-b border-gray-200 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div className="flex items-center gap-3">
                <Link
                  href="/projects"
                  className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition"
                >
                  &larr; 사업 목록
                </Link>
                <span className="text-gray-300">|</span>
                <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
                  ⑧ 보고서 초안
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">⑧ 종료평가보고서 종합</h1>
              <p className="mt-2 text-sm text-gray-600">④~⑦에서 확정한 성과·근거로 만든 초안입니다. 미확인 사항은 한계로 적습니다.{(draft?.draft_number ?? selectedVersion?.draft_number) != null ? ` (판 v${draft?.draft_number ?? selectedVersion?.draft_number})` : ''}</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm text-gray-600 font-medium">
                사업: <span className="text-gray-900 font-semibold">{project.name}</span>
              </div>
            </div>
          </div>

          <ProjectTabs projectId={project.id} activeScreen="report" />
        </header>

        {reportFinalizationRequired && !draft?.report_finalization && !isOutdated && <p role="status" data-testid="planner-final-report-required">기획팀은 평가팀 최종 확정본을 선택해야 내려받을 수 있습니다.</p>}

        {!isOutdated && draft?.ai_exclusions && draft.ai_exclusions.length > 0 && (
          <section aria-label="AI 입력 제외 안내" className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            <h2 className="font-semibold">AI 입력 제외</h2>
            <ul className="mt-2 list-disc pl-5">
              {draft.ai_exclusions.map((item, index) => (
                <li key={index}>{item.subject}: {item.reasons.join(', ')}</li>
              ))}
            </ul>
          </section>
        )}

        <OmittedItems items={isOutdated ? [{ name: '보고서 초안', reason: omissionReason('outdated') }] : []} />

        {/* 빈 상태 (UC-17: 확정 판단이 하나도 없을 때) */}
        {!hasConfirmedTargets && (
          <section
            data-testid="empty-report-state"
            aria-label="확정 판단 없음 안내"
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center space-y-4"
          >
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-500 mb-2">
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900">확정한 판단이 없습니다</h2>
            <p className="text-sm text-gray-600 max-w-md mx-auto">
              종료평가보고서 초안은 평가자가 &apos;확정&apos; 또는 &apos;수정 후
              확정&apos;한 판단만으로 작성됩니다. 먼저 AI 제안 검토 화면에서 판정을
              확정해 주십시오.
            </p>
            <div className="pt-2">
              <Link
                href={`/projects/${project.id}/review`}
                data-testid="goto-review-link"
                className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-md shadow-sm transition"
              >
                AI 제안 검토(S4) 바로가기 &rarr;
              </Link>
            </div>
          </section>
        )}

        {/* 확정 판단이 있는 경우: 요약 바, 액션 버튼, 일곱 절 본문 */}
        {(
          <div className="space-y-6">
            {/* 요약 헤더 문구 (SP S6) 및 액션 버튼 */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <p
                  data-testid="report-summary-bar"
                  className="text-sm font-medium text-gray-700"
                >
                  지표 확정 {initialConfirmedCount} · 노트 확정 {initialNoteConfirmedCount} (<Link className="underline" href={`/projects/${project.id}/review?noteStatus=confirmed`}>검토 화면에서 보기</Link>). 보고서에는 자격을 갖춘 근거가 있는 항목을 넣습니다.
                </p>
                {draft && <p data-testid="draft-confirmed-count" className="mt-1 text-xs text-gray-600">생성된 초안 확정 건수 {draft.confirmed_count}</p>}
                <p className="text-xs text-gray-500 mt-1">
                  모든 서술 문장에는 인용 대조를 통과한 근거 링크가 포함됩니다.
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-900">근거 검토: {draft?.review_pending_count == null ? '미확인' : draft.review_pending_count > 0 ? `진행 중 (${draft.review_pending_count}건 남음)` : '완료'}</span>
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-900">문안: {draft?.report_finalization ? `최종 확정 (${draft.report_finalization.role} · ${draft.report_finalization.confirmed_at})` : selectedVersion?.isFinalized ? `최종 확정 (${selectedVersion.finalizedRole ?? '평가팀'} · ${selectedVersion.finalizedAt ?? '시각 미확인'})` : '초안'}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label>보고서 서식 (초안 생성 시 적용) <select aria-label="보고서 서식" value={template} onChange={event => setTemplate(event.target.value as 'ksp' | 'eipp')} disabled={isGuest || !canGenerate || isPending} className="border rounded p-2"><option value="ksp">KSP</option><option value="eipp">EIPP</option></select></label>
                {canFinalize && draft && !draft.report_finalization && selectedReportId === latestReportId && <button type="button" data-testid="finalize-report-button" disabled={isPending || isOutdated} onClick={() => handleFinalize(false)} className="rounded-md border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-800 disabled:opacity-50">문안 최종 확정</button>}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="generate-draft-button"
                    disabled={isPending || isGuest || !canGenerate}
                    onClick={handleGenerateDraft}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md shadow-sm transition flex items-center gap-2"
                  >
                    {isPending ? (
                      <>
                        <svg
                          className="animate-spin h-4 w-4 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        <span>초안 만드는 중...</span>
                      </>
                    ) : draft ? (
                      '초안 다시 만들기'
                    ) : (
                      '초안 만들기'
                    )}
                  </button>
                  {isGuest && (
                    <span
                      data-testid="guest-generate-draft-blocked-notice"
                      className="text-xs text-gray-500"
                    >
                      로그인 뒤 쓸 수 있습니다
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="download-docx-button"
                    onClick={() => void handleDownload()}
                    disabled={isDownloading || isPending || isOutdated || isGuest || (!canGenerate && !(reportFinalizationRequired && draft?.report_finalization))}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-md shadow-sm transition flex items-center gap-2"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    <span>{isDownloading ? 'Word 준비 중...' : 'Word 로 내려받기'}</span>
                  </button>
                  {isGuest && !draft && (
                    <span
                      data-testid="guest-download-docx-blocked-notice"
                      className="text-xs text-gray-500"
                    >
                      로그인 뒤 쓸 수 있습니다
                    </span>
                  )}
                </div>
              </div>
            </div>

            {versions.length > 0 && <label className="block text-sm">보고서 판 선택 <select aria-label="보고서 판 선택" data-testid="report-version-select" value={selectedReportId ?? ''} onChange={event => handleSelectVersion(event.target.value)} disabled={isPending || isDownloading} className="ml-2 rounded border p-2">
              {versions.map(version => <option key={version.id} value={version.id}>v{version.draft_number ?? '?'}{version.isFinalized ? ` · 최종 확정${version.finalizedAt ? ` (${version.finalizedAt})` : ''}` : ' · 초안'} · {version.created_at}</option>)}
            </select></label>}

            <TemplateMismatchNotice hasDraft={draft !== null} savedTemplate={draft?.template} selectedTemplate={template} />

            {showFinalWarning && <div role="alert" data-testid="report-finalize-warning" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"><p>근거 검토가 남아 있습니다. 이 상태로 문안을 최종 확정하시겠습니까?</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => handleFinalize(true)} disabled={isPending} className="rounded border border-amber-600 px-3 py-1">확인 후 최종 확정</button><button type="button" onClick={() => setShowFinalWarning(false)} className="rounded border px-3 py-1">취소</button></div></div>}

            {/* 오류 상태 (D47: 실패 한 줄 + [다시 시도]) */}
            {actionFailure && (
              <FailureMessage
                message={actionFailure.message}
                onRetry={handleRetry}
                isRetrying={isPending || isDownloading}
                testId="action-error-banner"
              />
            )}

            {/* #22 Item 1: 확정 내용 변경에 따른 초안 무효화 안내 */}
            {isOutdated && (
              <div
                data-testid="outdated-draft-notice"
                role="alert"
                className="bg-amber-50 border border-amber-300 rounded-lg p-4 flex items-center justify-between gap-4 text-amber-900 text-sm font-medium"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-amber-600 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      /* public-safety-allow: SVG 아이콘 경로 숫자, 카드 번호 아님 */
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <span>{omissionReason('outdated')} — 확정 내용이나 근거가 바뀌어 새 초안을 만들어야 합니다.</span>
                </div>
              </div>
            )}

            {/* 아직 초안을 누르지 않은 상태 안내 */}
            {!draft && !isPending && (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center space-y-3">
                <p className="text-gray-700 font-medium">
                  지표 확정 {initialConfirmedCount} · 노트 확정 {initialNoteConfirmedCount}
                </p>
                <p className="text-sm text-gray-500">
                  우측 상단의 <strong className="text-blue-600">[초안 만들기]</strong> 버튼을
                  누르면 AI 가 인용 대조와 수치 검사를 거친 선택한 서식의 초안을 생성합니다.
                </p>
              </div>
            )}

            {/* 일곱 절 본문 (SP §S6) */}
            {draft?.sections && !isOutdated && (
              <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
              <article
                data-testid="report-content"
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 space-y-8 divide-y divide-gray-200"
              >
                <div className="space-y-2 text-sm text-gray-600"><p>서식: {(draft.template === 'ksp' || draft.template === 'eipp' ? draft.template : template).toUpperCase()} 종료평가보고서</p>{draft.template_source && <p data-testid="report-template-source">서식 출처: {draft.template_source}</p>}<p>각 문장 끝의 [n]은 근거 스니펫, 링크된 노드는 판단의 단위다. 레벨·신뢰도는 AI 제안이며 PO가 확정한다.</p></div>
                {draft.version && draft.template !== 'legacy7' && draft.report_sections ? <TemplateSections draft={draft} onSelect={setSelectedSentence} /> : <>
                {/* 1. 성과지표 달성표 */}
                <section
                  aria-labelledby="section-heading-1"
                  data-testid="section-achievement-table"
                  className="space-y-4"
                >
                  <h2
                    id="section-heading-1"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    1. 성과지표 달성표
                  </h2>

                  {draft.sections.achievement_table.rows.length === 0 ? (
                    <p
                      data-testid="empty-section-achievement-table"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200 text-sm">
                        <thead className="bg-gray-50 text-gray-700">
                          <tr>
                            <th className="py-2.5 px-4 text-left font-semibold">지표명</th>
                            <th className="py-2.5 px-4 text-left font-semibold">목표치</th>
                            <th className="py-2.5 px-4 text-left font-semibold">판정 결과</th>
                            <th className="py-2.5 px-4 text-left font-semibold">근거</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 bg-white">
                          {draft.sections.achievement_table.rows.map((row) => {
                            const badge = getStatusBadgeClass(row.status_display);
                            return (
                              <tr
                                key={row.indicator_id}
                                id={`achievement-row-${row.indicator_id}`}
                                data-testid={`achievement-row-${row.indicator_id}`}
                                className="hover:bg-gray-50 transition"
                              >
                                <td className="py-3 px-4 font-medium text-gray-900">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span>{row.indicator_name}</span>
                                    {row.is_orphaned ? (
                                      <span
                                        data-testid={`orphaned-badge-${row.indicator_id}`}
                                        className="inline-flex items-center text-xs font-semibold text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full"
                                      >
                                        (문서에서 사라진 지표)
                                      </span>
                                    ) : null}
                                  </div>
                                </td>
                                <td className="py-3 px-4 text-gray-600">{row.target_value}</td>
                                <td className="py-3 px-4">
                                  <div className="flex flex-col gap-1 items-start">
                                    <span
                                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge.container}`}
                                    >
                                      <span
                                        className={`w-1.5 h-1.5 rounded-full ${badge.dot}`}
                                      />
                                      {row.status_display}
                                    </span>
                                    {row.confirmation_type === '수정 후 확정' && row.edited_text && (
                                      <div
                                        data-testid={`edited-badge-${row.indicator_id}`}
                                        className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded px-2 py-1 leading-snug mt-1"
                                      >
                                        <span className="font-semibold text-blue-900">[수정본]</span> {row.edited_text}
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  {row.evidence_id ? (
                                    <Link
                                      href={`/projects/${project.id}/review?indicatorId=${row.indicator_id}#evidence-${row.evidence_id}`}
                                      aria-label={`근거: ${row.indicator_name}`}
                                      data-testid={`evidence-link-${row.indicator_id}`}
                                      className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition underline underline-offset-2"
                                    >
                                      [근거 ▸]
                                    </Link>
                                  ) : (
                                    <span className="text-gray-400 text-xs">-</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 2. 성과 분석 */}
                <section
                  aria-labelledby="section-heading-2"
                  data-testid="section-performance-analysis"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-2"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    2. 성과 분석
                  </h2>

                  {draft.sections.performance_analysis.sentences.length === 0 ? (
                    <p
                      data-testid="empty-section-performance-analysis"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  ) : (
                    <div className="space-y-2.5 pl-3">
                      {draft.sections.performance_analysis.sentences.map((sent, idx) => {
                        const evIds =
                          sent.evidence_ids && sent.evidence_ids.length > 0
                            ? sent.evidence_ids
                            : sent.evidence_id
                            ? [sent.evidence_id]
                            : [];
                        return (
                          <p
                            key={idx}
                            data-testid={`sentence-item-${idx}`}
                            className="text-sm text-gray-800 leading-relaxed"
                          >
                            <button
                              type="button"
                              data-testid={`select-sentence-${sent.indicator_id}-${idx}`}
                              aria-pressed={selectedSentence?.indicator_id === sent.indicator_id && selectedSentence.sentence === sent.sentence}
                              onClick={() => setSelectedSentence(sent)}
                              className="rounded text-left hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-300"
                            >
                              {sent.sentence}
                            </button>{' '}
                            {evIds.map((evId, evIdx) => (
                              <Link
                                key={evId}
                                href={`/projects/${project.id}/review?indicatorId=${sent.indicator_id}#evidence-${evId}`}
                                aria-label={`근거: ${sent.indicator_name}`}
                                data-testid={
                                  evIdx === 0
                                    ? `sentence-evidence-link-${sent.indicator_id}`
                                    : `sentence-evidence-link-${sent.indicator_id}-${evId}`
                                }
                                className="inline-flex items-center text-xs font-bold text-blue-600 hover:text-blue-800 transition underline underline-offset-2 ml-1"
                              >
                                {evIds.length > 1 ? `[근거 ${evIdx + 1} ▸]` : '[근거 ▸]'}
                              </Link>
                            ))}
                          </p>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* 3. 기여요인 */}
                <section
                  aria-labelledby="section-heading-3"
                  data-testid="section-contributing-factors"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-3"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    3. 기여요인
                  </h2>

                  {draft.sections.contributing_factors.excluded_notice && (
                    <p
                      data-testid="contributing-factors-excluded-notice"
                      className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-1.5 ml-3"
                    >
                      {draft.sections.contributing_factors.excluded_notice}
                    </p>
                  )}

                  {draft.sections.contributing_factors.sentences &&
                  draft.sections.contributing_factors.sentences.length > 0 ? (
                    <div
                      data-testid="contributing-factors-content"
                      className="space-y-2.5 pl-3"
                    >
                      {draft.sections.contributing_factors.sentences.map((sent, idx) => {
                        const evIds =
                          sent.evidence_ids && sent.evidence_ids.length > 0
                            ? sent.evidence_ids
                            : sent.evidence_id
                            ? [sent.evidence_id]
                            : [];
                        return (
                          <p
                            key={idx}
                            data-testid={`contributing-factor-item-${idx}`}
                            className="text-sm text-gray-800 leading-relaxed"
                          >
                            <button
                              type="button"
                              data-testid={`select-contributing-sentence-${sent.indicator_id}-${idx}`}
                              aria-pressed={selectedSentence?.indicator_id === sent.indicator_id && selectedSentence.sentence === sent.sentence}
                              onClick={() => setSelectedSentence(sent)}
                              className="rounded text-left hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-300"
                            >
                              {sent.sentence}
                            </button>{' '}
                            {evIds.map((evId, evIdx) => (
                              <Link
                                key={evId}
                                href={`/projects/${project.id}/review?indicatorId=${sent.indicator_id}#evidence-${evId}`}
                                aria-label={`근거: ${sent.indicator_name}`}
                                data-testid={
                                  evIdx === 0
                                    ? `contributing-evidence-link-${sent.indicator_id}`
                                    : `contributing-evidence-link-${sent.indicator_id}-${evId}`
                                }
                                className="inline-flex items-center text-xs font-bold text-blue-600 hover:text-blue-800 transition underline underline-offset-2 ml-1"
                              >
                                {evIds.length > 1 ? `[근거 ${evIdx + 1} ▸]` : '[근거 ▸]'}
                              </Link>
                            ))}
                          </p>
                        );
                      })}
                    </div>
                  ) : draft.sections.contributing_factors.content ? (
                    <p
                      data-testid="contributing-factors-content"
                      className="text-sm text-gray-800 leading-relaxed pl-3 whitespace-pre-line"
                    >
                      {draft.sections.contributing_factors.content}
                    </p>
                  ) : (
                    <p
                      data-testid="empty-section-contributing-factors"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  )}
                </section>

                {/* 4. 제약요인과 대응 */}
                <section
                  aria-labelledby="section-heading-4"
                  data-testid="section-constraints-and-responses"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-4"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    4. 제약요인과 대응
                  </h2>

                  {draft.sections.constraints_and_responses.content ? (
                    <p className="text-sm text-gray-800 leading-relaxed pl-3 whitespace-pre-line">
                      {draft.sections.constraints_and_responses.content}
                    </p>
                  ) : (
                    <p
                      data-testid="empty-section-constraints-and-responses"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  )}
                </section>

                {/* 5. 교훈 */}
                <section
                  aria-labelledby="section-heading-5"
                  data-testid="section-lessons-learned"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-5"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    5. 교훈
                  </h2>

                  {draft.sections.lessons_learned.content ? (
                    <p className="text-sm text-gray-800 leading-relaxed pl-3 whitespace-pre-line">
                      {draft.sections.lessons_learned.content}
                    </p>
                  ) : (
                    <p
                      data-testid="empty-section-lessons-learned"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  )}
                </section>

                {/* 6. 모니터링 계획 */}
                <section
                  aria-labelledby="section-heading-6"
                  data-testid="section-monitoring-plan"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-6"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    6. 모니터링 계획
                  </h2>

                  {draft.sections.monitoring_plan.content ? (
                    <p className="text-sm text-gray-800 leading-relaxed pl-3 whitespace-pre-line">
                      {draft.sections.monitoring_plan.content}
                    </p>
                  ) : (
                    <p
                      data-testid="empty-section-monitoring-plan"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  )}
                </section>

                {/* 7. 종합평가 */}
                <section
                  aria-labelledby="section-heading-7"
                  data-testid="section-overall-evaluation"
                  className="pt-6 space-y-4"
                >
                  <h2
                    id="section-heading-7"
                    className="text-lg font-bold text-gray-900 border-l-4 border-blue-600 pl-3"
                  >
                    7. 종합평가
                  </h2>

                  {draft.sections.overall_evaluation.content ? (
                    <p className="text-sm text-gray-800 leading-relaxed pl-3 whitespace-pre-line">
                      {draft.sections.overall_evaluation.content}
                    </p>
                  ) : (
                    <p
                      data-testid="empty-section-overall-evaluation"
                      className="text-sm text-gray-500 italic pl-3"
                    >
                      확정한 판단이 없습니다
                    </p>
                  )}
                </section>
                </>}
              </article>
              <aside
                data-testid="report-evidence-sidebar"
                className="self-start rounded-lg border border-gray-200 bg-white p-5 lg:sticky lg:top-4"
              >
                <h2 className="mb-4 text-base font-bold text-gray-900">선택 문장의 근거</h2>
                <EvidencePanel
                  projectId={project.id}
                  sentence={selectedSentence}
                  target={selectedTarget}
                  bannedSentences={initialBannedSentences}
                  isOutdated={isOutdated}
                  isGuest={isGuest}
                  allowSnapshot={!isOutdated}
                />
              </aside>
              </div>
            )}
          </div>
        )}
        <WorkflowNextAction projectId={project.id} screen="report" />
      </div>
    </div>
  );
}
