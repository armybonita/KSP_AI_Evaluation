'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ProjectPageLoadFailure } from '../failure-message';
import { loadHistoryPageAction } from './actions';
import { ProjectTabs } from '../project-tabs';
import type { HistoryPageData, IndicatorWithConfirmations } from '@/server/store/types';

interface HistoryClientViewProps {
  projectId: string;
  initialData: HistoryPageData | null;
  initialSelectedIndicatorId?: string;
  requestedIndicatorId?: string;
  initialLoadError?: string | null;
}

export function HistoryClientView({
  projectId,
  initialData,
  initialSelectedIndicatorId,
  requestedIndicatorId,
  initialLoadError,
}: HistoryClientViewProps) {
  const [data, setData] = useState<HistoryPageData | null>(initialData);
  const [selectedIndicatorId, setSelectedIndicatorId] = useState(initialSelectedIndicatorId);
  const [loadError, setLoadError] = useState<string | null>(initialLoadError ?? null);
  const [isRetrying, setIsRetrying] = useState(false);

  const retryLoad = async () => {
    setIsRetrying(true);
    try {
      const result = await loadHistoryPageAction(projectId, requestedIndicatorId);
      if (result.status === 'ready') {
        setData(result.data);
        setSelectedIndicatorId(result.selectedIndicatorId);
        setLoadError(null);
      } else {
        setLoadError(
          result.status === 'error' ? result.error : '확정 이력 데이터를 찾을 수 없습니다.'
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
      <ProjectPageLoadFailure
        projectId={projectId}
        activeScreen="history"
        title="확정 이력"
        message={loadError ?? '확정 이력을 불러오지 못했습니다.'}
        onRetry={() => void retryLoad()}
        isRetrying={isRetrying}
      />
    );
  }

  return (
    <HistoryContent
      initialData={data}
      initialSelectedIndicatorId={selectedIndicatorId}
    />
  );
}

export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const formatter = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(d);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');
    return `${year}-${month}-${day} ${hour}:${minute}:${second} (KST)`;
  } catch {
    return isoString;
  }
}

export function getConfirmationBadgeClass(type: string): {
  container: string;
  dot: string;
} {
  switch (type) {
    case '확정':
      return {
        container: 'bg-emerald-50 text-emerald-800 border-emerald-300',
        dot: 'bg-emerald-500',
      };
    case '수정 후 확정':
      return {
        container: 'bg-blue-50 text-blue-800 border-blue-300',
        dot: 'bg-blue-500',
      };
    case '보완 필요':
      return {
        container: 'bg-amber-50 text-amber-800 border-amber-300',
        dot: 'bg-amber-500',
      };
    case '채택 제외':
      return {
        container: 'bg-gray-100 text-gray-700 border-gray-300',
        dot: 'bg-gray-500',
      };
    default:
      return {
        container: 'bg-gray-100 text-gray-600 border-gray-200',
        dot: 'bg-gray-400',
      };
  }
}

