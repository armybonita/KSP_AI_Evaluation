import { z } from 'zod';
import { fitJudgmentRequest } from './synthesis-request';
import { AiClient, getAiClient, OntologyCallError, runOntologyAttempts, timeoutFromEnv } from '@/server/ai/client';
import type { ChatMessage } from '@/server/ai/types';
import { isAiDocumentEligible } from '@/server/documents/ai-eligibility';
import { checkNumericConsistency } from '@/server/numeric-check';
import { verifyQuote } from '@/server/quote-verify';
import { getDatabase, getParagraphsByDocument, getTocData, listDocuments, resolveProjectCitationContext } from '@/server/store/db';
import type { DbConnection } from '@/server/store/db';
import { assertSynthesisEligibility, getSynthesisEligibilityFingerprint, getSynthesisGraph, SynthesisEligibilityChanged } from '@/server/store/synthesis-store';
import { maskForbiddenSentenceInContent } from '@/server/store/citation-ban';
import type { ParagraphRecord } from '@/server/store/types';

const Step = z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7)]);
const Item = z.object({
  id: z.string().min(1), step: Step,
  grp: z.enum(['성과지표 기준 충족 여부', '성과지표 외 AI 제안', '기여요인', '제약요인']),
  name: z.string().min(1), ai: z.string(), state: z.enum(['관측됨', '미확인', '추진 중', '-']),
  k: z.enum(['ind', 'opt', 'out', 'fac']), target: z.string(), actual: z.string(), verify: z.string(), met: z.string(),
  cites: z.array(z.string()), match: z.string(), enough: z.string(), authors: z.string(), conflict: z.array(z.string()),
  fam: z.string(), lvl: z.string(), conf: z.string(), note: z.string(),
  links: z.array(z.object({ outcome: z.string(), relation: z.enum(['생성·유발', '유발', '촉진', '저해']) })).default([]),
});
export type SynthesisItem = z.infer<typeof Item>;
type SynthesisClient = Pick<AiClient, 'generateSynthesis' | 'provider'> & Partial<Pick<AiClient, 'synthesisRequestBytes'>>;
type InputNode = { id: string; type: string; title: string; description: string; score: number; evidence: Array<{ id: string; quote: string }>; edges: Array<{ target: string; title: string; relation: string }> };
type Indicator = { id: string; step: 4 | 5 | 6; name: string; target: string; verify: string; source: string | null; baselineSource: string | null };
export const SYNTHESIS_MAX_INPUT_BYTES = 30000;
const PROMPT = `현재 사업의 저장된 근거만 이용해 같은 뜻을 묶어 평가 항목을 만든다. JSON 객체의 items 배열만 반환한다. 각 항목은 id, step, grp, name, ai, state, k, target, actual, verify, met, cites, match, enough, authors, conflict, fam, lvl, conf, note, links를 모두 가진다. 문자열은 모르면 빈 문자열, conflict와 links는 배열이다. cites는 입력 evidence의 문단 id만 쓴다. 4=산출물, 5=단기성과, 6=중장기성과, 7=기여·제약이다. grp는 성과지표 기준 충족 여부/성과지표 외 AI 제안/기여요인/제약요인, k는 ind/opt/out/fac, state는 관측됨/미확인/추진 중/- 중 하나다. 지표는 입력 id를 그대로 유지한다. 활동이나 산출물은 성과로 올리지 않는다. 성과군은 협력국 정책 반영, 개발협력 촉진, 경제협력 촉진, 지식 네트워킹 중 선택한다. lvl은 K0~K6 또는 Lv1~Lv5 중 하나만 쓰고 설명을 덧붙이지 않는다. 협력국 정책 반영은 지식활용 K0 미반응, K1 전달·인지, K2 이해·검토, K3 참조·후속활동, K4 의제화·설계(공식 과업 시작), K5 채택·제도화 추진, K6 시행·정착이다. 나머지 세 성과군은 협력확장 Lv1 기회형성, Lv2 관계구축, Lv3 실행준비, Lv4 실행촉진(공식 신청·제출), Lv5 확장(재원 투입 확정·착수·수주)이다. 의지 표명만 있으면 K2 를 넘지 않는다. 각각 앞에 지식활용 또는 협력확장 접두어를 쓸 수 있다. 근거가 부족하면 단계를 비운다. 신뢰수준 conf는 높음/보통/낮음/해당 없음이다. 요인 links는 {outcome,relation}이며 관계는 생성·유발/유발/촉진/저해다. 관계를 추정하면 note에 AI 추정을 쓴다. 근거 없는 항목은 미확인과 근거 자료 미확보로 쓴다. 목표와 실적을 지어내지 않는다. 각 항목의 id 는 입력에 있는 그룹 id(또는 지표 id)를 그대로 복사한다. 입력 그룹마다 항목 하나를 입력 순서대로 돌려준다.`;
const norm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const noisePenalty = (title: string) => /사양|규격|장비|출장|회의\s*준비|여행|항공|숙박/.test(title) ? 10 : 0;
const str = (value: unknown) => typeof value === 'string' ? value : '';
const arr = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
function parseRecord(value: string): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function stage(level: string): 4 | 5 | 6 { return level === '단기성과' ? 5 : ['중기성과', '중장기성과', '영향'].includes(level) ? 6 : 4; }

