import { stableNodeId } from './node-id';
import { createHash } from 'node:crypto';
import { AiClient, AI_CALL_TIMEOUT_MS, OntologyCallError, runOntologyAttempts, createE2EFakeAiClient } from '@/server/ai/client';
import type { OntologyFailureKind } from '@/server/ai/client';
export { AI_CALL_TIMEOUT_MS } from '@/server/ai/client';
import type { ChatMessage } from '@/server/ai/types';
import { getParagraphsByDocument, listDocuments } from '@/server/store/db';
import type { DbConnection } from '@/server/store/db';
import type { DocumentRecord, ParagraphRecord, ProjectRecord } from '@/server/store/types';
import { checkNumericConsistency } from '@/server/numeric-check';
import { verifyQuote } from '@/server/quote-verify';
import { getAiDocumentEligibilityForProvider } from '@/server/documents/ai-eligibility';
import { AiEligibilityChangedError, createProjectEligibilityGuard } from '@/server/documents/eligibility-fingerprint';
import { ID_PATTERNS, REQUIRED, RELATION_FIELDS, VOCAB, checkOntologyGraph } from './checker';
import { safeOntologyError } from './error-safety';
import { OntologyGraph } from './types';
import type { OntologyGenerationResponse } from './generator-types';

/** Paragraphs per knowledge-map request; slower models answer smaller chunks more reliably (1-200, default 30). */
export function paragraphsPerRequestFromEnv(raw: string | undefined, fallback = 30): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : fallback;
}
export const MAX_PARAGRAPHS_PER_REQUEST = paragraphsPerRequestFromEnv(typeof process !== 'undefined' ? process.env.AIEAS_ONTOLOGY_PARAGRAPHS_PER_REQUEST : undefined);
export const MAX_CONCURRENT_AI_CALLS = 2;
const MAX_CONFIGURED_AI_CALLS = 16;

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return MAX_CONCURRENT_AI_CALLS;
  return Math.min(value, MAX_CONFIGURED_AI_CALLS);
}

function configuredConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return MAX_CONCURRENT_AI_CALLS;
  return normalizeConcurrency(Number(value.trim()));
}

const SYSTEM_PROMPT = `너는 evidence-based ontology 추출기다. 오직 전달된 현재 사업의 문단만 사용한다. 문단 id와 quote는 입력에서 그대로 복사한다. 인용은 원문에서 연속된 문자열을 최대 300자로 복사한다. 원문에 없는 사실, 이름, 숫자, 날짜, 기관이나 관계를 만들지 않는다. 스니펫마다 확인된 사실(fact), AI 해석(interpretation), 불확실성(uncertainty), 관측일(observed_date)을 근거로 작성하고 모르면 빈 문자열로 둔다. 계획·희망·예정 문장은 evidence_level=예견이다. evidence_level은 ${[...VOCAB.evidence_level].join("·")} 중 하나, speaker는 ${[...VOCAB.speaker].join("·")} 중 하나, evidence_kind는 ${[...VOCAB.evidence_kind].join("·")} 중 하나, category는 ${[...VOCAB.category].join("·")} 중 하나다. snippet의 proves_indices/supports_indices/contradicts_indices는 해당 관계를 갖는 nodes 배열의 0부터 시작하는 인덱스다. node의 evidence_indices는 근거 snippets 배열의 0부터 시작하는 인덱스다. 노드 유형은 project, partner(협력국), implementer(수행기관), policy-area(정책분야), participant-org(기관), activity, output, outcome-short, outcome-mid, indicator, enabler, constraint만 쓴다. 사업계획서·종료보고서 첫머리에서 수행기관·정책분야를 뽑는다. 같은 사업의 후속·연계 사업은 새 project가 아니라 outcome-mid 성과로 나타내고 기존 성과에서 extends_to로 연결한다. 각 노드에는 원문 근거를 연결한다. 활동은 date_start/date_end/place, 산출물은 output_type, 성과는 outcome_type/timing, 지표는 baseline/target/actual/verification_source, 요인은 factor_scope/factor_class를 근거에 맞춰 분류하고, response는 대응 노력이 원문에 있으면 그 문구를 그대로 옮기며 없으면 빈 문자열로 둔다. outcome_family는 ${[...VOCAB.outcome_family].join("·")}, outcome_state_ai는 ${[...VOCAB.outcome_state_ai].join("·")}, pdm_stage는 ${[...VOCAB.pdm_stage].join("·")} 중 하나다. factor_scope는 ${[...VOCAB.factor_scope].join("·")}, factor_class는 ${[...VOCAB.factor_class].join("·")}, output_type은 ${[...VOCAB.output_type].join("·")}, outcome_type은 ${[...VOCAB.outcome_type].join("·")}, timing은 ${[...VOCAB.timing].join("·")}, institution_type은 ${[...VOCAB.institution_type].join("·")} 중 하나다. 수준·점수·등급·전문가 승인·사람 승인과 status를 출력하지 않는다. 예견·추정 근거만 있는 성과를 관측됨이나 추진 중으로 만들지 않는다. 관계는 project→activity conducts, project→outcome-mid targets, project→partner partner, project→participant-org study_tour, partner/participant-org→activity participates_in, activity→output generates, output→outcome induces, enabler→outcome promotes, constraint→outcome hinders, indicator→output/outcome measures, indicator의 verification_source에 검증 문서 제목을 그대로 쓴다. 동일한 입력 문서가 확인되면 후처리가 indicator→source verified_by 관계를 만든다. 명시된 관계만 낸다. 불확실하거나 근거 없는 칸은 빈 문자열, 수치는 JSON number 또는 null로 둔다. 주어진 JSON Schema에 맞는 JSON만 반환한다.`;

