import { overviewFields } from './overview-fields';
import { isConfirmedNonPastReport } from '../documents/holdout';
import { getNoteReviewData, type NoteItem } from '../store/note-review';
import { getDatabase, getParagraphsByDocument, listDocuments } from '../store';
import { reportBannedParagraphIds, reportEvidenceDetails, reportIndicatorLevels, reportIndicatorReview, reportSourceRows } from '../store/report-input';
import { getAiDocumentEligibilityForProvider } from '../documents/ai-eligibility';
import { hasForbiddenSentenceOverlap, isCitationBannedSentence } from '../store/citation-ban';
import { checkNumericConsistency } from '../numeric-check';
import { getAiClient, getAiProvider, type AiClient } from '../ai';
import type { ReportCell, ReportDraftData, ReportFootnote, ReportSection, ReportSentenceItem } from './types';
import { reportTemplateSource } from './templates';
import { AiEligibilityChangedError, createProjectEligibilityGuard } from '../documents/eligibility-fingerprint';

const missing = '※ 근거 자료 미확보';
const missingCell = (): ReportCell => ({ text: missing, source: 'missing' });
const label = (text: string): ReportCell => ({ text, source: 'human' });
const documentValue = (text: string, evidenceIds: string[] = []): ReportCell => ({ text, source: 'document', evidence_ids: evidenceIds });
function monitoringTime(sentence: ReportSentenceItem): string {
  const text = [sentence.sentence, ...(sentence.evidences ?? []).map(evidence => evidence.quote)].join(' ');
  const match = text.match(/\bN\s*\+\s*\d+(?:\s*[~〜–-]\s*\d+)?/i);
  return match?.[0].replace(/\s+/g, '') ?? '※ 확인 필요';
}

type EligibleNode = { item: NoteItem; review: NoteItem['history'][number]; evidence: NoteItem['evidence'] };

