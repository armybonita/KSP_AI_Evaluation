'use client';

import type { NoteStatusItem } from '@/lib/note-visibility';
import { useCallback, useEffect, useState } from 'react';
import { ProjectTabs } from '../project-tabs';
import type { OntologyProjectGraph, OntologyProjectNode, OntologySummary } from '@/server/ontology/store';
import {
  getOntologyEvidenceAction,
  getOntologyEvidenceSourceAction,
  getOntologyGenerationAction,
  getOntologyPageAction,
  importOntologyAction,
  startOntologyGenerationAction,
} from './actions';
import { displayEvidenceLevel, InitialTocTable, OntologyGraphView, OntologyNodeDetails } from './ontology-views';
import type { OntologyEvidenceSummary } from './ontology-views';

type AvailableVault = { code: string; name: string };
type Generation = { id: string; state: 'queued' | 'running' | 'completed' | 'failed'; completed_count: number; total_count: number; error_message: string | null; result_json: string | null };
type PageData = OntologySummary & { availableVaults: AvailableVault[]; generation: Generation | null; graph: OntologyProjectGraph };
type EvidenceItem = OntologyEvidenceSummary;
type NumericWarning = { level: 'L1'; unmatchedTokens: string[] } | { level: '[확인 필요]'; reason: string } | null;
type OntologyStatement = { id: string; type: string; title: string; text: string; evidenceIds: string[]; numericWarning: NumericWarning };
type EvidenceResponse = { evidence: EvidenceItem[]; statements: OntologyStatement[] };
type SourceParagraph = { position: 'previous' | 'selected' | 'next'; location: string; content: string };
type SourceViewData = {
  sourceTitle: string;
  locator: string;
  quote: string;
  quoteStatus: 'verified' | 'unverified';
  quoteMatchPercent: number | null;
  paragraphs: SourceParagraph[];
  highlightRange: { start: number; end: number } | null;
};