export interface GenerateOntologyOptions {
  db?: DbConnection;
  aiClient?: Pick<AiClient, 'generateOntology' | 'modelName' | 'provider'>;
  concurrency?: number;
  aiCallTimeoutMs?: number;
  retryWait?: (ms: number) => Promise<void>;
  afterAssembleChunk?: (documentId: string, chunkIndex: number) => void;
  project?: ProjectRecord;
  onProgress?: (completed: number, total: number) => void | Promise<void>;
  guard?: () => void;
}

export interface GeneratedOntologyResult {
  graph: OntologyGraph;
  modelName: string;
  documentSuccessCount: number;
  documentFailureCount: number;
  discardedQuoteCount: number;
  failedDocuments: Array<{ documentId: string; reason: string }>;
  excludedDocuments: Array<{ documentId: string; reasons: string[] }>;
  failureKinds: Partial<Record<OntologyFailureKind, number>>;
}

interface InputParagraph extends ParagraphRecord { document_name: string; }

export async function generateProjectOntology(projectId: string, options: GenerateOntologyOptions = {}): Promise<GeneratedOntologyResult> {
  const guard = options.guard ?? createProjectEligibilityGuard(projectId, options.db);
  const concurrency = options.concurrency === undefined
    ? configuredConcurrency(process.env.AIEAS_ONTOLOGY_CONCURRENCY)
    : normalizeConcurrency(options.concurrency);
  const ai = options.aiClient ?? (process.env.AIEAS_E2E_FAKE_AI === '1' ? createE2EFakeAiClient() : new AiClient());
  const selectedDocs = listDocuments(projectId, options.db).filter((doc) => doc.is_included === 1);
  const eligibility = selectedDocs.map((doc) => ({ doc, result: getAiDocumentEligibilityForProvider(doc, ai.provider) }));
  const eligibleDocs = eligibility.filter(({ result }) => result.eligible).map(({ doc }) => doc);
  const unreadDocs = eligibleDocs.filter((doc) => doc.status !== '추출 완료');
  const docs = eligibleDocs.filter((doc) => doc.status === '추출 완료');
  const excludedDocuments = eligibility.filter(({ result }) => !result.eligible).map(({ doc, result }) => ({ documentId: doc.id, reasons: result.reasons }));
  const project = options.project ?? { id: projectId, name: projectId, created_at: '' };
  const docsWithParagraphs = docs.map((doc) => ({ doc, paragraphs: getParagraphsByDocument(doc.id, options.db) }));
  const emptyDocs = docsWithParagraphs.filter(({ paragraphs }) => paragraphs.length === 0).map(({ doc }) => doc);
  const chunks = docsWithParagraphs.flatMap(({ doc, paragraphs }) => chunk(paragraphs.map((p) => ({ ...p, document_name: doc.file_name })), MAX_PARAGRAPHS_PER_REQUEST).map((paragraphs) => ({ doc, paragraphs })));
  const responses: Array<OntologyGenerationResponse | Error | undefined> = Array(chunks.length);
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= chunks.length) return;
      const { doc } = chunks[index];
      try {
        const response = await runOntologyAttempts<OntologyGenerationResponse>(
          (signal) => {
            guard();
            return ai.generateOntology(buildMessages(doc, chunks[index].paragraphs), signal, { singleAttempt: true, guard });
          },
          { timeoutMs: options.aiCallTimeoutMs ?? AI_CALL_TIMEOUT_MS, wait: options.retryWait, guard },
        );
        responses[index] = response;
      }
      catch (error) { if (error instanceof AiEligibilityChangedError) throw error; responses[index] = error instanceof Error ? error : new Error('AI 호출 실패'); }
      completed++;
      await options.onProgress?.(completed, chunks.length);
    }
  });
  await Promise.all(workers);

  const code = `P${stableToken(projectId, 6)}`;
  const graph: OntologyGraph = { code, projectName: project.name, project: { id: projectId }, sources: {}, snippets: {}, nodes: {}, edges: [], reports: {}, report_status: {}, issues: [] };
  const created = new Date().toISOString().slice(0, 10);
  let discardedQuoteCount = 0;
  const failedDocuments: GeneratedOntologyResult['failedDocuments'] = [
    ...unreadDocs.map((doc) => ({ documentId: doc.id, reason: '문서 추출이 완료되지 않음' })),
    ...emptyDocs.map((doc) => ({ documentId: doc.id, reason: '추출된 문단이 없음' })),
  ];
  const failureKinds: GeneratedOntologyResult['failureKinds'] = {};
  const failuresByDoc = new Map<string, Partial<Record<OntologyFailureKind, number>>>();
  const sourceIds = new Map<string, string>();
  const chunksByDoc = new Map<string, number[]>();
  chunks.forEach(({ doc }, index) => chunksByDoc.set(doc.id, [...(chunksByDoc.get(doc.id) ?? []), index]));
  const evidenceNumberByDoc = new Map<string, number>();
  const nodeIdsByName = assignStableNodeIds(docsWithParagraphs, chunksByDoc, chunks, responses, code, project.name);

  for (const { doc } of docsWithParagraphs) {
    const docToken = `D${stableToken(doc.id, 5)}`;
    const sourceId = `SRC-${code}-${docToken}-01`;
    sourceIds.set(doc.id, sourceId);
    graph.sources[sourceId] = {
      id: sourceId, title: doc.file_name, file: doc.file_name, document_id: doc.id,
      layer: 'L3', created, updated: created, reviewer: '', tags: [],
      doc_type: doc.doc_type && DOC_TYPE_SET.has(doc.doc_type) ? doc.doc_type : '기타',
      me_stage: '', doc_date: '', masked: doc.masked, approved_ai: doc.approved_ai, holdout: null, is_past_final_report: doc.is_past_final_report,
      status: 'ai-draft', author: 'ai',
    };
  }

  for (const [docId, indices] of chunksByDoc) {
    const documentGraph = structuredClone(graph);
    const documentNodeIds = new Map(nodeIdsByName);
    const evidenceCountBefore = evidenceNumberByDoc.get(docId) ?? 0;
    const discardedQuoteCountBefore = discardedQuoteCount;
    try {
    for (const index of indices) {
      const response = responses[index];
      const { doc, paragraphs } = chunks[index];
      if (!paragraphs.length) continue;
      if (response instanceof Error || !response) {
        const kind = response instanceof OntologyCallError ? response.kind : 'network';
        const counts = failuresByDoc.get(docId) ?? {};
        counts[kind] = (counts[kind] ?? 0) + 1;
        failuresByDoc.set(docId, counts);
        failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
        graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'generation', rule: 'AI 호출 실패', detail: kind });
        continue;
      }
      const paragraphById = new Map(paragraphs.map((p) => [p.id, p]));
      const snippets: Array<string | null> = Array(response.snippets.length).fill(null);
      const orderedSnippets = response.snippets.map((candidate, responseIndex) => ({ candidate, responseIndex })).sort((left, right) => {
        const leftSequence = paragraphById.get(left.candidate.paragraph_id)?.sequence_no ?? Number.MAX_SAFE_INTEGER;
        const rightSequence = paragraphById.get(right.candidate.paragraph_id)?.sequence_no ?? Number.MAX_SAFE_INTEGER;
        return leftSequence - rightSequence || left.candidate.quote.localeCompare(right.candidate.quote) || left.responseIndex - right.responseIndex;
      });
      for (const { candidate, responseIndex } of orderedSnippets) {
        const paragraph = paragraphById.get(candidate.paragraph_id);
        if (!paragraph) {
          discardedQuoteCount++;
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.paragraph_id', rule: '입력 밖 문단 id 폐기' });
          continue;
        }
        if (candidate.quote.length > 300 || !verifyQuote(candidate.quote, paragraph.content)) {
          discardedQuoteCount++;
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.quote', rule: '원문 불일치 인용 폐기' });
          continue;
        }
        if (!vocab('speaker', candidate.speaker) || !vocab('evidence_kind', candidate.evidence_kind) || !vocab('category', candidate.category)) {
          discardedQuoteCount++;
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.vocabulary', rule: '통제 어휘 밖 값 폐기' });
          continue;
        }
        const n = (evidenceNumberByDoc.get(docId) ?? 0) + 1;
        evidenceNumberByDoc.set(docId, n);
        const id = `SNP-${code}-${stableToken(docId, 5)}-${String(n).padStart(3, '0')}`;
        const observedDate = groundedDate(candidate.observed_date, [candidate.quote]);
        const safeSnippetText = {
          fact: groundedText(candidate.fact, [candidate.quote]) ? candidate.fact : '',
          interpretation: candidate.interpretation,
          uncertainty: candidate.uncertainty,
        };
        for (const [field, safeValue] of Object.entries(safeSnippetText)) {
          if (candidate[field as keyof typeof safeSnippetText] && !safeValue) graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `snippet.${field}`, rule: '인용에서 확인되지 않는 문구 비움' });
        }
        if (candidate.observed_date && !observedDate) graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.observed_date', rule: '원문에서 확인할 수 없는 관측일 비움' });
        const claimKind = classifyClaim(candidate.quote);
        if (claimKind === 'ambiguous') graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.evidence_level', rule: 'R05 사람 확인 필요' });
        const evidenceLevel = claimKind === 'plan' ? '예견' : candidate.evidence_level;
        if (evidenceLevel !== candidate.evidence_level) graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: 'snippet.evidence_level', rule: 'R04 계획·희망 근거의 신뢰수준을 예견으로 교정' });
        graph.snippets[id] = { id, type: 'evidence', layer: 'L3', created, updated: created, source: sourceIds.get(docId), locator: paragraph.location, quote: candidate.quote, speaker: candidate.speaker, evidence_kind: candidate.evidence_kind, evidence_level: evidenceLevel, category: candidate.category, ...safeSnippetText, observed_date: observedDate, proves: [], supports: [], contradicts: [], status: 'ai-draft', author: 'ai', reviewer: '', tags: [] };
        snippets[responseIndex] = id;
      }
      const nodeIds: string[] = [];
      response.nodes.forEach((rawCandidate, nodeIndex) => {
        const candidate = normalizeFollowup(rawCandidate, project.name);
        const linked: number[] = [];
        for (const evidenceIndex of candidate.evidence_indices) {
          if (!Number.isInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex >= snippets.length || !snippets[evidenceIndex]) {
            graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}.evidence_indices`, rule: '해결할 수 없는 근거 인덱스 폐기' });
            continue;
          }
          if (linked.includes(evidenceIndex)) {
            graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}.evidence_indices`, rule: '중복 근거 인덱스 폐기' });
            continue;
          }
          linked.push(evidenceIndex);
        }
        if (!linked.length) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}`, rule: '유효 근거 없는 점 폐기' });
          nodeIds[nodeIndex] = '';
          return;
        }
        const evidenceIds = linked.map((evidenceIndex) => snippets[evidenceIndex]!);
        const quotes = evidenceIds.map((id) => String(graph.snippets[id].quote ?? ''));
        if (!checkNumericConsistency(candidate.name, quotes).passed) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}.name`, rule: '인용에 없는 수치 점 이름 폐기' });
          nodeIds[nodeIndex] = '';
          return;
        }
        const description = checkNumericConsistency(candidate.description, quotes).passed && groundedText(candidate.description, quotes) ? candidate.description : '';
        if (description !== candidate.description) graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}.description`, rule: '인용과 일치하지 않는 설명 비움' });
        const mergeKey = nodeOccurrenceKey(candidate, response, docId, paragraphs);
        let id = nodeIdsByName.get(mergeKey);
        if (!id) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}`, rule: '안정 ID를 만들 수 없는 점 폐기' });
          nodeIds[nodeIndex] = '';
          return;
        }
        if (!graph.nodes[id]) {
          const record = { id, type: candidate.type, layer: layerForType(candidate.type), created, updated: created, title: candidate.name.trim(), description, evidence: evidenceIds, status: 'ai-draft', review_state: '미검토', author: 'ai', reviewer: '', tags: [], screen: screenForType(candidate.type), ...nodeMetadata(candidate, graph, sourceIds.get(docId)!, quotes) };
          const missing = (REQUIRED[candidate.type] ?? []).filter((field) => !(field in record));
          if (missing.length) {
            graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `nodes.${nodeIndex}`, rule: `필수 칸 누락: ${missing.join(',')}` });
            nodeIds[nodeIndex] = '';
            return;
          }
          graph.nodes[id] = record;
        } else {
          const existing = graph.nodes[id];
          existing.evidence = [...new Set([...(existing.evidence as string[]), ...evidenceIds])];
          if ((existing.evidence as string[]).length >= 2) existing.merged_same_document = true;
          if (!existing.description && description) existing.description = description;
        }
        nodeIds[nodeIndex] = id;
      });
      response.snippets.forEach((candidateEvidence, evidenceIndex) => {
        const snippetId = snippets[evidenceIndex];
        if (!snippetId) return;
        for (const relation of ['proves', 'supports', 'contradicts'] as const) {
          const seenNodeIndices = new Set<number>();
          for (const nodeIndex of candidateEvidence[`${relation}_indices`]) {
            if (seenNodeIndices.has(nodeIndex)) {
              graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `snippets.${evidenceIndex}.${relation}_indices`, rule: '중복 점 인덱스 폐기' });
              continue;
            }
            seenNodeIndices.add(nodeIndex);
            const target = Number.isInteger(nodeIndex) && nodeIndex >= 0 && nodeIndex < nodeIds.length ? nodeIds[nodeIndex] : '';
            if (!target || !graph.nodes[target]) {
              graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `snippets.${evidenceIndex}.${relation}`, rule: '해결할 수 없는 점 인덱스 폐기' });
              continue;
            }
            const snippet = graph.snippets[snippetId];
            const targets = (snippet[relation] as string[]) ?? [];
            snippet[relation] = [...new Set([...targets, target])];
            graph.edges.push({ source: snippetId, target, relation });
          }
        }
      });
      for (const edge of response.edges) {
        const source = nodeIds[edge.source_node_index];
        const target = nodeIds[edge.target_node_index];
        if (!source || !target || !RELATION_FIELDS.includes(edge.relation)) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `edges.${edge.source_node_index}.${edge.target_node_index}`, rule: '끝점 없는 선 폐기' });
          continue;
        }
        if (source === target) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `edges.${edge.source_node_index}.${edge.target_node_index}`, rule: '자기 자신을 잇는 선 폐기' });
          continue;
        }
        if (!validGeneratedRelation(graph.nodes[source]?.type, graph.nodes[target]?.type, edge.relation)) {
          graph.issues.push({ severity: 'warning', file: sourceIds.get(docId)!, field: `edges.${edge.source_node_index}.${edge.target_node_index}`, rule: '관계 유형·방향 또는 끝점이 올바르지 않은 선 폐기' });
          continue;
        }
        if (edge.relation === 'extends_to' || edge.relation === 'targets') {
          (graph.candidates ??= []).push({ source, target, relation: edge.relation });
        } else {
          graph.edges.push({ source, target, relation: edge.relation });
        }
      }
      options.afterAssembleChunk?.(docId, index);
    }
    } catch (error) {
      for (const key of Object.keys(graph.sources)) if (!(key in documentGraph.sources)) delete graph.sources[key];
      for (const key of Object.keys(graph.snippets)) if (!(key in documentGraph.snippets)) delete graph.snippets[key];
      for (const key of Object.keys(graph.nodes)) if (!(key in documentGraph.nodes)) delete graph.nodes[key];
      Object.assign(graph.sources, documentGraph.sources);
      Object.assign(graph.snippets, documentGraph.snippets);
      Object.assign(graph.nodes, documentGraph.nodes);
      graph.edges = documentGraph.edges;
      graph.candidates = documentGraph.candidates;
      graph.issues = documentGraph.issues;
      nodeIdsByName.clear();
      for (const [key, value] of documentNodeIds) nodeIdsByName.set(key, value);
      evidenceNumberByDoc.set(docId, evidenceCountBefore);
      discardedQuoteCount = discardedQuoteCountBefore;
      const safeError = safeOntologyError(error);
      const reason = safeError.message;
      console.error(`[ontology-generation] stage=assemble name=${safeError.name} message=${reason}`);
      failedDocuments.push({ documentId: docId, reason: `문서 조립 실패: ${reason}` });
    }
  }
  for (const [documentId, counts] of failuresByDoc) {
    const summary = Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(', ');
    const previous = failedDocuments.find((failure) => failure.documentId === documentId);
    if (previous) previous.reason += `; 생성 요청 실패 (${summary})`;
    else failedDocuments.push({ documentId, reason: `문서 일부 생성 요청 실패 (${summary})` });
  }
  const projectNodes = Object.entries(graph.nodes).filter(([, node]) => node.type === 'project');
  const currentProject = projectNodes.find(([, node]) => normalizeName(String(node.title ?? '')) === normalizeName(project.name)) ?? (projectNodes.length === 1 ? projectNodes[0] : undefined);
  if (currentProject) {
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (node.type === 'outcome-mid' && node.outcome_type === '후속사업연계') (graph.candidates ??= []).push({ source: currentProject[0], target: id, relation: 'targets' });
    }
  }
  // Only link a verification source when the quoted title identifies exactly one input document.
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type !== 'indicator' || typeof node.verification_source !== 'string' || !node.verification_source.trim()) continue;
    const matches = Object.entries(graph.sources).filter(([, source]) => normalizeName(String(source.title ?? '')) === normalizeName(String(node.verification_source)));
    if (matches.length === 1) graph.edges.push({ source: id, target: matches[0][0], relation: 'verified_by' });
  }
  // AI proposes cross-chunk paths; these remain proposals until a reviewer confirms them.
  const outcomes = Object.entries(graph.nodes).filter(([, node]) => ['outcome-short', 'outcome-mid'].includes(String(node.type)));
  if (outcomes.some(([, node]) => node.type === 'outcome-short') && outcomes.some(([, node]) => node.type === 'outcome-mid')) {
    const candidates = outcomes.map(([id, node]) => ({ id, type: node.type, title: node.title, description: node.description,
      evidence: (Array.isArray(node.evidence) ? node.evidence : []).map((evidenceId) => graph.snippets[String(evidenceId)]?.quote).filter(Boolean) }));
    try {
      const proposal = await runOntologyAttempts((signal) => {
        guard();
        return ai.generateOntology([
        { role: 'system', content: '같은 사업의 단기성과에서 중장기성과로 이어지는 근거 있는 extends_to 후보만 제안한다. nodes와 snippets는 빈 배열, edges의 인덱스는 입력 candidates 배열을 가리킨다. 확정하지 않는다. JSON Schema에 맞게 반환한다.' },
        { role: 'user', content: JSON.stringify({ candidates }) },
      ], signal, { singleAttempt: true, guard });
      }, { timeoutMs: options.aiCallTimeoutMs ?? AI_CALL_TIMEOUT_MS, wait: options.retryWait, guard });
      for (const edge of proposal.edges) {
        const source = candidates[edge.source_node_index];
        const target = candidates[edge.target_node_index];
        if (edge.relation === 'extends_to' && source?.type === 'outcome-short' && target?.type === 'outcome-mid') {
          (graph.candidates ??= []).push({ source: source.id, target: target.id, relation: 'extends_to' });
        }
      }
    } catch (error) {
      if (error instanceof AiEligibilityChangedError) throw error;
      graph.issues.push({ severity: 'warning', file: projectId, field: 'extends_to', rule: '사업 단위 성과 연결 후보 생성 실패' });
    }
  }
  graph.edges = [...new Map(graph.edges.map((edge) => [JSON.stringify(edge), edge])).values()];
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (!['outcome-short', 'outcome-mid'].includes(String(node.type))) continue;
    const supportingEdges = graph.edges.filter((edge) => edge.target === id && ['proves', 'supports'].includes(edge.relation) && edge.source in graph.snippets);
    const evidenceEdges = graph.edges.filter((edge) => edge.target === id && ['proves', 'supports', 'contradicts'].includes(edge.relation) && edge.source in graph.snippets);
    const hasContradiction = evidenceEdges.some((edge) => edge.relation === 'contradicts');
    const linkedEvidence = Array.isArray(node.evidence) ? node.evidence : [];
    const hasUnresolvedEvidence = !hasContradiction && linkedEvidence.some((evidenceId) => typeof evidenceId === 'string'
      && evidenceId in graph.snippets && !evidenceEdges.some((edge) => edge.source === evidenceId)
      && classifyClaim(String(graph.snippets[evidenceId].quote ?? '')) === 'ambiguous');
    const levels = supportingEdges.map((edge) => String(graph.snippets[edge.source]?.evidence_level ?? ''));
    const allSupportPlanned = supportingEdges.every((edge) => classifyClaim(String(graph.snippets[edge.source]?.quote ?? '')) === 'plan');
    if (['관측됨', '추진 중'].includes(String(node.outcome_state_ai)) && levels.length === 0 && !hasUnresolvedEvidence) {
      node.outcome_state_ai = '미확인';
      graph.issues.push({ severity: 'warning', file: id, field: 'outcome_state_ai', rule: 'R05 적극 지지 근거가 없어 상태를 미확인으로 낮춤' });
    } else if (allSupportPlanned && levels.length && levels.every((level) => ['예견', '추정'].includes(level)) && ['관측됨', '추진 중'].includes(String(node.outcome_state_ai))) {
      node.outcome_state_ai = '기대/추정';
      graph.issues.push({ severity: 'warning', file: id, field: 'outcome_state_ai', rule: 'R05 예견·추정 근거만으로 관측 상태를 부여할 수 없어 기대/추정으로 낮춤' });
    }
  }
  graph.issues.push(...checkOntologyGraph(graph));
  const failedDocsSet = new Set(failedDocuments.map(({ documentId }) => documentId));
  const successfulDocs = new Set(chunks.flatMap((item, index) => item.paragraphs.length && responses[index] && !(responses[index] instanceof Error) ? [item.doc.id] : []));
  guard();
  return {
    graph,
    modelName: ai.modelName,
    documentSuccessCount: docs.filter((doc) => successfulDocs.has(doc.id) && !failedDocsSet.has(doc.id)).length,
    documentFailureCount: failedDocuments.length,
    discardedQuoteCount,
    failedDocuments,
    excludedDocuments,
    failureKinds,
  };
}