/** Builds only from reviewed nodes with project-owned, included and AI-eligible documents. */
export async function populateReportSummary(draft: ReportDraftData, projectId: string, client: AiClient | undefined, banned: string[], db: ReturnType<typeof getDatabase> = getDatabase(), indicatorGenerationFailed = false, eligibilityGuard: () => void = createProjectEligibilityGuard(projectId, db)): Promise<void> {
  const data = getNoteReviewData(projectId, db);
  draft.review_pending_count = data.items.filter(item => !['확정', '수정 후 확정', '채택 제외'].includes(item.history.at(-1)?.status ?? '') || item.splitPending).length + data.missingReviewedCount + data.unknownReviewedCount + data.missingLinkCount + data.unknownLinkCount + data.splitReviewedCount + data.splitLinkCount;
  const documents = new Map(listDocuments(projectId, db).map(d => [d.id, d]));
  const sourceRows = reportSourceRows(projectId, data.importId, db);
  const eligibleSources = new Set<string>();
  const sourceDocuments = new Map<string, string>();
  for (const row of sourceRows) {
    try {
      const source = JSON.parse(row.data_json) as { document_id?: string };
      const doc = source.document_id ? documents.get(source.document_id) : undefined;
      if (doc?.is_included === 1 && getAiDocumentEligibilityForProvider(doc, client?.provider ?? getAiProvider()).eligible) { eligibleSources.add(row.id); sourceDocuments.set(row.id, doc.id); }
    } catch { /* malformed source is not eligible */ }
  }
  const nodes: EligibleNode[] = data.items.flatMap(item => {
    const review = item.history.at(-1);
    if (!review || !['확정', '수정 후 확정'].includes(review.status) || item.splitPending) return [];
    const isUnsafe = (text: string) => text.includes('[인용 금지 문장]') || isCitationBannedSentence(text) || hasForbiddenSentenceOverlap(text, banned, 8);
    if ([item.title, item.text, review.text].some(isUnsafe)) return [];
    const evidence = item.evidence.filter(e => e.verified && eligibleSources.has(e.sourceId) && !isCitationBannedSentence(e.quote) && !hasForbiddenSentenceOverlap(e.quote, banned, 8));
    return evidence.length ? [{ item, review, evidence }] : [];
  });
  draft.confirmed_count += nodes.length;
  draft.summary_format = 1;
  if (draft.template && draft.template !== 'legacy7') draft.template_source = reportTemplateSource(draft.template);
  const sentenceFor = (node: EligibleNode, text: string, ids: string[], source: 'human' | 'ai'): ReportSentenceItem => {
    const field = (keys: string[]) => keys.map(k => node.item.fields[k]).find(v => typeof v === 'string' && v.trim() && safeText(v));
    const level = field(['level_ai', 'outcome_level', 'level']);
    const confidence = field(['confidence_ai', 'confidence', '신뢰도']);
    const evidences = node.evidence.filter(e => ids.includes(e.id)).map(e => ({ id: e.id, quote: e.quote, location: e.location, speaker: e.speaker, document_id: sourceDocuments.get(e.sourceId), document_name: e.sourceTitle, review_status: node.review.status, evidence_level: e.level, confidence: typeof confidence === 'string' ? confidence : undefined, confirmer_role: node.review.reviewer, confirmed_at: node.review.created_at }));
    const node_label = `${node.item.id} · 레벨 ${level || '미확인'}${level ? ' 제안' : ''} · 신뢰도 ${confidence || '미확인'}${confidence ? ' 제안' : ''}`;
    return { indicator_id: node.item.id, indicator_name: node.item.title, node_label, sentence: text, source, evidence_id: ids[0] ?? '', evidence_ids: ids, evidences };
  };
  const safeText = (text: string) => !isCitationBannedSentence(text) && !hasForbiddenSentenceOverlap(text, banned, 8);
  const section = async (id: string, title: string, chosen: EligibleNode[], level = 3): Promise<ReportSection> => {
    const result: ReportSection = { id, title, level, source: 'ai' };
    if (!chosen.length) return { ...result, source: 'missing', empty_message: missing };
    const indicators = chosen.map(({ item, review, evidence }) => ({ id: item.id, name: item.title, confirmed_text: review.text || item.text, confirmation_type: review.status, evidence_level: evidence.map(e => e.level), evidences: evidence.map(e => ({ id: e.id, quote: e.quote, location: e.location, document_name: e.sourceTitle, speaker: e.speaker })) }));
    try {
      eligibilityGuard();
      const answer = await (client ?? getAiClient()).generateReportDraft([{ role: 'system', content: `종료평가보고서의 '${title}' 절을 작성한다. 확정된 판단과 인용문만 사용하고 각 문장에 해당 노드 ID와 근거 ID를 빠짐없이 제공한다. 수치·단위는 인용문 그대로 쓰고, 예견·추정은 확정처럼 쓰지 않는다. 인과와 해석은 제안으로 표현한다.` }, { role: 'user', content: JSON.stringify({ section: id, indicators }) }], { guard: eligibilityGuard });
      result.sentences = answer.report.sentences.flatMap(sent => {
        const node = chosen.find(n => n.item.id === sent.indicator_id);
        if (!node || !sent.evidence_ids.length || sent.evidence_ids.some(eid => !node.evidence.some(e => e.id === eid)) || !safeText(sent.sentence)) return [];
        const ev = node.evidence.filter(e => sent.evidence_ids.includes(e.id));
        if (!checkNumericConsistency(sent.sentence, ev.map(e => e.quote)).passed) return [];
        if (ev.every(e => /예견|추정|계획/.test(e.level)) && !/예정|가능|기대|추정|계획|제안|필요|검토/.test(sent.sentence)) return [];
        return [sentenceFor(node, sent.sentence, sent.evidence_ids, 'ai')];
      });
      if (!result.sentences.length) { result.source = 'missing'; result.empty_message = missing; }
    } catch (error) { if (error instanceof AiEligibilityChangedError) throw error; result.source = 'missing'; result.empty_message = '※ 생성 실패 — 다시 만들기'; }
    return result;
  };
  const outcomes = nodes.filter(n => ['outcome-short', 'outcome-mid', 'output'].includes(n.item.type));
  const factors = nodes.filter(n => n.item.type === 'enabler');
  const constraints = nodes.filter(n => n.item.type === 'constraint');
  const family = (n: EligibleNode) => String(n.item.fields.outcome_family ?? '');
  const eipp = draft.template === 'eipp';
  const overviewNotes: ReportFootnote[] = [];
  const bannedParagraphs = reportBannedParagraphIds(projectId, db);
  const paragraphs = [...documents.values()].filter(d => d.is_included === 1 && isConfirmedNonPastReport(d)).flatMap(d => getParagraphsByDocument(d.id, db).map(p => ({ paragraph: p, document: d })));
  const overviewRows = overviewFields.map(({ title, aliases, alwaysCheck }) => {
    const matchesByField = aliases.map(fieldAliases => paragraphs.flatMap(({ paragraph, document }) => {
      if (bannedParagraphs.has(paragraph.id) || !safeText(paragraph.content)) return [];
      for (const alias of fieldAliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = paragraph.content.match(new RegExp(`^\\s*${escaped}\\s*[:：]\\s*(.+)$`, 'm'));
        if (match?.[1]?.trim()) return [{ paragraph, document, value: match[1].trim() }];
      }
      return [];
    }));
    const matched = matchesByField.flat();
    if (!matched.length) return [{ ...label(title), is_label: true }, missingCell()];
    const chosen = matchesByField.flatMap(fieldMatches => fieldMatches.slice(0, 1));
    const ids = chosen.map(({ paragraph, document }) => {
      const id = `paragraph-${paragraph.id}`;
      if (!overviewNotes.some(n => n.evidence_id === id)) overviewNotes.push({ number: 0, evidence_id: id, document_id: document.id, document_name: document.file_name, location: paragraph.location, quote: paragraph.content });
      return id;
    });
    const values = chosen.map(item => item.value);
    const distinctValues = new Set(matched.map(item => item.value));
    const conflictingValues = matchesByField.some(fieldMatches => new Set(fieldMatches.map(item => item.value)).size > 1);
    const uncertainty = alwaysCheck || conflictingValues || values.some(value => /확인 필요|미확인|미정/.test(value));
    return [{ ...label(title), is_label: true }, documentValue(`${values.join(' / ')}${uncertainty ? ' ※ 확인 필요' : ''}`, ids)];
  });
  const indicatorLevels = new Map(reportIndicatorLevels(projectId, db).map(i => [i.id, i.level]));
  const rowTable = draft.sections.achievement_table.rows.map(row => [documentValue(indicatorLevels.get(row.indicator_id) ?? '미확인'), documentValue(`${row.indicator_name}${row.is_orphaned ? ' (문서에서 사라진 지표)' : ''}`), row.target_value ? documentValue(row.target_value) : missingCell(), row.evidence_id ? { text: `${row.status_display}${row.confirmation_type === '수정 후 확정' && row.edited_text ? ` [사람 확정 수정본] ${row.edited_text}` : ''}`, source: row.confirmation_type ? 'human' as const : 'ai' as const, evidence_ids: [row.evidence_id], indicator_id: row.indicator_id } : missingCell(), row.evidence_id ? documentValue(row.indicator_id, [row.evidence_id]) : missingCell()]);
  const overview: ReportSection = { id: `${draft.template}-overview`, title: eipp ? '1) 사업 개요' : '1. 사업 개요', level: 2, table: { columns: ['항목', '내용'], rows: overviewRows } };
  const achievement: ReportSection = { id: `${draft.template}-indicators`, title: '성과지표 및 실적', level: 3, table: { columns: ['구분', '성과지표', '목표', '실적', '근거'], rows: rowTable }, ...(rowTable.length ? {} : { source: 'missing', empty_message: missing }) };
  const groups = eipp ? [
    await section('eipp-financing', '재원연계형', outcomes.filter(n => /개발협력/.test(family(n)))),
    await section('eipp-policy', '정책수립 및 집행 촉진형', outcomes.filter(n => /정책/.test(family(n)))),
    await section('eipp-trade', '교역·교류 촉진형', outcomes.filter(n => /경제협력|네트워킹/.test(family(n)))),
    await section('eipp-incidental', '부수적 성과', outcomes.filter(n => !family(n))),
  ] : [await section('ksp-major', '주요 성과', outcomes)];
  for (const group of groups) {
    const chosen = outcomes.filter(node => group.id === 'eipp-financing' ? /개발협력/.test(family(node)) : group.id === 'eipp-policy' ? /정책/.test(family(node)) : group.id === 'eipp-trade' ? /경제협력|네트워킹/.test(family(node)) : group.id === 'eipp-incidental' ? !family(node) : true);
    const descriptors = chosen.map(node => {
      const level = String(node.item.fields.level_ai ?? node.item.fields.outcome_level ?? node.item.fields.level ?? '').trim();
      const confidence = String(node.item.fields.confidence_ai ?? node.item.fields.confidence ?? node.item.fields['신뢰도'] ?? '').trim();
      const familyName = family(node).trim();
      const tags = [familyName ? `${familyName}${level ? ` Lv${level} 제안` : ''}` : level ? `Lv${level} 제안` : '', confidence ? `신뢰도 ${confidence} 제안` : ''].filter(Boolean);
      return `${node.item.id}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    });
    if (descriptors.length) group.title = `${group.title} — ${descriptors.join(' · ')}`;
  }
  if (draft.sections.performance_analysis.sentences.length) {
    const group = groups.at(-1)!;
    group.sentences = [...(group.sentences ?? []), ...draft.sections.performance_analysis.sentences];
    if (group.source === 'missing') group.source = undefined;
    delete group.empty_message;
  }
  if (indicatorGenerationFailed) groups.push({ id: `${draft.template}-indicator-generation-failed`, title: '지표 성과 서술 (AI 초안)', level: 3, source: 'missing', empty_message: '※ 생성 실패 — 다시 만들기' });
  // Confirmed edited text is retained verbatim, independent of AI generation.
  for (const group of groups) {
    if (group.id.endsWith('-indicator-generation-failed')) continue;
    const chosen = eipp ? outcomes.filter(n => group.id === 'eipp-financing' ? /개발협력/.test(family(n)) : group.id === 'eipp-policy' ? /정책/.test(family(n)) : group.id === 'eipp-trade' ? /경제협력|네트워킹/.test(family(n)) : !family(n)) : outcomes;
    const confirmed = chosen.filter(n => n.review.status === '수정 후 확정' && n.review.text && safeText(n.review.text)).map(n => sentenceFor(n, n.review.text, n.evidence.map(e => e.id), 'human'));
    if (confirmed.length) { group.sentences = [...confirmed, ...(group.sentences ?? [])]; delete group.empty_message; }
  }
  const factor = await section(`${draft.template}-factors`, '성과 발현 기여요인', factors);
  if (draft.sections.contributing_factors.sentences?.length) {
    factor.sentences = [...(factor.sentences ?? []), ...draft.sections.contributing_factors.sentences];
    if (factor.source === 'missing') factor.source = 'human';
    delete factor.empty_message;
  }
  const constraint = await section(`${draft.template}-constraints`, '제약요인 및 대응 노력', constraints);
  const lessons = await section(`${draft.template}-lessons`, '성과 촉진을 위한 교훈 (AI 제안 — PO 확정 필요)', [...factors, ...constraints]);
  // 견본·서식 목차와 같은 제목: EIPP 는 '향후 성과 모니터링 계획', KSP 는 '성과 모니터링 계획'.
  const monitoring = await section(`${draft.template}-monitoring`, eipp ? '향후 성과 모니터링 계획' : '성과 모니터링 계획', outcomes);
  if (monitoring.sentences?.length) {
    monitoring.table = { columns: ['시점', '확인 항목', '관련 노드'], rows: monitoring.sentences.map(s => [
      { text: monitoringTime(s), source: /※ 확인 필요/.test(monitoringTime(s)) ? 'missing' : 'ai' },
      { text: s.sentence, source: 'ai', evidence_ids: s.evidence_ids, indicator_id: s.indicator_id },
      { text: s.indicator_id, source: 'human', evidence_ids: s.evidence_ids, indicator_id: s.indicator_id },
    ]) };
    delete monitoring.sentences;
  }
  const evaluations = [];
  for (const title of ['적절성', '효율성', '효과성', '지속가능성', '제언']) evaluations.push(await section(`${draft.template}-${title}`, title, [...outcomes, ...factors, ...constraints]));
  const results: ReportSection = { id: `${draft.template}-results`, title: eipp ? '2) 사업의 성과' : '2. 종료평가 종합 결과', level: 2, children: [achievement, { id: `${draft.template}-analysis`, title: '성과 분석', level: 3, children: groups }, factor, constraint, lessons, monitoring] };
  const evaluation: ReportSection = { id: `${draft.template}-evaluation`, title: eipp ? '3) 종합평가 및 제언 (AI 초안)' : '3. 종합평가 및 제언 (AI 초안)', level: 2, source: 'ai', children: evaluations };
  if (eipp) draft.report_sections = [overview, results, evaluation];
  else {
    // Keep the official KSP hierarchy, replacing only populated bodies.
    const previous = draft.report_sections ?? [];
    const replace = (sections: ReportSection[], id: string, replacement: Partial<ReportSection>) => {
      for (const s of sections) { if (s.id === id) { Object.assign(s, replacement); if ((replacement.table?.rows.length || replacement.sentences?.length || replacement.children?.length) && !replacement.empty_message) delete s.empty_message; } if (s.children) replace(s.children, id, replacement); }
    };
    replace(previous, 'ksp-project', { table: overview.table });
    replace(previous, 'ksp-indicators', { table: achievement.table, rows: undefined });
    replace(previous, 'ksp-major', { sentences: groups[0].sentences, empty_message: groups[0].empty_message, source: groups[0].source });
    replace(previous, 'ksp-unclassified', { sentences: [], empty_message: missing, source: 'missing' });
    replace(previous, 'ksp-factors', { sentences: factor.sentences, empty_message: factor.empty_message, source: factor.source });
    replace(previous, 'ksp-constraints', { sentences: constraint.sentences, empty_message: constraint.empty_message, source: constraint.source });
    replace(previous, 'ksp-responses-lessons', { title: '대응 노력과 교훈 (AI 제안 — PO 확정 필요)', sentences: lessons.sentences, empty_message: lessons.empty_message, source: lessons.source });
    replace(previous, 'ksp-monitoring', { title: monitoring.title, table: monitoring.table, empty_message: monitoring.empty_message, source: monitoring.source });
    replace(previous, 'ksp-summary', { title: '4) 총평 (AI 초안)', children: evaluations });
    if (indicatorGenerationFailed) {
      const result = previous.find(s => s.id === 'ksp-results');
      const assessment = result?.children?.find(s => s.id === 'ksp-assessment');
      const performance = assessment?.children?.find(s => s.id === 'ksp-performance');
      performance?.children?.push(groups[groups.length - 1]);
    }
    draft.report_sections = previous;
  }
  const notes = new Map<string, ReportFootnote>();
  const addSentence = (s: ReportSentenceItem) => { for (const e of s.evidences ?? []) if (!notes.has(e.id)) notes.set(e.id, { number: notes.size + 1, evidence_id: e.id, document_id: e.document_id, document_name: e.document_name, location: e.location, quote: e.quote, speaker: e.speaker, review_status: e.review_status, evidence_level: e.evidence_level, confidence: e.confidence, confirmer_role: e.confirmer_role, confirmed_at: e.confirmed_at, indicator_id: s.indicator_id, indicator_name: s.indicator_name }); };
  for (const note of overviewNotes) notes.set(note.evidence_id, { ...note, number: notes.size + 1 });
  const addNode = (node: EligibleNode) => addSentence(sentenceFor(node, '', node.evidence.map(e => e.id), 'human'));
  for (const n of nodes) addNode(n);
  for (const s of draft.sections.performance_analysis.sentences) addSentence(s);
  for (const s of draft.sections.contributing_factors.sentences ?? []) addSentence(s);
  for (const r of draft.sections.achievement_table.rows) if (r.evidence_id && !notes.has(r.evidence_id)) {
    const ev = reportEvidenceDetails(r.evidence_id, db);
    const review = reportIndicatorReview(r.indicator_id, db);
    notes.set(r.evidence_id, { number: notes.size + 1, evidence_id: r.evidence_id, document_id: ev?.document_id, quote: ev?.quote, speaker: ev?.speaker, document_name: r.evidence_document_name, location: r.evidence_location, indicator_id: r.indicator_id, indicator_name: r.indicator_name, review_status: review?.confirmation_type, confirmer_role: review?.confirmer_name, confirmed_at: review?.created_at });
  }
  draft.footnotes = [...notes.values()];
  eligibilityGuard();
}
