'use client';

import React, { useState } from 'react';
import type { NoteStatusItem } from '@/lib/note-visibility';
import Link from 'next/link';
import type { OntologyProjectGraph, OntologyProjectNode } from '@/server/ontology/store';
import { initialTocColumnForNode } from '@/lib/ontology-toc';
import { getTocGraphAction } from './actions';
import { InitialTocTable, OntologyGraphView } from '../ontology/ontology-views';
import type { OutcomeFinalResultsData } from '@/server/store/types';

export function getReviewItemHref(projectId: string, nodeId: string, reviewNodeIds: readonly string[]): string | null {
  return reviewNodeIds.includes(nodeId)
    ? `/projects/${encodeURIComponent(projectId)}/review?nodeId=${encodeURIComponent(nodeId)}`
    : null;
}

export function mergeGraphWithPdmIndicators(graphNodes: readonly OntologyProjectNode[], fallbackNodes: readonly OntologyProjectNode[]): OntologyProjectNode[] {
  const merged = new Map(graphNodes.map((node) => [node.id, node]));
  for (const node of fallbackNodes) {
    const existing = merged.get(node.id);
    if (!existing) {
      merged.set(node.id, node);
      continue;
    }
    const labels = new Set(existing.planDetails.map((detail) => detail.label));
    merged.set(node.id, {
      ...existing,
      pdmStage: existing.pdmStage ?? node.pdmStage,
      planDetails: [...existing.planDetails, ...node.planDetails.filter((detail) => !labels.has(detail.label))],
    });
  }
  return [...merged.values()];
}

export function supportsNoteReview(node: OntologyProjectGraph['nodes'][number]): boolean {
  return initialTocColumnForNode(node) !== null || ['enabler', 'constraint'].includes(node.type);
}

export function getGraphReviewHref(projectId: string, node: OntologyProjectNode, reviewNodeIds: readonly string[]): string | null {
  return supportsNoteReview(node) ? getReviewItemHref(projectId, node.id, reviewNodeIds) : null;
}