/** Group by normalized title and rank peripheral detail below substantive outputs. */
export function reduceSynthesisNodes(nodes: InputNode[]): InputNode[] {
  const grouped = new Map<string, InputNode>();
  for (const node of nodes) {
    const key = `${node.type}:${norm(node.title)}`;
    const score = node.score - noisePenalty(node.title);
    const previous = grouped.get(key);
    if (previous) {
      previous.evidence = [...new Map([...previous.evidence, ...node.evidence].map(e => [e.id, e])).values()];
      previous.edges = [...new Map([...previous.edges, ...node.edges].map(e => [JSON.stringify(e), e])).values()];
    } else grouped.set(key, { ...node, score, evidence: [...node.evidence], edges: [...node.edges] });
  }
  return [...grouped.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Byte bound is deliberately conservative for multilingual tokenizers. */
export function chunkSynthesisInput<T>(rows: T[], maxBytes = SYNTHESIS_MAX_INPUT_BYTES): T[][] {
  const chunks: T[][] = []; let current: T[] = []; let bytes = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (size + 2 > maxBytes) throw new Error('합성 입력 항목이 한도보다 큽니다.');
    if (current.length && bytes + size > maxBytes) { chunks.push(current); current = []; bytes = 2; }
    current.push(row); bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Arithmetic verdicts only for exact values. The actual must be a bare number with its unit; the target may add
 * "이상"/"이하" and a year in brackets such as "(2025)". Any other wording — hedges, bounds, notes in brackets —
 * is left to the reviewer, because no word list can cover every qualifier.
 */
export function judgeIndicator(target: string, actual: string): string {
  const number = '([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)';
  const unit = '((?:(?!이상|이하)[^\\d\\s()~～<>≥≤+\\-.,])*)';
  const goal = target.trim().match(new RegExp(`^${number}\\s*${unit}\\s*(이상|이하)?\\s*(?:\\(\\d{4}년?\\))?$`));
  const observed = actual.trim().match(new RegExp(`^${number}\\s*${unit}$`));
  if (!observed) return '판정 불가 (실적 표현 확인 필요)';
  if (!goal || goal[2] !== observed[2]) return '판정 불가 (목표 방향·수치·단위 확인 필요)';
  const g = Number(goal[1].replace(/,/g, '')); const a = Number(observed[1].replace(/,/g, ''));
  if (!Number.isFinite(g) || !Number.isFinite(a)) return '판정 불가 (수치 확인 필요)';
  return `${goal[3] === '이하' ? a <= g ? '충족' : '미충족' : a >= g ? '충족' : '미충족'} (산술 비교)`;
}
const TEXT_FIELDS = ['name', 'ai', 'target', 'actual', 'verify', 'met', 'match', 'enough', 'authors', 'fam', 'lvl', 'conf', 'note'] as const;
const STATES = ['관측됨', '미확인', '추진 중', '-'];
/** Coerce a model item into the schema's shape without inventing content. */
export function normalizeCandidate(raw: Record<string, unknown>, step: number, sole?: { id: string; indicator: boolean }): Record<string, unknown> {
  const text = (v: unknown) => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  const list = (v: unknown) => Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === 'string' && v ? [v] : [];
  const out: Record<string, unknown> = {};
  for (const f of TEXT_FIELDS) out[f] = text(raw[f]).trim();
  out.id = text(raw.id).trim() || sole?.id || '';
  out.step = typeof raw.step === 'number' ? raw.step : Number(text(raw.step)) || step;
  const k = text(raw.k).trim();
  out.k = ['ind', 'opt', 'out', 'fac'].includes(k) ? k : (sole?.indicator ? 'ind' : step === 4 ? 'opt' : step === 7 ? 'fac' : 'out');
  const grp = text(raw.grp).trim();
  out.grp = grp || (out.k === 'ind' ? '성과지표 기준 충족 여부' : step === 7 ? '' : '성과지표 외 AI 제안');
  const state = text(raw.state).trim();
  out.state = STATES.includes(state) ? state : '미확인';
  out.cites = list(raw.cites);
  out.conflict = list(raw.conflict);
  out.links = Array.isArray(raw.links) ? raw.links.filter(l => l && typeof l === 'object').map(l => ({ outcome: text((l as Record<string, unknown>).outcome), relation: text((l as Record<string, unknown>).relation) })).filter(l => l.outcome && ['생성·유발', '유발', '촉진', '저해'].includes(l.relation)) : [];
  return out;
}
function blank(ind: Indicator): SynthesisItem {
  return { id: ind.id, step: ind.step, grp: '성과지표 기준 충족 여부', name: ind.name, ai: '', state: '미확인', k: 'ind', target: ind.target, actual: '', verify: ind.verify, met: '판정 불가 (실적 근거 미확보)', cites: [], match: '', enough: '', authors: '', conflict: [], fam: '', lvl: '', conf: '', note: '근거 자료 미확보', links: [] };
}
function addNote(note: string, clause: string): string { return note.includes(clause) ? note : [note, clause].filter(Boolean).join(' · '); }
type Stage = 4 | 5 | 6 | 7;
export type StageDiagnostics = { candidateNodeCount: number; evidenceMismatchDroppedCount: number; forbiddenDroppedCount: number; groupingCalls: number; judgmentCalls: number; discardedResponseCount: number; finalItemCount: number; noiseDroppedCount: number; ungroupedNodeCount: number; groupingInputNodeCount: number; ineligibleSourceIndicatorCount: number; ineligibleSourceIndicatorReason?: string; regroupFailure?: string; partialReason?: string; changedEligibilityParagraphCount: number; changedEligibilityReason?: string; skippedJudgmentCount: number; skippedJudgmentReason?: string; discardReasons?: Record<string, number>; blankedFieldCount?: number };
export type SynthesisDiagnostics = Record<Stage, StageDiagnostics>;
const emptyDiagnostics = (): SynthesisDiagnostics => Object.fromEntries([4, 5, 6, 7].map(step => [step, { candidateNodeCount: 0, evidenceMismatchDroppedCount: 0, forbiddenDroppedCount: 0, groupingCalls: 0, judgmentCalls: 0, discardedResponseCount: 0, finalItemCount: 0, noiseDroppedCount: 0, ungroupedNodeCount: 0, groupingInputNodeCount: 0, ineligibleSourceIndicatorCount: 0, changedEligibilityParagraphCount: 0, skippedJudgmentCount: 0 }])) as SynthesisDiagnostics;
const nodeStep = (type: string): Stage => type === 'output' ? 4 : type === 'outcome-short' ? 5 : type === 'outcome-mid' ? 6 : 7;
type Evidence = { id: string; quote: string; documentId: string };
type Group = { id: string; name: string; nodes: InputNode[] };
// Extra keys from the model (e.g. a description) are dropped, not fatal; only name and ids are used.
// Groups are validated one by one so a single malformed group cannot discard the valid ones.
const GroupItem = z.object({ name: z.string().min(1).max(500), ids: z.array(z.string()) });
const GroupResponse = z.object({ groups: z.array(z.unknown()) });
// Large grouping requests (250 rows) made Solar return incomplete replies on real projects; 100 keeps replies whole.
export const GROUP_ROWS_PER_CALL = 100;
const GROUP_PROMPT = `같은 뜻을 단계별 평가 항목으로 묶는다. JSON {"groups":[{"name":"항목 이름","ids":["입력 id"]}]}만 반환한다. 입력 id는 한 그룹에만 쓰고 빠짐없이 포함한다. 근거를 추측하지 않는다. 단계별 목표 항목 수: 4는 6~15개, 5는 2~8개, 6은 4~12개, 7은 6~15개. 입력 수가 목표보다 적으면 입력 수 이하로 한다.`;
const LIMITS: Record<Stage, string> = { 4: '6~15', 5: '2~8', 6: '4~12', 7: '6~15' };

/** Distribute citations across documents before taking additional quotes from each. */
function selectEvidence(nodes: InputNode[]): Array<{ id: string; quote: string }> {
  const docs = new Map<string, Evidence[]>();
  for (const node of nodes) for (const e of node.evidence as Evidence[]) {
    const list = docs.get(e.documentId) ?? [];
    if (!list.some(old => old.id === e.id && old.quote === e.quote)) list.push(e);
    docs.set(e.documentId, list);
  }
  const selected: Evidence[] = [];
  while (selected.length < 8 && [...docs.values()].some(list => list.length)) {
    for (const list of docs.values()) { const evidence = list.shift(); if (evidence) selected.push(evidence); if (selected.length === 8) break; }
  }
  return selected.map(({ id, quote }) => ({ id, quote }));
}
/** Shared character pairs and meaningful tokens offer a conservative local match without disclosing unrelated quotes. */
function relevance(name: string, node: InputNode): number {
  const a = norm(name), b = norm(`${node.title} ${node.description}`);
  if (!a || !b) return 0;
  if (b.includes(a) || a.includes(norm(node.title)) && norm(node.title).length >= 2) return 100;
  const pairs = new Set(Array.from({ length: Math.max(0, a.length - 1) }, (_, i) => a.slice(i, i + 2)));
  return [...pairs].filter(pair => b.includes(pair)).length;
}

export type SynthesisResult = { items: SynthesisItem[]; inputNodeCount: number; discardedCount: number; diagnostics: SynthesisDiagnostics; partialReason?: string };
class SynthesisLimit extends Error {}
class StageLimit extends Error {}
export async function synthesizeProject(projectId: string, options: { db?: DbConnection; aiClient?: SynthesisClient; onProgress?: (diagnostics: SynthesisDiagnostics) => void; onStageComplete?: (result: SynthesisResult) => void; maxDurationMs?: number; maxCalls?: number; now?: () => number; eligibilityFingerprint?: string; groupRowsPerCall?: number } = {}): Promise<SynthesisResult> {
  const maxDurationMs = options.maxDurationMs ?? timeoutFromEnv(process.env.AIEAS_SYNTHESIS_MAX_MS, 45 * 60_000, 14_400_000);
  const timeLimitReason = `전체 시간 ${maxDurationMs % 60_000 === 0 ? `${maxDurationMs / 60_000}분` : maxDurationMs % 1000 === 0 ? `${maxDurationMs / 1000}초` : `${maxDurationMs}밀리초`} 상한`;
  const now = options.now ?? (() => performance.now()); const deadline = now() + maxDurationMs;
  const maxCalls = options.maxCalls ?? 400; let calls = 0;
  const rowsPerCall = options.groupRowsPerCall ?? GROUP_ROWS_PER_CALL;
  const db = options.db ?? getDatabase(); const ai = options.aiClient ?? getAiClient();
  const fingerprint = options.eligibilityFingerprint ?? getSynthesisEligibilityFingerprint(projectId, db, ai.provider);
  const assertEligibility = () => assertSynthesisEligibility(projectId, fingerprint, db, ai.provider);
  assertEligibility();
  const diagnostics = emptyDiagnostics(); const progress = () => options.onProgress?.(diagnostics);
  const allDocuments = listDocuments(projectId, db);
  const documents = allDocuments.filter(d => d.is_included === 1 && d.status === '추출 완료' && isAiDocumentEligible(d, ai.provider));
  const eligibleDocIds = new Set(documents.map(d => d.id)); const allDocIds = new Set(allDocuments.map(d => d.id));
  const paragraphByDoc = new Map(documents.map(d => [d.id, getParagraphsByDocument(d.id, db)]));
  const context = resolveProjectCitationContext(projectId, db);
  const safe = (text: string) => maskForbiddenSentenceInContent(text, context.sentences, context.index);
  const toc = getTocData(projectId, db);
  const indicators: Indicator[] = (toc?.items ?? []).flatMap(({ indicator, baseline }, index) => {
    const step = stage(indicator.level); const source = indicator.source_doc_id ?? null; const baselineSource = baseline?.document_id ?? null;
    if ((!source && !baselineSource) || (source && !eligibleDocIds.has(source)) || (baselineSource && !eligibleDocIds.has(baselineSource))) {
      diagnostics[step].ineligibleSourceIndicatorCount++; diagnostics[step].ineligibleSourceIndicatorReason = `자격 없는 출처 지표 ${diagnostics[step].ineligibleSourceIndicatorCount}`; return [];
    }
    return [{ id: `IND-${String(index + 1).padStart(2, '0')}`, step, name: safe(indicator.name), target: safe(baseline?.target_value ?? indicator.target_value ?? ''), verify: safe(indicator.mov ?? ''), source, baselineSource }];
  });
  const graph = getSynthesisGraph(projectId, db);
  if (!graph) { for (const ind of indicators) diagnostics[ind.step].finalItemCount++; progress(); assertEligibility(); return { items: indicators.map(blank), inputNodeCount: 0, discardedCount: 0, diagnostics }; }
  const sourceMap = new Map(graph.sources.map(r => [r.id, parseRecord(r.data_json)]));
  const evidenceMap = new Map<string, { status: 'valid' | 'mismatch' | 'forbidden' | 'excluded'; evidence?: Evidence }>();
  for (const row of graph.snippets) {
    const data = parseRecord(row.data_json); const source = sourceMap.get(str(data.source)); const documentId = str(source?.document_id);
    if (allDocIds.has(documentId) && !eligibleDocIds.has(documentId)) { evidenceMap.set(row.id, { status: 'excluded' }); continue; }
    const paragraphs = paragraphByDoc.get(documentId) ?? []; const quote = str(data.quote); const locator = str(data.locator);
    const matches = paragraphs.filter((p: ParagraphRecord) => p.location === locator && verifyQuote(quote, p.content));
    if (quote && safe(quote) !== quote) evidenceMap.set(row.id, { status: 'forbidden' });
    else if (matches.length === 1 && quote) evidenceMap.set(row.id, { status: 'valid', evidence: { id: matches[0].id, quote, documentId } });
    else evidenceMap.set(row.id, { status: 'mismatch' });
  }
  const edges = graph.edges; const nodes: InputNode[] = [];
  for (const row of graph.nodes) {
    if (!['output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint'].includes(row.node_type)) continue;
    const d = diagnostics[nodeStep(row.node_type)]; d.candidateNodeCount++;
    const data = parseRecord(row.data_json); const ids = [...new Set([...arr(data.evidence), ...edges.filter(e => e.target_id === row.id && ['proves', 'supports', 'contradicts'].includes(e.relation_field)).map(e => e.source_id)])];
    const entries = ids.map(id => evidenceMap.get(id) ?? { status: 'mismatch' as const });
    const title = safe(row.title); const description = safe(str(data.description));
    if (title !== row.title || description !== str(data.description)) { d.forbiddenDroppedCount++; continue; }
    if (entries.some(e => e.status === 'excluded')) { d.evidenceMismatchDroppedCount++; continue; }
    const evidence = entries.flatMap(e => e.evidence ? [e.evidence] : []);
    if (!evidence.length) { if (entries.some(e => e.status === 'forbidden')) d.forbiddenDroppedCount++; else d.evidenceMismatchDroppedCount++; continue; }
    nodes.push({ id: row.id, type: row.node_type, title: title.slice(0, 500), description: description.slice(0, 800), score: evidence.length, evidence, edges: [] });
  }
  progress();
  const safeById = new Map(nodes.map(n => [n.id, n]));
  for (const node of nodes) node.edges = edges.filter(e => e.source_id === node.id && safeById.has(e.target_id) && ['promotes', 'hinders', 'induces', 'extends_to'].includes(e.relation_field)).map(e => ({ target: e.target_id, title: safeById.get(e.target_id)!.title, relation: e.relation_field }));
  const items: SynthesisItem[] = [];
  const processedNodeIds = new Set<string>();
  let partialReason: string | undefined;
  let activeStep: Stage = 4;
  try {
  for (const step of [4, 5, 6, 7] as const) {
    activeStep = step;
    if (now() >= deadline) throw new SynthesisLimit(timeLimitReason);
    const d = diagnostics[step];
    try {
    const discard = (reason: string) => { d.discardedResponseCount++; d.discardReasons = { ...(d.discardReasons ?? {}), [reason]: ((d.discardReasons ?? {})[reason] ?? 0) + 1 }; progress(); };
    const call = async (makeMessages: () => ChatMessage[] | null, kind: 'groupingCalls' | 'judgmentCalls', onAttempt?: () => void) => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new SynthesisLimit(timeLimitReason);
      if (calls >= maxCalls) throw new SynthesisLimit('모델 호출 400회 상한');
      if (d.groupingCalls + d.judgmentCalls >= 100) throw new StageLimit('단계 모델 호출 100회 상한');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const response = await Promise.race([
          runOntologyAttempts(signal => {
            if (now() >= deadline || calls >= maxCalls) { controller.abort(); throw new SynthesisLimit(now() >= deadline ? timeLimitReason : '모델 호출 400회 상한'); }
            if (d.groupingCalls + d.judgmentCalls >= 100) { controller.abort(); throw new StageLimit('단계 모델 호출 100회 상한'); }
            const messages = makeMessages();
            if (!messages) return Promise.resolve(null);
            calls++; d[kind]++; onAttempt?.(); progress();
            try { assertEligibility(); } catch (error) { controller.abort(); throw error; }
            return ai.generateSynthesis(messages, signal);
          }, { signal: controller.signal }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new SynthesisLimit(timeLimitReason)); }, remaining); }),
        ]);
        if (now() >= deadline) throw new SynthesisLimit(timeLimitReason);
        return response;
      } catch (error) {
        if (error instanceof StageLimit || error instanceof SynthesisEligibilityChanged) throw error;
        if (timedOut || now() >= deadline) throw new SynthesisLimit(timeLimitReason);
        if (calls >= maxCalls && controller.signal.aborted) throw new SynthesisLimit('모델 호출 400회 상한');
        // A failed model call (bad or empty reply, HTTP error, network) costs this one request, not the whole run.
        if (error instanceof OntologyCallError) { discard(`AI 응답 오류:${error.kind}`); return null; }
        // Network-level failures (fetch failed, header/body timeouts) are the same kind of loss: one request, not the run.
        if (error instanceof Error && (error.name === 'TypeError' || error.name === 'AbortError' || /UND_ERR|ECONN|ETIMEDOUT|fetch failed/i.test(`${error.message} ${(error as { cause?: { code?: string } }).cause?.code ?? ''}`))) {
          discard(`AI 호출 실패:${(error as { cause?: { code?: string } }).cause?.code ?? error.name}`); return null;
        }
        throw error;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const eligible = nodes.filter(n => nodeStep(n.type) === step);
    const reduced = reduceSynthesisNodes(eligible);
    const layer = reduced.filter(n => n.score >= 0);
    d.noiseDroppedCount = eligible.filter(n => n.score - noisePenalty(n.title) < 0).length;
    const reducedById = new Map(layer.map(node => [node.id, node]));
    const stageIndicators = indicators.filter(i => i.step === step);
    let groups: Group[] = [];
    const rows = layer.map(({ id, title, description, evidence }) => ({ id, title, description: description.slice(0, 120), evidenceCount: evidence.length }));
    const chunks = Array.from({ length: Math.ceil(rows.length / rowsPerCall) }, (_, i) => rows.slice(i * rowsPerCall, (i + 1) * rowsPerCall)).flatMap(chunk => chunkSynthesisInput(chunk));
    // Missing IDs are retried exactly once, and invalid IDs never displace a valid first assignment.
    const groupRows = async <T extends { id: string }>(input: T[], key: 'nodes' | 'groups', prefix: string, resolve: (id: string) => InputNode[]) => {
      const accepted: Group[] = []; const used = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = input.filter(row => !used.has(row.id));
        if (!pending.length) break;
        let sent: T[] = [];
        const response = await call(() => {
          sent = pending;
          if (!sent.length) return null;
          const cleaned = sent.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && k !== 'id' ? safe(v) : v])));
          return [{ role: 'system', content: GROUP_PROMPT + (key === 'groups' ? ` 입력은 그룹 이름이며 이 단계 목표는 ${LIMITS[step]}개다.` : '') }, { role: 'user', content: JSON.stringify({ step, [key]: cleaned }) }];
        }, 'groupingCalls', key === 'nodes' ? () => { for (const row of sent) processedNodeIds.add(row.id); d.groupingInputNodeCount = layer.filter(node => processedNodeIds.has(node.id)).length; } : undefined);
        if (!response) break;
        const parsed = GroupResponse.safeParse(response);
        if (!parsed.success) { discard('묶기 응답 형식'); continue; }
        const available = new Set(sent.map(row => row.id));
        for (const raw of parsed.data.groups) {
          const one = GroupItem.safeParse(raw);
          if (!one.success) { discard('묶기 스키마'); continue; }
          const g = one.data;
          if (safe(g.name) !== g.name) { discard('묶기 이름 금지 문장'); continue; }
          const ids = g.ids.filter(id => { if (used.has(id)) { discard('묶기 중복 id'); return false; } if (!available.has(id)) { discard('묶기 없는 id'); return false; } used.add(id); return true; });
          if (ids.length) accepted.push({ id: `${prefix}${accepted.length + 1}`, name: g.name.slice(0, 30), nodes: ids.flatMap(resolve) });
        }
      }
      d.ungroupedNodeCount += input.filter(row => !used.has(row.id)).reduce((sum, row) => sum + resolve(row.id).length, 0);
      progress(); return accepted;
    };
    for (const chunk of chunks) {
      const grouped = await groupRows(chunk, 'nodes', `G${groups.length + 1}-`, id => [reducedById.get(id)!]);
      groups.push(...grouped);
    }
    if (chunks.length > 1 && groups.length) {
      let pass = 0; let regroupChunks: Array<Array<{ id: string; name: string }>>;
      do {
        const previous = groups; const byId = new Map(previous.map(g => [g.id, g]));
        const names = previous.map(({ id, name }) => ({ id, name }));
        regroupChunks = Array.from({ length: Math.ceil(names.length / rowsPerCall) }, (_, i) => names.slice(i * rowsPerCall, (i + 1) * rowsPerCall)).flatMap(chunk => chunkSynthesisInput(chunk));
        groups = [];
        for (const chunk of regroupChunks) groups.push(...await groupRows(chunk, 'groups', `M${pass}-${groups.length}-`, id => byId.get(id)!.nodes));
        pass++;
        if (groups.length > previous.length * 0.9) { d.regroupFailure = '재묶기 축소 실패'; progress(); break; }
      } while (regroupChunks.length > 1 && groups.length);
    }
    const cap = ({ 4: 15, 5: 8, 6: 12, 7: 15 } as const)[step] * 3;
    if (groups.length > cap) {
      groups.sort((a, b) => new Set(b.nodes.flatMap(n => n.evidence.map(e => e.id))).size - new Set(a.nodes.flatMap(n => n.evidence.map(e => e.id))).size);
      d.skippedJudgmentCount = groups.length - cap; d.skippedJudgmentReason = `판정 생략(묶기 실패) ${d.skippedJudgmentCount}`;
      groups = groups.slice(0, cap);
    }
    const tasks: Array<{ group: Group; indicator?: Indicator }> = [...groups.map(group => ({ group })), ...stageIndicators.map(indicator => ({ indicator, group: { id: indicator.id, name: indicator.name, nodes: layer.map(node => ({ node, score: relevance(indicator.name, node) })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).map(entry => entry.node) } }))];
    const batches = [...Array.from({ length: Math.ceil(groups.length / 5) }, (_, i) => tasks.slice(i * 5, Math.min((i + 1) * 5, groups.length))), ...tasks.slice(groups.length).map(task => [task])];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      type Prepared = { group: Group; indicator?: Indicator; allowedParagraphs: Map<string, string[]>; payload: { group: { id: string; name: string; nodes: Array<{ id: string; title: string; evidence: Array<{ id: string; quote: string }>; edges?: unknown[] }> }; indicator?: object } };
      let prepared: Prepared[] = [];
      const response = await call(() => {
        prepared = batch.flatMap(({ group, indicator }) => {
          const liveNodes = group.nodes;
          if (!indicator && !liveNodes.length) return [];
          const evidence = selectEvidence(liveNodes).filter(e => Buffer.byteLength(JSON.stringify(e), 'utf8') < 5000);
          while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 5000) evidence.pop();
          const allowedParagraphs = new Map<string, string[]>();
          for (const e of evidence) allowedParagraphs.set(e.id, [...(allowedParagraphs.get(e.id) ?? []), e.quote]);
          const remaining = new Set(evidence);
          const evidenceNodes = liveNodes.map(n => { const selected = [...remaining].filter(e => n.evidence.some(ne => ne.id === e.id && ne.quote === e.quote)); selected.forEach(e => remaining.delete(e)); return { id: n.id, title: safe(n.title), evidence: selected, ...(step === 7 ? { edges: n.edges.slice(0, 4).map(edge => ({ ...edge, title: safe(edge.title).slice(0, 100) })) } : {}) }; }).filter(n => n.evidence.length);
          const payload = { group: { id: group.id, name: safe(group.name), nodes: evidenceNodes }, ...(indicator ? { indicator: { ...indicator, name: safe(indicator.name), target: safe(indicator.target), verify: safe(indicator.verify) } } : {}) };
          return [{ group, indicator, allowedParagraphs, payload }];
        });
        if (!prepared.length) return null;
        const measure = (messages: ChatMessage[]) => ai.synthesisRequestBytes?.(messages) ?? Buffer.byteLength(JSON.stringify({ model: '', messages, reasoning_effort: '', response_format: { type: 'json_object' } }), 'utf8') + 1024;
        const fitted = fitJudgmentRequest(prepared, step, PROMPT + ' 입력 그룹마다 id를 그대로 유지한 항목 하나를 items 배열에 반환한다.', measure);
        if (fitted.overflow.length) {
          const overflow = new Set(fitted.overflow.map(p => p.group));
          const remaining = batch.filter(task => overflow.has(task.group));
          batch.splice(0, batch.length, ...batch.filter(task => !overflow.has(task.group)));
          batches.splice(batchIndex + 1, 0, remaining);
        }
        prepared = fitted.included;
        for (const task of prepared) {
          task.allowedParagraphs = new Map();
          for (const node of task.payload.group.nodes) for (const e of node.evidence) task.allowedParagraphs.set(e.id, [...(task.allowedParagraphs.get(e.id) ?? []), e.quote]);
        }
        return fitted.messages;
      }, 'judgmentCalls');
      if (!response) continue;
      if (typeof response !== 'object' || !Array.isArray((response as { items?: unknown }).items)) { discard('응답 형식'); continue; }
      const candidates = (response as { items: unknown[] }).items;
      const used = new Set<string>();
      for (const candidate of candidates) {
      const candidateObject = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : null;
      if (!candidateObject) { discard('형식'); continue; }
      // Fill harmless gaps the model leaves (missing fields, numbers or null for text, string step, missing id/k when
      // the call held one task). Safety checks below are unchanged.
      const soleTask = prepared.length === 1 ? prepared[0] : undefined;
      const normalized = normalizeCandidate(candidateObject, step, soleTask ? { id: soleTask.group.id, indicator: Boolean(soleTask.indicator) } : undefined);
      // Models often rename or drop the group id: fall back to the group whose name matches, then to the next
      // unanswered group in request order. Cites are still limited to the chosen group's own evidence below.
      const open = prepared.filter(p => !used.has(p.group.id));
      const itemName = str(normalized.name);
      const task = open.find(p => p.group.id === normalized.id)
        ?? open.find(p => norm(p.group.name) === norm(itemName) || (norm(itemName).length > 1 && (norm(p.group.name).includes(norm(itemName)) || norm(itemName).includes(norm(p.group.name)))))
        ?? open[0];
      if (!task) { discard('항목 id 불일치'); continue; }
      const types = task.group.nodes.map(n => n.type);
      normalized.grp = task.indicator ? '성과지표 기준 충족 여부' : step !== 7 ? '성과지표 외 AI 제안'
        : ['기여요인', '제약요인'].includes(str(normalized.grp)) ? str(normalized.grp)
        : types.filter(x => x === 'enabler').length >= types.filter(x => x === 'constraint').length ? '기여요인' : '제약요인';
      const parsed = Item.safeParse(task.indicator || normalized.k === 'ind' ? { ...normalized, met: '' } : normalized);
      if (!parsed.success) { discard(`스키마:${parsed.error.issues.slice(0, 2).map(i => i.path.join('.')).join(',')}`); continue; }
      if (parsed.data.step !== step) { discard('단계 불일치'); continue; }
      const item = parsed.data;
      used.add(task.group.id);
      const { indicator, allowedParagraphs } = task;
      // Type and group follow the task, not the model's label.
      item.id = task.group.id;
      item.k = indicator ? 'ind' : step === 4 ? 'opt' : step === 7 ? 'fac' : 'out';
      item.cites = [...new Set(item.cites.filter(id => allowedParagraphs.has(id)))];
      const quotes = item.cites.flatMap(id => allowedParagraphs.get(id) ?? []);
      const fieldsToCheck: Array<[string, string | undefined]> = [[item.name, indicator?.name], [item.ai, undefined], [item.target, indicator?.target], [item.actual, undefined], [item.verify, indicator?.verify], ...(indicator ? [] : [[item.met, undefined] as [string, undefined]]), [item.match, undefined], [item.enough, undefined], [item.authors, undefined], [item.note, undefined], ...item.conflict.map((value): [string, undefined] => [value, undefined]), ...item.links.map((link): [string, undefined] => [link.outcome, undefined])];
      const failing = fieldsToCheck.map(([value, source], index) => ({ index, value, banned: safe(value) !== value, numeric: !checkNumericConsistency(value, source === value ? [...quotes, source] : quotes).passed })).filter(f => f.banned || f.numeric);
      // Banned sentences or unsupported numbers in the core fields (name, ai, target, actual, verify) drop the item.
      const core = failing.find(f => f.banned || f.index < 5);
      if (core) { discard(core.banned ? '금지 문장' : `근거 없는 수치:${['name', 'ai', 'target', 'actual', 'verify'][core.index]}`); continue; }
      // Side remarks (met, match, enough, authors, note, conflicts, link targets) with an unsupported number are blanked instead.
      if (failing.length) {
        const blankValues = new Set(failing.map(f => f.value));
        for (const key of ['met', 'match', 'enough', 'authors', 'note'] as const) if (blankValues.has(item[key])) item[key] = '';
        item.conflict = item.conflict.filter(c => !blankValues.has(c));
        item.links = item.links.filter(l => !blankValues.has(l.outcome));
        d.blankedFieldCount = (d.blankedFieldCount ?? 0) + failing.length;
      }
      // fam·lvl·conf are closed vocabularies validated below; level codes such as K4 carry no evidence number, so only the banned-sentence boundary applies.
      if (![item.fam, item.lvl, item.conf].every(value => safe(value) === value)) { discard('금지 문장'); continue; }
      if (!item.cites.length) { item.state = '미확인'; item.actual = ''; item.note = addNote(item.note, '근거 자료 미확보'); }
      if (indicator) { item.name = indicator.name; item.target = indicator.target; item.verify = indicator.verify; item.grp = '성과지표 기준 충족 여부'; item.met = item.actual ? judgeIndicator(item.target, item.actual) : '판정 불가 (실적 근거 미확보)'; }
      if (item.fam && !['협력국 정책 반영', '개발협력 촉진', '경제협력 촉진', '지식 네트워킹'].includes(item.fam)) { discard('성과군 값'); continue; }
      if (item.conf && !['높음', '보통', '낮음', '해당 없음'].includes(item.conf)) { discard('신뢰수준 값'); continue; }
      if (item.lvl && !/^(?:(?:지식활용 )?K[0-6]|(?:협력확장 )?Lv[1-5])$/.test(item.lvl)) { discard('단계 값'); continue; }
      if (step === 7) { const outcomes = nodes.filter(n => ['outcome-short', 'outcome-mid'].includes(n.type)); item.links = item.links.filter(link => outcomes.some(outcome => outcome.id === link.outcome || norm(outcome.title) === norm(link.outcome))); if (item.links.length) item.note = addNote(item.note, 'AI 추정'); }
      if (!indicator) item.id = `S${step}-${String(items.length + 1).padStart(2, '0')}`;
      items.push(item); d.finalItemCount++; progress();
      }
    }
    for (const ind of indicators.filter(ind => ind.step === step)) if (!items.some(item => item.id === ind.id && item.k === 'ind')) { items.push(blank(ind)); d.finalItemCount++; }
    assertEligibility();
    options.onStageComplete?.({ items: [...items], inputNodeCount: processedNodeIds.size, discardedCount: Object.values(diagnostics).reduce((sum, entry) => sum + entry.discardedResponseCount, 0), diagnostics });
    } catch (error) {
      if (!(error instanceof StageLimit)) throw error;
      d.partialReason = error.message; partialReason = error.message;
      assertEligibility();
      options.onStageComplete?.({ items: [...items], inputNodeCount: processedNodeIds.size, discardedCount: Object.values(diagnostics).reduce((sum, entry) => sum + entry.discardedResponseCount, 0), diagnostics, partialReason });
    }
  }
  } catch (error) {
    if (!(error instanceof SynthesisLimit)) throw error;
    partialReason = error.message; diagnostics[activeStep].partialReason = partialReason; progress();
  }
  assertEligibility();
  const deduped = [...new Map(items.map(item => [`${item.step}:${item.k}:${item.k === 'ind' ? item.id : norm(item.name)}`, item])).values()];
  for (const ind of partialReason ? [] : indicators) if (!deduped.some(item => item.id === ind.id && item.k === 'ind')) deduped.push(blank(ind));
  for (const step of [4, 5, 6, 7] as const) diagnostics[step].finalItemCount = 0;
  for (const item of deduped) diagnostics[item.step].finalItemCount++;
  progress();
  // Points the model never grouped (malformed replies twice) are lost input: report the run as partial, not complete.
  const ungrouped = Object.values(diagnostics).reduce((sum, d) => sum + d.ungroupedNodeCount, 0);
  if (!partialReason && ungrouped > 0) partialReason = `묶기 응답 오류로 점 ${ungrouped}개를 묶지 못했습니다`;
  return { items: deduped, inputNodeCount: processedNodeIds.size, discardedCount: Object.values(diagnostics).reduce((sum, d) => sum + d.discardedResponseCount, 0), diagnostics, partialReason };
}
