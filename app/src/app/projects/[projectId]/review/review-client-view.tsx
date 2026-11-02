'use client';

import React, { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { DocumentExclusionNotice } from '@/app/projects/document-exclusion-notice';
import type { ExcludedDocumentSummary } from '@/server/store/excluded-documents';
import { NoteReviewView, noteReviewStageForNode, noteReviewStageForScope } from './note-review-view';
import type { NoteItem } from '@/server/store/note-review';
import { FailureMessage } from '../failure-message';
import { ProjectTabs } from '../project-tabs';
import { WorkflowNextAction } from '@/app/workflow-next-action';
import {
  ConfirmationType,
  ReviewEvidence,
  ReviewIndicatorItem,
  ReviewPageData,
  VERDICT_STATUSES,
  VerdictStatus,
} from '@/server/store/types';
import {
  confirmVerdictAction,
  resuggestIndicatorAction,
  saveAttributionAction,
  type ConfirmVerdictInput,
  type SaveAttributionInput,
} from './actions';

interface ReviewClientViewProps {
  exclusionSummary?: ExcludedDocumentSummary;
  noteReviewData?: {importId:string|null;items:NoteItem[]};
  initialSelectedNoteNodeId?: string;
  initialData: ReviewPageData;
  initialSelectedIndicatorId?: string;
  initialAutoOpenSnippetId?: string | null;
  // #53: 손님 화면에서는 실제 사업 프로그램·협력기관 약어를 일반 이름으로 보인다.
  isGuest?: boolean;
  canConfirm?: boolean;
}

export function getVerdictBadgeClass(status: string | null | undefined): {
  container: string;
  dot: string;
  label: string;
} {
  switch (status) {
    case '실현':
      return {
        container: 'bg-emerald-50 text-emerald-800 border-emerald-300',
        dot: 'bg-emerald-500',
        label: '실현',
      };
    case '추진 중':
      return {
        container: 'bg-blue-50 text-blue-800 border-blue-300',
        dot: 'bg-blue-500',
        label: '추진 중',
      };
    case '기대':
      return {
        container: 'bg-amber-50 text-amber-800 border-amber-300',
        dot: 'bg-amber-500',
        label: '기대',
      };
    case '미확인':
      return {
        container: 'bg-slate-100 text-slate-800 border-slate-300',
        dot: 'bg-slate-400',
        label: '미확인',
      };
    case '근거 충돌':
      return {
        container: 'bg-orange-50 text-orange-800 border-orange-300',
        dot: 'bg-orange-500',
        label: '근거 충돌',
      };
    default:
      return {
        container: 'bg-gray-100 text-gray-600 border-gray-200',
        dot: 'bg-gray-400',
        label: '제안 없음',
      };
  }
}

export type ReviewStage =
  | '전체'
  | '산출물'
  | '단기성과'
  | '중·장기성과'
  | '기여·제약요인';

export const REVIEW_STAGES: readonly ReviewStage[] = [
  '전체',
  '산출물',
  '단기성과',
  '중·장기성과',
  '기여·제약요인',
] as const;

export const KNOWN_INDICATOR_LEVELS = [
  '산출물',
  '활동',
  '단기성과',
  '중기성과',
  '영향',
  '기여·제약요인',
] as const;

export function isKnownLevel(level: string): boolean {
  return (KNOWN_INDICATOR_LEVELS as readonly string[]).includes(level);
}

export function isIndicatorInStage(level: string, stage: ReviewStage): boolean {
  if (!isKnownLevel(level)) {
    return false;
  }
  switch (stage) {
    case '전체':
      return true;
    case '산출물':
      return level === '산출물' || level === '활동';
    case '단기성과':
      return level === '단기성과';
    case '중·장기성과':
      return level === '중기성과' || level === '영향';
    case '기여·제약요인':
      return level === '기여·제약요인';
    default:
      return false;
  }
}

interface ConfirmationDraft {
  editedText: string;
  reason: string;
  isEditFormOpen: boolean;
  editedVerdictStatus?: VerdictStatus;
}

type ReviewRetryAction =
  | { kind: 'resuggest'; projectId: string; indicatorId: string }
  | { kind: 'attribution'; input: SaveAttributionInput }
  | { kind: 'confirm'; input: ConfirmVerdictInput };

export function guestSpeakerLabel(speaker: string, isGuest: boolean): string {
  return isGuest && speaker === 'KDI' ? '협력기관' : speaker;
}

export function sourceSnippetFromSearch(search: string): string | null {
  const query = new URLSearchParams(search);
  return query.get('open') === 'source' ? query.get('snippet') : null;
}

export function ReviewClientView({ initialData, initialSelectedIndicatorId, initialAutoOpenSnippetId, isGuest = false, canConfirm = true, noteReviewData, initialSelectedNoteNodeId, exclusionSummary = { unconfirmed: 0, past: 0 } }: ReviewClientViewProps) {
  const attributionProgram = isGuest ? '사업' : 'KSP';
  const [data, setData] = useState<ReviewPageData>(initialData);
  const [activeStage, setActiveStage] = useState<ReviewStage>('전체');
  const noteReviewScope = JSON.stringify([initialData.project.id, noteReviewData?.importId ?? null]);
  const initialNoteReviewStage = noteReviewStageForNode(noteReviewData?.items ?? [], initialSelectedNoteNodeId);
  const [noteReviewStageState, setNoteReviewStageState] = useState({ scope: noteReviewScope, stage: initialNoteReviewStage });
  const noteReviewStage = noteReviewStageForScope(noteReviewStageState, noteReviewScope, initialNoteReviewStage);
  const setNoteReviewStage = (stage: number) => setNoteReviewStageState({ scope: noteReviewScope, stage });

  const defaultSelectedId =
    initialSelectedIndicatorId &&
    initialData.indicators.some((i) => i.indicator.id === initialSelectedIndicatorId)
      ? initialSelectedIndicatorId
      : initialData.indicators[0]?.indicator.id ?? '';
  const [selectedIndicatorId, setSelectedIndicatorId] = useState<string>(defaultSelectedId);
  const [openParagraphPanels, setOpenParagraphPanels] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!initialAutoOpenSnippetId) return;
    const allowedInCurrentData = data.indicators.some((item =>
      item.indicator.id === selectedIndicatorId &&
      item.suggestion?.evidences.some(evidence => evidence.id === initialAutoOpenSnippetId && evidence.is_citation_banned === 0)
    ));
    setOpenParagraphPanels(prev => {
      if (allowedInCurrentData) return prev[initialAutoOpenSnippetId] ? prev : { ...prev, [initialAutoOpenSnippetId]: true };
      if (!prev[initialAutoOpenSnippetId]) return prev;
      const next = { ...prev };
      delete next[initialAutoOpenSnippetId];
      return next;
    });
  }, [data.indicators, initialAutoOpenSnippetId, selectedIndicatorId]);
  const [isPending, startTransition] = useTransition();
  const [actionFailure, setActionFailure] = useState<{ message: string; action: ReviewRetryAction } | null>(null);
  const [actionValidationError, setActionValidationError] = useState<string | null>(null);
  const [resuggestDiagnostics, setResuggestDiagnostics] = useState<string[]>([]);

  // 확정 관련 상태 (D16, D44, UC-05, UC-16)
  const [confirmerName, setConfirmerName] = useState<string>(initialData.latestConfirmerName ?? '');
  const [confirmerError, setConfirmerError] = useState<string | null>(null);
  const [editValidationError, setEditValidationError] = useState<string | null>(null);
  const [confirmSuccessMsg, setConfirmSuccessMsg] = useState<string | null>(null);

  // 단계·지표 이동 시 확정 폼 입력(수정본·사유) 지표별 보관 및 복원 (#20 검수 8번)
  const [confirmationDrafts, setConfirmationDrafts] = useState<Record<string, ConfirmationDraft>>({});

  const activeDraft = confirmationDrafts[selectedIndicatorId] ?? {
    editedText: '',
    reason: '',
    isEditFormOpen: false,
  };
  const editedText = activeDraft.editedText;
  const editReason = activeDraft.reason;
  const isEditFormOpen = activeDraft.isEditFormOpen;

  // KSP 기여 귀속 상태 (RQ-16, SP §s4)
  const [attributions, setAttributions] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const item of initialData.indicators) {
      init[item.indicator.id] = item.attribution ?? '';
    }
    return init;
  });
  const [attributionSaveMessage, setAttributionSaveMessage] = useState<string | null>(null);

  const activeIndicators = data.indicators.filter((item) => !item.indicator.is_orphaned);
  const orphanedIndicators = data.indicators.filter((item) => item.indicator.is_orphaned === 1);

  const filteredIndicators = activeIndicators.filter((item) =>
    isIndicatorInStage(item.indicator.level, activeStage)
  );

  const unclassifiedIndicators = activeIndicators.filter(
    (item) => !isKnownLevel(item.indicator.level)
  );

  const selectedItem: ReviewIndicatorItem | undefined = data.indicators.find(
    (item) => item.indicator.id === selectedIndicatorId
  );

  const hasSuggestion = !!selectedItem?.suggestion;

  const toggleParagraphPanel = (evidenceId: string) => {
    setOpenParagraphPanels((prev) => ({
      ...prev,
      [evidenceId]: !prev[evidenceId],
    }));
  };

  const handleStageChange = (newStage: ReviewStage) => {
    setActiveStage(newStage);
    const nextFiltered = activeIndicators.filter((item) =>
      isIndicatorInStage(item.indicator.level, newStage)
    );
    const nextVisible =
      newStage === '전체'
        ? [...nextFiltered, ...activeIndicators.filter((i) => !isKnownLevel(i.indicator.level))]
        : nextFiltered;
    if (!nextVisible.some((i) => i.indicator.id === selectedIndicatorId)) {
      setSelectedIndicatorId(nextVisible[0]?.indicator.id ?? '');
    }
  };

  const handleSelectIndicator = (indicatorId: string) => {
    setSelectedIndicatorId(indicatorId);
    setActionFailure(null);
    setActionValidationError(null);
    setConfirmerError(null);
    setEditValidationError(null);
    setConfirmSuccessMsg(null);
    setAttributionSaveMessage(null);
  };

  const runSaveAttribution = (input: SaveAttributionInput) => {
    setActionFailure(null);
    setAttributionSaveMessage(null);

    startTransition(async () => {
      try {
        const res = await saveAttributionAction(input);
        if (res.success && res.data) {
          setData(res.data);
          setAttributionSaveMessage('기여 귀속 판단이 저장되었습니다.');
        } else {
          setActionFailure({
            message: res.error ?? '기여 귀속 저장 중 오류가 발생했습니다.',
            action: { kind: 'attribution', input },
          });
        }
      } catch (err) {
        setActionFailure({
          message: err instanceof Error ? err.message : String(err),
          action: { kind: 'attribution', input },
        });
      }
    });
  };

  const handleSaveAttribution = (indicatorId: string) => {
    runSaveAttribution({
      projectId: data.project.id,
      indicatorId,
      attributionText: attributions[indicatorId] ?? '',
    });
  };

  const runResuggest = (projectId: string, indicatorId: string) => {
    setActionFailure(null);
    setActionValidationError(null);
    setResuggestDiagnostics([]);
    startTransition(async () => {
      try {
        const res = await resuggestIndicatorAction(projectId, indicatorId);
        setResuggestDiagnostics(res.diagnostics ?? []);
        if (res.data) {
          setData(res.data);
        }
        if (res.success && res.data) {
          setActionFailure(null);
        } else {
          setActionFailure({
            message: res.error ?? '제안 재실행 중 알 수 없는 오류가 발생했습니다.',
            action: { kind: 'resuggest', projectId, indicatorId },
          });
        }
      } catch (err) {
        setActionFailure({
          message: err instanceof Error ? err.message : String(err),
          action: { kind: 'resuggest', projectId, indicatorId },
        });
      }
    });
  };

  const handleResuggest = (indicatorId: string) => {
    runResuggest(data.project.id, indicatorId);
  };

  const runConfirm = (input: ConfirmVerdictInput) => {
    setActionFailure(null);
    setActionValidationError(null);
    startTransition(async () => {
      try {
        const res = await confirmVerdictAction(input);
        if (res.success && res.data) {
          setData(res.data);
          if (input.confirmationType === '수정 후 확정') {
            setConfirmationDrafts((prev) => {
              const next = { ...prev };
              delete next[input.indicatorId];
              return next;
            });
          }
          setConfirmSuccessMsg(`'${input.confirmationType}' 상태로 확정되었습니다.`);
        } else {
          setActionFailure({
            message: res.error ?? '확정 처리 중 오류가 발생했습니다.',
            action: { kind: 'confirm', input },
          });
        }
      } catch (err) {
        setActionFailure({
          message: err instanceof Error ? err.message : String(err),
          action: { kind: 'confirm', input },
        });
      }
    });
  };

  const handleRetryAction = () => {
    if (!actionFailure) return;
    const { action } = actionFailure;
    if (action.kind === 'resuggest') {
      runResuggest(action.projectId, action.indicatorId);
    } else if (action.kind === 'attribution') {
      runSaveAttribution(action.input);
    } else {
      runConfirm(action.input);
    }
  };

  const handleConfirmDirect = (type: ConfirmationType) => {
    if (!selectedItem?.suggestion) {
      setActionValidationError('AI 제안이 없는 지표는 확정할 수 없습니다.');
      return;
    }
    if (!confirmerName.trim()) {
      setConfirmerError('확정자 이름을 입력해 주십시오.');
      return;
    }
    setConfirmerError(null);
    setEditValidationError(null);
    setConfirmationDrafts((prev) => ({
      ...prev,
      [selectedIndicatorId]: {
        editedText: prev[selectedIndicatorId]?.editedText ?? '',
        reason: prev[selectedIndicatorId]?.reason ?? '',
        isEditFormOpen: false,
      },
    }));
    setConfirmSuccessMsg(null);

    runConfirm({
      projectId: data.project.id,
      indicatorId: selectedIndicatorId,
      confirmationType: type,
      confirmerName: confirmerName.trim(),
    });
  };

  const handleOpenEditConfirm = () => {
    if (!selectedItem?.suggestion) {
      setActionValidationError('AI 제안이 없는 지표는 확정할 수 없습니다.');
      return;
    }
    setConfirmationDrafts((prev) => ({
      ...prev,
      [selectedIndicatorId]: {
        editedText: prev[selectedIndicatorId]?.editedText ?? '',
        reason: prev[selectedIndicatorId]?.reason ?? '',
        isEditFormOpen: true,
      },
    }));
    setConfirmerError(null);
    setEditValidationError(null);
    setConfirmSuccessMsg(null);
  };

  const handleSaveEditConfirm = () => {
    if (!selectedItem?.suggestion) {
      setActionValidationError('AI 제안이 없는 지표는 확정할 수 없습니다.');
      return;
    }
    if (!confirmerName.trim()) {
      setConfirmerError('확정자 이름을 입력해 주십시오.');
      return;
    }
    setConfirmerError(null);

    if (!editedText.trim() || !editReason.trim()) {
      setEditValidationError('수정본과 수정 사유를 모두 입력해야 합니다.');
      return;
    }
    setEditValidationError(null);
    setConfirmSuccessMsg(null);

    const proposalVerdict = selectedItem?.suggestion?.verdict_status;
    const isVerdictChanged =
      Boolean(activeDraft.editedVerdictStatus) &&
      activeDraft.editedVerdictStatus !== proposalVerdict;
    const finalVerdictToSave = isVerdictChanged ? activeDraft.editedVerdictStatus : null;

    runConfirm({
      projectId: data.project.id,
      indicatorId: selectedIndicatorId,
      confirmationType: '수정 후 확정',
      confirmerName: confirmerName.trim(),
      editedText: editedText.trim(),
      reason: editReason.trim(),
      editedVerdictStatus: finalVerdictToSave,
    });
  };

  const renderIndicatorButton = (item: ReviewIndicatorItem) => {
    const isSelected = item.indicator.id === selectedIndicatorId;
    const badge = getVerdictBadgeClass(item.suggestion?.verdict_status);

    return (
      <button
        key={item.indicator.id}
        data-testid={`indicator-item-${item.indicator.id}`}
        onClick={() => {
          handleSelectIndicator(item.indicator.id);
        }}
        aria-current={isSelected ? 'true' : undefined}
        className={`w-full text-left p-4 transition flex flex-col gap-2 hover:bg-gray-50 ${
          isSelected
            ? 'bg-blue-50/50 border-l-4 border-l-blue-600'
            : 'border-l-4 border-l-transparent'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
            {isKnownLevel(item.indicator.level)
              ? item.indicator.level
              : `미분류 (${item.indicator.level})`}
          </span>
          {/* D28 배지: 색 + 글자 병기 */}
          <span
            data-testid={`badge-${item.indicator.id}`}
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge.container}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
            <span>{badge.label}</span>
          </span>
        </div>

        <div className="text-sm font-semibold text-gray-900 truncate">
          {item.indicator.name}
        </div>

        {item.indicator.target_value && (
          <div className="text-xs text-gray-500 truncate">
            목표: {item.indicator.target_value}
          </div>
        )}
      </button>
    );
  };

  const visibleIndicators =
    activeStage === '전체'
      ? [...filteredIndicators, ...unclassifiedIndicators]
      : filteredIndicators;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <DocumentExclusionNotice projectId={data.project.id} summary={exclusionSummary} />
        {noteReviewData && <NoteReviewView projectId={data.project.id} initialData={noteReviewData} initialSelectedNodeId={initialSelectedNoteNodeId} opinionOnly={!canConfirm} stage={noteReviewStage} onStageChange={setNoteReviewStage} />}
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
                  ④ 판정 · 근거 검토
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">AI 제안 검토</h1>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="text-sm text-gray-600 font-medium">
                사업: <span className="text-gray-900">{data.project.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="confirmer-name"
                  className="text-sm font-medium text-gray-700 whitespace-nowrap"
                >
                  확정자:
                </label>
                <input
                  id="confirmer-name"
                  type="text"
                  data-testid="confirmer-name-input"
                  value={confirmerName}
                  onChange={(e) => {
                    setConfirmerName(e.target.value);
                    setConfirmerError(null);
                  }}
                  placeholder="확정자 이름"
                  className="px-3 py-1 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500 bg-white"
                />
              </div>
            </div>
          </div>

          <ProjectTabs
            projectId={data.project.id}
            activeScreen="review"
            selectedIndicatorId={selectedIndicatorId}
          />
        </header>

        {/* 단계 탭 (RQ-15, SP §s4) */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 bg-white border border-gray-200 rounded-xl shadow-xs">
          <span className="text-xs font-bold text-gray-600 whitespace-nowrap">단계:</span>
          <nav
            role="tablist"
            aria-label="성과 단계 탭"
            className="flex flex-wrap gap-1.5"
          >
            {REVIEW_STAGES.map((stage) => {
              const isSelected = activeStage === stage;
              return (
                <button
                  key={stage}
                  type="button"
                  role="tab"
                  aria-selected={isSelected ? 'true' : 'false'}
                  data-testid={`stage-tab-${stage}`}
                  onClick={() => handleStageChange(stage)}
                  className={`px-3 py-1 text-xs font-semibold rounded-lg transition ${
                    isSelected
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                >
                  {stage}
                </button>
              );
            })}
          </nav>
        </div>

        {/* 읽지 못한 파일 알림 (RQ-06, UC-10, SP §s4) */}
        {data.unreadableDocuments.length > 0 && (
          <div
            role="alert"
            data-testid="unreadable-docs-alert"
            className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-900 flex items-start sm:items-center justify-between gap-3 text-sm font-medium"
          >
            <div className="flex items-start sm:items-center gap-3">
              <span className="text-lg leading-none font-bold text-red-700 select-none">⊘</span>
              <div>
                <span className="font-semibold text-red-800">
                  읽지 못함 {data.unreadableDocuments.length}건:
                </span>{' '}
                {data.unreadableDocuments.map((d) => d.file_name).join(', ')} — 이 파일은 근거로
                쓰이지 않았습니다.
              </div>
            </div>
            <Link
              href={`/projects/${data.project.id}/documents`}
              className="text-xs font-semibold text-red-700 hover:underline shrink-0"
            >
              [S2 ▸]
            </Link>
          </div>
        )}

        {/* D47: 오류 발생 시 한 줄 알림 + 다시 시도 버튼 */}
        {actionFailure && (
          <FailureMessage
            message={actionFailure.message}
            onRetry={handleRetryAction}
            isRetrying={isPending}
            testId="error-banner"
          />
        )}
        {resuggestDiagnostics.map(diagnostic => (
          <p key={diagnostic} role="status" data-testid="resuggest-diagnostic" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {diagnostic}
          </p>
        ))}
        {actionValidationError && (
          <p
            role="alert"
            data-testid="action-validation-error"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            오류: {actionValidationError}
          </p>
        )}

        {/* 2단 구성 (D27: 데스크톱 2단, 좁은 폭 1단 쌓임) */}
        <main className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
          {/* 왼쪽 칸: 지표 목록 */}
          <aside className="md:col-span-5 lg:col-span-4 bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50/70 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">지표 목록</h2>
              <span className="text-xs text-gray-500 font-medium">
                총 {visibleIndicators.length}개
              </span>
            </div>

            {visibleIndicators.length === 0 ? (
              <div
                data-testid="stage-empty-message"
                className="p-8 text-center text-xs text-gray-500 bg-gray-50/50"
              >
                {activeStage} 단계에 등록된 지표가 없습니다.
              </div>
            ) : (
              <div>
                {filteredIndicators.length > 0 && (
                  <nav aria-label="지표 목록" className="divide-y divide-gray-100">
                    {filteredIndicators.map((item) => renderIndicatorButton(item))}
                  </nav>
                )}

                {/* 알 수 없는 level: '분류되지 않은 지표' 묶음 (#20 검수 7번) */}
                {activeStage === '전체' && unclassifiedIndicators.length > 0 && (
                  <div
                    data-testid="unclassified-indicators-group"
                    className="mt-3 border-t-2 border-amber-200 bg-amber-50/30"
                  >
                    <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
                      <span className="text-xs font-bold text-amber-900">분류되지 않은 지표</span>
                      <span className="text-[11px] text-amber-700 font-medium">
                        {unclassifiedIndicators.length}개
                      </span>
                    </div>
                    <nav aria-label="분류되지 않은 지표 목록" className="divide-y divide-gray-100">
                      {unclassifiedIndicators.map((item) => renderIndicatorButton(item))}
                    </nav>
                  </div>
                )}
              </div>
            )}

            {/* 문서에서 사라진 지표 — 이력 보존 (RQ-07, #19) */}
            {orphanedIndicators.length > 0 && (
              <div data-testid="orphaned-indicators-section" className="border-t-2 border-amber-200">
                <div className="p-3 bg-amber-50/80 border-b border-amber-200 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-amber-900 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    <span>문서에서 사라진 지표 — 이력 보존</span>
                  </h3>
                  <span className="text-xs text-amber-800 font-semibold bg-amber-100 px-1.5 py-0.5 rounded">
                    {orphanedIndicators.length}개
                  </span>
                </div>
                <nav aria-label="문서에서 사라진 지표 목록" className="divide-y divide-amber-100 bg-amber-50/20">
                  {orphanedIndicators.map((item) => {
                    const isSelected = item.indicator.id === selectedIndicatorId;
                    const badge = getVerdictBadgeClass(item.suggestion?.verdict_status);

                    return (
                      <button
                        key={item.indicator.id}
                        data-testid={`indicator-item-${item.indicator.id}`}
                        onClick={() => {
                          handleSelectIndicator(item.indicator.id);
                        }}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`w-full text-left p-4 transition flex flex-col gap-2 hover:bg-amber-50/60 ${
                          isSelected
                            ? 'bg-amber-100/60 border-l-4 border-l-amber-600'
                            : 'border-l-4 border-l-transparent'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-gray-600 bg-gray-200 px-2 py-0.5 rounded">
                              {item.indicator.level}
                            </span>
                            <span className="text-xs text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
                              문서에서 사라짐
                            </span>
                          </div>
                          <span
                            data-testid={`badge-${item.indicator.id}`}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge.container}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                            <span>{badge.label}</span>
                          </span>
                        </div>

                        <div className="text-sm font-semibold text-gray-900 truncate">
                          {item.indicator.name}
                        </div>

                        {item.indicator.target_value && (
                          <div className="text-xs text-gray-500 truncate">
                            목표: {item.indicator.target_value}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </nav>
              </div>
            )}
          </aside>

          {/* 오른쪽 칸: 선택 지표 상세 검토 */}
          <section className="md:col-span-7 lg:col-span-8 bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-6">
            {visibleIndicators.length === 0 && (!selectedItem || selectedItem.indicator.is_orphaned !== 1) ? (
              <div
                data-testid="stage-empty-detail"
                className="text-center py-16 text-gray-500 space-y-2"
              >
                <p className="text-sm font-semibold text-gray-700">
                  {activeStage} 단계에 등록된 지표가 없습니다.
                </p>
                <p className="text-xs text-gray-500">
                  위 단계 탭에서 다른 단계를 선택하여 지표를 검토해 주십시오.
                </p>
              </div>
            ) : !selectedItem ? (
              <div className="text-center py-12 text-gray-500">
                선택된 지표가 없습니다. 왼쪽 목록에서 지표를 선택해 주십시오.
              </div>
            ) : (
              <>
                {/* 지표 머리 정보 */}
                {selectedItem.indicator.is_orphaned === 1 && (
                  <div
                    data-testid="orphaned-indicator-notice"
                    className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2 text-sm text-amber-900 font-medium"
                  >
                    <span className="text-amber-600 font-bold">!</span>
                    <span className="font-bold">문서에서 사라진 지표 — 이력 보존</span>
                    <span className="text-xs text-amber-700">
                      (성과관리표에서 삭제된 지표입니다. 기존 판정 제안 및 확정 이력은 보존됩니다.)
                    </span>
                  </div>
                )}
                <div className="border-b border-gray-200 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                        {isKnownLevel(selectedItem.indicator.level)
                          ? selectedItem.indicator.level
                          : `분류되지 않은 지표 (${selectedItem.indicator.level})`}
                      </span>
                      {selectedItem.indicator.is_orphaned === 1 && (
                        <span
                          data-testid="orphaned-badge"
                          className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300"
                        >
                          문서에서 사라진 지표 — 이력 보존
                        </span>
                      )}
                      <h2
                        data-testid="selected-indicator-name"
                        className="text-lg font-bold text-gray-900"
                      >
                        {selectedItem.indicator.name}
                      </h2>

                      {/* 기준 지표 표시 (RQ-08, D32) */}
                      {selectedItem.baselines && selectedItem.baselines.length > 0 ? (
                        <span
                          data-testid="baseline-header-label"
                          className="inline-flex items-center text-xs font-bold text-blue-700 bg-blue-100 px-2.5 py-0.5 rounded-full"
                        >
                          기준: {selectedItem.baselines.map((b) => b.document_name).join(', ')}
                        </span>
                      ) : selectedItem.baseline ? (
                        <span
                          data-testid="baseline-header-label"
                          className="inline-flex items-center text-xs font-bold text-blue-700 bg-blue-100 px-2.5 py-0.5 rounded-full"
                        >
                          기준: {selectedItem.baseline.document_name}
                        </span>
                      ) : (selectedItem.conflicts && selectedItem.conflicts.length > 0) || selectedItem.conflict ? (
                        <span
                          data-testid="baseline-unselected-badge"
                          className="inline-flex items-center text-xs font-bold text-amber-800 bg-amber-100 px-2.5 py-0.5 rounded-full"
                        >
                          기준 미선택
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-gray-500 space-y-0.5">
                      {selectedItem.indicator.ovi && <div>지표(OVI): {selectedItem.indicator.ovi}</div>}
                      {selectedItem.indicator.target_value && (
                        <div>목표값: {selectedItem.indicator.target_value}</div>
                      )}
                    </div>
                  </div>

                  {/* D30: 다시 제안 받기 버튼 (서버 액션). 손님은 비활성화(#53 후속 fix-r1). */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="resuggest-button"
                      onClick={() => handleResuggest(selectedItem.indicator.id)}
                      disabled={isPending || isGuest || !canConfirm}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 text-xs font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      {isPending ? (
                        <>
                          <span className="w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
                          <span>제안 받는 중...</span>
                        </>
                      ) : (
                        <span>다시 제안 받기</span>
                      )}
                    </button>
                    {isGuest && (
                      <span
                        data-testid="guest-resuggest-blocked-notice"
                        className="text-xs text-gray-500"
                      >
                        로그인 뒤 쓸 수 있습니다
                      </span>
                    )}
                  </div>
                </div>

                {/* D32: 충돌이 있으나 기준을 고르지 않은 경우 안내 및 S3 링크 */}
                {(((selectedItem.conflicts && selectedItem.conflicts.length > 0) || selectedItem.conflict) &&
                  (!selectedItem.baselines || selectedItem.baselines.length === 0) &&
                  !selectedItem.baseline) && (
                  <div
                    data-testid="unselected-baseline-notice"
                    className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm">⚠</span>
                      <span className="font-semibold">
                        지표 충돌이 있습니다. 초기 ToC에서 기준 지표를 먼저 선택하세요.
                      </span>
                    </div>
                    <Link
                      href={`/projects/${data.project.id}/toc`}
                      data-testid="link-to-s3-from-notice"
                      className="inline-flex items-center gap-1 font-bold text-amber-800 hover:text-amber-950 underline shrink-0"
                    >
                      초기 ToC(S3)로 이동 &rarr;
                    </Link>
                  </div>
                )}

                {/* 진행 중 표시 (입력 및 선택은 유지됨) */}
                {isPending && (
                  <div
                    data-testid="pending-indicator"
                    className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs font-medium text-blue-800 flex items-center gap-2"
                  >
                    <span className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span>AI 제안을 새로 받는 중입니다... (입력 상태는 유지됩니다)</span>
                  </div>
                )}

                {/* 상태: 빈 상태 (제안 없음) */}
                {!selectedItem.suggestion ? (
                  <div
                    data-testid="empty-suggestion-box"
                    className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300 space-y-3"
                  >
                    <p className="text-sm font-medium text-gray-600">
                      이 지표에 대한 생성된 AI 제안이 아직 없습니다.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button
                        type="button"
                        data-testid="get-suggestion-button"
                        onClick={() => handleResuggest(selectedItem.indicator.id)}
                        disabled={isPending || isGuest}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        제안 받기
                      </button>
                      {isGuest && (
                        <span
                          data-testid="guest-get-suggestion-blocked-notice"
                          className="text-xs text-gray-500"
                        >
                          로그인 뒤 쓸 수 있습니다
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {/* 제안 판정 배지 (D28) 및 제안 시각 */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-gray-700">제안 판정:</span>
                        {(() => {
                          const badge = getVerdictBadgeClass(selectedItem.suggestion.verdict_status);
                          return (
                            <span
                              data-testid="selected-verdict-badge"
                              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold border ${badge.container}`}
                            >
                              <span className={`w-2 h-2 rounded-full ${badge.dot}`} />
                              <span>{badge.label}</span>
                            </span>
                          );
                        })()}
                      </div>
                      {selectedItem.suggestion.created_at && (
                        <div
                          data-testid="suggestion-created-at"
                          className="text-xs text-gray-500 font-mono"
                        >
                          제안 시각: {selectedItem.suggestion.created_at}
                        </div>
                      )}
                    </div>

                    {/* 제안 문장 */}
                    {selectedItem.suggestion.proposal_text && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                          제안 문장
                        </div>
                        <div
                          data-testid="proposal-text"
                          className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-gray-900 leading-relaxed font-normal"
                        >
                          &ldquo;{selectedItem.suggestion.proposal_text}&rdquo;
                        </div>
                      </div>
                    )}

                    {/* 미확인 사유 또는 오류 사유 */}
                    {selectedItem.suggestion.verdict_status === '미확인' && (
                      <div className="space-y-1.5">
                        {selectedItem.suggestion.error_reason ? (
                          <div
                            data-testid="error-reason-box"
                            className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 space-y-2"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="font-semibold flex items-center gap-1.5 text-red-800 truncate">
                                <span>⚠</span>
                                <span data-testid="error-reason-summary">
                                  오류: AI 출력 형식 오류가 발생했습니다.
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  data-testid="retry-suggestion-button"
                                  onClick={() => handleResuggest(selectedItem.indicator.id)}
                                  disabled={isPending || isGuest}
                                  className="shrink-0 px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-900 rounded font-semibold text-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  다시 시도
                                </button>
                                {isGuest && (
                                  <span
                                    data-testid="guest-retry-suggestion-blocked-notice"
                                    className="text-xs text-gray-500"
                                  >
                                    로그인 뒤 쓸 수 있습니다
                                  </span>
                                )}
                              </div>
                            </div>
                            <details
                              data-testid="error-reason-details"
                              className="text-xs text-red-700"
                            >
                              <summary className="cursor-pointer font-medium text-red-800 hover:underline select-none">
                                상세 오류 접기/펼치기
                              </summary>
                              <div
                                data-testid="error-reason-text"
                                className="font-mono text-xs text-red-700 whitespace-pre-wrap bg-red-100/60 p-2.5 rounded mt-1.5 overflow-x-auto"
                              >
                                {selectedItem.suggestion.error_reason}
                              </div>
                            </details>
                          </div>
                        ) : (
                          <div
                            data-testid="unconfirmed-reason-box"
                            className="p-4 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-800"
                          >
                            <span className="font-bold text-gray-700">사유:</span> 포함 문서에서
                            근거를 찾지 못함
                          </div>
                        )}
                      </div>
                    )}

                    {/* 근거 카드 목록 (RQ-10: 인용, 문서 이름, 위치, 말한 사람) */}
                    <div className="space-y-3 pt-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-gray-900">
                          근거 카드 ({selectedItem.suggestion.evidences.length}건)
                        </h3>
                      </div>

                      {selectedItem.suggestion.evidences.length === 0 ? (
                        <p className="text-xs text-gray-500 italic py-2">
                          {selectedItem.suggestion.verdict_status === '미확인'
                            ? '포함 문서에서 확인된 근거가 없습니다.'
                            : '등록된 근거가 없습니다.'}
                        </p>
                      ) : (
                        <div
                          data-testid={
                            selectedItem.suggestion.verdict_status === '근거 충돌'
                              ? 'conflict-evidences-grid'
                              : undefined
                          }
                          className={
                            selectedItem.suggestion.verdict_status === '근거 충돌'
                              ? 'grid grid-cols-1 md:grid-cols-2 gap-4'
                              : 'space-y-4'
                          }
                        >
                          {selectedItem.suggestion.evidences.map((ev: ReviewEvidence, idx: number) => {
                            const isPanelOpen = !!openParagraphPanels[ev.id];
                            const isUnconfirmed =
                              selectedItem.suggestion?.verdict_status === '미확인';
                            const isConflict =
                              selectedItem.suggestion?.verdict_status === '근거 충돌';
                            const isBanned = ev.is_citation_banned !== 0;

                            if (isBanned) {
                              return (
                                <article
                                  key={ev.id}
                                  data-testid={`evidence-card-${idx}`}
                                  className="p-4 bg-amber-50/70 border border-amber-200 rounded-xl shadow-xs space-y-2.5"
                                >
                                  {isConflict && (
                                    <div className="text-xs font-bold text-amber-900 border-b border-amber-200 pb-1">
                                      근거 {String.fromCharCode(65 + idx)}
                                    </div>
                                  )}
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5 text-amber-900 font-bold text-xs">
                                      <span className="text-sm select-none">⚠</span>
                                      <span data-testid={`citation-banned-notice-${idx}`}>
                                        인용 금지 문장 있음 — {ev.document_name} · {ev.location}
                                      </span>
                                    </div>
                                    <button
                                      type="button"
                                      data-testid={`toggle-source-button-${idx}`}
                                      onClick={() => toggleParagraphPanel(ev.id)}
                                      className="text-xs text-amber-800 hover:text-amber-950 font-semibold underline shrink-0"
                                    >
                                      <span>
                                        [원문 위치 {isPanelOpen ? '닫기' : '열기'}]
                                      </span>
                                    </button>
                                  </div>
                                  <p className="text-[11px] text-amber-700 leading-normal">
                                    정보 제공자 보호를 위해 인용 문장을 표시하지 않으며, 보고서에도 인용되지 않습니다.
                                  </p>

                                  {/* [원문 위치 열기] 패널 */}
                                  {isPanelOpen && (
                                    <div
                                      data-testid={`source-context-panel-${idx}`}
                                      className="mt-3 p-3 bg-white border border-amber-200 rounded-lg space-y-3 text-xs text-gray-800"
                                    >
                                      <div className="font-bold text-gray-700 flex items-center justify-between border-b border-gray-100 pb-1.5">
                                        <span>원문 위치 문맥 (해당 문단 및 앞뒤 문단)</span>
                                        <span className="text-gray-400 font-normal">
                                          문서: {ev.document_name}
                                        </span>
                                      </div>

                                      {!ev.paragraph_context ||
                                      ev.paragraph_context.surroundings.length === 0 ? (
                                        <p className="text-gray-500 italic">
                                          추출된 원문 문단을 찾을 수 없습니다.
                                        </p>
                                      ) : (
                                        <div className="space-y-2">
                                          {ev.paragraph_context.surroundings.map((p) => {
                                            const isTarget =
                                              p.location === ev.location ||
                                              p.sequence_no ===
                                                ev.paragraph_context?.target.sequence_no;
                                            const isPrev =
                                              ev.paragraph_context?.previous &&
                                              p.sequence_no ===
                                                ev.paragraph_context.previous.sequence_no;
                                            const isNext =
                                              ev.paragraph_context?.next &&
                                              p.sequence_no ===
                                                ev.paragraph_context.next.sequence_no;

                                            const testId = isTarget
                                              ? `target-paragraph-${idx}`
                                              : isPrev
                                              ? `prev-paragraph-${idx}`
                                              : isNext
                                              ? `next-paragraph-${idx}`
                                              : undefined;

                                            return (
                                              <div
                                                key={p.id}
                                                data-testid={testId}
                                                className={`p-2.5 rounded transition ${
                                                  isTarget
                                                    ? 'bg-amber-50/80 border-l-4 border-amber-600 shadow-xs'
                                                    : 'bg-white border border-gray-100 text-gray-600'
                                                }`}
                                              >
                                                <div className="text-[11px] font-semibold text-gray-400 mb-1">
                                                  {p.location}{' '}
                                                  {isTarget && (
                                                    <span className="ml-1 text-amber-700 font-bold">
                                                      (해당 위치)
                                                    </span>
                                                  )}
                                                  {isPrev && (
                                                    <span className="ml-1 text-gray-500 font-medium">
                                                      (이전 문단)
                                                    </span>
                                                  )}
                                                  {isNext && (
                                                    <span className="ml-1 text-gray-500 font-medium">
                                                      (다음 문단)
                                                    </span>
                                                  )}
                                                </div>
                                                <p className="text-xs text-gray-900 leading-relaxed whitespace-pre-wrap">
                                                  {p.content}
                                                </p>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </article>
                              );
                            }

                            return (
                              <article
                                key={ev.id}
                                id={`evidence-${ev.id}`}
                                data-testid={`evidence-card-${idx}`}
                                className="p-4 bg-white border border-gray-200 rounded-xl shadow-sm space-y-3"
                              >
                                {isConflict && (
                                  <div className="text-xs font-bold text-gray-700 border-b border-gray-100 pb-1">
                                    근거 {String.fromCharCode(65 + idx)}
                                  </div>
                                )}
                                {/* '미확인'인데 근거가 있으면 표시: '판정 근거 아님 · 참고' */}
                                {isUnconfirmed && (
                                  <div>
                                    <span
                                      data-testid="unconfirmed-reference-tag"
                                      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300"
                                    >
                                      판정 근거 아님 · 참고
                                    </span>
                                  </div>
                                )}

                                {/* 1. 인용 (Quote) */}
                                <div className="text-sm font-medium text-gray-900 leading-relaxed border-l-2 border-blue-500 pl-3">
                                  <span className="text-xs text-gray-400 block mb-0.5">인용</span>
                                  <blockquote data-testid={`evidence-quote-${idx}`}>
                                    &ldquo;{ev.quote}&rdquo;
                                  </blockquote>
                                </div>

                                {/* 2, 3, 4: 문서 이름, 위치, 말한 사람 */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-gray-600 bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                                  <div>
                                    <span className="font-semibold text-gray-500">문서:</span>{' '}
                                    <span
                                      data-testid={`evidence-doc-${idx}`}
                                      className="font-medium text-gray-900"
                                    >
                                      {ev.document_name}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="font-semibold text-gray-500">위치:</span>{' '}
                                    <span
                                      data-testid={`evidence-loc-${idx}`}
                                      className="font-medium text-gray-900"
                                    >
                                      {ev.location}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="font-semibold text-gray-500">
                                      말한 사람:
                                    </span>{' '}
                                    <span
                                      data-testid={`evidence-speaker-${idx}`}
                                      className="font-medium text-gray-900"
                                    >
                                      {guestSpeakerLabel(ev.speaker, isGuest)}
                                    </span>
                                  </div>
                                </div>

                                {/* [원문 위치 열기] 버튼 */}
                                <div>
                                  <button
                                    type="button"
                                    data-testid={`toggle-source-button-${idx}`}
                                    onClick={() => toggleParagraphPanel(ev.id)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold inline-flex items-center gap-1 transition"
                                  >
                                    <span>
                                      [원문 위치 {isPanelOpen ? '닫기' : '열기'}]
                                    </span>
                                  </button>
                                </div>

                                {/* [원문 위치 열기] 패널: 해당 문단과 앞뒤 문단 (추출 문단 그대로) */}
                                {isPanelOpen && (
                                  <div
                                    data-testid={`source-context-panel-${idx}`}
                                    className="mt-3 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3 text-xs text-gray-800"
                                  >
                                    <div className="font-bold text-gray-700 flex items-center justify-between border-b border-slate-200 pb-1.5">
                                      <span>원문 위치 문맥 (해당 문단 및 앞뒤 문단)</span>
                                      <span className="text-gray-400 font-normal">
                                        문서: {ev.document_name}
                                      </span>
                                    </div>

                                    {!ev.paragraph_context ||
                                    ev.paragraph_context.surroundings.length === 0 ? (
                                      <p className="text-gray-500 italic">
                                        추출된 원문 문단을 찾을 수 없습니다.
                                      </p>
                                    ) : (
                                      <div className="space-y-2">
                                        {ev.paragraph_context.surroundings.map((p) => {
                                          const isTarget =
                                            p.location === ev.location ||
                                            p.sequence_no ===
                                              ev.paragraph_context?.target.sequence_no;
                                          const isPrev =
                                            ev.paragraph_context?.previous &&
                                            p.sequence_no ===
                                              ev.paragraph_context.previous.sequence_no;
                                          const isNext =
                                            ev.paragraph_context?.next &&
                                            p.sequence_no ===
                                              ev.paragraph_context.next.sequence_no;

                                          const testId = isTarget
                                            ? `target-paragraph-${idx}`
                                            : isPrev
                                            ? `prev-paragraph-${idx}`
                                            : isNext
                                            ? `next-paragraph-${idx}`
                                            : undefined;

                                          return (
                                            <div
                                              key={p.id}
                                              data-testid={testId}
                                              className={`p-2.5 rounded transition ${
                                                isTarget
                                                  ? 'bg-blue-50/80 border-l-4 border-blue-600 shadow-xs'
                                                  : 'bg-white border border-gray-100 text-gray-600'
                                              }`}
                                            >
                                              <div className="text-[11px] font-semibold text-gray-400 mb-1">
                                                {p.location}{' '}
                                                {isTarget && (
                                                  <span className="ml-1 text-blue-600 font-bold">
                                                    (해당 위치)
                                                  </span>
                                                )}
                                                {isPrev && (
                                                  <span className="ml-1 text-gray-500 font-medium">
                                                    (이전 문단)
                                                  </span>
                                                )}
                                                {isNext && (
                                                  <span className="ml-1 text-gray-500 font-medium">
                                                    (다음 문단)
                                                  </span>
                                                )}
                                              </div>
                                              <p className="text-xs text-gray-900 leading-relaxed whitespace-pre-wrap">
                                                {p.content}
                                              </p>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* ---------------- KSP 기여 귀속 (평가자 판단) (RQ-16, SP §s4) ---------------- */}
                    <div
                      data-testid="attribution-section"
                      className="pt-6 border-t border-gray-200 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="attribution-input"
                          className="text-sm font-bold text-gray-900"
                        >
                          {attributionProgram} 기여 귀속 (평가자 판단)
                        </label>
                        {selectedItem.attribution && (
                          <span
                            data-testid="attribution-status-badge"
                            className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded font-medium"
                          >
                            저장된 기여 귀속 있음
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500">
                        본 지표의 성과 실현 및 변화에 {isGuest ? '이 사업이' : 'KSP 사업이'} 미친 기여 또는 제약요인에 대한 평가자 판단을 기재합니다 (AI 제안 직후 비어 있음).
                      </p>
                      <textarea
                        id="attribution-input"
                        data-testid="contribution-attribution-input"
                        rows={3}
                        value={attributions[selectedItem.indicator.id] ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAttributions((prev) => ({
                            ...prev,
                            [selectedItem.indicator.id]: val,
                          }));
                          setAttributionSaveMessage(null);
                        }}
                        placeholder={`이 지표에 대한 ${attributionProgram} 기여 귀속 판단을 입력하십시오 (AI 제안 직후 비어 있음).`}
                        className="w-full text-xs p-2.5 rounded-lg border border-gray-300 bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                      />
                      {attributionSaveMessage && (
                        <div
                          role="status"
                          data-testid="attribution-saved-message"
                          className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-800"
                        >
                          {attributionSaveMessage}
                        </div>
                      )}
                      <div className="flex justify-end">
                        <button
                          type="button"
                          data-testid="save-attribution-button"
                          onClick={() => handleSaveAttribution(selectedItem.indicator.id)}
                          disabled={isPending || !canConfirm}
                          className="px-3.5 py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold shadow-xs transition disabled:opacity-50"
                        >
                          {isPending ? '저장 중...' : '기여 귀속 저장'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ---------------- S4 확정 영역 (FE-10, RQ-17, RQ-18, UC-05, UC-16, D13, D16, D44) ---------------- */}
                <div
                  data-testid="confirmation-section"
                  className="pt-6 border-t border-gray-200 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <h3 className="text-sm font-bold text-gray-900">평가자 판단 확정</h3>
                    {selectedItem.latestConfirmation && (
                      <div
                        data-testid="latest-confirmation-summary"
                        className="text-xs text-gray-600 bg-gray-50 px-2.5 py-1 rounded-md border border-gray-200 flex items-center gap-1.5"
                      >
                        <span className="font-semibold text-gray-500">현재 확정 상태:</span>
                        <span className="font-bold text-blue-700">
                          {selectedItem.latestConfirmation.confirmation_type}
                        </span>
                        <span className="text-gray-400">·</span>
                        <span>확정자: {selectedItem.latestConfirmation.confirmer_name}</span>
                      </div>
                    )}
                  </div>

                  {/* 결정 (b): AI 제안이 하나도 없는 지표는 확정할 수 없다 (사유 표시) */}
                  {!hasSuggestion && (
                    <div
                      role="status"
                      data-testid="no-suggestion-reason"
                      className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs font-semibold text-amber-800 flex items-center gap-2"
                    >
                      <span className="text-base select-none">⚠</span>
                      <span>AI 제안이 없는 지표는 확정할 수 없습니다. 먼저 [제안 받기]를 진행해 주십시오.</span>
                    </div>
                  )}

                  {/* 확정자 이름 미입력 오류 안내 */}
                  {confirmerError && (
                    <div
                      role="alert"
                      data-testid="confirmer-name-error"
                      className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs font-semibold text-red-800"
                    >
                      {confirmerError}
                    </div>
                  )}

                  {/* 확정 액션 성공 알림 */}
                  {confirmSuccessMsg && (
                    <div
                      role="status"
                      data-testid="confirm-success-message"
                      className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-800"
                    >
                      {confirmSuccessMsg}
                    </div>
                  )}

                  {/* 확정 버튼 4개 묶음 (role="group", aria-label="확정") */}
                  <div
                    role="group"
                    aria-label="확정"
                    className="flex flex-wrap items-center gap-2.5"
                  >
                    <button
                      type="button"
                      data-testid="confirm-btn-확정"
                      onClick={() => handleConfirmDirect('확정')}
                      disabled={!hasSuggestion || isPending || !canConfirm}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      확정
                    </button>
                    <button
                      type="button"
                      data-testid="confirm-btn-수정후확정"
                      onClick={handleOpenEditConfirm}
                      disabled={!hasSuggestion || isPending || !canConfirm}
                      className={`px-4 py-2 rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed ${
                        isEditFormOpen
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border border-blue-600 text-blue-700 hover:bg-blue-50'
                      }`}
                    >
                      수정 후 확정
                    </button>
                    <button
                      type="button"
                      data-testid="confirm-btn-보완필요"
                      onClick={() => handleConfirmDirect('보완 필요')}
                      disabled={!hasSuggestion || isPending || !canConfirm}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      보완 필요
                    </button>
                    <button
                      type="button"
                      data-testid="confirm-btn-채택제외"
                      onClick={() => handleConfirmDirect('채택 제외')}
                      disabled={!hasSuggestion || isPending || !canConfirm}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      채택 제외
                    </button>
                  </div>

                  {/* 수정 후 확정 입력 패널 (UC-16: 수정본이나 사유가 비면 저장 거부, 빈 칸 표시) */}
                  {isEditFormOpen && hasSuggestion && (
                        <div
                          data-testid="edit-confirm-panel"
                          className="mt-3 p-4 bg-blue-50/50 border border-blue-200 rounded-xl space-y-3"
                        >
                          <div className="text-xs font-bold text-blue-900">
                            수정 후 확정 내용 입력
                          </div>

                          {editValidationError && (
                            <div
                              role="alert"
                              data-testid="edit-validation-error"
                              className="p-2.5 bg-red-100 border border-red-300 rounded-lg text-xs font-bold text-red-900"
                            >
                              {editValidationError}
                            </div>
                          )}

                          <div>
                            <label
                              htmlFor="edited-verdict-status"
                              className="block text-xs font-semibold text-gray-700 mb-1"
                            >
                              판정 상태 <span className="text-red-500">*</span>
                            </label>
                            <select
                              id="edited-verdict-status"
                              data-testid="edited-verdict-status-select"
                              value={
                                activeDraft.editedVerdictStatus ??
                                selectedItem?.suggestion?.verdict_status ??
                                '미확인'
                              }
                              onChange={(e) => {
                                const val = e.target.value as VerdictStatus;
                                setConfirmationDrafts((prev) => ({
                                  ...prev,
                                  [selectedIndicatorId]: {
                                    editedText: prev[selectedIndicatorId]?.editedText ?? '',
                                    reason: prev[selectedIndicatorId]?.reason ?? '',
                                    isEditFormOpen: true,
                                    editedVerdictStatus: val,
                                  },
                                }));
                                setEditValidationError(null);
                              }}
                              className="w-full text-xs p-2 rounded-lg border border-gray-300 bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                            >
                              {VERDICT_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                  {status}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label
                              htmlFor="edited-text"
                              className="block text-xs font-semibold text-gray-700 mb-1"
                            >
                              수정본 <span className="text-red-500">*</span>
                            </label>
                            <textarea
                              id="edited-text"
                              data-testid="edited-text-input"
                              rows={3}
                              value={editedText}
                              onChange={(e) => {
                                const val = e.target.value;
                                setConfirmationDrafts((prev) => ({
                                  ...prev,
                                  [selectedIndicatorId]: {
                                    editedText: val,
                                    reason: prev[selectedIndicatorId]?.reason ?? '',
                                    isEditFormOpen: true,
                                    editedVerdictStatus: prev[selectedIndicatorId]?.editedVerdictStatus,
                                  },
                                }));
                                setEditValidationError(null);
                              }}
                              placeholder="수정본 제안 문장을 입력해 주십시오."
                              aria-invalid={editValidationError && !editedText.trim() ? 'true' : undefined}
                              className={`w-full text-xs p-2.5 rounded-lg border bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${
                                editValidationError && !editedText.trim()
                                  ? 'border-red-500 ring-1 ring-red-500'
                                  : 'border-gray-300'
                              }`}
                            />
                          </div>

                          <div>
                            <label
                              htmlFor="edit-reason"
                              className="block text-xs font-semibold text-gray-700 mb-1"
                            >
                              수정 사유 <span className="text-red-500">*</span>
                            </label>
                            <textarea
                              id="edit-reason"
                              data-testid="reason-input"
                              rows={2}
                              value={editReason}
                              onChange={(e) => {
                                const val = e.target.value;
                                setConfirmationDrafts((prev) => ({
                                  ...prev,
                                  [selectedIndicatorId]: {
                                    editedText: prev[selectedIndicatorId]?.editedText ?? '',
                                    reason: val,
                                    isEditFormOpen: true,
                                    editedVerdictStatus: prev[selectedIndicatorId]?.editedVerdictStatus,
                                  },
                                }));
                                setEditValidationError(null);
                              }}
                              placeholder="수정 사유를 입력해 주십시오."
                              aria-invalid={editValidationError && !editReason.trim() ? 'true' : undefined}
                              className={`w-full text-xs p-2.5 rounded-lg border bg-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${
                                editValidationError && !editReason.trim()
                                  ? 'border-red-500 ring-1 ring-red-500'
                                  : 'border-gray-300'
                              }`}
                            />
                          </div>

                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              data-testid="cancel-edit-confirm-button"
                              onClick={() => {
                                setConfirmationDrafts((prev) => ({
                                  ...prev,
                                  [selectedIndicatorId]: {
                                    editedText: prev[selectedIndicatorId]?.editedText ?? '',
                                    reason: prev[selectedIndicatorId]?.reason ?? '',
                                    isEditFormOpen: false,
                                    editedVerdictStatus: prev[selectedIndicatorId]?.editedVerdictStatus,
                                  },
                                }));
                                setEditValidationError(null);
                              }}
                              className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700 hover:bg-gray-100 transition"
                            >
                              취소
                            </button>
                            <button
                              type="button"
                              data-testid="save-edit-confirm-button"
                              onClick={handleSaveEditConfirm}
                              disabled={isPending}
                              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-xs transition disabled:opacity-50"
                            >
                              {isPending ? '저장 중...' : '저장'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
              </>
            )}
          </section>
        </main>
        <WorkflowNextAction
          projectId={data.project.id}
          screen="review"
          reviewStage={noteReviewStage}
          onReviewStageChange={setNoteReviewStage}
        />
      </div>
    </div>
  );
}