export function OntologyClientView({ projectId, projectName, canImport, noteItems = [] }: { projectId: string; projectName: string; canImport: boolean; noteItems?: NoteStatusItem[] }) {
  const [data, setData] = useState<PageData | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [statements, setStatements] = useState<OntologyStatement[]>([]);
  const [activeEvidence, setActiveEvidence] = useState<EvidenceItem | null>(null);
  const [sourceView, setSourceView] = useState<SourceViewData | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'toc' | 'graph'>('toc');
  const [selectedCode, setSelectedCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const loadEvidence = useCallback(async () => {
    const body = await getOntologyEvidenceAction(projectId);
    if (!body.success) throw new Error(body.error);
    setEvidence(body.evidence ?? []);
    setStatements(body.statements ?? []);
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await getOntologyPageAction(projectId);
      if (!body.success) throw new Error(body.error);
      setData(body);
      setSelectedCode((current) => current || body.availableVaults[0]?.code || '');
      await loadEvidence();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '온톨로지 결과를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [loadEvidence, projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!['queued', 'running'].includes(data?.generation?.state ?? '')) return;
    const timer = window.setInterval(async () => {
      try {
        const body = await getOntologyGenerationAction(projectId);
        if (!body.success) return;
        setData((current) => current ? { ...current, generation: body.generation } : current);
        if (body.generation && !['queued', 'running'].includes(body.generation.state)) void load();
      } catch { /* 다음 주기에 다시 읽는다. */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [data?.generation?.state, load, projectId]);

  async function runImport() {
    if (!selectedCode) return;
    setImporting(true);
    setError('');
    try {
      const body = await importOntologyAction(projectId, selectedCode);
      if (!body.success) throw new Error(body.error);
      setData(body);
      setSelectedNodeId(null);
      await loadEvidence();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '가져오기를 완료하지 못했습니다.');
    } finally {
      setImporting(false);
    }
  }

  async function runGenerate() {
    setGenerating(true);
    setError('');
    try {
      const body = await startOntologyGenerationAction(projectId);
      if (!body.success) throw new Error(body.error);
      setData((current) => current ? { ...current, generation: body.generation } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '생성을 시작하지 못했습니다.');
    } finally { setGenerating(false); }
  }

  const generatedResult = data?.generation?.result_json ? safeParseResult(data.generation.result_json) : null;
  const warnedStatements = statements.filter((statement) => statement.numericWarning !== null);
  const selectedNode = data?.graph.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedStatement = selectedNode ? statements.find((statement) => statement.id === selectedNode.id) : undefined;

  async function openSource(item: EvidenceItem) {
    setActiveEvidence(item);
    setSourceView(null);
    setSourceError('');
    setSourceLoading(true);
    try {
      const body = await getOntologyEvidenceSourceAction(projectId, item.id);
      if (!body.success) throw new Error(body.error);
      setSourceView(body.source);
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : '원문 문단을 불러오지 못했습니다.');
    } finally {
      setSourceLoading(false);
    }
  }

  const closeSource = useCallback(() => {
    setActiveEvidence(null);
    setSourceView(null);
    setSourceError('');
  }, []);

  useEffect(() => {
    if (!activeEvidence) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeSource(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activeEvidence, closeSource]);

  return <main className="mx-auto max-w-6xl p-6">
    <h1 className="text-2xl font-bold text-gray-900">{projectName} · 온톨로지</h1>
    <ProjectTabs projectId={projectId} activeScreen="ontology" />
    <section className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-5">
      <h2 className="text-lg font-semibold">올린 자료에서 만들기</h2>
      <p className="mt-1 text-sm text-gray-700">이 사업에 포함되고 추출이 완료된 문단만 사용합니다. 문서별 생성 결과는 기존 검사 규칙으로 확인합니다.</p>
      <div className="mt-4 flex items-center gap-3">
        {canImport ? <button type="button" onClick={() => void runGenerate()} disabled={generating || loading || ['queued', 'running'].includes(data?.generation?.state ?? '')} className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{generating ? '시작 중…' : '올린 자료에서 만들기'}</button> : <span className="text-sm text-gray-600">생성은 로그인한 사용자만 할 수 있습니다.</span>}
        {data?.generation && <span role="status" className="text-sm text-gray-700">{generationLabel(data.generation)}</span>}
      </div>
      {data?.generation?.state === 'failed' && data.generation.error_message && <p role="alert" className="mt-3 text-sm text-red-700">{data.generation.error_message}</p>}
      {generatedResult && data?.generation?.state === 'completed' && <p className="mt-3 text-sm text-gray-700">완료 · 점 {generatedResult.nodeCount}개 · 관계 {generatedResult.edgeCount}개 · 문서 성공 {generatedResult.documentSuccessCount}건 / 실패 {generatedResult.documentFailureCount}건 · 버린 인용 {generatedResult.discardedQuoteCount}건</p>}
      {generatedResult && data?.generation?.state === 'completed' && (generatedResult.excludedDocuments?.length ?? 0) > 0 && <div className="mt-3 text-sm text-amber-900">
        <h3 className="font-semibold">AI 입력에서 제외된 문서</h3>
        <ul className="mt-1 list-disc pl-5">{generatedResult.excludedDocuments?.map((doc) => <li key={doc.documentId}>문서 {doc.documentId}: {doc.reasons.join(' · ')}</li>)}</ul>
      </div>}
    </section>
    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-lg font-semibold">가상 볼트 가져오기</h2>
      <p className="mt-1 text-sm text-gray-600">저장소의 가상 사업 자료만 선택할 수 있습니다. 볼트 파일 올리기는 지원하지 않습니다.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label htmlFor="ontology-vault" className="text-sm font-medium">가상 사업</label>
        <select id="ontology-vault" className="rounded border border-gray-300 px-3 py-2" value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)} disabled={!canImport || importing || !data}>
          {(data?.availableVaults ?? []).map((vault) => <option key={vault.code} value={vault.code}>{vault.name} ({vault.code})</option>)}
        </select>
        {canImport ? <button type="button" onClick={() => void runImport()} disabled={importing || loading || !selectedCode} className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{importing ? '가져오는 중…' : '가져오기'}</button> : <span className="text-sm text-gray-600">가져오기는 로그인한 사용자만 할 수 있습니다.</span>}
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded border border-gray-300 px-3 py-2 text-sm">새로고침</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    </section>

    {loading ? <p className="mt-6 text-sm text-gray-600">불러오는 중…</p> : data?.import ? <>
      <nav aria-label="목차 보기 전환" className="mt-6 flex gap-2">
        <button type="button" aria-pressed={viewMode === 'toc'} onClick={() => setViewMode('toc')} className={`rounded border px-3 py-2 text-sm font-medium ${viewMode === 'toc' ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-300 bg-white text-gray-700'}`}>단순 목차</button>
        <button type="button" aria-pressed={viewMode === 'graph'} onClick={() => setViewMode('graph')} className={`rounded border px-3 py-2 text-sm font-medium ${viewMode === 'graph' ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-300 bg-white text-gray-700'}`}>상세 그래프</button>
      </nav>
      {viewMode === 'toc'
        ? <InitialTocTable noteItems={noteItems} nodes={data.graph.nodes} selectedId={selectedNodeId} onSelect={(node) => setSelectedNodeId(node.id)} />
        : <OntologyGraphView nodes={data.graph.nodes} edges={data.graph.edges} candidates={data.graph.candidates} selectedId={selectedNodeId} onSelect={(node) => setSelectedNodeId(node.id)} />}
      {selectedNode && <OntologyNodeDetails node={selectedNode} statement={selectedStatement} evidence={evidence} onOpenEvidence={(item) => void openSource(item)} />}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <CountTable title="점 종류별 수" label="점 종류" rows={data.nodeCounts.map(({ type, count }) => [type, count])} />
        <CountTable title="관계 필드별 수" label="관계 필드" rows={data.edgeCounts.map(({ relation, count }) => [relation, count])} />
      </div>
      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">검사 결과</h2>
        <p className="mt-1 text-sm text-gray-600">오류 {data.import.error_count}건 · 경고 {data.import.warning_count}건</p>
        {data.issues.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">심각도</th><th className="p-2">규칙</th><th className="p-2">파일</th><th className="p-2">필드</th><th className="p-2">메시지</th></tr></thead><tbody>{data.issues.map((issue) => <tr key={issue.id} className="border-b"><td className={`p-2 ${issue.severity === 'error' ? 'text-red-700' : 'text-amber-700'}`}>{issue.severity === 'error' ? '오류' : '경고'}</td><td className="p-2">{issue.rule}</td><td className="p-2">{issue.file}</td><td className="p-2">{issue.field}</td><td className="p-2">{issue.message}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-gray-600">표시할 검사 결과가 없습니다.</p>}
      </section>
    </> : <p className="mt-6 rounded border border-dashed p-6 text-sm text-gray-600">아직 가져온 온톨로지가 없습니다. 가상 사업을 선택해 가져오기를 실행하세요.</p>}

    {data?.import && <>
      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">근거문장 · 신뢰 표시</h2>
        <p className="mt-1 text-sm text-gray-600">원문 대조를 통과한 인용만 판정 근거로 셉니다. 85%는 검증 전 표시용 참고선입니다.</p>
        {!evidence.length ? <p className="mt-3 text-sm text-gray-600">표시할 근거문장이 없습니다.</p> : <div className="mt-3 grid gap-3">
          {evidence.map((item) => <button key={item.id} type="button" onClick={() => void openSource(item)} className="rounded border border-gray-200 p-4 text-left hover:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500">
            <span className="font-medium text-gray-900">{item.sourceTitle || '출처 문서'} · {item.locator || '위치 미확인'}</span>
            <span className={`ml-2 text-sm ${item.countsAsRationale ? 'text-green-700' : 'text-amber-700'}`}>{item.countsAsRationale ? '원문 확인 · 판정 근거' : '미확인 · 판정 근거 제외'}</span>
            <p className="mt-2 text-sm text-gray-800">{item.quote ? `“${item.quote}”` : '인용문 없음'}</p>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <TrustValue label="원문 2-gram 일치도" value={item.quoteMatchPercent === null ? '[확인 필요]' : `${item.quoteMatchPercent}%`} note="85% [확인 필요] · 합격 기준 아님" />
              <TrustValue label="진술 성격" value={displayEvidenceLevel(item.evidenceLevel)} />
              <TrustValue label="근거 충분성" value={item.sufficiency.label} note={item.sufficiency.reason} />
              <TrustValue label="상충 근거 수" value={`${item.contradictionCount}건`} />
            </dl>
            <span className="mt-3 inline-block text-sm font-semibold text-blue-700">원문 보기</span>
          </button>)}
        </div>}
      </section>

      {warnedStatements.length > 0 && <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold">가져오거나 수정한 문안의 수치 확인</h2>
        <div className="mt-3 grid gap-3">
          {warnedStatements.map((statement) => <article key={statement.id} className="rounded border border-gray-200 p-4">
            <h3 className="font-medium">{statement.title || statement.id}</h3>
            <p className="mt-1 text-sm text-gray-800">{statement.text}</p>
            {statement.numericWarning?.level === 'L1' && <p role="status" className="mt-2 text-sm text-amber-800">L1 경고 · 인용 원문에 없는 수치·단위: {statement.numericWarning.unmatchedTokens.join(', ')}</p>}
            {statement.numericWarning?.level === '[확인 필요]' && <p role="status" className="mt-2 text-sm text-amber-800">[확인 필요] · {statement.numericWarning.reason}</p>}
          </article>)}
        </div>
      </section>}
    </>}

    <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-lg font-semibold">가져오기 이력</h2>
      {!data?.history.length ? <p className="mt-2 text-sm text-gray-600">이력이 없습니다.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">시각</th><th className="p-2">원천 / 코드</th><th className="p-2">모델</th><th className="p-2">점</th><th className="p-2">선</th><th className="p-2">근거</th><th className="p-2">원본</th><th className="p-2">문서 성공 / 실패</th><th className="p-2">오류 / 경고</th><th className="p-2">버린 인용</th><th className="p-2">실행자</th></tr></thead><tbody>{data.history.map((item) => <tr key={item.id} className="border-b"><td className="p-2">{new Date(item.imported_at).toLocaleString('ko-KR')}</td><td className="p-2">{item.source_kind === 'generated' ? '올린 자료에서 생성' : `가상 볼트 · ${item.vault_code}`}</td><td className="p-2">{item.model_name ?? '—'}</td><td className="p-2">{item.node_count}</td><td className="p-2">{item.edge_count}</td><td className="p-2">{item.snippet_count}</td><td className="p-2">{item.source_count}</td><td className="p-2">{item.document_success_count} / {item.document_failure_count}</td><td className="p-2">{item.error_count} / {item.warning_count}</td><td className="p-2">{item.discarded_quote_count}</td><td className="p-2">{item.executor}</td></tr>)}</tbody></table></div>}
    </section>

    {activeEvidence && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSource(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="source-view-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="source-view-title" className="text-lg font-semibold">원문 보기</h2>
            <p className="mt-1 text-sm text-gray-600">{sourceView?.sourceTitle ?? activeEvidence.sourceTitle} · {sourceView?.locator ?? activeEvidence.locator}</p>
          </div>
          <button type="button" onClick={closeSource} className="rounded border border-gray-300 px-3 py-1 text-sm">닫기</button>
        </div>
        <p className="mt-3 rounded bg-gray-50 p-3 text-sm text-gray-800">인용 후보: “{sourceView?.quote ?? activeEvidence.quote}”</p>
        {sourceLoading ? <p role="status" className="mt-4 text-sm text-gray-600">원문 문단을 불러오는 중…</p> : sourceError ? <p role="alert" className="mt-4 text-sm text-amber-800">{sourceError}</p> : sourceView?.paragraphs.length ? <div className="mt-4 space-y-2">
          {sourceView.paragraphs.map((paragraph) => <p key={`${paragraph.position}:${paragraph.location}`} className={`rounded p-3 text-sm leading-6 ${paragraph.position === 'selected' ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-gray-50 text-gray-700'}`}>
            <span className="mr-2 text-xs font-semibold text-gray-500">{paragraph.position === 'selected' ? '선택 문단' : paragraph.position === 'previous' ? '앞 문단' : '뒤 문단'} · {paragraph.location}</span>
            <br />{renderHighlightedText(paragraph.content, paragraph.position === 'selected' ? sourceView.highlightRange : null)}
          </p>)}
        </div> : <p className="mt-4 text-sm text-amber-800">원문 문단을 찾지 못해 인용을 미확인으로 표시합니다.</p>}
        <section className="mt-5 border-t border-gray-200 pt-4">
          <h3 className="font-semibold">신뢰 표시</h3>
          <p className="mt-2 text-sm text-gray-700">{sourceView?.quoteStatus === 'verified' ? '원문 확인 · 판정 근거에 포함' : '미확인 · 판정 근거에서 제외'}</p>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <TrustValue label="원문 2-gram 일치도" value={sourceView?.quoteMatchPercent == null ? '[확인 필요]' : `${sourceView.quoteMatchPercent}%`} note="85% [확인 필요] · 합격 기준 아님" />
            <TrustValue label="진술 성격" value={displayEvidenceLevel(activeEvidence.evidenceLevel)} />
            <TrustValue label="근거 충분성" value={activeEvidence.sufficiency.label} note={activeEvidence.sufficiency.reason} />
            <TrustValue label="상충 근거 수" value={`${activeEvidence.contradictionCount}건`} />
          </dl>
        </section>
      </section>
    </div>}
  </main>;
}

function TrustValue({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded bg-gray-50 p-2"><dt className="text-xs text-gray-600">{label}</dt><dd className="font-medium text-gray-900">{value}</dd>{note && <dd className="mt-1 text-xs text-gray-500">{note}</dd>}</div>;
}

function renderHighlightedText(content: string, range: { start: number; end: number } | null) {
  if (!range || range.start < 0 || range.end <= range.start || range.end > content.length) return content;
  return <>{content.slice(0, range.start)}<mark className="rounded bg-yellow-300 px-0.5">{content.slice(range.start, range.end)}</mark>{content.slice(range.end)}</>;
}

function generationLabel(run: Generation): string {
  if (run.state === 'queued') return '대기 중';
  if (run.state === 'running') return `진행 중 ${run.completed_count}/${run.total_count}`;
  if (run.state === 'completed') return '끝';
  return '실패';
}

function safeParseResult(value: string): { nodeCount: number; edgeCount: number; documentSuccessCount: number; documentFailureCount: number; discardedQuoteCount: number; ontologyPreserved?: boolean; excludedDocuments?: Array<{ documentId: string; reasons: string[] }> } | null {
  try { return JSON.parse(value) as ReturnType<typeof safeParseResult>; } catch { return null; }
}

function CountTable({ title, label, rows }: { title: string; label: string; rows: Array<[string, number]> }) {
  return <section className="rounded-lg border border-gray-200 bg-white p-5"><h2 className="text-lg font-semibold">{title}</h2>{rows.length ? <table className="mt-3 w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">{label}</th><th className="p-2">수</th></tr></thead><tbody>{rows.map(([name, count]) => <tr key={name} className="border-b"><td className="p-2">{name}</td><td className="p-2">{count}</td></tr>)}</tbody></table> : <p className="mt-3 text-sm text-gray-600">표시할 자료가 없습니다.</p>}</section>;
}
