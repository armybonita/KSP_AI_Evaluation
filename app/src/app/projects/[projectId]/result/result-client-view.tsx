'use client';

import React, { useState } from 'react';
import { DocumentExclusionNotice } from '@/app/projects/document-exclusion-notice';
import type { ExcludedDocumentSummary } from '@/server/store/excluded-documents';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProjectPageLoadFailure } from '../failure-message';
import { ProjectTabs } from '../project-tabs';
import { loadResultTocPageAction } from './actions';
import type { ResultTocPageData, ResultTocItem, ResultTocDisplayKind } from '@/server/store/types';

interface ResultClientViewProps {
  canViewHistory?: boolean;
  initialData: ResultTocPageData;
  exclusionSummary: ExcludedDocumentSummary;
}

interface ResultPageClientViewProps {
  canViewHistory?: boolean;
  projectId: string;
  exclusionSummary: ExcludedDocumentSummary;
  initialData: ResultTocPageData | null;
  initialLoadError?: string | null;
}

export function ResultTocPageClientView({
  projectId,
  exclusionSummary,
  initialData,
  initialLoadError,
  canViewHistory = false,
}: ResultPageClientViewProps) {
  const [data, setData] = useState<ResultTocPageData | null>(initialData);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError ?? null);
  const [isRetrying, setIsRetrying] = useState(false);

  const retryLoad = async () => {
    setIsRetrying(true);
    try {
      const result = await loadResultTocPageAction(projectId);
      if (result.status === 'ready') {
        setData(result.data);
        setLoadError(null);
      } else {
        setLoadError(
          result.status === 'error' ? result.error : '결과 ToC 데이터를 찾을 수 없습니다.'
        );
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRetrying(false);
    }
  };

  if (!data) {
    return (
      <>
        <DocumentExclusionNotice projectId={projectId} summary={exclusionSummary} />
        <ProjectPageLoadFailure
          projectId={projectId}
          activeScreen="result"
          title="결과 ToC"
          message={loadError ?? '결과 ToC를 불러오지 못했습니다.'}
          onRetry={() => void retryLoad()}
          isRetrying={isRetrying}
        />
      </>
    );
  }

  return <ResultTocClientView initialData={data} canViewHistory={canViewHistory} exclusionSummary={exclusionSummary} />;
}

export function getResultBadgeStyles(displayKind: ResultTocDisplayKind): {
  containerClass: string;
  dotClass?: string;
  text: string;
} {
  switch (displayKind) {
    case '실현':
      return {
        containerClass: 'bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-2xs font-semibold',
        dotClass: 'bg-emerald-500',
        text: '실현',
      };
    case '추진 중':
      return {
        containerClass: 'bg-blue-100 text-blue-800 border border-blue-300 shadow-2xs font-semibold',
        dotClass: 'bg-blue-500',
        text: '추진 중',
      };
    case '기대':
      return {
        containerClass: 'bg-amber-100 text-amber-800 border border-amber-300 shadow-2xs font-semibold',
        dotClass: 'bg-amber-500',
        text: '기대',
      };
    case '미확인':
      return {
        containerClass: 'bg-gray-100 text-gray-700 border border-gray-300 shadow-2xs font-semibold',
        dotClass: 'bg-gray-400',
        text: '미확인',
      };
    case '근거 충돌':
      return {
        containerClass: 'bg-orange-100 text-orange-800 border border-orange-300 shadow-2xs font-semibold',
        dotClass: 'bg-orange-500',
        text: '근거 충돌',
      };
    case '보완 필요':
      return {
        containerClass: 'bg-white text-gray-700 border border-dashed border-gray-400 font-semibold',
        text: '보완 필요',
      };
    case '채택 제외':
      return {
        containerClass: 'bg-transparent text-gray-400 line-through font-normal',
        text: '채택 제외',
      };
    case '미확정':
    default:
      return {
        containerClass: 'bg-white text-gray-600 border border-solid border-gray-300 font-medium',
        text: '미확정',
      };
  }
}

