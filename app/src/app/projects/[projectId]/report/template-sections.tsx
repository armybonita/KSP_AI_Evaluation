import React from 'react';
import type { ReportDraftData, ReportSection, ReportSentenceItem } from '@/server/report/types';

type Source = 'human' | 'ai' | 'document' | 'missing';
const sourceLabels: Record<Source, string> = { human: '사람 확정', ai: 'AI 제안', document: '문서 원문', missing: '근거 미확보' };

function SourceBadge({ source }: { source: Source }) {
  return <span data-testid={`report-source-${source}`} className={`mr-2 inline-block rounded px-2 py-0.5 text-xs font-semibold ${source === 'ai' ? 'bg-violet-100 text-violet-800' : source === 'human' ? 'bg-emerald-50 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>{sourceLabels[source]}</span>;
}

export function TemplateSections({ draft, onSelect }: { draft: ReportDraftData; onSelect: (sentence: ReportSentenceItem) => void }) {
  const notes = draft.footnotes ?? [];
  const selectNote = (id: string, sentence?: ReportSentenceItem) => {
    const note = notes.find(item => item.evidence_id === id);
    if (!note) return;
    const evidence = sentence?.evidences?.find(item => item.id === id) ?? {
      id, quote: note.quote ?? '', location: note.location ?? '', speaker: note.speaker ?? '', document_name: note.document_name,
      review_status: note.review_status, evidence_level: note.evidence_level, confidence: note.confidence,
      confirmer_role: note.confirmer_role, confirmed_at: note.confirmed_at,
    };
    onSelect({ indicator_id: sentence?.indicator_id ?? note.indicator_id ?? '', indicator_name: sentence?.indicator_name ?? note.indicator_name ?? '연결 항목', sentence: sentence?.sentence ?? note.quote ?? '', evidence_id: id, evidence_ids: [id], evidences: [evidence] });
  };
  const refs = (ids: string[], sentence?: ReportSentenceItem) => ids.map(id => notes.find(note => note.evidence_id === id)).filter(note => note !== undefined).map(note => <button key={note.evidence_id} type="button" data-testid={`report-footnote-${note.number}`} aria-label={`근거 각주 ${note.number} 열기`} className="font-semibold text-blue-700 underline" onClick={() => selectNote(note.evidence_id, sentence)}><sup>[{note.number}]</sup></button>);
  const render = (section: ReportSection): React.ReactNode => <section key={section.id} className="space-y-2 pt-3" data-testid={`report-template-${section.id}`}>
    <div role="heading" aria-level={section.level} className="font-bold text-gray-900">{section.title}{section.source && <span className="ml-2"><SourceBadge source={section.source} /></span>}</div>
    {section.table && <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr>{section.table.columns.map((column, index) => <th className="border-b border-gray-300 px-2 py-2" key={index}>{column}</th>)}</tr></thead><tbody>{section.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className={`border-b border-gray-200 px-2 py-2 align-top ${cell.source === 'ai' ? 'bg-violet-50' : ''}`}>{!cell.is_label && <SourceBadge source={cell.source} />}{cell.text}{refs(cell.evidence_ids ?? [])}</td>)}</tr>)}</tbody></table></div>}
    {section.rows && section.rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>지표명</th><th>목표치</th><th>판정 결과</th><th>근거</th></tr></thead><tbody>{section.rows.map(row => <tr key={row.indicator_id} id={`achievement-row-${row.indicator_id}`} data-testid={`achievement-row-${row.indicator_id}`}><td>{row.indicator_name}{row.is_orphaned ? ' (문서에서 사라진 지표)' : ''}</td><td>{row.target_value}</td><td>{row.status_display}{row.confirmation_type === '수정 후 확정' && row.edited_text ? ` [수정본] ${row.edited_text}` : ''}{row.evidence_match_warning && <p data-testid={`evidence-match-warning-${row.indicator_id}`} className="text-xs font-medium text-amber-800">{row.evidence_match_warning}</p>}</td><td>{row.evidence_id ? refs([row.evidence_id]) : '근거 미확인'}</td></tr>)}</tbody></table></div>}
    {section.sentences?.map((sentence, index) => <p key={`${sentence.indicator_id}-${index}`} className={`rounded p-2 ${sentence.source === 'ai' ? 'bg-violet-50' : ''}`}><SourceBadge source={sentence.source ?? 'human'} />{sentence.node_label && <span className="mr-2 font-semibold">{sentence.node_label}</span>}<button type="button" data-testid={`select-sentence-${sentence.indicator_id}-${index}`} aria-label={`근거: ${sentence.indicator_name}`} aria-describedby={`sentence-description-${section.id}-${index}`} className="text-left underline decoration-dotted" onClick={() => onSelect(sentence)}>{sentence.sentence}</button><span id={`sentence-description-${section.id}-${index}`} className="sr-only">{sentence.sentence}</span>{sentence.evidence_ids?.length || sentence.evidence_id ? refs(sentence.evidence_ids?.length ? sentence.evidence_ids : [sentence.evidence_id], sentence) : ''}{sentence.evidence_match_warning && <span data-testid={`evidence-match-warning-${sentence.indicator_id}-${index}`} className="ml-2 text-xs font-medium text-amber-800">{sentence.evidence_match_warning}</span>}</p>)}
    {section.content && <p>{section.content}</p>}
    {section.empty_message && <p className="text-sm italic text-gray-500"><SourceBadge source="missing" /><span>{section.empty_message}</span></p>}
    {section.children?.map(render)}
  </section>;
  return <>{draft.report_sections?.map(render)}{notes.length > 0 && <section><h2 className="font-bold">근거 각주</h2>{notes.map(note => <p key={note.evidence_id}><button type="button" className="text-blue-700 underline" data-testid={`report-footnote-entry-${note.number}`} onClick={() => selectNote(note.evidence_id)}>[{note.number}] {note.document_name || '문서명 미확인'} · {note.location || '위치 미확인'}</button></p>)}</section>}</>;
}
