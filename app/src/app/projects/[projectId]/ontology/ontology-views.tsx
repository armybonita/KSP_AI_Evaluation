'use client';

import React, { useState } from 'react';
import { noteStatus, type NoteStatusItem } from '@/lib/note-visibility';
import type { OntologyNodeStatement, OntologyProjectEdge, OntologyProjectNode } from '@/server/ontology/store';
import type { OutcomeFinalResultsData, OutcomeStageKey } from '@/server/store/types';
import {
  buildInitialTocColumns,
  buildUnassignedIndicators,
  formatUnmappedIndicatorNotice,
  layoutOntologyGraph,
  summarizeUnmappedIndicatorStages,
} from '@/lib/ontology-toc';

export function displayEvidenceLevel(value: string | null): string {
  return value === '예견' ? '예견 (기대·계획)' : value ?? '[확인 필요]';
}

export interface OntologyEvidenceSummary {
  id: string;
  quote: string;
  sourceTitle: string;
  locator: string;
  quoteStatus: 'verified' | 'unverified';
  quoteMatchPercent: number | null;
  evidenceLevel: string | null;
  sufficiency: { label: string; reason: string };
  contradictionCount: number;
  countsAsRationale: boolean;
}

const OMITTED_TYPE_LABEL: Record<string, string> = { indicator: '지표', impact: '영향', project: '사업', partner: '협력국', 'policy-area': '정책분야', implementer: '수행기관', 'participant-org': '참여기관', evidence: '근거', source: '원본' };