function buildMessages(doc: DocumentRecord, paragraphs: InputParagraph[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ document: { id: doc.id, doc_type: doc.doc_type ?? '기타' }, paragraphs: paragraphs.map(({ id, location, content }) => ({ id, location, content })) }) },
  ];
}

export function buildOntologyPrompt(): string { return SYSTEM_PROMPT; }

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function assignStableNodeIds(
  documents: Array<{ doc: DocumentRecord; paragraphs: ParagraphRecord[] }>,
  chunksByDoc: Map<string, number[]>,
  chunks: Array<{ doc: DocumentRecord; paragraphs: InputParagraph[] }>,
  responses: Array<OntologyGenerationResponse | Error | undefined>,
  projectCode: string,
  projectName: string,
): Map<string, string> {
  const ids = new Map<string, string>();
  const groups = new Map<string, Set<string>>();
  for (const { doc } of documents) {
    for (const chunkIndex of chunksByDoc.get(doc.id) ?? []) {
      const response = responses[chunkIndex];
      if (!response || response instanceof Error) continue;
      for (const rawCandidate of response.nodes) {
        const candidate = normalizeFollowup(rawCandidate, projectName);
        const key = nodeOccurrenceKey(candidate, response, doc.id, chunks[chunkIndex].paragraphs);
        const id = stableNodeId(projectCode, candidate.type, candidate.name);
        ids.set(key, id);
        if (!groups.has(id)) groups.set(id, new Set());
        groups.get(id)!.add(key);
      }
    }
  }
  for (const [id, keys] of groups) if (keys.size > 1) {
    for (const key of keys) {
      const evidence = JSON.parse(key) as [string, string, string];
      ids.set(key, `${id}-${stableToken(evidence[2], 10)}`);
    }
    if (new Set([...keys].map((key) => ids.get(key))).size !== keys.size) throw new Error('노드 키와 첫 근거가 충돌했습니다.');
  }
  return ids;
}