export function ResultTocClientView({ initialData, canViewHistory = false, exclusionSummary }: ResultClientViewProps) {
  const router = useRouter();
  const project = initialData.project;
  const activeItems = initialData.activeItems;
  const orphanedItems = initialData.orphanedItems;

  const handleItemClick = (indicatorId: string) => {
    router.push(`/projects/${project.id}/history?indicatorId=${indicatorId}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent, indicatorId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleItemClick(indicatorId);
    }
  };

  const indentStyles: Record<string, string> = {
    '영향': 'pl-0',
    '중기성과': 'pl-6 sm:pl-8 border-l-2 border-blue-100',
    '단기성과': 'pl-12 sm:pl-16 border-l-2 border-blue-200',
    '산출물': 'pl-18 sm:pl-24 border-l-2 border-indigo-200',
    '활동': 'pl-24 sm:pl-32 border-l-2 border-indigo-300',
  };

  const renderItemRow = (item: ResultTocItem, index: number, isOrphanedList = false) => {
    const badgeStyle = getResultBadgeStyles(item.displayKind);
    const indentClass = isOrphanedList ? 'pl-0' : indentStyles[item.indicator.level] || 'pl-0';
    const isExcluded = item.displayKind === '채택 제외';

    return (
      <div
        key={item.indicator.id}
        role="treeitem"
        tabIndex={canViewHistory ? 0 : undefined}
        aria-selected="false"
        aria-label={`${item.indicator.level}: ${item.indicator.name} - ${badgeStyle.text}`}
        data-testid={`result-toc-item-${item.indicator.id}`}
        onClick={canViewHistory ? () => handleItemClick(item.indicator.id) : undefined}
        onKeyDown={canViewHistory ? (e) => handleKeyDown(e, item.indicator.id) : undefined}
        className={`group ${canViewHistory ? 'cursor-pointer' : ''} select-none transition focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-xl ${indentClass}`}
      >
        <div className="p-4 bg-white hover:bg-blue-50/40 rounded-xl border border-gray-200/90 shadow-2xs group-hover:border-blue-300 transition flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {/* 좌측: 단계 및 지표 정보 */}
          <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
            {!isOrphanedList && index > 0 && (
              <span className="text-gray-300 font-bold select-none text-sm hidden sm:inline" aria-hidden="true">
                └
              </span>
            )}
            <span className="px-2.5 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-800 shrink-0">
              {item.indicator.level}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`text-sm ${
                    isExcluded
                      ? 'text-gray-400 line-through'
                      : 'text-gray-900 font-semibold group-hover:text-blue-900'
                  } transition`}
                >
                  {item.indicator.name}
                </span>
                {item.indicator.target_value && (
                  <span className="text-xs text-gray-500 font-normal">
                    (목표: {item.indicator.target_value})
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* 우측: 판정 상태 배지 및 이력 링크 (D28 글자 병기, D05, D26) */}
          <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
            <span
              data-testid={`result-status-badge-${item.indicator.id}`}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition ${badgeStyle.containerClass}`}
            >
              {badgeStyle.dotClass && (
                <span className={`w-2 h-2 rounded-full ${badgeStyle.dotClass} shrink-0`} aria-hidden="true" />
              )}
              <span>{badgeStyle.text}</span>
            </span>

            {canViewHistory && <span className="text-xs font-semibold text-blue-600 group-hover:text-blue-800 transition flex items-center gap-0.5">
              <span>이력</span>
              <span aria-hidden="true">&rarr;</span>
            </span>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* 1. 상단 머리 영역 (SP §S7) */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20 shadow-2xs">
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
                  ⑩ 종합 결과
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">결과 ToC</h1>
            </div>
            <div className="text-sm text-gray-600 font-medium">
              사업: <span className="text-gray-900 font-semibold">{project.name}</span>
            </div>
          </div>

          <ProjectTabs projectId={project.id} activeScreen="result" />
        </div>
      </header>

      {/* 2. 본문 영역 */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full space-y-6">
        <p className="text-sm font-semibold">지표 확정 {initialData.indicatorConfirmedCount ?? initialData.totalConfirmedCount} · 노트 확정 {initialData.noteConfirmedCount ?? 0} (<Link className="text-blue-700 underline" href={`/projects/${project.id}/review?noteStatus=confirmed`}>검토 화면에서 보기</Link>)</p>
        <DocumentExclusionNotice projectId={project.id} summary={exclusionSummary} />
        {/* 확정 0건 상태 안내 배너 (UC-17, RQ-23, SP §S7 line 234) */}
        {!initialData.totalConfirmedCount && !(initialData.noteConfirmedCount ?? 0) && (
          <div
            role="alert"
            data-testid="empty-confirmations-notice"
            className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs"
          >
            <div className="flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs font-bold shrink-0">
                !
              </span>
              <div>
                <span className="text-sm font-bold">확정한 판단이 없습니다</span>
                <span className="text-xs text-amber-700 ml-2 hidden sm:inline">
                  — 초기 ToC의 모든 항목이 미확정으로 표시됩니다. AI 제안을 검토하고 확정하면 결과가 반영됩니다.
                </span>
              </div>
            </div>
            <Link
              href={`/projects/${project.id}/review`}
              data-testid="link-to-s4"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition self-start sm:self-auto shrink-0"
            >
              <span>AI 제안 검토로 이동</span>
              <span aria-hidden="true">&rarr;</span>
            </Link>
          </div>
        )}

        {/* 빈 성과관리표 상태 (지표 없음) */}
        {!initialData.hasPdm || initialData.items.length === 0 ? (
          <div
            data-testid="empty-pdm-notice"
            className="bg-white border border-gray-200 rounded-xl p-12 text-center shadow-xs space-y-4"
          >
            <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-full flex items-center justify-center mx-auto text-xl font-bold">
              !
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-gray-900">
                {initialData.warningMessage ?? '포함된 성과관리표가 없습니다'}
              </h2>
              <p className="text-sm text-gray-500">
                결과 ToC 를 확인하려면 성과관리표 문서를 등록하고 포함 상태로 지정해야 합니다.
              </p>
            </div>
            <div>
              <Link
                href={`/projects/${project.id}/documents`}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition"
              >
                <span>자료 등록으로 이동</span>
                <span aria-hidden="true">&rarr;</span>
              </Link>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl shadow-xs p-6 sm:p-8 space-y-6">
            {/* 범례 영역 (SP §S7 line 224, D28, D05, D26) */}
            <div
              data-testid="result-toc-legend"
              aria-label="결과 ToC 범례"
              className="p-3.5 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-700 flex flex-wrap items-center gap-x-4 gap-y-2.5"
            >
              <span className="font-bold text-gray-900">범례:</span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-800">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500 inline-block" aria-hidden="true" />
                <span>실현</span>
              </span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-blue-800">
                <span className="w-2.5 h-2.5 rounded-xs bg-blue-500 inline-block" aria-hidden="true" />
                <span>추진 중</span>
              </span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-amber-800">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-500 inline-block" aria-hidden="true" />
                <span>기대</span>
              </span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-gray-700">
                <span className="w-2.5 h-2.5 rounded-xs bg-gray-400 inline-block" aria-hidden="true" />
                <span>미확인</span>
              </span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-orange-800">
                <span className="w-2.5 h-2.5 rounded-xs bg-orange-500 inline-block" aria-hidden="true" />
                <span>근거 충돌</span>
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 border border-dashed border-gray-400 rounded bg-white text-gray-700 font-semibold">
                보완 필요(회색 점선)
              </span>
              <span className="inline-flex items-center gap-1 text-gray-400 line-through font-normal">
                채택 제외(취소선)
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 border border-solid border-gray-300 rounded bg-white text-gray-600 font-medium">
                □ 미확정
              </span>
            </div>

            {/* 설명 및 안내 */}
            <div className="border-b border-gray-200 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-gray-900">성과 경로 결과</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  초기 ToC 성과 경로 위에 최신 확정 판정이 색으로 얹힌 결과입니다. {canViewHistory && '항목을 누르면 해당 지표의 확정 이력으로 이동합니다.'}
                </p>
              </div>
              <div className="text-xs text-gray-500 shrink-0">
                총 {initialData.items.length}개 지표 (확정 완료 {initialData.indicatorConfirmedCount ?? initialData.totalConfirmedCount}건)
              </div>
            </div>

            {/* 성과 경로 트리 컨테이너 */}
            <div
              role="tree"
              aria-label="결과 ToC 성과 경로 계층 구조"
              data-testid="result-toc-tree"
              className="space-y-3"
            >
              {activeItems.map((item, index) => renderItemRow(item, index, false))}
            </div>

            {/* 문서에서 사라진 지표 (orphaned) 영역 */}
            {orphanedItems.length > 0 && (
              <div
                data-testid="orphaned-section"
                className="mt-8 pt-6 border-t border-gray-200 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                  <h3 className="text-base font-bold text-gray-900">문서에서 사라진 지표</h3>
                  <span className="text-xs text-gray-500">
                    (문서가 변경되어 성과관리표에서 사라졌으나 기존 판단 이력이 보존된 지표)
                  </span>
                </div>
                <div
                  role="tree"
                  aria-label="문서에서 사라진 지표 목록"
                  className="space-y-3"
                >
                  {orphanedItems.map((item, index) => renderItemRow(item, index, true))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