export function InitialTocTable({ nodes, factorNodes = nodes, selectedId, onSelect, outcomeFinalResults, noteItems = [] }: {
  nodes: OntologyProjectNode[];
  factorNodes?: readonly OntologyProjectNode[];
  noteItems?: NoteStatusItem[];
  selectedId: string | null;
  onSelect: (node: OntologyProjectNode) => void;
  outcomeFinalResults?: OutcomeFinalResultsData | null;
}) {
  const columns = buildInitialTocColumns(nodes);
  const unassignedIndicators = buildUnassignedIndicators(nodes);
  const unmappedIndicatorNotice = formatUnmappedIndicatorNotice(summarizeUnmappedIndicatorStages(nodes));
  const statuses = new Map(noteItems.map((item) => [JSON.stringify([item.id, item.type]), item]));
  return <section className="mt-6 min-w-0 rounded-lg border border-gray-200 bg-white p-5">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-semibold">초기 목차</h2>
      <span className="rounded-full border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-800">참고 기준선</span>
    </div>
    <p className="mt-1 text-sm text-gray-600">저장된 사업 계획과 확정된 실제 성과를 단계별로 비교합니다. 실제 성과는 확정 이력이 있을 때만 표시합니다.</p>
    <div className="mt-4 overflow-x-auto">
      <table aria-label="초기 목차 PDM 계획 기준선 5열" className="min-w-[700px] w-full table-fixed border-collapse text-left text-sm">
        <thead><tr>{columns.map((column, index) => <th key={column.key} scope="col" className="border border-gray-200 bg-gray-50 p-3 text-base"><div className="flex items-center justify-between gap-2"><span>{column.label}</span>{index < columns.length - 1 && <span aria-label={`${column.label}에서 다음 단계로`} className="text-blue-500" aria-hidden="true">→</span>}</div></th>)}</tr></thead>
        <tbody><tr>{columns.map((column) => <td key={column.key} className="align-top border border-gray-200 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">계획</h3>
          {column.nodes.length ? <ul className="mt-2 space-y-2">{column.nodes.map((node) => <li key={node.id}>
            <button type="button" onClick={() => onSelect(node)} aria-pressed={selectedId === node.id} className={`w-full rounded border p-2 text-left focus:outline-none focus:ring-2 focus:ring-blue-500 ${selectedId === node.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}>
              <span className="block font-medium text-gray-900">{node.title || node.id}</span>
              {node.planDetails.filter((detail) => detail.label !== 'PDM 단계').map((detail) => <span key={`${node.id}:${detail.label}`} className="mt-1 block text-xs text-gray-600">{detail.label}: {detail.value}</span>)}
            </button>
          </li>)}</ul> : <p className="mt-2 rounded bg-gray-50 p-2 text-gray-500">PDM에 없음</p>}
          <h3 className="mt-4 border-t border-gray-100 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-600">실제</h3>
          {(() => {
            const actualIndicators = outcomeFinalResults?.stages
              .find((stage) => stage.stage_key === (column.key as OutcomeStageKey))
              ?.indicators.filter((indicator) => indicator.is_confirmed) ?? [];
            return actualIndicators.length ? <ul className="mt-2 space-y-2" data-testid={`actual-items-${column.key}`}>
              {actualIndicators.map((indicator) => <li key={indicator.indicator_id} data-testid={`actual-item-${indicator.indicator_id}`} className="rounded border border-emerald-200 bg-emerald-50 p-2">
                <span className="block font-medium text-emerald-900">{indicator.indicator_name}</span>
                <span className="mt-1 block text-xs text-emerald-800">기등록 · {indicator.actual_value}</span>
              </li>)}
            </ul> : <p data-testid={`actual-unreviewed-${column.key}`} className="mt-2 rounded bg-gray-50 p-2 text-gray-700">미검토</p>;
          })()}
        </td>)}</tr></tbody>
      </table>
    </div>
    <div className="mt-4 flex flex-wrap gap-6 text-sm">{([['기여요인', 'enabler'], ['제약요인', 'constraint']] as const).map(([label, type]) => { const factors = factorNodes.filter(node => node.type === type); return <div key={type}><strong>{label}</strong>{factors.length ? <ul>{factors.map(node => { const status = statuses.get(JSON.stringify([node.id, node.type])); const title = status?.title === node.title ? node.title : status?.title === '[인용 금지 문장]' ? status.title : '[확인 필요]'; return <li key={node.id}><span data-testid="toc-factor-name">{title}</span>: <span data-testid="toc-factor-status">{status ? noteStatus(status) : '미검토'}</span></li>; })}</ul> : <p>등록된 요인이 없습니다.</p>}</div>; })}</div>
    {unmappedIndicatorNotice && <p role="note" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{unmappedIndicatorNotice}</p>}
    {unassignedIndicators.length > 0 && <section aria-label="칸 미지정 지표" className="mt-4 rounded border border-amber-200 bg-amber-50/50 p-4">
      <h3 className="font-semibold text-amber-950">칸 미지정 · {unassignedIndicators.length}개</h3>
      <p className="mt-1 text-xs text-amber-900">빈 단계·5칸에 대응하지 않는 지표를 계획값과 함께 보존합니다.</p>
      <ul className="mt-3 space-y-2">{unassignedIndicators.map((node) => <li key={node.id} data-testid={`unassigned-indicator-${node.id}`} className="rounded border border-amber-100 bg-white p-3">
        <span className="font-medium text-gray-900">{node.title || node.id}</span>
        <span className="ml-2 text-xs text-gray-600">PDM 단계: {node.pdmStage || '미지정'}</span>
        {node.planDetails.filter((detail) => detail.label !== 'PDM 단계').map((detail) => <span key={`${node.id}:${detail.label}`} className="mt-1 block text-xs text-gray-700">{detail.label}: {detail.value}</span>)}
      </li>)}</ul>
    </section>}
  </section>;
}

export function OntologyGraphView({ nodes, edges, candidates = [], showCandidates = true, selectedId, onSelect }: {
  nodes: OntologyProjectNode[];
  edges: OntologyProjectEdge[];
  candidates?: OntologyProjectEdge[];
  showCandidates?: boolean;
  selectedId: string | null;
  onSelect: (node: OntologyProjectNode) => void;
}) {
  const [candidateToggle, setCandidateToggle] = useState(showCandidates);
  const layout = layoutOntologyGraph({ nodes, edges, candidates: candidateToggle ? candidates : [] });
  const unmappedIndicatorNotice = formatUnmappedIndicatorNotice(summarizeUnmappedIndicatorStages(nodes));
  const selectedNode = nodes.find(node => node.id === selectedId);
  const incident = (edge: OntologyProjectEdge) => selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
  const edgeColor = (relation: string, candidate: boolean) => candidate ? '#9ca3af' : relation === 'promotes' ? '#16a34a' : relation === 'hinders' ? '#dc2626' : '#64748b';
  const relationLabel = (relation: string, candidate = false) => `${candidate ? '후보 · ' : ''}${relation}`;
  return <section className="mt-6 min-w-0 rounded-lg border border-gray-200 bg-white p-5">
    <h2 className="text-lg font-semibold">상세 그래프</h2>
    <p className="mt-1 text-sm text-gray-600">저장된 노드와 확정 관계를 네 단계 흐름으로 표시합니다. 점을 선택하면 연결된 선을 강조합니다.</p>
    {candidates.length > 0 && <label className="mt-3 inline-flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700"><input data-testid="ontology-candidate-toggle" aria-label="AI 관계 후보 표시" type="checkbox" checked={candidateToggle} onChange={event => setCandidateToggle(event.target.checked)} />AI 관계 후보 표시</label>}
    <div aria-label="관계 범례" className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-gray-700">
      <span><i className="mr-1 inline-block w-7 border-t-2 border-slate-500 align-middle" />생성·유발·확장</span>
      <span><i className="mr-1 inline-block w-7 border-t-2 border-dashed border-green-600 align-middle" />촉진</span>
      <span><i className="mr-1 inline-block w-7 border-t-2 border-dashed border-red-600 align-middle" />저해</span>
      {candidateToggle && candidates.length > 0 && <span><i className="mr-1 inline-block w-7 border-t-2 border-dashed border-gray-400 align-middle" />AI 후보</span>}
    </div>
    {layout.omitted.length > 0 && <p data-testid="ontology-graph-omitted" className="mt-2 text-xs text-gray-600">상세 그래프는 활동·산출물·단기·중장기성과와 기여·제약요인만 그립니다. 그리지 않은 점: {layout.omitted.map(({ type, count }) => `${OMITTED_TYPE_LABEL[type] ?? type} ${count}개`).join(', ')} (지표는 단순 ToC 에서 봅니다)</p>}
    {selectedNode && <p role="status" className="mt-2 text-xs text-blue-800">선택: {selectedNode.title} · {selectedNode.id}</p>}
    {unmappedIndicatorNotice && <p role="note" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{unmappedIndicatorNotice}</p>}
    {!layout.nodes.length ? <p className="mt-3 rounded border border-dashed p-5 text-sm text-gray-600">표시할 저장 점이 없습니다.</p> : <div className="mt-4 overflow-auto rounded border border-gray-100 bg-slate-50 p-2">
      <svg role="img" aria-label="저장된 사업 온톨로지 상세 그래프" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} className="max-w-none">
        <defs><marker id="ontology-edge-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 z" fill="#64748b" /></marker></defs>
        {layout.columnLabels.map((label, index) => <g key={`${label}:${index}`}>
          <text x={24 + index * 232} y="28" className="fill-slate-600 text-xs font-semibold">{label}</text>
          {index < layout.columnLabels.length - 1 && <text x={24 + index * 232 + 200} y="28" className="fill-blue-500 text-xs font-bold">→</text>}
        </g>)}
        {layout.nodes.some(node => node.type === 'enabler' || node.type === 'constraint') && <>
          <text x="24" y={layout.factorY + 18} className="fill-green-800 text-sm font-bold">기여요인</text>
          <text x="488" y={layout.factorY + 18} className="fill-red-800 text-sm font-bold">제약요인</text>
        </>}
        {[...layout.edges.map(edge => ({ edge, candidate: false })), ...layout.candidates.map(edge => ({ edge, candidate: true }))].map(({ edge, candidate }, index) => {
          const active = incident(edge);
          const stroke = edgeColor(edge.relation, candidate);
          const dashed = candidate || edge.relation === 'promotes' || edge.relation === 'hinders';
          const label = relationLabel(edge.relation, candidate);
          return <g key={`${candidate ? 'candidate' : 'confirmed'}:${edge.source}:${edge.relation}:${edge.target}:${index}`} opacity={selectedId && !active ? 0.2 : 1}>
          <title>{label}</title>
          <line data-source={edge.source} data-target={edge.target} data-relation={edge.relation} data-candidate={candidate ? 'true' : 'false'} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke={stroke} strokeWidth={active ? 3 : 1.8} strokeDasharray={dashed ? '6 4' : undefined} markerEnd="url(#ontology-edge-arrow)" />
          <text x={edge.labelX} y={edge.labelY - 4} textAnchor="middle" fill={stroke} className="text-[10px] font-medium">{label}</text>
        </g>;
        })}
        {layout.nodes.map((node) => <g key={node.id} data-node-id={node.id} role="button" tabIndex={0} aria-label={`${node.type}: ${node.title} (${node.displayId}, 원 ID ${node.id})`} aria-pressed={selectedId === node.id} onClick={() => onSelect(node)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); } }} className="cursor-pointer">
          <title>{`${node.title} · 원 ID ${node.id}`}</title>
          <rect x={node.x} y={node.y} width={node.width} height={node.height} rx="8" fill={selectedId === node.id ? '#dbeafe' : node.type === 'enabler' ? '#f0fdf4' : node.type === 'constraint' ? '#fef2f2' : '#ffffff'} stroke={selectedId === node.id ? '#2563eb' : node.type === 'enabler' ? '#16a34a' : node.type === 'constraint' ? '#dc2626' : '#94a3b8'} strokeWidth={selectedId === node.id ? '2.5' : '1'} />
          <text x={node.x + 10} y={node.y + 15} className="fill-slate-500 text-[10px]">{node.type} · {node.displayId}</text>
          <text x={node.x + node.width / 2} y={node.y + 34} textAnchor="middle" className="fill-slate-900 text-xs font-medium">{node.lines.map((line, index) => <tspan key={`${node.id}:line:${index}`} x={node.x + node.width / 2} dy={index === 0 ? 0 : 18}>{line}</tspan>)}</text>
        </g>)}
      </svg>
    </div>}
  </section>;
}

export function OntologyNodeDetails({ node, statement, evidence, onOpenEvidence }: {
  node: OntologyProjectNode;
  statement?: OntologyNodeStatement;
  evidence: OntologyEvidenceSummary[];
  onOpenEvidence: (item: OntologyEvidenceSummary) => void;
}) {
  const evidenceIds = new Set(statement?.evidenceIds ?? []);
  const linkedEvidence = evidence.filter((item) => evidenceIds.has(item.id));
  return <section aria-labelledby="ontology-node-details-title" className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">점 정보</p>
        <h2 id="ontology-node-details-title" className="mt-1 text-lg font-semibold text-gray-900">{node.title || node.id}</h2>
        <p className="mt-1 text-sm text-gray-700">종류: {node.type}</p>
        {node.description && <p className="mt-2 text-sm text-gray-700">{node.description}</p>}
      </div>
      <p className="rounded bg-white px-3 py-2 text-sm text-gray-700">연결된 근거문장 {linkedEvidence.length}건</p>
    </div>
    <section className="mt-4 rounded border border-blue-100 bg-white p-3">
      <h3 className="font-semibold text-gray-900">3단계 신뢰 네 요소 요약</h3>
      {!linkedEvidence.length ? <p className="mt-2 text-sm text-gray-600">연결된 근거가 없어 네 요소는 [확인 필요]입니다.</p> : <div className="mt-3 grid gap-3 md:grid-cols-2">{linkedEvidence.map((item) => <article key={item.id} className="rounded border border-gray-200 p-3">
        <h4 className="text-sm font-medium text-gray-800">{item.sourceTitle || '출처 문서'} · {item.locator || '위치 미확인'}</h4>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <TrustValue label="원문 2-gram 일치도" value={item.quoteMatchPercent === null ? '[확인 필요]' : `${item.quoteMatchPercent}%`} />
          <TrustValue label="진술 성격" value={displayEvidenceLevel(item.evidenceLevel)} />
          <TrustValue label="근거 충분성" value={item.sufficiency.label} note={item.sufficiency.reason} />
          <TrustValue label="상충 근거 수" value={`${item.contradictionCount}건`} />
        </dl>
        <button type="button" onClick={() => onOpenEvidence(item)} className="mt-3 rounded border border-blue-200 px-3 py-2 text-left text-sm text-blue-800 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500">
          {item.quote ? `“${item.quote}”` : '인용문 없음'} · 원문 보기
        </button>
      </article>)}</div>}
    </section>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" disabled className="cursor-not-allowed rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-500">해당 검토 단계로 이동</button>
      <span className="text-sm font-semibold text-amber-800">[확인 필요]</span>
    </div>
  </section>;
}

function TrustValue({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded bg-gray-50 p-2"><dt className="text-xs text-gray-600">{label}</dt><dd className="font-medium text-gray-900">{value}</dd>{note && <dd className="mt-1 text-xs text-gray-500">{note}</dd>}</div>;
}
