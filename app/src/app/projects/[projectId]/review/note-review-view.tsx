'use client';

import React, { useState, useTransition } from 'react';
import type { NoteItem, NoteEvidence } from '@/server/store/note-review';
import type { LinkReview } from '@/server/store/link-review';
import { getManualNumericWarning } from '@/server/ontology/trust';
import { getNoteSourceAction, saveNoteReviewAction, confirmNoteLinkAction, rejectNoteLinkAction } from './note-actions';

const stages = [
  ['④ 산출물', 'output', '산출물'],
  ['⑤ 단기성과', 'outcome-short', '단기성과'],
  ['⑥ 중·장기성과', 'outcome-mid', '중장기성과'],
  ['⑦ 기여·제약요인', 'factor', ''],
] as const;
const errors = ['성과 과장', '근거 부족', '시점 혼동', '주체 혼동', '외부 자료 혼입', '산출물·성과 혼동', '수치 오류', '누락', '기타'];
const states = ['관측됨', '추진 중', '기대/추정', '미확인'];
const text = (value: unknown) => Array.isArray(value) ? value.join(' · ') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';

function sufficiency(evidence: NoteEvidence[]) {
  const verified = evidence.filter(e => e.verified);
  if (verified.some(e => e.level === '입증') || new Set(verified.filter(e => e.level === '관측').map(e => e.sourceId).filter(Boolean)).size >= 2) return '충분';
  return verified.some(e => e.level === '관측') ? '검토 중' : '추가 확인';
}

export function inStage(item: NoteItem, stage: number) {
  const [, type, pdm] = stages[stage];
  if (item.type === 'indicator') {
    const storedStage = text(item.fields.pdm_stage).replace(/[·\s]/g, '');
    const normalizedStage = storedStage === '산출' ? '산출물' : storedStage;
    return normalizedStage === pdm;
  }
  return type === 'factor' ? ['enabler', 'constraint'].includes(item.type) : item.type === type;
}

export function noteReviewStageForNode(items: NoteItem[], selectedNodeId?: string): number {
  const item = selectedNodeId ? items.find((candidate) => candidate.id === selectedNodeId) : undefined;
  if (!item) return 0;
  const stage = stages.findIndex((_, index) => inStage(item, index));
  return stage >= 0 ? stage : 0;
}

export function noteReviewStageForScope(state: { scope: string; stage: number }, scope: string, initialStage: number): number {
  return state.scope === scope ? state.stage : initialStage;
}

export function FactorLists({ items, renderRow }: { items: NoteItem[]; renderRow: (item: NoteItem) => React.ReactNode }) {
  return <>
    <section aria-label="기여요인 목록">
      <h3 className="font-bold">기여요인</h3>
      {items.filter(i => i.type === 'enabler').map(renderRow)}
    </section>
    <section aria-label="제약요인 목록">
      <h3 className="mt-4 font-bold">제약요인</h3>
      {items.filter(i => i.type === 'constraint').map(renderRow)}
    </section>
    <p className="mt-3 text-sm">외부 상황만으로 사업의 제약요인으로 확정하지 않음</p>
  </>;
}

