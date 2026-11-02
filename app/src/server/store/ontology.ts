import { backfillReviewNodeAliases } from './review-node-aliases';
import { holdoutOntologySources } from './ontology-holdout';
import { backfillReviewEvidenceKeys } from './review-evidence-keys';
import { latestLinkReviews } from './link-review';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase, getDocumentInProject, getParagraphWithSurroundings, resolveProjectCitationContext, type ProjectCitationContext } from '@/server/store/db';
import { maskForbiddenSentenceInContent } from '@/server/store/citation-ban';
import type { ParagraphContext } from '@/server/store/types';
import { verifyQuote } from '@/server/quote-verify';
import { quoteBigramCoverage, assessEvidenceSufficiency, getManualNumericWarning } from '@/server/ontology/trust';
import type { OntologyGraph, OntologyIssue } from '../ontology/types';

export interface OntologyImportRecord {
  id: string;
  project_id: string;
  vault_code: string;
  imported_at: string;
  node_count: number;
  edge_count: number;
  source_count: number;
  snippet_count: number;
  error_count: number;
  warning_count: number;
  executor: string;
  source_kind: string;
  model_name: string | null;
  document_success_count: number;
  document_failure_count: number;
  discarded_quote_count: number;
}

export interface OntologyIssueRecord extends OntologyIssue {
  id: string;
  message: string;
}

export interface OntologySummary {
  import: OntologyImportRecord | null;
  nodeCounts: Array<{ type: string; count: number }>;
  edgeCounts: Array<{ relation: string; count: number }>;
  issues: OntologyIssueRecord[];
  history: OntologyImportRecord[];
}

export interface OntologyProjectNode {
  id: string;
  type: string;
  title: string;
  description: string;
  pdmStage: string | null;
  planDetails: Array<{ label: string; value: string }>;
}

export interface OntologyProjectEdge {
  source: string;
  target: string;
  relation: string;
}

export interface OntologyProjectGraph {
  importId: string | null;
  nodes: OntologyProjectNode[];
  edges: OntologyProjectEdge[];
  candidates?: OntologyProjectEdge[];
}

export interface OntologyEvidenceView {
  id: string;
  sourceTitle: string;
  locator: string;
  quote: string;
  quoteStatus: 'verified' | 'unverified';
  quoteMatchPercent: number | null;
  evidenceLevel: string | null;
  sufficiency: ReturnType<typeof assessEvidenceSufficiency>;
  contradictionCount: number;
  countsAsRationale: boolean;
}

export interface OntologyNodeStatement {
  id: string;
  type: string;
  title: string;
  text: string;
  evidenceIds: string[];
  numericWarning: ReturnType<typeof getManualNumericWarning>;
}

export interface OntologyEvidenceList {
  importId: string | null;
  evidence: OntologyEvidenceView[];
  statements: OntologyNodeStatement[];
}

export interface OntologySourceView {
  sourceTitle: string;
  locator: string;
  quote: string;
  quoteStatus: 'verified' | 'unverified';
  quoteMatchPercent: number | null;
  paragraphs: Array<{ position: 'previous' | 'selected' | 'next'; location: string; content: string }>;
  highlightRange: { start: number; end: number } | null;
}