export function OutcomeFinalResultsTable({ data }: { data: OutcomeFinalResultsData }) {
  const getBadgeClass = (status: string) => {
    switch (status) {
      case '실현':
        return 'bg-green-100 text-green-800 border-green-300';
      case '추진 중':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case '기대':
        return 'bg-amber-100 text-amber-800 border-amber-300';
      case '근거 미확인':
      case '미확인':
        return 'bg-gray-100 text-gray-800 border-gray-300';
      case '근거 충돌':
        return 'bg-red-100 text-red-800 border-red-300';
      case '검토 중':
      default:
        return 'bg-slate-100 text-slate-700 border-slate-300';
    }
  };

  return (
    <section aria-label="PDM 성과표 및 성과관리 최종결과" data-testid="outcome-final-results-section" className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">PDM 성과표 및 성과관리 최종결과</h2>
          <p className="mt-1 text-xs text-gray-500">
            활동·산출물·단기·중장기·영향 5단계 계획 대비 최종 성과관리 확정 결과입니다. 확정 전 지표는 &apos;검토 중&apos;으로 표시됩니다.
          </p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
          확정 {data.confirmedCount} / 전체 {data.totalIndicators}건
        </span>
      </div>

      <div className="mt-4 w-full max-w-full overflow-x-auto" data-testid="outcome-table-scroll">
        <table aria-label="PDM 성과표 및 성과관리 최종결과 표" className="min-w-[900px] w-full divide-y divide-gray-200 border border-gray-200 text-sm">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th scope="col" rowSpan={2} className="border-r border-b border-gray-200 whitespace-nowrap px-3 py-2 text-center font-semibold text-xs">단계</th>
              <th scope="col" rowSpan={2} className="border-r border-b border-gray-200 px-3 py-2 text-left font-semibold text-xs">지표명</th>
              <th scope="col" colSpan={3} className="border-r border-b border-gray-200 bg-blue-50/70 px-3 py-1.5 text-center font-semibold text-xs text-blue-900">PDM 성과표 (계획)</th>
              <th scope="col" colSpan={3} className="border-r border-b border-gray-200 bg-emerald-50/70 px-3 py-1.5 text-center font-semibold text-xs text-emerald-900">성과관리 최종결과</th>
              <th scope="col" rowSpan={2} className="border-b border-gray-200 px-3 py-2 text-center font-semibold text-xs">이동</th>
            </tr>
            <tr className="bg-gray-50 text-gray-600 text-xs">
              <th scope="col" className="border-r border-b border-gray-200 bg-blue-50/30 px-3 py-1.5 text-left font-medium">목표값</th>
              <th scope="col" className="border-r border-b border-gray-200 bg-blue-50/30 px-3 py-1.5 text-left font-medium">기준값</th>
              <th scope="col" className="border-r border-b border-gray-200 bg-blue-50/30 whitespace-nowrap px-3 py-1.5 text-left font-medium">단위</th>
              <th scope="col" className="border-r border-b border-gray-200 bg-emerald-50/30 px-3 py-1.5 text-left font-medium">실제 값</th>
              <th scope="col" className="border-r border-b border-gray-200 bg-emerald-50/30 whitespace-nowrap px-3 py-1.5 text-left font-medium">달성 판단</th>
              <th scope="col" className="border-r border-b border-gray-200 bg-emerald-50/30 whitespace-nowrap px-3 py-1.5 text-center font-medium">근거 수</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {data.stages.map((stage) => {
              if (stage.indicators.length === 0) {
                return (
                  <tr key={stage.stage_key} data-testid={`outcome-row-${stage.stage_key}-empty`} className="hover:bg-gray-50">
                    <td className="border-r border-gray-200 bg-gray-50 whitespace-nowrap px-3 py-3 text-center font-semibold text-gray-800">{stage.stage_label}</td>
                    <td className="border-r border-gray-200 px-3 py-3 text-gray-400 italic">PDM에 없음</td>
                    <td className="border-r border-gray-200 px-3 py-3 text-gray-400">PDM에 없음</td>
                    <td data-outcome-cell="baseline" className="border-r border-gray-200 whitespace-nowrap px-3 py-3 text-gray-400">PDM에 없음</td>
                    <td data-outcome-cell="unit" className="border-r border-gray-200 whitespace-nowrap px-3 py-3 text-gray-400">PDM에 없음</td>
                    <td className="border-r border-gray-200 px-3 py-3 text-gray-400">—</td>
                    <td className="border-r border-gray-200 px-3 py-3 text-gray-400">—</td>
                    <td className="border-r border-gray-200 px-3 py-3 text-center text-gray-400">—</td>
                    <td className="px-3 py-3 text-center text-gray-400">—</td>
                  </tr>
                );
              }

              return stage.indicators.map((ind, index) => (
                <tr key={ind.indicator_id} data-testid={`outcome-row-${ind.indicator_id}`} className="hover:bg-gray-50">
                  {index === 0 && (
                    <td rowSpan={stage.indicators.length} className="border-r border-gray-200 bg-gray-50 whitespace-nowrap px-3 py-3 text-center font-semibold text-gray-800 align-top">
                      {stage.stage_label}
                    </td>
                  )}
                  <td className="border-r border-gray-200 px-3 py-3 font-medium text-gray-900">
                    <div className="flex items-center gap-1.5">
                      <span>{ind.indicator_name}</span>
                      {ind.is_orphaned && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">문서 제외</span>}
                    </div>
                  </td>
                  <td className="border-r border-gray-200 px-3 py-3 text-gray-700">{ind.target_value}</td>
                  <td data-outcome-cell="baseline" className="border-r border-gray-200 whitespace-nowrap px-3 py-3 text-gray-700">{ind.baseline_value}</td>
                  <td data-outcome-cell="unit" className="border-r border-gray-200 whitespace-nowrap px-3 py-3 text-gray-700">{ind.unit}</td>
                  <td className="border-r border-gray-200 px-3 py-3 font-medium text-gray-900">{ind.actual_value}</td>
                  <td data-outcome-cell="status" className="border-r border-gray-200 whitespace-nowrap px-3 py-3">
                    <span className={`inline-flex whitespace-nowrap items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getBadgeClass(ind.status_display)}`}>
                      {ind.status_display}
                    </span>
                  </td>
                  <td data-outcome-cell="evidence" className="border-r border-gray-200 whitespace-nowrap px-3 py-3 text-center text-gray-700">
                    {ind.is_confirmed ? (ind.evidence_count ? `${ind.evidence_count}건` : '근거 미확인') : '—'}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <div className="flex min-w-max items-center justify-center gap-2">
                      <Link
                        href={ind.review_href}
                        data-testid={`review-link-${ind.indicator_id}`}
                        className="whitespace-nowrap rounded border border-blue-600 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                      >
                        검토
                      </Link>
                      <Link
                        href={ind.report_href}
                        data-testid={`report-link-${ind.indicator_id}`}
                        className="whitespace-nowrap rounded border border-indigo-600 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                      >
                        보고서
                      </Link>
                    </div>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function InitialTocSection({ graph, fallbackNodes, hasPdm, projectId, reviewNodeIds, initialGraphView = false, outcomeFinalResults, noteItems = [] }: {
  graph: OntologyProjectGraph;
  noteItems?: NoteStatusItem[];
  fallbackNodes: OntologyProjectNode[];
  hasPdm: boolean;
  projectId: string;
  reviewNodeIds: string[];
  initialGraphView?: boolean;
  outcomeFinalResults?: OutcomeFinalResultsData | null;
}) {
  const [currentGraph, setCurrentGraph] = useState(graph);
  const [graphLoaded, setGraphLoaded] = useState(initialGraphView);
  const [viewMode, setViewMode] = useState<'toc' | 'graph'>(initialGraphView ? 'graph' : 'toc');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nodes = mergeGraphWithPdmIndicators(currentGraph.nodes, fallbackNodes);
  // 교수님 시안: 단순 ToC 는 PDM 에 있는 계획정보만 보인다. AI 가 만든 온톨로지 점은 상세 그래프에서 본다. PDM 점이 없으면 예전처럼 전체.
  const pdmIds = new Set(fallbackNodes.map((node) => node.id));
  const planNodes = pdmIds.size ? nodes.filter((node) => pdmIds.has(node.id)) : nodes;

  if (!hasPdm) {
    return (
      <section data-testid="initial-toc-locked" className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="text-lg font-semibold text-amber-950">초기 ToC 잠김</h2>
        <p className="mt-1 text-sm text-amber-900">평가팀이 성과관리표(PDM)를 등록하면 계획 기준선을 볼 수 있습니다.</p>
      </section>
    );
  }

  return (
    <section aria-label="초기 ToC 계획 기준선" data-testid="initial-toc-section">
      {outcomeFinalResults && <OutcomeFinalResultsTable data={outcomeFinalResults} />}
      <nav aria-label="초기 ToC 보기 전환" className="flex gap-2">
        <button type="button" aria-pressed={viewMode === 'toc'} onClick={() => setViewMode('toc')} className={`rounded border px-3 py-2 text-sm font-medium ${viewMode === 'toc' ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-300 bg-white text-gray-700'}`}>단순 ToC</button>
        <button type="button" aria-pressed={viewMode === 'graph'} onClick={async () => {
          if (!graphLoaded) {
            try {
              const loaded = await getTocGraphAction(projectId);
              if (!loaded) { setNotice('그래프를 불러올 수 없습니다.'); return; }
              setCurrentGraph(loaded); setGraphLoaded(true);
            } catch { setNotice('그래프를 불러올 수 없습니다.'); return; }
          }
          setViewMode('graph');
        }} className={`rounded border px-3 py-2 text-sm font-medium ${viewMode === 'graph' ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-300 bg-white text-gray-700'}`}>상세 그래프</button>
      </nav>
      {notice && <p role="status" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}
      {viewMode === 'toc'
        ? <InitialTocTable nodes={planNodes} factorNodes={currentGraph.nodes} selectedId={selectedNodeId} onSelect={(node) => setSelectedNodeId(node.id)} outcomeFinalResults={outcomeFinalResults} noteItems={noteItems} />
        : <OntologyGraphView nodes={nodes} edges={currentGraph.edges} candidates={currentGraph.candidates} selectedId={selectedNodeId} onSelect={(node) => {
            setSelectedNodeId(node.id);
            const href = getGraphReviewHref(projectId, node, reviewNodeIds);
            if (href) window.location.assign(href);
            else setNotice('이 점과 같은 ID의 검토 항목이 없어 검토 화면으로 이동할 수 없습니다.');
          }} />}
      <a href={`/projects/${encodeURIComponent(projectId)}/documents`} className="mt-4 inline-block rounded bg-blue-700 px-4 py-2 text-sm text-white">사업 자료 입력 →</a>
    </section>
  );
}