export function NoteReviewView({ projectId, initialData, initialSelectedNodeId, opinionOnly = false, stage: controlledStage, onStageChange }: {
  projectId: string;
  initialData: { importId: string | null; items: NoteItem[]; missingReviewedCount?: number; unknownReviewedCount?: number; missingLinkCount?: number; unknownLinkCount?: number; unknownRelationLinks?: LinkReview[]; splitReviewedCount?: number; splitLinkCount?: number };
  initialSelectedNodeId?: string;
  opinionOnly?: boolean;
  stage?: number;
  onStageChange?: (stage: number) => void;
}) {
  const scope = JSON.stringify([projectId, initialData.importId]);
  const [dataState, setDataState] = useState({ scope, data: initialData });
  const data = dataState.scope === scope ? dataState.data : initialData;
  const setData = (nextData: typeof initialData) => setDataState({ scope, data: nextData });
  const initialStage = noteReviewStageForNode(initialData.items, initialSelectedNodeId);
  const [localStageState, setLocalStageState] = useState({ scope, stage: initialStage });
  const localStage = noteReviewStageForScope(localStageState, scope, initialStage);
  const setLocalStage = (stage: number) => setLocalStageState({ scope, stage });
  const stage = controlledStage ?? localStage;
  const stageKey = JSON.stringify([projectId, data.importId, stage]);
  const [selectedByStage, setSelectedByStage] = useState<Record<string, string>>(
    initialSelectedNodeId ? { [JSON.stringify([projectId, initialData.importId, initialStage])]: initialSelectedNodeId } : {},
  );
  const [drafts, setDrafts] = useState<Record<string, { text: string; reason: string; errorType: string; outcome: string }>>({});
  const [messageState, setMessageState] = useState({ scope, message: '' });
  const message = messageState.scope === scope ? messageState.message : '';
  const setMessage = (message: string) => setMessageState({ scope, message });
  const [sourceState, setSourceState] = useState<{ scope: string; source: { title: string; paragraphs: Array<{ position: string; location: string; content: string }> } | null }>({ scope, source: null });
  const source = sourceState.scope === scope ? sourceState.source : null;
  const setSource = (source: typeof sourceState.source) => setSourceState({ scope, source });
  const [pending, startTransition] = useTransition();
  const items = data.items.filter(i => inStage(i, stage));
  const selectedId = selectedByStage[stageKey] ?? (stage === initialStage ? initialSelectedNodeId : undefined);
  const item = items.find(i => i.id === selectedId) ?? items[0];
  const last = item?.history.at(-1);
  const draftKey = item ? JSON.stringify([projectId, data.importId, stage, item.id]) : '';
  const saved = drafts[draftKey];
  const current = saved?.text ?? last?.text ?? item?.text ?? '';
  const outcome = saved?.outcome ?? last?.outcome_state ?? (states.includes(text(item?.fields.outcome_state_ai)) ? text(item?.fields.outcome_state_ai) : '미확인');
  const reason = saved?.reason ?? '';
  const errorType = saved?.errorType ?? '';
  const locked = !!last && ['확정', '수정 후 확정', '채택 제외'].includes(last.status);

  function updateDraft(update: Partial<{ text: string; reason: string; errorType: string; outcome: string }>) {
    if (!item) return;
    setDrafts(previous => ({ ...previous, [draftKey]: { text: current, reason, errorType, outcome, ...update } }));
  }
  function changeStage(nextStage: number) {
    if (nextStage === stage) return;
    setLocalStage(nextStage);
    onStageChange?.(nextStage);
    setMessage('');
    setSource(null);
  }
  function choose(i: NoteItem) {
    setSelectedByStage(previous => ({ ...previous, [stageKey]: i.id }));
    setMessage('');
    setSource(null);
  }
  function action(status: string) {
    if (!item || !data.importId) return;
    startTransition(async () => {
      const result = await saveNoteReviewAction(projectId, data.importId!, item.id, { status, text: current, outcomeState: outcome, reason, errorType });
      if (!result.success) { setMessage(result.error); return; }
      setData(result.data);
      setDrafts(previous => {
        if (previous[draftKey] !== saved) return previous;
        const next = { ...previous };
        delete next[draftKey];
        return next;
      });
      setSelectedByStage(previous => ({ ...previous, [stageKey]: item.id }));
      setMessage('저장했습니다.');
    });
  }
  async function openSource(e: NoteEvidence) {
    const result = await getNoteSourceAction(projectId, e.id);
    if (result.success) setSource({ title: result.source.sourceTitle, paragraphs: result.source.paragraphs });
    else setMessage(result.error);
  }
  const row = (i: NoteItem) => <button key={i.id} type="button" aria-pressed={i.id === item?.id} onClick={() => choose(i)} className={`block w-full border-b p-2 text-left text-sm ${i.id === item?.id ? 'bg-blue-50 ring-1 ring-blue-300' : ''}`}>
    <span aria-label="검토 상태">● {i.history.at(-1)?.status ?? '미검토'}</span> {i.title} <small>{i.history.at(-1)?.outcome_state ?? text(i.fields.outcome_state_ai)}</small>
    {i.splitPending && <small className="block">{i.mergeCount && i.mergeCount >= 2 ? `이전 노트 ${i.mergeCount}개가 하나로 합쳐짐 — 다시 확인 필요` : '이전 확정 있음 — 둘 이상으로 나뉨, 다시 확인 필요'}</small>}
    {!!i.uncertainHistory?.length && <small className="block">이전 검토 있음 — 다시 확인 필요</small>}
    {!!i.renamedHistory?.length && <small className="block">이전 검토 있음 — 이름 바뀜, 다시 확인 필요</small>}
    {!i.evidence.length && <small className="block">근거 자료 미확보</small>}
    {i.evidence.filter(e => e.quote === '[인용 금지 문장]').map(e => <small key={e.id} className="block">인용 금지 문장 있음 · {e.sourceTitle} · {e.location || '위치 미확인'}</small>)}
  </button>;
  const ev = (e: NoteEvidence) => <article key={e.id} className="rounded border p-2 text-sm">
    {e.quote === '[인용 금지 문장]' ? <p>인용 금지 문장 있음 · {e.sourceTitle} · {e.location || '위치 미확인'}</p> : <>
      <blockquote>“{e.quote}”</blockquote>
      <p>{e.sourceTitle} · {e.date || '날짜 미확인'} · 진술 성격 {e.level || '미확인'} · 말한 주체 {e.speaker || '미확인'}</p>
      <button type="button" className="text-blue-700 underline" onClick={() => openSource(e)}>원문 보기</button>
    </>}
  </article>;
  const mergedEvidenceCounts = item ? Object.values(item.evidence.reduce<Record<string, number>>((counts, e) => { counts[e.sourceId] = (counts[e.sourceId] ?? 0) + 1; return counts; }, {})) : [];
  const numeric = item ? getManualNumericWarning(current, item.evidence.filter(e => e.verified).map(e => e.quote)) : null;
  const props: Array<[string, string]> = [
    ['target', '목표'], ['actual', '실적'], ['verification_source', '검증 자료'], ['outcome_family', '성과군'],
    ['outcome_type', 'KSP 성과유형'], ['eipp_class', 'EIPP 분류'], ['factor_class', '요인 분류'],
    ['output_type', '산출물 유형'], ['timing', '발현 시점'], ['level_ai', '레벨(AI 제안)'],
    ['promotes', '촉진하는 성과'], ['hinders', '저해하는 성과'], ['response', '대응 노력'],
  ];
  if (!data.items.length) return <div className="p-4"><p>검토할 노트가 없습니다.</p></div>;
  return <section className="mx-auto max-w-7xl space-y-4 p-4" aria-label="온톨로지 노트 검토">
    <h2 className="text-xl font-bold">④~⑦ 노트 검토</h2>
    {!!data.unknownReviewedCount && <p>이전 생성에서 검토한 종류 불명 노트 {data.unknownReviewedCount}건</p>}
    {!!data.unknownLinkCount && <p>이전 생성에서 검토한 종류 불명 연결 {data.unknownLinkCount}건</p>}
    {!!data.unknownRelationLinks?.length && <details><summary>관계 불명 확정 {data.unknownRelationLinks.length}건</summary>{data.unknownRelationLinks.map(l => <p key={l.id}>{l.source_title ?? l.source_id} ({l.source_id}) → {l.target_title ?? l.target_id} ({l.target_id}) · {l.reviewer} · {l.created_at}</p>)}</details>}
    {!!data.missingLinkCount && <p>이전 생성에서 확정했으나 이번 생성에 없는 연결 {data.missingLinkCount}건</p>}
    {!!data.splitLinkCount && <p>나뉨·합쳐짐 연결 {data.splitLinkCount}건</p>}
    {!!data.splitReviewedCount && <p>이전 검토가 나뉨·합쳐짐 노트 {data.splitReviewedCount}건</p>}
    {!!data.missingReviewedCount && <p>이전 생성에서 검토했으나 이번 생성에 없는 노트 {data.missingReviewedCount}건</p>}
    <nav className="flex flex-wrap gap-2" aria-label="검토 단계">
      {stages.map(([label], index) => {
        const all = data.items.filter(i => inStage(i, index));
        return <button type="button" key={label} aria-pressed={stage === index} data-testid={`note-stage-${index}`}
          className="rounded border px-3 py-2" onClick={() => changeStage(index)}>
          {label} {all.filter(i => i.history.length).length}/{all.length}
        </button>;
      })}
    </nav>
    <div className="grid gap-4 lg:grid-cols-3">
      <aside className="rounded border p-4">
        {stage === 3 ? <FactorLists items={items} renderRow={row} /> : <>
          <h3 className="font-bold">성과지표 기준 충족 여부</h3>
          {items.filter(i => i.type === 'indicator').map(row)}
          <h3 className="mt-4 font-bold">성과지표 외 AI 제안</h3>
          {items.filter(i => i.type !== 'indicator').map(row)}
        </>}
      </aside>
      {item ? <>
        <div className="space-y-3 rounded border p-4">
          <h3 className="font-bold">{opinionOnly ? 'PO 수정 의견' : '판단 문안'} · {item.title}</h3>
          <textarea aria-label={opinionOnly ? '수정 의견' : '판단 문안'} className="w-full rounded border p-2" rows={5}
            disabled={locked && !opinionOnly} value={current} onChange={e => {
              updateDraft({ text: e.target.value });
            }} />
          {text(item.fields.po_opinion) && <p>PO 수정 의견: {text(item.fields.po_opinion)}</p>}
          {current !== (item.history[0]?.original_text ?? item.text) && <p>AI 최초 제안: <s>{item.history[0]?.original_text ?? item.text}</s></p>}
          {numeric && <p role="alert">원문 근거에 없는 수치 (가드레일 {numeric.level}): {numeric.level === 'L1' ? numeric.unmatchedTokens.join(', ') : numeric.reason}</p>}
          <p>원문 일치: {item.evidence.some(e => e.verified) ? '확인' : '확인 필요'} · 근거 충분성: {sufficiency(item.evidence)} · 상충 근거: {item.contradictions.length}건</p>
          <dl>{props.map(([key, label]) => {
            const value = text(item.fields[key]) || item.relations.filter(r => r.relation === key).map(r => r.target).join(' · ');
            return value ? <div key={key}><dt className="font-bold">{label}</dt><dd>{value}{key === 'level_ai' && ' — 기준 합의 전'}</dd></div> : null;
          })}</dl>
          {stage === 3 && !item.relations.some(r => ['promotes', 'hinders'].includes(r.relation)) && !text(item.fields.promotes) && !text(item.fields.hinders) && <p>운영상 특이사항</p>}
          {!opinionOnly && stage === 2 && item.candidates.map(c => <p key={`${c.source}:${c.relation}`}>
            {c.relation === 'targets' ? '사업 연결' : '단기성과 연결'}: {c.title} · {c.status} {c.unknownRelation && '같은 노트 쌍에 관계 불명 옛 확정 있음'} {c.splitLink && '이전 확정 연결 있음 — 나뉨, 다시 확인 필요'}
            {c.status !== '확정' && <button type="button" disabled={pending} onClick={() => startTransition(async () => {
              const result = await confirmNoteLinkAction(projectId, data.importId!, c.source, item.id, c.relation);
              if (result.success) setData(result.data); else setMessage(result.error);
            })}>연결 확정</button>}
            {c.status === 'AI 후보' && <button type="button" disabled={pending} onClick={() => startTransition(async () => {
              const result = await rejectNoteLinkAction(projectId, data.importId!, c.source, item.id, c.relation, reason, errorType);
              if (result.success) setData(result.data); else setMessage(result.error);
            })}>기각</button>}
          </p>)}
          {stage === 2 && outcome !== '관측됨' && <p>평가결과: 성과 미확인 · 보완: 후속 모니터링 자료</p>}
          {!opinionOnly && <label>성과 상태 바꾸기 <select value={outcome} disabled={locked} onChange={e => updateDraft({ outcome: e.target.value })}>
            {states.map(s => <option key={s}>{s}</option>)}
          </select></label>}
        </div>
        <div className="space-y-3 rounded border p-4">
          <h3 className="font-bold">{stage === 3 ? '내부 평가근거' : '근거 문장'}</h3>
          {item.evidence.length ? item.evidence.map(ev) : <p>근거 자료 미확보</p>}
          {stage === 3 && <><h3 className="font-bold">외부 보조자료</h3><p>등록된 자료 없음 · 허용 출처 · 게시일 · 검색일 · 검색 범위 · 사업기간 관련성</p></>}
          <h3 className="font-bold">반대·상충 근거</h3>
          {item.contradictions.length ? item.contradictions.map(ev) : <p>탐지되지 않았다는 사실이 반대 근거의 부재를 보장하지는 않음</p>}
          <h3 className="font-bold">AI 메모 (불확실성·한계)</h3>
          <p>{text(item.sections['불확실성·반대 근거'] ?? item.sections['확인 필요'] ?? item.sections['가정·위험']) || '기록 없음'}</p>
        </div>
      </> : <p>이 단계에 검토할 노트가 없습니다.</p>}
    </div>
    {item && <div className="space-y-2 rounded border p-4">
      <p>현재 {last?.status ?? '미검토'} {last && `· ${last.reviewer} · ${last.created_at} · 이력 ${item.history.length}건`}</p>
      {opinionOnly ? <button type="button" className="rounded border px-3 py-1" disabled={pending} onClick={() => action('수정 의견')}>수정 의견 저장</button> : locked ? <button type="button" disabled={pending} onClick={() => action('수정 중')}>새 이력으로 수정</button> : <>
        <div className="flex flex-wrap gap-2">
          {[
            ['확정', '확정'], ['수정 중', '수정 중'],
            ['수정 완료', current === item.text ? '확정' : '수정 후 확정'],
            ['보완 필요', '보완 필요'], ['채택 제외', '채택 제외'],
          ].map(([label, status]) => <button key={label} type="button" className="rounded border px-3 py-1"
            disabled={pending} onClick={() => action(status)}>{label}</button>)}
        </div>
      </>}
      <label>사유 <input className="rounded border p-1" value={reason} onChange={e => updateDraft({ reason: e.target.value })} /></label>{' '}
      <label>오류 유형 <select value={errorType} onChange={e => updateDraft({ errorType: e.target.value })}>
        <option value="">선택</option>{errors.map(e => <option key={e}>{e}</option>)}
      </select></label>
      {message && <p role="status">{message}</p>}
      {item.splitPending && <p>{item.mergeCount && item.mergeCount >= 2 ? `이전 노트 ${item.mergeCount}개가 하나로 합쳐짐 — 다시 확인 필요` : '이전 확정 있음 — 둘 이상으로 나뉨, 다시 확인 필요'}</p>}
      {!!item.splitHistory?.length && <details><summary>이전 이력 보기</summary>{item.splitHistory.map(h => <p key={h.id}>{h.old_title} · {h.status} · {h.reviewer} · {h.created_at} · {h.text}</p>)}</details>}
      {!!item.uncertainHistory?.length && <details><summary>이전 검토 있음 — 다시 확인 필요 · 이전 이력 보기</summary>{item.uncertainHistory.map(h => <p key={h.id}>{h.status} · {h.reviewer} · {h.created_at} · {h.text}</p>)}</details>}
      {!!item.renamedHistory?.length && <details><summary>이전 검토 있음 — 이름 바뀜, 다시 확인 필요 · 이전 이력 보기</summary>{item.renamedHistory.map(h => <p key={h.id}>{h.node_id} · {h.status} · {h.reviewer} · {h.created_at} · {h.text}</p>)}</details>}
      {item.fields.merged_same_document === true && mergedEvidenceCounts.length > 0 && <p>한 문서의 같은 이름 근거 {Math.max(...mergedEvidenceCounts)}건을 합침 — 서로 다른 성과면 기각 뒤 나눠 확인</p>}
      {!!item.splitLinkHistory?.length && <details><summary>나뉜 연결 이력</summary>{item.splitLinkHistory.map(h => <p key={h.id}>{h.source_title ?? h.source_id} → {h.target_title ?? h.target_id} · {h.relation} · {h.reviewer} · {h.created_at}</p>)}</details>}
      {!!item.linkHistory?.length && <details><summary>연결 검토 이력</summary>{item.linkHistory.map((h, index) => <p key={`${h.id}:${index}`}>{h.source_title ?? h.source_id} → {h.target_title ?? h.target_id} · {h.relation} · {h.status} · {h.reason} · {h.error_type} · {h.reviewer} · {h.created_at}</p>)}</details>}
      <details><summary>검토 이력</summary>{item.history.map(h => <p key={h.id}>{h.status} · {h.reviewer} · {h.created_at} · {h.reason} · {h.text}</p>)}</details>
    </div>}
    {source && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <section role="dialog" aria-modal="true" aria-label="원문 보기" className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded bg-white p-4">
        <h3>원문 보기 · {source.title}</h3>
        {source.paragraphs.length ? source.paragraphs.map(p => <p key={p.position}>{p.location}: {p.content}</p>) : <p>원문 위치를 찾을 수 없습니다.</p>}
        <button type="button" onClick={() => setSource(null)}>닫기</button>
      </section>
    </div>}
  </section>;
}