export interface OntologyGenerationRun {
  id: string;
  project_id: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  completed_count: number;
  total_count: number;
  error_message: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export function startGenerationRun(projectId: string, totalCount: number, db: Database.Database = getDatabase()): OntologyGenerationRun | null {
  const now = new Date().toISOString();
  const run: OntologyGenerationRun = { id: crypto.randomUUID(), project_id: projectId, state: 'queued', completed_count: 0, total_count: totalCount, error_message: null, result_json: null, created_at: now, updated_at: now };
  try {
    db.prepare(`INSERT INTO ontology_generation_runs (id, project_id, state, completed_count, total_count, created_at, updated_at) VALUES (@id, @project_id, @state, @completed_count, @total_count, @created_at, @updated_at)`).run(run);
    return run;
  } catch (error) {
    if (error instanceof Error && /idx_ontology_generation_one_active|UNIQUE constraint failed/i.test(error.message)) return null;
    throw error;
  }
}

export function updateGenerationRun(id: string, values: Partial<Pick<OntologyGenerationRun, 'state' | 'completed_count' | 'total_count' | 'error_message' | 'result_json'>>, db: Database.Database = getDatabase()): void {
  const current = getGenerationRun(id, db);
  if (!current) throw new Error('생성 실행을 찾을 수 없습니다.');
  db.prepare(`UPDATE ontology_generation_runs SET state = ?, completed_count = ?, total_count = ?, error_message = ?, result_json = ?, updated_at = ? WHERE id = ?`).run(
    values.state ?? current.state, values.completed_count ?? current.completed_count, values.total_count ?? current.total_count,
    values.error_message === undefined ? current.error_message : values.error_message,
    values.result_json === undefined ? current.result_json : values.result_json,
    new Date().toISOString(), id,
  );
}

export function forceFailGenerationRun(id: string, errorMessage: string, db: Database.Database = getDatabase(), resultJson?: string): void {
  db.prepare(`UPDATE ontology_generation_runs SET state = 'failed', error_message = ?, result_json = COALESCE(?, result_json), updated_at = ? WHERE id = ? AND state IN ('queued', 'running')`)
    .run(errorMessage, resultJson ?? null, new Date().toISOString(), id);
}

export function getGenerationRun(id: string, db: Database.Database = getDatabase()): OntologyGenerationRun | null {
  return (db.prepare('SELECT * FROM ontology_generation_runs WHERE id = ?').get(id) as OntologyGenerationRun | undefined) ?? null;
}

export function getLatestGenerationRun(projectId: string, db: Database.Database = getDatabase()): OntologyGenerationRun | null {
  return (db.prepare('SELECT * FROM ontology_generation_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId) as OntologyGenerationRun | undefined) ?? null;
}

export function getActiveGenerationRun(projectId: string, db: Database.Database = getDatabase()): OntologyGenerationRun | null {
  return (db.prepare("SELECT * FROM ontology_generation_runs WHERE project_id = ? AND state IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").get(projectId) as OntologyGenerationRun | undefined) ?? null;
}

/** Atomically replaces one project's current graph while retaining its import history. */
export function replaceProjectOntology(
  projectId: string,
  graph: OntologyGraph,
  executor: string,
  db: Database.Database = getDatabase(),
  importedAt = new Date().toISOString(),
  metadata: { sourceKind?: 'vault' | 'generated'; modelName?: string | null; documentSuccessCount?: number; documentFailureCount?: number; discardedQuoteCount?: number } = {},
): OntologyImportRecord {
  const importId = crypto.randomUUID();
  const record: OntologyImportRecord = {
    id: importId,
    project_id: projectId,
    vault_code: graph.code,
    imported_at: importedAt,
    node_count: Object.keys(graph.nodes).length,
    edge_count: graph.edges.length,
    source_count: Object.keys(graph.sources).length,
    snippet_count: Object.keys(graph.snippets).length,
    error_count: graph.issues.filter((issue) => issue.severity === 'error').length,
    warning_count: graph.issues.filter((issue) => issue.severity === 'warning').length,
    executor,
    source_kind: metadata.sourceKind ?? 'vault',
    model_name: metadata.modelName ?? null,
    document_success_count: metadata.documentSuccessCount ?? 0,
    document_failure_count: metadata.documentFailureCount ?? 0,
    discarded_quote_count: metadata.discardedQuoteCount ?? 0,
  };

  const transaction = db.transaction(() => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    backfillReviewNodeAliases(db, projectId);
    if (!project) throw new Error('사업을 찾을 수 없습니다.');

    db.prepare(`INSERT INTO ontology_imports
      (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor, source_kind, model_name, document_success_count, document_failure_count, discarded_quote_count)
      VALUES (@id, @project_id, @vault_code, @imported_at, @node_count, @edge_count, @source_count, @snippet_count, @error_count, @warning_count, @executor, @source_kind, @model_name, @document_success_count, @document_failure_count, @discarded_quote_count)`).run(record);

    const insertNode = db.prepare(`INSERT INTO ontology_nodes (id, project_id, import_id, node_type, title, data_json)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [id, data] of Object.entries(graph.nodes)) {
      const fm = asRecord(data.fm);
      insertNode.run(id, projectId, importId, String(data.type ?? fm.type ?? ''), String(data.title ?? id), JSON.stringify(data));
    }
    const insertKey = db.prepare('INSERT INTO ontology_review_node_keys VALUES (?, ?, ?, ?)');
    for (const [id, data] of Object.entries(graph.nodes)) {
      insertKey.run(projectId, importId, id, String(data.type ?? asRecord(data.fm).type ?? ''));
    }
    const insertTitle = db.prepare('INSERT INTO ontology_review_node_titles VALUES (?, ?, ?, ?)');
    for (const [id, data] of Object.entries(graph.nodes)) insertTitle.run(projectId, importId, id, String(data.title ?? id));
    const insertEvidenceKey = db.prepare('INSERT OR IGNORE INTO ontology_review_evidence_keys VALUES (?, ?, ?, ?, ?, ?)');
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      const refs = Array.isArray(node.evidence) ? node.evidence : [];
      for (const [snippetId, snippet] of Object.entries(graph.snippets)) {
        const relates = (v: unknown) => Array.isArray(v) && v.includes(nodeId);
        if (!refs.includes(snippetId) && !relates(snippet.proves) && !relates(snippet.supports)) continue;
        if (typeof snippet.source === 'string' && snippet.source && typeof snippet.locator === 'string' && snippet.locator && typeof snippet.quote === 'string' && snippet.quote)
          insertEvidenceKey.run(projectId, importId, nodeId, snippet.source, snippet.locator, snippet.quote);
      }
    }
    const insertCandidate = db.prepare('INSERT OR IGNORE INTO ontology_relation_candidates VALUES (?, ?, ?, ?, ?)');
    for (const candidate of graph.candidates ?? []) {
      insertCandidate.run(projectId, importId, candidate.source, candidate.target, candidate.relation);
    }
    const insertEdge = db.prepare(`INSERT INTO ontology_edges
      (id, project_id, import_id, source_id, target_id, relation_field) VALUES (?, ?, ?, ?, ?, ?)`);
    graph.edges.forEach((edge, index) => insertEdge.run(`${index}:${edge.source}:${edge.relation}:${edge.target}`, projectId, importId, edge.source, edge.target, edge.relation));
    const evidenceMetadataBySource = new Map<string, Record<string, Record<string, unknown>>>();
    if (metadata.sourceKind !== 'generated') {
      for (const [snippetId, data] of Object.entries(graph.snippets)) {
        const sourceId = typeof data.source === 'string' ? data.source : '';
        if (!sourceId || !graph.sources[sourceId]) continue;
        const safeMetadata = Object.fromEntries(
          ['evidence_level', 'level', 'speaker', 'evidence_kind', 'kind', 'category', 'proves', 'supports', 'contradicts']
            .filter((field) => field in data)
            .map((field) => [field, data[field]]),
        );
        const sourceMetadata = evidenceMetadataBySource.get(sourceId) ?? {};
        sourceMetadata[snippetId] = safeMetadata;
        evidenceMetadataBySource.set(sourceId, sourceMetadata);
      }
    }
    const insertSource = db.prepare('INSERT INTO ontology_sources (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
    for (const [id, data] of Object.entries(graph.sources)) {
      const metadata = evidenceMetadataBySource.get(id);
      insertSource.run(id, projectId, importId, JSON.stringify(metadata ? { ...data, evidence_metadata: metadata } : data));
    }
    const insertSnippet = db.prepare('INSERT INTO ontology_snippets (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
    for (const [id, data] of Object.entries(graph.snippets)) {
      const snippet = metadata.sourceKind === 'generated'
        ? Object.fromEntries(GENERATED_SNIPPET_FIELDS.filter((field) => field in data).map((field) => [field, data[field]]))
        : { id, locator: data.locator, quote: data.quote, source: data.source };
      insertSnippet.run(id, projectId, importId, JSON.stringify(snippet));
    }
    const insertIssue = db.prepare(`INSERT INTO ontology_check_issues
      (id, project_id, import_id, rule_number, severity, file, field, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    graph.issues.forEach((issue, index) => insertIssue.run(
      `${index}:${issue.rule}:${issue.file}:${issue.field}`, projectId, importId,
      issue.rule, issue.severity, issue.file, issue.field, issueMessage(issue),
    ));

    backfillReviewEvidenceKeys(db, projectId);
    // The historical import rows remain, but only the newest graph is queryable.
    for (const table of ['ontology_nodes', 'ontology_edges', 'ontology_sources', 'ontology_snippets', 'ontology_check_issues']) {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND import_id != ?`).run(projectId, importId);
    }
    db.prepare('DELETE FROM ontology_quote_verification_cache_v2 WHERE project_id = ? AND import_id != ?').run(projectId, importId);
    db.prepare('DELETE FROM ontology_quote_verification_cache_v3 WHERE project_id = ? AND import_id != ?').run(projectId, importId);
  });
  transaction();
  return record;
}

// Retain evidence and its graph links for later evaluation while omitting review
// state, author, and other fields already represented by assessment nodes.
const GENERATED_SNIPPET_FIELDS = [
  'id', 'type', 'layer', 'created', 'updated', 'source', 'locator', 'quote',
  'speaker', 'evidence_kind', 'evidence_level', 'category', 'proves', 'supports', 'contradicts',
] as const;

export function getProjectOntology(projectId: string, db: Database.Database = getDatabase()): OntologySummary {
  const history = db.prepare(`SELECT * FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC`).all(projectId) as OntologyImportRecord[];
  const latest = history[0] ?? null;
  if (!latest) return { import: null, nodeCounts: [], edgeCounts: [], issues: [], history };
  const nodeCounts = db.prepare(`SELECT node_type AS type, COUNT(*) AS count FROM ontology_nodes
    WHERE project_id = ? AND import_id = ? GROUP BY node_type ORDER BY node_type`).all(projectId, latest.id) as OntologySummary['nodeCounts'];
  const edgeCounts = db.prepare(`SELECT relation_field AS relation, COUNT(*) AS count FROM ontology_edges
    WHERE project_id = ? AND import_id = ? GROUP BY relation_field ORDER BY relation_field`).all(projectId, latest.id) as OntologySummary['edgeCounts'];
  const issues = db.prepare(`SELECT id, severity, file, field, rule_number AS rule, message FROM ontology_check_issues
    WHERE project_id = ? AND import_id = ? ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, file, field`)
    .all(projectId, latest.id) as OntologyIssueRecord[];
  return { import: latest, nodeCounts, edgeCounts, issues, history };
}

/** Returns only the latest graph stored for the requested app project. */
export function getProjectOntologyGraph(projectId: string, db: Database.Database = getDatabase(), includeEdges = true): OntologyProjectGraph {
  const latest = latestOntologyImport(projectId, db);
  if (!latest) return { importId: null, nodes: [], edges: [], ...(includeEdges ? { candidates: [] } : {}) };

  const nodeRows = db.prepare(`SELECT id, node_type AS type, title, data_json FROM ontology_nodes
    WHERE project_id = ? AND import_id = ? ORDER BY id`).all(projectId, latest.id) as Array<{ id: string; type: string; title: string; data_json: string }>;
  const nodes = nodeRows.map((row): OntologyProjectNode => {
    const data = parseJsonRecord(row.data_json);
    const frontmatter = asRecord(data.fm);
    const description = scalarText(data.description ?? frontmatter.description);
    const rawStage = data.pdm_stage ?? frontmatter.pdm_stage;
    const pdmStage = scalarText(rawStage) || null;
    const fields: Array<[string, unknown]> = [
      ['계획', data.plan ?? frontmatter.plan],
      ['세부 내용', description],
      ['PDM 단계', pdmStage],
      ['활동 단계', data.stage ?? frontmatter.stage],
      ['산출물 유형', data.output_type ?? frontmatter.output_type],
      ['OVI', data.ovi ?? frontmatter.ovi],
      ['MoV', data.mov ?? frontmatter.mov],
      ['목표값', data.target_value ?? frontmatter.target_value],
    ];
    const planDetails = fields.flatMap(([label, value]) => {
      const text = scalarText(value);
      return text ? [{ label, value: text }] : [];
    });
    return { id: row.id, type: row.type, title: row.title, description, pdmStage, planDetails };
  });
  if (!includeEdges) return { importId: latest.id, nodes, edges: [] };
  const edges = db.prepare(`SELECT source_id AS source, target_id AS target, relation_field AS relation FROM ontology_edges
    WHERE project_id = ? AND import_id = ? AND NOT EXISTS (SELECT 1 FROM ontology_relation_candidates c WHERE c.project_id = ontology_edges.project_id AND c.import_id = ontology_edges.import_id AND c.source_id = ontology_edges.source_id AND c.target_id = ontology_edges.target_id AND c.relation = ontology_edges.relation_field) ORDER BY source_id, relation_field, target_id`).all(projectId, latest.id) as OntologyProjectEdge[];
  const nodeKeys = new Set(nodes.map(n => JSON.stringify([n.id, n.type])));
  const reviews = [...latestLinkReviews(projectId, db).values()];
  const confirmed = reviews
    .filter(r => r.status === '확정' && r.relation && nodeKeys.has(JSON.stringify([r.source_id, r.source_type])) && nodeKeys.has(JSON.stringify([r.target_id, r.target_type])))
    .map(r => ({ source: r.source_id, target: r.target_id, relation: r.relation }));
  const reviewedPairs = new Set(reviews.filter(review => !review.split && ['확정', '기각'].includes(review.status)).map(review => JSON.stringify([review.source_id, review.target_id])));
  const candidates = db.prepare(`SELECT source_id AS source, target_id AS target, relation FROM ontology_relation_candidates
    WHERE project_id = ? AND import_id = ? ORDER BY source_id, relation, target_id`).all(projectId, latest.id) as OntologyProjectEdge[];
  // A split review does not confirm any individual candidate pair.
  const pendingCandidates = candidates.filter(candidate => !reviewedPairs.has(JSON.stringify([candidate.source, candidate.target])));
  return { importId: latest.id, nodes, edges: [...edges, ...confirmed], candidates: pendingCandidates };
}

type OntologySnippet = { id: string; data: Record<string, unknown> };

// Shared by full evidence views and note review; keep source ownership checks,
// masking and cache invalidation identical for both consumers.
function resolveOntologyQuoteChecks(
  projectId: string,
  importId: string,
  db: Database.Database,
  snippets: OntologySnippet[],
  sources: Map<string, Record<string, unknown>>,
  citationContext?: ProjectCitationContext,
) {
  const documentIds = [...new Set([...sources.values()].flatMap((source) =>
    typeof source.document_id === 'string' && source.document_id ? [source.document_id] : []))];
  const ownedDocuments = new Set<string>();
  const paragraphsByDocument = new Map<string, Map<string, { location: string; content: string }>>();
  if (documentIds.length) {
    const ids = JSON.stringify(documentIds);
    const docs = db.prepare('SELECT id FROM documents WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))').all(projectId, ids) as Array<{ id: string }>;
    docs.forEach(({ id }) => ownedDocuments.add(id));
    const rows = db.prepare(`SELECT p.document_id, p.location, p.content FROM paragraphs p
      JOIN documents d ON d.id = p.document_id AND d.project_id = ?
      WHERE p.document_id IN (SELECT value FROM json_each(?)) ORDER BY p.rowid`).all(projectId, ids) as Array<{ document_id: string; location: string; content: string }>;
    for (const row of rows) {
      let byLocation = paragraphsByDocument.get(row.document_id);
      if (!byLocation) paragraphsByDocument.set(row.document_id, byLocation = new Map());
      if (!byLocation.has(row.location)) byLocation.set(row.location, row);
    }
  }
  const context = documentIds.length ? resolveProjectCitationContext(projectId, db, citationContext) : undefined;
  const bannedSentences = context?.sentences ?? [];
  const bannedIndex = context?.index;
  // A source can carry many original paragraphs. Parse and index that array
  // once per source, rather than sorting it again for every evidence item.
  const originalIndexes = new Map<string, { originals: OriginalParagraph[]; byLocation: Map<string, number> }>();
  const resolutionCache = new Map<string, OriginalParagraphResolution>();
  const resolveSource = (sourceId: string, source: Record<string, unknown>, locator: string): OriginalParagraphResolution => {
    const key = JSON.stringify([sourceId, locator]);
    const cached = resolutionCache.get(key);
    if (cached) return cached;
    let result: OriginalParagraphResolution;
    if (typeof source.document_id === 'string' && source.document_id) {
      const documentId = source.document_id;
      const paragraph = paragraphsByDocument.get(documentId)?.get(locator);
      result = !ownedDocuments.has(documentId) ? { status: 'wrong-project' } : paragraph ? {
        status: 'found', target: { location: paragraph.location, content: maskForbiddenSentenceInContent(paragraph.content, bannedSentences, bannedIndex) },
      } : { status: 'unavailable' };
    } else {
      let index = originalIndexes.get(sourceId);
      if (!index) {
        let rawParagraphs = source.original_paragraphs;
        if (!rawParagraphs && !source.document_id) {
          const row = db.prepare(`SELECT json_extract(data_json, '$.original_paragraphs') as p FROM ontology_sources WHERE project_id = ? AND import_id = ? AND id = ?`).get(projectId, importId, sourceId) as { p: string } | undefined;
          if (row?.p) rawParagraphs = JSON.parse(row.p);
        }
        const originals = parseOriginalParagraphs(rawParagraphs);
        const byLocation = new Map<string, number>();
        originals.forEach((p, i) => { if (!byLocation.has(p.location)) byLocation.set(p.location, i); });
        index = { originals, byLocation };
        originalIndexes.set(sourceId, index);
      }
      const i = index.byLocation.get(locator);
      result = i === undefined ? { status: 'unavailable' } : {
        status: 'found', target: toSourceParagraph(index.originals[i]),
        previous: i > 0 ? toSourceParagraph(index.originals[i - 1]) : undefined,
        next: i + 1 < index.originals.length ? toSourceParagraph(index.originals[i + 1]) : undefined,
      };
    }
    resolutionCache.set(key, result);
    return result;
  };

  // The digest binds the result to the exact quote and resolved original. It
  // also invalidates old entries when the verification algorithm changes.
  const cacheRows = db.prepare(`SELECT snippet_id, input_hash, snippet_hash, verified, coverage
    FROM ontology_quote_verification_cache_v3 WHERE project_id = ? AND import_id = ?`)
    .all(projectId, importId) as Array<{ snippet_id: string; input_hash: string; snippet_hash: string; verified: number; coverage: number }>;
  const quoteCache = new Map(cacheRows.map(row => [row.snippet_id, row]));
  const pendingCache: Array<{ id: string; hash: string; snippetHash: string; verified: boolean; coverage: number }> = [];
  const paragraphHashes = new Map<string, string>();
  const resolved = snippets.map((snippet) => {
    const cached = quoteCache.get(snippet.id);
    const sourceId = typeof snippet.data.source === 'string' ? snippet.data.source : '';
    const source = sources.get(sourceId);
    const locator = typeof snippet.data.locator === 'string' ? snippet.data.locator : '';
    const quote = typeof snippet.data.quote === 'string' ? snippet.data.quote : '';
    const snippetHash = crypto.createHash('sha256').update(JSON.stringify([sourceId, locator, quote])).digest('hex');
    if (cached?.snippet_hash === snippetHash && source && !source.document_id) {
      return { ...snippet, sourceId, source, locator, quote, paragraph: undefined, verified: cached.verified === 1, coverage: cached.coverage };
    }
    const resolution = source ? resolveSource(sourceId, source, locator) : null;
    const paragraph = resolution?.status === 'found' ? resolution.target : undefined;
    let verified = false;
    let coverage: number | null = null;
    if (paragraph) {
      let paragraphHash = paragraphHashes.get(paragraph.content);
      if (!paragraphHash) {
        paragraphHash = crypto.createHash('sha256').update(paragraph.content).digest('hex');
        paragraphHashes.set(paragraph.content, paragraphHash);
      }
      const hash = crypto.createHash('sha256').update('quote-verification-v1\0').update(paragraphHash).update('\0').update(quote).digest('hex');
      if (cached?.input_hash === hash && cached.snippet_hash === snippetHash) {
        verified = cached.verified === 1;
        coverage = cached.coverage;
      } else {
        verified = verifyQuote(quote, paragraph.content);
        coverage = quoteBigramCoverage(quote, paragraph.content);
        pendingCache.push({ id: snippet.id, hash, snippetHash, verified, coverage });
      }
    }
    return { ...snippet, sourceId, source, locator, quote, paragraph, verified, coverage };
  });
  if (pendingCache.length) {
    const save = db.prepare(`INSERT INTO ontology_quote_verification_cache_v3
      (project_id, import_id, snippet_id, input_hash, snippet_hash, verified, coverage) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, import_id, snippet_id) DO UPDATE SET
      input_hash = excluded.input_hash, snippet_hash = excluded.snippet_hash, verified = excluded.verified, coverage = excluded.coverage`);
    db.transaction(() => {
      for (const row of pendingCache) save.run(projectId, importId, row.id, row.hash, row.snippetHash, Number(row.verified), row.coverage);
    })();
  }
  return resolved;
}

/** Internal review path: callers supply rows already scoped to the current project/import. */
export function getOntologyQuoteChecks(
  projectId: string,
  importId: string,
  db: Database.Database,
  snippets: OntologySnippet[],
  sources: Map<string, Record<string, unknown>>,
  citationContext?: ProjectCitationContext,
): Map<string, { verified: boolean; coverage: number | null }> {
  // Keep the import/project boundary even if a caller accidentally supplies stale data.
  if (latestOntologyImport(projectId, db)?.id !== importId) return new Map();
  return new Map(resolveOntologyQuoteChecks(projectId, importId, db, snippets, sources, citationContext)
    .map(item => [item.id, { verified: item.verified, coverage: item.coverage }]));
}

/** Lists the latest import's evidence using only rows owned by the requested project. */
export function listProjectOntologyEvidence(projectId: string, db: Database.Database = getDatabase()): OntologyEvidenceList {
  const latest = latestOntologyImport(projectId, db);
  if (!latest) return { importId: null, evidence: [], statements: [] };

  const snippetRows = db.prepare(`SELECT id, data_json FROM ontology_snippets
    WHERE project_id = ? AND import_id = ? ORDER BY rowid`).all(projectId, latest.id) as Array<{ id: string; data_json: string }>;
  const sources = new Map((db.prepare(`SELECT id, data_json FROM ontology_sources
    WHERE project_id = ? AND import_id = ?`).all(projectId, latest.id) as Array<{ id: string; data_json: string }>).map((row) => [row.id, parseJsonRecord(row.data_json)]));
  const holdoutSources = holdoutOntologySources(projectId, db, sources);
  const edgeRows = db.prepare(`SELECT source_id, target_id FROM ontology_edges
    WHERE project_id = ? AND import_id = ? AND relation_field = 'contradicts'`).all(projectId, latest.id) as Array<{ source_id: string; target_id: string }>;
  const contradictions = new Map<string, Set<string>>();
  for (const edge of edgeRows) {
    if (edge.source_id === edge.target_id) continue;
    addToSetMap(contradictions, edge.source_id, edge.target_id);
    addToSetMap(contradictions, edge.target_id, edge.source_id);
  }

  const snippets = snippetRows.map((row) => {
    const stored = parseJsonRecord(row.data_json);
    const sourceId = typeof stored.source === 'string' ? stored.source : '';
    const sourceMetadata = asRecord(asRecord(sources.get(sourceId)?.evidence_metadata)[row.id]);
    return { id: row.id, data: { ...sourceMetadata, ...stored } };
  }).filter(snippet => !holdoutSources.has(typeof snippet.data.source === 'string' ? snippet.data.source : ''));
  const snippetById = new Map(snippets.map((snippet) => [snippet.id, snippet.data]));
  const snippetIdsByNode = new Map<string, Set<string>>();
  for (const snippet of snippets) {
    for (const relation of ['proves', 'supports'] as const) {
      for (const nodeId of stringList(snippet.data[relation])) addToSetMap(snippetIdsByNode, nodeId, snippet.id);
    }
  }
  const nodes = db.prepare(`SELECT id, node_type, title, data_json FROM ontology_nodes
    WHERE project_id = ? AND import_id = ? ORDER BY rowid`).all(projectId, latest.id) as Array<{ id: string; node_type: string; title: string; data_json: string }>;
  const nodeTypes = new Map(nodes.map((node) => [node.id, node.node_type]));
  for (const node of nodes) {
    const data = parseJsonRecord(node.data_json);
    for (const snippetId of stringList(data.evidence)) addToSetMap(snippetIdsByNode, node.id, snippetId);
  }

  // Build the reverse relation once, in node insertion order, rather than
  // scanning every node's evidence set for every snippet.
  const nodesBySnippet = new Map<string, string[]>();
  for (const [nodeId, ids] of snippetIdsByNode) for (const id of ids) {
    const linked = nodesBySnippet.get(id) ?? [];
    linked.push(nodeId);
    nodesBySnippet.set(id, linked);
  }

  const resolved = resolveOntologyQuoteChecks(projectId, latest.id, db, snippets, sources);
  const verifiedIds = new Set(resolved.filter((item) => item.verified).map((item) => item.id));
  const verifiedQuotes = new Map(resolved.filter((item) => item.verified).map((item) => [item.id, item.quote]));
  const statements = buildNodeStatements(latest.source_kind, nodes, snippets, verifiedQuotes);

  const evidence = resolved.map((item): OntologyEvidenceView => {
    const linkedNodes = new Set([
      ...stringList(item.data.proves),
      ...stringList(item.data.supports),
      ...(nodesBySnippet.get(item.id) ?? []),
    ]);
    const linkedOutcomes = [...linkedNodes].filter((nodeId) => ['outcome-short', 'outcome-mid'].includes(nodeTypes.get(nodeId) ?? ''));
    const sufficiencyIds = new Set<string>();
    for (const nodeId of linkedOutcomes) for (const linkedId of snippetIdsByNode.get(nodeId) ?? []) {
      if (verifiedIds.has(linkedId)) sufficiencyIds.add(linkedId);
    }
    if (!linkedOutcomes.length && item.verified) sufficiencyIds.add(item.id);
    const sufficiencyRecords = [...sufficiencyIds].map((id) => {
      const data = snippetById.get(id) ?? {};
      return { evidence_level: data.evidence_level, level: data.level, speaker: data.speaker };
    });
    const rawLevel = item.data.evidence_level ?? item.data.level ?? null;
    return {
      id: item.id,
      sourceTitle: typeof item.source?.title === 'string' ? item.source.title : item.sourceId,
      locator: item.locator,
      quote: item.quote,
      quoteStatus: item.verified ? 'verified' : 'unverified',
      quoteMatchPercent: item.coverage,
      evidenceLevel: typeof rawLevel === 'string' ? rawLevel : null,
      sufficiency: item.verified
        ? assessEvidenceSufficiency(sufficiencyRecords)
        : { label: '[확인 필요]', reason: '인용이 원문 대조를 통과하지 않아 근거로 세지 않습니다.' },
      contradictionCount: [...(contradictions.get(item.id) ?? [])].filter(id => snippetById.has(id)).length,
      countsAsRationale: item.verified,
    };
  });

  return { importId: latest.id, evidence, statements };
}

/** Resolves one evidence item to a project-owned paragraph and its immediate neighbors. */
export function getProjectOntologyEvidenceSource(
  projectId: string,
  evidenceId: string,
  db: Database.Database = getDatabase(),
): OntologySourceView | null {
  const latest = latestOntologyImport(projectId, db);
  if (!latest) return null;
  const evidenceRow = db.prepare(`SELECT id, data_json FROM ontology_snippets
    WHERE project_id = ? AND import_id = ? AND id = ?`).get(projectId, latest.id, evidenceId) as { id: string; data_json: string } | undefined;
  if (!evidenceRow) return null;
  const storedEvidenceData = parseJsonRecord(evidenceRow.data_json);
  const sourceId = typeof storedEvidenceData.source === 'string' ? storedEvidenceData.source : '';
  const sourceRow = db.prepare(`SELECT id, data_json FROM ontology_sources
    WHERE project_id = ? AND import_id = ? AND id = ?`).get(projectId, latest.id, sourceId) as { id: string; data_json: string } | undefined;
  if (!sourceRow) return null;
  const source = parseJsonRecord(sourceRow.data_json);
  if (holdoutOntologySources(projectId, db, new Map([[sourceId, source]])).has(sourceId)) return null;
  const evidenceData = {
    ...asRecord(asRecord(source.evidence_metadata)[evidenceId]),
    ...storedEvidenceData,
  };
  const locator = typeof evidenceData.locator === 'string' ? evidenceData.locator : '';
  const quote = typeof evidenceData.quote === 'string' ? evidenceData.quote : '';
  const resolution = lookupOriginalParagraph(source, locator, projectId, db);
  if (resolution?.status === 'wrong-project') return null;
  const paragraphContext = resolution?.status === 'found' ? resolution : null;
  const target = paragraphContext?.target;
  const matched = Boolean(target && verifyQuote(quote, target.content));
  const paragraphs: OntologySourceView['paragraphs'] = [];
  if (paragraphContext?.previous) paragraphs.push({ position: 'previous', location: paragraphContext.previous.location, content: paragraphContext.previous.content });
  if (paragraphContext?.target) paragraphs.push({ position: 'selected', location: paragraphContext.target.location, content: paragraphContext.target.content });
  if (paragraphContext?.next) paragraphs.push({ position: 'next', location: paragraphContext.next.location, content: paragraphContext.next.content });
  return {
    sourceTitle: typeof source.title === 'string' ? source.title : sourceId,
    locator,
    quote,
    quoteStatus: matched ? 'verified' : 'unverified',
    quoteMatchPercent: target ? quoteBigramCoverage(quote, target.content) : null,
    paragraphs,
    highlightRange: target ? findQuoteRange(target.content, quote) : null,
  };
}

function latestOntologyImport(projectId: string, db: Database.Database): OntologyImportRecord | null {
  return (db.prepare(`SELECT * FROM ontology_imports WHERE project_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1`)
    .get(projectId) as OntologyImportRecord | undefined) ?? null;
}

function lookupOriginalParagraph(
  source: Record<string, unknown>,
  locator: string,
  projectId: string,
  db: Database.Database,
): OriginalParagraphResolution {
  const documentId = typeof source.document_id === 'string' ? source.document_id : '';
  if (documentId) {
    // This scoped lookup is mandatory before getParagraphWithSurroundings uses a document ID.
    if (!getDocumentInProject(documentId, projectId, db)) return { status: 'wrong-project' };
    const context = getParagraphWithSurroundings(documentId, locator, db);
    return context ? { status: 'found', ...contextToSourceParagraphs(context) } : { status: 'unavailable' };
  }

  const originals = parseOriginalParagraphs(source.original_paragraphs);
  const targetIndex = originals.findIndex((paragraph) => paragraph.location === locator);
  if (targetIndex === -1) return { status: 'unavailable' };
  return {
    status: 'found',
    target: toSourceParagraph(originals[targetIndex]),
    previous: targetIndex > 0 ? toSourceParagraph(originals[targetIndex - 1]) : undefined,
    next: targetIndex + 1 < originals.length ? toSourceParagraph(originals[targetIndex + 1]) : undefined,
  };
}

type OriginalParagraphResolution =
  | { status: 'found'; target: { location: string; content: string }; previous?: { location: string; content: string }; next?: { location: string; content: string } }
  | { status: 'unavailable' }
  | { status: 'wrong-project' };

type OriginalParagraph = { location: string; content: string; sequence_no?: number; inputIndex: number };

function parseOriginalParagraphs(value: unknown): OriginalParagraph[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, inputIndex) => {
    const row = asRecord(item);
    if (typeof row.location !== 'string' || typeof row.content !== 'string') return [];
    return [{
      location: row.location,
      content: row.content,
      ...(typeof row.sequence_no === 'number' && Number.isFinite(row.sequence_no) ? { sequence_no: row.sequence_no } : {}),
      inputIndex,
    }];
  }).sort((left, right) => (left.sequence_no ?? left.inputIndex) - (right.sequence_no ?? right.inputIndex) || left.inputIndex - right.inputIndex);
}

function contextToSourceParagraphs(context: ParagraphContext) {
  return {
    target: { location: context.target.location, content: context.target.content },
    previous: context.previous ? { location: context.previous.location, content: context.previous.content } : undefined,
    next: context.next ? { location: context.next.location, content: context.next.content } : undefined,
  };
}

function toSourceParagraph(paragraph: OriginalParagraph) {
  return { location: paragraph.location, content: paragraph.content };
}

function buildNodeStatements(
  sourceKind: string,
  nodes: Array<{ id: string; node_type: string; title: string; data_json: string }>,
  snippets: Array<{ id: string; data: Record<string, unknown> }>,
  verifiedQuotes: Map<string, string>,
): OntologyNodeStatement[] {
  const manualEvidence = new Map<string, Set<string>>();
  if (sourceKind !== 'generated') for (const snippet of snippets) {
    for (const relation of ['proves', 'supports', 'contradicts']) {
      for (const nodeId of stringList(snippet.data[relation])) addToSetMap(manualEvidence, nodeId, snippet.id);
    }
  }
  const visibleSnippetIds = new Set(snippets.map(snippet => snippet.id));
  return nodes.map((node) => {
    const data = parseJsonRecord(node.data_json);
    const frontmatter = asRecord(data.fm);
    const title = typeof data.title === 'string' ? data.title : node.title;
    const descriptionValue = data.description ?? frontmatter.description;
    const description = typeof descriptionValue === 'string' ? descriptionValue : '';
    const evidenceIds = sourceKind === 'generated'
      ? stringList(data.evidence).filter(id => visibleSnippetIds.has(id))
      : [...(manualEvidence.get(node.id) ?? [])];
    const linkedQuotes = evidenceIds.map((id) => verifiedQuotes.get(id)).filter((quote): quote is string => typeof quote === 'string');
    const shouldWarn = sourceKind !== 'generated' || (typeof data.author === 'string' && data.author !== 'ai');
    const statementText = description ? `${title} ${description}` : title;
    return {
      id: node.id,
      type: node.node_type,
      title,
      text: description,
      evidenceIds: [...new Set(evidenceIds)],
      numericWarning: shouldWarn ? getManualNumericWarning(statementText, linkedQuotes) : null,
    };
  });
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function findQuoteRange(paragraph: string, quote: string): { start: number; end: number } | null {
  if (!quote) return null;
  const rawStart = paragraph.indexOf(quote);
  if (rawStart >= 0) return { start: rawStart, end: rawStart + quote.length };
  const normalizedQuote = normalizeTextWithOffsets(quote).normalized;
  const { normalized, offsets } = normalizeTextWithOffsets(paragraph);
  const normalizedStart = normalized.indexOf(normalizedQuote);
  if (normalizedStart < 0 || !normalizedQuote) return null;
  const startIndex = Array.from(normalized.slice(0, normalizedStart)).length;
  const endIndex = startIndex + Array.from(normalizedQuote).length - 1;
  const start = offsets[startIndex];
  const end = offsets[endIndex];
  return start && end ? { start: start.start, end: end.end } : null;
}

function normalizeTextWithOffsets(text: string): { normalized: string; offsets: Array<{ start: number; end: number }> } {
  let normalized = '';
  const offsets: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < text.length;) {
    const codepoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codepoint);
    const width = character.length;
    if (/\s/.test(character)) {
      const start = index;
      let end = index + width;
      while (end < text.length) {
        const next = String.fromCodePoint(text.codePointAt(end)!);
        if (!/\s/.test(next)) break;
        end += next.length;
      }
      if (normalized && end < text.length) {
        normalized += ' ';
        offsets.push({ start, end });
      }
      index = end;
      continue;
    }
    const mapped = /[\u2018\u2019\u201A\u201B`']/.test(character) ? "'"
      : /[\u201C\u201D\u201E\u201F«»"]/.test(character) ? '"'
        : character;
    normalized += mapped;
    offsets.push({ start: index, end: index + width });
    index += width;
  }
  return { normalized, offsets };
}

function issueMessage(issue: OntologyIssue): string {
  const detail = issue.detail ? ` · ${issue.detail}` : '';
  return `${issue.severity === 'error' ? '검사 오류' : '검사 경고'} (${issue.rule}) · ${issue.field}${detail}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(' · ');
  return '';
}
