'use client';

import React, { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { FailureMessage } from '../failure-message';
import { ProjectTabs } from '../project-tabs';
import { WorkflowNextAction } from '@/app/workflow-next-action';
import {
  type IndicatorBaselineRecord,
  type IndicatorConflictRecord,
  type TocItem,
  type TocPageData,
  type OutcomeFinalResultsData,
} from '@/server/store/types';
import { selectBaselineAction } from './actions';
import {
  getBaselineKey,
  getBaselineForConflict,
  syncSelectedDocsFromToc,
} from '@/lib/baseline-key';
import type { NoteStatusItem } from '@/lib/note-visibility';
import type { OntologyProjectGraph } from '@/server/ontology/store';
import { InitialTocSection } from './initial-toc-section';
import { initialTocColumnForNode } from '@/lib/ontology-toc';

interface TocClientViewProps {
  initialData: TocPageData;
  initialGraph: OntologyProjectGraph;
  reviewNodeIds: string[];
  noteItems?: NoteStatusItem[];
  projectId: string;
  initialGraphView?: boolean;
  outcomeFinalResults?: OutcomeFinalResultsData | null;
}

export function TocClientView({ initialData, initialGraph, reviewNodeIds, projectId, initialGraphView = false, outcomeFinalResults, noteItems = [] }: TocClientViewProps) {
  const [data, setData] = useState<TocPageData>(initialData);
  const [isPending, startTransition] = useTransition();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<{
    message: string;
    indicatorId: string;
    documentId: string;
    conflictId: string;
  } | null>(null);

  // S3 라디오 선택 상태를 conflict.id 가 아니라 기준 식별자(지표 정규화 이름, 두 문서 id)로 저장하고,
  // 서버가 돌려준 기준 목록으로 매번 다시 맞춘다 (#19 검수 4회차 2번)
  const [selectedDocs, setSelectedDocs] = useState<Record<string, string>>(() =>
    syncSelectedDocsFromToc(initialData)
  );

  useEffect(() => {
    setData(initialData);
    setSelectedDocs((prev) => syncSelectedDocsFromToc(initialData, prev));
  }, [initialData]);

  const handleSelectDoc = (baselineKey: string, docId: string) => {
    setSelectedDocs((prev) => ({
      ...prev,
      [baselineKey]: docId,
    }));
  };

  const runSaveBaseline = (
    indicatorId: string,
    documentId: string,
    conflictId: string
  ) => {
    setSaveFailure(null);
    startTransition(async () => {
      setSaveMessage(null);
      try {
        const res = await selectBaselineAction(data.project.id, indicatorId, documentId, conflictId);
        if (res.success && res.data) {
          setData(res.data);
          // 서버가 돌려준 기준 목록으로 매번 다시 맞춘다 (#19 검수 4회차 2번)
          setSelectedDocs((prev) => syncSelectedDocsFromToc(res.data!, prev));

          const updatedItem = res.data.items.find((i) => i.indicator.id === indicatorId);
          const conflicts =
            updatedItem?.conflicts && updatedItem.conflicts.length > 0
              ? updatedItem.conflicts
              : updatedItem?.conflict
                ? [updatedItem.conflict]
                : [];
          const conf = conflicts.find((c) => c.id === conflictId) || conflicts[0];
          const b = conf
            ? getBaselineForConflict(conf, updatedItem?.baselines, updatedItem?.baseline)
            : updatedItem?.baseline;
          if (b) {
            setSaveMessage(`기준 지표가 저장되었습니다: 기준: ${b.document_name}`);
          }
        } else {
          setSaveFailure({
            message: res.error ?? '기준 지표 저장에 실패했습니다.',
            indicatorId,
            documentId,
            conflictId,
          });
        }
      } catch (err) {
        setSaveFailure({
          message: err instanceof Error ? err.message : String(err),
          indicatorId,
          documentId,
          conflictId,
        });
      }
    });
  };

  const handleSaveBaseline = (indicatorId: string, conflict: IndicatorConflictRecord) => {
    const item = data.items.find((i) => i.indicator.id === indicatorId);
    const baselineKey = getBaselineKey(
      item?.indicator.name,
      conflict.doc_a_id,
      conflict.doc_b_id
    );
    const confBaseline = getBaselineForConflict(conflict, item?.baselines, item?.baseline);
    const docId =
      selectedDocs[baselineKey] ??
      (confBaseline ? confBaseline.document_id : conflict.doc_a_id);
    if (!docId) return;

    runSaveBaseline(indicatorId, docId, conflict.id);
  };

  const project = data.project;
  const activeItems = data.items.filter((item) => !item.indicator.is_orphaned);
  const orphanedItems = data.items.filter((item) => item.indicator.is_orphaned === 1);
  const pdmFallbackNodes = activeItems.map(({ indicator, planDetails }) => ({
    id: indicator.id,
    type: 'indicator',
    title: indicator.name,
    description: '',
    pdmStage: indicator.level,
    planDetails: [
      ...(planDetails ?? []),
      ...(indicator.ovi ? [{ label: 'OVI', value: indicator.ovi }] : []),
      ...(indicator.mov ? [{ label: 'MoV', value: indicator.mov }] : []),
      ...(indicator.target_value ? [{ label: '목표값', value: indicator.target_value }] : []),
    ],
  }));

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* 1. 상단 머리 영역 (SP §S3) */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
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
                  ② 초기 ToC
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">초기 ToC</h1>
            </div>
            <div className="text-sm text-gray-600 font-medium">
              사업: <span className="text-gray-900">{project.name}</span>
            </div>
          </div>

          <ProjectTabs projectId={project.id} activeScreen={initialGraphView ? 'ontology' : 'toc'} />
        </div>
      </header>

      {/* 2. 본문 영역 */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full space-y-6">
        <InitialTocSection noteItems={noteItems} graph={initialGraph} fallbackNodes={pdmFallbackNodes} hasPdm={data.hasPdm} projectId={projectId} reviewNodeIds={reviewNodeIds} initialGraphView={initialGraphView} outcomeFinalResults={outcomeFinalResults} />
        {saveFailure && (
          <FailureMessage
            message={saveFailure.message}
            onRetry={() =>
              runSaveBaseline(
                saveFailure.indicatorId,
                saveFailure.documentId,
                saveFailure.conflictId
              )
            }
            isRetrying={isPending}
            testId="baseline-save-error"
          />
        )}
        {saveMessage && (
          <div
            data-testid="save-success-banner"
            className="p-4 bg-green-50 border border-green-200 text-green-800 rounded-xl text-sm font-semibold flex items-center justify-between"
          >
            <span>{saveMessage}</span>
            <button
              type="button"
              onClick={() => setSaveMessage(null)}
              className="text-green-600 hover:text-green-900 text-xs"
            >
              닫기
            </button>
          </div>
        )}

        {/* 표를 찾지 못했을 때 경고 (검수 2회차 1번) */}
        {data.warningMessage && (
          <div
            data-testid="pdm-no-table-warning"
            className="p-4 bg-amber-50 border border-amber-300 rounded-xl text-amber-900 text-sm font-semibold flex items-center gap-2"
          >
            <span className="text-lg">⚠</span>
            <span>{data.warningMessage}</span>
          </div>
        )}

        {/* 빈 상태 안내 (SP §S3 line 125, AC 4) */}
        {!data.hasPdm || activeItems.length === 0 ? (
          <div
            data-testid="empty-pdm-notice"
            className="bg-white border border-gray-200 rounded-xl p-12 text-center shadow-sm space-y-4"
          >
            <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-full flex items-center justify-center mx-auto text-xl font-bold">
              !
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-gray-900">
                {data.warningMessage ? data.warningMessage : '포함된 성과관리표가 없습니다'}
              </h2>
              <p className="text-sm text-gray-500">
                {data.warningMessage ?? '성과관리표가 없습니다. 자료 화면에서 등록해 주세요.'}
              </p>
            </div>
            <div>
              <Link
                href={`/projects/${project.id}/documents`}
                data-testid="link-to-s2"
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition"
              >
                <span>③ 자료 등록으로 이동</span>
                <span>&rarr;</span>
              </Link>
            </div>
          </div>
        ) : (
          /* 성과 경로 계층 트리 (SP §S3 line 111-122) */
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 sm:p-8 space-y-6">
            <div className="border-b border-gray-200 pb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <span>성과 경로 계층</span>
                  <span className="text-xs font-normal text-gray-500">
                    (영향 &rarr; 중/장기성과 &rarr; 단기성과 &rarr; 산출물 &rarr; 활동)
                  </span>
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  성과관리표에서 추출된 지표 체계입니다. 항목의 [출처 ▸]를 누르면 원문 문단으로 이동합니다.
                </p>
              </div>
            </div>

            {/* Tree Container */}
            <div
              role="tree"
              aria-label="성과 경로 계층 구조"
              className="space-y-4"
            >
              {activeItems.map((item, index) => {
                const indentStyles: Record<string, string> = {
                  '영향': 'pl-0',
                  '중/장기성과': 'pl-6 sm:pl-8 border-l-2 border-blue-100',
                  '단기성과': 'pl-12 sm:pl-16 border-l-2 border-blue-200',
                  '산출물': 'pl-18 sm:pl-24 border-l-2 border-indigo-200',
                  '활동': 'pl-24 sm:pl-32 border-l-2 border-indigo-300',
                };

                const displayLevel = initialTocColumnForNode({ type: 'indicator', pdmStage: item.indicator.level }) === 'outcome-mid' ? '중/장기성과' : item.indicator.level;
                const indentClass = indentStyles[displayLevel] || 'pl-0';
                const conflicts =
                  item.conflicts && item.conflicts.length > 0
                    ? item.conflicts
                    : item.conflict
                      ? [item.conflict]
                      : [];
                const baseline = item.baseline;
                const hasBaselines =
                  (item.baselines && item.baselines.length > 0) || Boolean(baseline);
                const needsBaselineReview = (item.baselines ?? (baseline ? [baseline] : [])).some((saved) =>
                  !saved.conflict_id || !conflicts.some((conflict) => conflict.id === saved.conflict_id)
                );

                const sourceHref = item.indicator.source_doc_id
                  ? `/projects/${project.id}/documents?docId=${item.indicator.source_doc_id}&location=${encodeURIComponent(
                      item.indicator.source_location || ''
                    )}`
                  : `/projects/${project.id}/documents`;

                return (
                  <div
                    key={item.indicator.id}
                    role="treeitem"
                    aria-selected="false"
                    aria-label={`${displayLevel}: ${item.indicator.name}`}
                    className={`space-y-3 ${indentClass}`}
                  >
                    <div className="p-4 bg-gray-50 hover:bg-gray-100/70 rounded-xl border border-gray-200/80 transition space-y-2">
                      {/* 항목 헤더 줄 */}
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          {index > 0 && <span className="text-gray-400 font-bold">└</span>}
                          <span className="px-2.5 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-800">
                            {displayLevel}
                          </span>
                          {item.is_unknown_level && (
                            <span
                              data-testid="unknown-level-warning"
                              className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300"
                            >
                              알 수 없는 단계
                            </span>
                          )}
                          <span
                            data-testid={`indicator-name-${item.indicator.id}`}
                            className="text-base font-bold text-gray-900"
                          >
                            {item.indicator.name}
                          </span>
                          {needsBaselineReview && (
                            <span data-testid={`baseline-review-needed-${item.indicator.id}`} className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                              다시 확인 필요
                            </span>
                          )}
                        </div>

                        {/* 출처 링크 (D07, RQ-07) */}
                        <div className="flex items-center gap-2">
                          <Link
                            href={sourceHref}
                            data-testid={`source-link-${item.indicator.id}`}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-white px-2.5 py-1 rounded border border-gray-200 shadow-2xs hover:border-blue-300 transition"
                          >
                            <span>출처 ▸</span>
                            {item.indicator.source_location && (
                              <span className="font-mono text-gray-500">
                                {item.indicator.source_location}
                              </span>
                            )}
                          </Link>
                        </div>
                      </div>

                      {/* 세부 항목 정보: OVI, MoV, 목표값, 기준값 */}
                      <div
                        className={`grid grid-cols-1 ${
                          hasBaselines ? 'sm:grid-cols-4' : 'sm:grid-cols-3'
                        } gap-2 text-xs text-gray-600 bg-white/70 p-2.5 rounded-lg border border-gray-100`}
                      >
                        <div>
                          <span className="font-semibold text-gray-500 mr-1.5">OVI:</span>
                          <span data-testid={`ovi-${item.indicator.id}`}>{item.indicator.ovi}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-gray-500 mr-1.5">MoV:</span>
                          <span>{item.indicator.mov || '-'}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-gray-500 mr-1.5">목표값:</span>
                          <span
                            data-testid={`target-value-${item.indicator.id}`}
                            className="font-medium text-gray-900"
                          >
                            {item.indicator.target_value || '-'}
                          </span>
                        </div>
                        {hasBaselines && (
                          <div data-testid={`baseline-slot-${item.indicator.id}`}>
                            <span className="font-semibold text-blue-700 mr-1.5">기준값:</span>
                            <span className="font-bold text-blue-900">
                              {item.baselines && item.baselines.length > 0
                                ? item.baselines
                                    .map((b) => `${b.target_value} (${b.document_name})`)
                                    .join(', ')
                                : `${baseline!.target_value} (${baseline!.document_name})`}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* 지표 충돌 경고 및 기준 지표 선택 (SP §S3 lines 116-118, RQ-08) */}
                      {conflicts.map((conflict, cIdx) => {
                        const baselineKey = getBaselineKey(
                          item.indicator.name,
                          conflict.doc_a_id,
                          conflict.doc_b_id
                        );
                        const confBaseline = getBaselineForConflict(
                          conflict,
                          item.baselines,
                          item.baseline
                        );
                        const selectedDocId =
                          selectedDocs[baselineKey] ??
                          (confBaseline ? confBaseline.document_id : conflict.doc_a_id);

                        return (
                          <div
                            key={conflict.id}
                            data-conflict-id={conflict.id}
                            data-baseline-key={baselineKey}
                            data-testid={
                              cIdx === 0
                                ? `conflict-container-${item.indicator.id}`
                                : `conflict-container-${conflict.id}`
                            }
                            className="mt-3 p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3"
                          >
                            {/* ⚠ 충돌 경고 */}
                            <div
                              data-conflict-id={conflict.id}
                              data-testid={
                                cIdx === 0
                                  ? `conflict-warning-${item.indicator.id}`
                                  : `conflict-warning-${conflict.id}`
                              }
                              className="text-xs font-bold text-amber-900 flex items-center gap-2"
                            >
                              <span className="text-sm">⚠</span>
                              <span>
                                지표 충돌: {conflict.doc_a_name} &quot;{conflict.doc_a_value}&quot; ↔{' '}
                                {conflict.doc_b_name} &quot;{conflict.doc_b_value}&quot;
                              </span>
                            </div>

                            {/* 저장된 기준 표시 또는 선택 라디오 */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1 border-t border-amber-200/60">
                              <div className="flex items-center gap-4 text-xs font-semibold text-amber-950">
                                <span>기준 지표:</span>
                                <div
                                  role="radiogroup"
                                  aria-label="기준 지표 선택"
                                  className="flex items-center gap-4"
                                >
                                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="radio"
                                      name={`baseline-${baselineKey}`}
                                      value={conflict.doc_a_id}
                                      checked={selectedDocId === conflict.doc_a_id}
                                      onChange={() =>
                                        handleSelectDoc(baselineKey, conflict.doc_a_id)
                                      }
                                      data-doc-id={conflict.doc_a_id}
                                      data-conflict-id={conflict.id}
                                      data-baseline-key={baselineKey}
                                      data-testid={`baseline-radio-${conflict.doc_a_name}`}
                                      className="text-blue-600 focus:ring-blue-500"
                                    />
                                    <span>{conflict.doc_a_name}</span>
                                  </label>

                                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="radio"
                                      name={`baseline-${baselineKey}`}
                                      value={conflict.doc_b_id}
                                      checked={selectedDocId === conflict.doc_b_id}
                                      onChange={() =>
                                        handleSelectDoc(baselineKey, conflict.doc_b_id)
                                      }
                                      data-doc-id={conflict.doc_b_id}
                                      data-conflict-id={conflict.id}
                                      data-baseline-key={baselineKey}
                                      data-testid={`baseline-radio-${conflict.doc_b_name}`}
                                      className="text-blue-600 focus:ring-blue-500"
                                    />
                                    <span>{conflict.doc_b_name}</span>
                                  </label>
                                </div>
                              </div>

                              <div className="flex items-center gap-3">
                                {confBaseline && (
                                  <span
                                    data-conflict-id={conflict.id}
                                    data-testid={
                                      cIdx === 0
                                        ? `saved-baseline-label-${item.indicator.id}`
                                        : `saved-baseline-label-${conflict.id}`
                                    }
                                    className="text-xs font-bold text-blue-700 bg-blue-100/80 px-2.5 py-1 rounded"
                                  >
                                    기준: {confBaseline.document_name}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  disabled={isPending}
                                  onClick={() => handleSaveBaseline(item.indicator.id, conflict)}
                                  data-conflict-id={conflict.id}
                                  data-baseline-key={baselineKey}
                                  data-testid={
                                    cIdx === 0
                                      ? `save-baseline-button-${item.indicator.id}`
                                      : `save-baseline-button-${conflict.id}`
                                  }
                                  className="px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-bold transition shadow-2xs disabled:opacity-50"
                                >
                                  {isPending ? '저장 중...' : '저장'}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 문서에서 사라진 지표 — 이력 보존 (RQ-07, #19) */}
        {orphanedItems.length > 0 && (
          <div
            data-testid="orphaned-indicators-section"
            className="bg-white border border-amber-200 rounded-xl shadow-sm p-6 sm:p-8 space-y-4"
          >
            <div className="border-b border-amber-100 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span>문서에서 사라진 지표 — 이력 보존</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                    {orphanedItems.length}개
                  </span>
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  성과관리표에서 제거되었으나 이전 판정 제안이나 확정 이력이 존재하여 보존된 지표입니다.
                </p>
              </div>
            </div>
            <div className="space-y-3">
              {orphanedItems.map((item) => (
                <div
                  key={item.indicator.id}
                  data-testid={`orphaned-indicator-${item.indicator.id}`}
                  className="p-4 bg-amber-50/40 rounded-xl border border-amber-200/60 space-y-2"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="px-2.5 py-0.5 rounded text-xs font-bold bg-gray-200 text-gray-700">
                        {initialTocColumnForNode({ type: 'indicator', pdmStage: item.indicator.level }) === 'outcome-mid' ? '중/장기성과' : item.indicator.level}
                      </span>
                      <span className="text-base font-bold text-gray-900">
                        {item.indicator.name}
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
                        문서에서 사라짐
                      </span>
                      <span data-testid={`orphan-review-needed-${item.indicator.id}`} className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                        다시 확인 필요
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-gray-600 bg-white/80 p-2.5 rounded-lg border border-amber-100">
                    <div>
                      <span className="font-semibold text-gray-500 mr-1.5">OVI:</span>
                      <span data-testid={`ovi-${item.indicator.id}`}>{item.indicator.ovi}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-500 mr-1.5">MoV:</span>
                      <span>{item.indicator.mov || '-'}</span>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-500 mr-1.5">목표값:</span>
                      <span
                        data-testid={`target-value-${item.indicator.id}`}
                        className="font-medium text-gray-900"
                      >
                        {item.indicator.target_value || '-'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <WorkflowNextAction projectId={projectId} screen="toc" />
      </main>
    </div>
  );
}