function HistoryContent({
  initialData,
  initialSelectedIndicatorId,
}: Pick<HistoryClientViewProps, 'initialData' | 'initialSelectedIndicatorId'> & {
  initialData: HistoryPageData;
}) {
  const defaultSelectedId =
    initialSelectedIndicatorId &&
    initialData.indicators.some((i) => i.indicator.id === initialSelectedIndicatorId)
      ? initialSelectedIndicatorId
      : initialData.indicators[0]?.indicator.id ?? '';

  const [selectedIndicatorId, setSelectedIndicatorId] = useState<string>(defaultSelectedId);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const selectedItem: IndicatorWithConfirmations | undefined = initialData.indicators.find(
    (item) => item.indicator.id === selectedIndicatorId
  );

  const toggleRow = (confId: string) => {
    setExpandedRows((prev) => ({
      ...prev,
      [confId]: !prev[confId],
    }));
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-6">
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
                  S5 확정 이력
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">확정 이력</h1>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="text-sm text-gray-600 font-medium">
                사업: <span className="text-gray-900">{initialData.project.name}</span>
              </div>
              {initialData.latestConfirmerName && (
                <div className="text-sm text-gray-600 font-medium">
                  확정자:{' '}
                  <span className="text-gray-900 font-semibold">
                    {initialData.latestConfirmerName}
                  </span>
                </div>
              )}
            </div>
          </div>

          <ProjectTabs
            projectId={initialData.project.id}
            activeScreen="history"
            selectedIndicatorId={selectedIndicatorId}
          />
        </header>

        {/* 메인 영역 */}
        <main className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-6">
          {/* 지표 선택기 (SP §s5: 지표: [연수 만족도 ▾]) */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
            <div className="flex items-center gap-2">
              <label
                htmlFor="indicator-select"
                className="text-sm font-bold text-gray-700 whitespace-nowrap"
              >
                지표:
              </label>
              <select
                id="indicator-select"
                data-testid="indicator-select"
                value={selectedIndicatorId}
                onChange={(e) => setSelectedIndicatorId(e.target.value)}
                className="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-900 focus:outline-hidden focus:ring-2 focus:ring-blue-500 max-w-md truncate"
              >
                {initialData.indicators.map((item) => (
                  <option key={item.indicator.id} value={item.indicator.id}>
                    [{item.indicator.level}] {item.indicator.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedItem && (
              <div className="flex items-center gap-2">
                <Link
                  href={`/projects/${initialData.project.id}/review?indicatorId=${selectedItem.indicator.id}`}
                  className="text-xs text-blue-600 hover:text-blue-800 font-semibold"
                >
                  [AI 제안 검토(S4) 바로가기 &rarr;]
                </Link>
              </div>
            )}
          </div>

          {!selectedItem ? (
            <div className="text-center py-12 text-gray-500">
              선택된 지표가 없습니다. 위 선택기에서 지표를 골라 주십시오.
            </div>
          ) : selectedItem.confirmations.length === 0 ? (
            /* 빈 상태: 이 지표는 아직 확정하지 않았습니다 (SP §s5 상태 규칙, UC-17) */
            <div
              data-testid="empty-history-box"
              className="text-center py-16 bg-gray-50 rounded-xl border border-dashed border-gray-300 space-y-3"
            >
              <p
                data-testid="empty-history-message"
                className="text-sm font-medium text-gray-600"
              >
                이 지표는 아직 확정하지 않았습니다.
              </p>
              <div>
                <Link
                  href={`/projects/${initialData.project.id}/review?indicatorId=${selectedItem.indicator.id}`}
                  className="inline-flex items-center gap-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg shadow-xs transition"
                >
                  AI 제안 검토에서 확정하기 &rarr;
                </Link>
              </div>
            </div>
          ) : (
            /* 확정 이력 표 (SP §s5, UC-05, UC-14, RQ-18, RQ-19) */
            <div className="space-y-4">
              <div className="text-xs text-gray-500 font-medium">
                총 {selectedItem.confirmations.length}건의 확정 이력이 있습니다 (시간순, 추가 전용).
              </div>

              <div className="overflow-x-auto border border-gray-200 rounded-xl shadow-xs">
                <table className="min-w-full divide-y divide-gray-200 text-left text-xs">
                  <thead className="bg-gray-50 text-gray-600 font-semibold uppercase tracking-wider">
                    <tr>
                      <th scope="col" className="px-4 py-3 w-12 text-center">
                        #
                      </th>
                      <th scope="col" className="px-4 py-3">
                        시각
                      </th>
                      <th scope="col" className="px-4 py-3">
                        확정자
                      </th>
                      <th scope="col" className="px-4 py-3">
                        결과
                      </th>
                      <th scope="col" className="px-4 py-3">
                        수정 사유
                      </th>
                      <th scope="col" className="px-4 py-3 text-right">
                        상세 비교
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {selectedItem.confirmations.map((conf, index) => {
                      const isExpanded = !!expandedRows[conf.id];
                      const badge = getConfirmationBadgeClass(conf.confirmation_type);

                      return (
                        <React.Fragment key={conf.id}>
                          <tr
                            data-testid={`history-row-${index}`}
                            className={`hover:bg-gray-50/80 transition ${
                              isExpanded ? 'bg-blue-50/30' : ''
                            }`}
                          >
                            <td className="px-4 py-3 font-mono text-center text-gray-500 font-medium">
                              {index + 1}
                            </td>
                            <td
                              data-testid={`history-time-${index}`}
                              className="px-4 py-3 text-gray-700 whitespace-nowrap font-mono"
                            >
                              {formatDateTime(conf.created_at)}
                            </td>
                            <td
                              data-testid={`history-confirmer-${index}`}
                              className="px-4 py-3 font-semibold text-gray-900 whitespace-nowrap"
                            >
                              {conf.confirmer_name}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex flex-col gap-1 items-start">
                                <span
                                  data-testid={`history-type-${index}`}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full font-bold border ${badge.container}`}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                                  <span>{conf.confirmation_type}</span>
                                </span>
                                {Boolean(
                                  conf.edited_verdict_status &&
                                  conf.edited_verdict_status !== conf.ai_verdict_status
                                ) && (
                                  <div
                                    data-testid={`history-verdict-change-${index}`}
                                    className="text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200"
                                  >
                                    판정: {conf.ai_verdict_status ?? '미확인'} &rarr; {conf.edited_verdict_status}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td
                              data-testid={`history-reason-${index}`}
                              className="px-4 py-3 text-gray-700 max-w-xs truncate"
                            >
                              {conf.reason || '-'}
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              <button
                                type="button"
                                data-testid={`history-expand-button-${index}`}
                                onClick={() => toggleRow(conf.id)}
                                aria-expanded={isExpanded}
                                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800 transition"
                              >
                                <span>{isExpanded ? '접기 ▴' : '펼침 ▾'}</span>
                              </button>
                            </td>
                          </tr>

                          {/* 펼침 상세 비교 (AI 최초 제안 ↔ 수정본 비교, SP §s5, UC-05) */}
                          {isExpanded && (
                            <tr data-testid={`history-detail-panel-${index}`}>
                              <td
                                colSpan={6}
                                className="p-4 bg-slate-50 border-t border-b border-slate-200"
                              >
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  {/* AI 최초 제안 (RQ-18, UC-14: 첫 줄에 고정 보존) */}
                                  <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1">
                                    <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                                      AI 최초 제안
                                    </div>
                                    <div
                                      data-testid={`history-initial-proposal-${index}`}
                                      className="text-xs text-gray-800 leading-relaxed font-normal whitespace-pre-wrap"
                                    >
                                      {conf.initial_proposal
                                        ? `"${conf.initial_proposal}"`
                                        : '(최초 제안 없음)'}
                                    </div>
                                  </div>

                                  {/* 수정본 */}
                                  <div className="bg-white p-3 rounded-lg border border-slate-200 space-y-1">
                                    <div className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                                      수정본
                                    </div>
                                    <div
                                      data-testid={`history-edited-text-${index}`}
                                      className="text-xs text-gray-800 leading-relaxed font-normal whitespace-pre-wrap"
                                    >
                                      {conf.edited_text ? (
                                        `"${conf.edited_text}"`
                                      ) : (
                                        <span className="text-gray-400 italic">
                                          (수정본 없음)
                                        </span>
                                      )}
                                    </div>
                                    {Boolean(
                                      conf.edited_verdict_status &&
                                      conf.edited_verdict_status !== conf.ai_verdict_status
                                    ) && (
                                      <div
                                        data-testid={`history-detail-verdict-change-${index}`}
                                        className="pt-1 text-[11px] text-blue-700 font-semibold"
                                      >
                                        <span className="text-gray-500">판정 변경:</span>{' '}
                                        {conf.ai_verdict_status ?? '미확인'} &rarr; {conf.edited_verdict_status}
                                      </div>
                                    )}
                                    {conf.reason && (
                                      <div className="pt-1 text-[11px] text-gray-500">
                                        <span className="font-semibold text-gray-600">
                                          수정 사유:
                                        </span>{' '}
                                        {conf.reason}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