function nodeOccurrenceKey(candidate: OntologyGenerationResponse['nodes'][number], response: OntologyGenerationResponse, docId: string, paragraphs: InputParagraph[]): string {
  void response; void paragraphs;
  return JSON.stringify([candidate.type, normalizeName(candidate.name), docId]);
}

function stableToken(value: string, length: number): string { return createHash('sha256').update(value).digest('hex').slice(0, length).toUpperCase(); }
function normalizeName(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR'); }
function vocab(field: string, value: string): boolean { return VOCAB[field]?.has(value) ?? false; }
const DOC_TYPE_SET = VOCAB.doc_type;

function normalizeFollowup(candidate: OntologyGenerationResponse['nodes'][number], projectName: string): OntologyGenerationResponse['nodes'][number] {
  return candidate.type === 'project' && normalizeName(candidate.name) !== normalizeName(projectName) && /(?:후속\s*사업|후속\s*연계|연계\s*사업)/.test(candidate.name)
    ? { ...candidate, type: 'outcome-mid', outcome_type: '후속사업연계' } : candidate;
}

function screenForType(type: string): string { return ['project', 'partner', 'participant-org', 'implementer', 'policy-area', 'activity', 'output'].includes(type) ? 'EV04' : type === 'outcome-short' ? 'EV05' : type === 'outcome-mid' || type === 'indicator' ? 'EV06' : 'EV07'; }
function layerForType(type: string): string { return type === 'indicator' ? 'L3' : type === 'enabler' || type === 'constraint' ? 'L2' : 'L1'; }

function nodeMetadata(candidate: OntologyGenerationResponse['nodes'][number], graph: OntologyGraph, sourceId: string, quotes: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const values: Record<string, unknown> = {
    outcome_family: candidate.outcome_family, outcome_type: candidate.outcome_type,
    outcome_state_ai: candidate.outcome_state_ai || '미확인', timing: candidate.timing,
    pdm_stage: candidate.pdm_stage, factor_scope: candidate.factor_scope,
    factor_class: candidate.factor_class, response: candidate.response,
    output_type: candidate.output_type, institution_type: candidate.institution_type,
    date_start: groundedDate(candidate.date_start, quotes), date_end: groundedDate(candidate.date_end, quotes), place: candidate.place,
    baseline: candidate.baseline, target: candidate.target, actual: candidate.actual, verification_source: candidate.verification_source,
  };
  if (candidate.type === 'partner') result.country = candidate.name;
  if (candidate.type === 'participant-org') result.org_name = candidate.name;
  for (const [field, raw] of Object.entries(values)) {
    const isVocabField = Boolean(VOCAB[field]);
    let value: unknown = typeof raw === 'string' && isVocabField && !VOCAB[field].has(raw) ? '' : raw;
    const exactTextField = ['date_start', 'date_end', 'place', 'verification_source', 'response'].includes(field);
    if (exactTextField && raw && (field === 'date_start' || field === 'date_end' ? !groundedDate(String(raw), quotes) : !groundedText(String(raw), quotes))) value = '';
    if (['baseline', 'target', 'actual'].includes(field)) {
      value = typeof raw === 'number'
        ? checkNumericConsistency(String(raw), quotes).passed ? raw : null
        : typeof raw === 'string' && raw !== '' && groundedText(raw, quotes) ? raw : null;
    }
    if (raw !== '' && raw !== null && value === '') graph.issues.push({ severity: 'warning', file: sourceId, field, rule: isVocabField ? '통제 어휘 밖 값 폐기' : '인용에 없는 값 비움' });
    const typeAllowed = (field.startsWith('outcome_') || field === 'timing') ? ['outcome-short', 'outcome-mid'].includes(candidate.type)
      : ['factor_scope', 'factor_class', 'response'].includes(field) ? ['enabler', 'constraint'].includes(candidate.type)
      : field === 'output_type' ? candidate.type === 'output'
      : field === 'institution_type' ? candidate.type === 'participant-org'
      : field.startsWith('date_') || field === 'place' ? candidate.type === 'activity'
      : ['baseline', 'target', 'actual', 'verification_source', 'pdm_stage'].includes(field) ? candidate.type === 'indicator'
      : true;
    if (typeAllowed) result[field] = value;
  }
  if (candidate.type === 'participant-org') result.org_type = result.institution_type;
  return result;
}

function validObservedDate(value: string): string {
  const iso = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (iso) return [iso[1], iso[2], iso[3]].filter(Boolean).join('-');
  const korean = value.match(/^(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?$/);
  if (korean) return [korean[1], korean[2].padStart(2, '0'), korean[3]?.padStart(2, '0')].filter(Boolean).join('-');
  return '';
}

function groundedDate(value: string, quotes: string[]): string {
  const normalized = validObservedDate(value);
  if (!normalized) return '';
  return quotes.some((quote) => dateValuesInText(quote).includes(normalized)) ? normalized : '';
}

function dateValuesInText(text: string): string[] {
  const dates = new Set<string>();
  const patterns = [/(\d{4}-\d{2}(?:-\d{2})?)/g, /(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/g];
  for (const match of text.matchAll(patterns[0])) dates.add(validObservedDate(match[1]));
  for (const match of text.matchAll(patterns[1])) dates.add(validObservedDate(`${match[1]}년 ${match[2]}월${match[3] ? ` ${match[3]}일` : ''}`));
  return [...dates].filter(Boolean);
}

function groundedText(value: string, quotes: string[]): boolean {
  return value === '' || quotes.some((quote) => quote.includes(value));
}

function classifyClaim(quote: string): 'plan' | 'completed' | 'ambiguous' {
  const plan = /예정|희망|계획|하고자|기대|예상|추진할|방침|목표로\s*한다|전망|할\s*것이다/.test(quote);
  const completed = /완료했|달성했|개소했|실시했|완료하였|달성하였|개소하였|실시하였|완료됐다|달성됐다|개소됐다|실시됐다/.test(quote);
  if (plan === completed) return 'ambiguous';
  return plan ? 'plan' : 'completed';
}

function validGeneratedRelation(sourceType: unknown, targetType: unknown, relation: string): boolean {
  const allowed: Record<string, Array<[string, string]>> = {
    conducts: [['project', 'activity']],
    targets: [['project', 'outcome-mid']],
    partner: [['project', 'partner']],
    study_tour: [['project', 'participant-org']],
    participates_in: [['partner', 'activity'], ['participant-org', 'activity']],
    generates: [['activity', 'output']],
    induces: [['output', 'outcome-short'], ['output', 'outcome-mid']],
    extends_to: [['outcome-short', 'outcome-mid']],
    verified_by: [['indicator', 'source']],
    measures: [['indicator', 'output'], ['indicator', 'outcome-short'], ['indicator', 'outcome-mid']],
    promotes: [['enabler', 'outcome-short'], ['enabler', 'outcome-mid']],
    hinders: [['constraint', 'outcome-short'], ['constraint', 'outcome-mid']],
  };
  return allowed[relation]?.some(([source, target]) => sourceType === source && targetType === target) ?? false;
}
