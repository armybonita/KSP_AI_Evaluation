import { getConfirmedNoteCount } from './note-review';
import { exclusionReasonForDocument } from '../documents/exclusion-reason';
import { pdmReasonDocument } from '../documents/pdm-eligibility';
import { isConfirmedNonPastReport } from '../documents/holdout';
import { isReportTargetDocumentIncluded } from './report-inclusion';
import { prepareEvidenceQuoteCache } from './evidence-quote-cache';
import { reviewResolversForProjects } from './review-resolution';
import { backfillReviewEvidenceKeys } from './review-evidence-keys';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { CREATE_TABLES_SQL, EVIDENCE_QUOTE_CACHE_SQL } from './schema';
import { migratePortfolioLevels } from './additive-migration';
import {
  assertConfirmationType,
  assertVerdictStatus,
  ClassificationSource,
  ConfirmationRecord,
  CreateConfirmationInput,
  DocumentRecord,
  DocType,
  EvidenceRecord,
  IndicatorBaselineRecord,
  IndicatorConflictRecord,
  HistoryPageData,
  IndicatorAttributionRecord,
  IndicatorRecord,
  IndicatorWithConfirmations,
  ParagraphContext,
  ParagraphRecord,
  ProjectRecord,
  ProjectMetadata,
  ProjectWithCount,
  ProjectDocumentSummary,
  OutcomeFinalResultsData,
  OutcomeIndicatorFinalResult,
  OutcomeStageRow,
  OutcomeStageKey,
  OutcomeStageLabel,
  ReportRecord,
  ReportTargetIndicator,
  ReviewEvidence,
  ReviewIndicatorItem,
  ReviewPageData,
  SentenceRecord,
  SuggestionRecord,
  TocItem,
  TocPageData,
  ResultTocDisplayKind,
  ResultTocItem,
  ResultTocPageData,
  VerdictStatus,
} from './types';
import { getIndicatorNaturalKey, parsePdmParagraphs } from '../../lib/baseline-key';
import {
  isCitationBannedSentence,
  createForbiddenSentenceIndex,
  type ForbiddenSentenceIndex,
  hasForbiddenSentenceOverlap,
  maskForbiddenSentenceInContent,
  migrateExistingEvidencesForCitationBan,
  isEvidenceCitationBanned,
  maskEvidenceIfCitationBanned,
  maskTextIfForbiddenSentenceOverlap,
} from './citation-ban';

// Avoid rebuilding an intact project cache when a write changes no quote input.
function prepareEvidenceQuoteCacheIfNeeded(projectId: string, db: Database.Database): void {
  const missing = db.prepare(`SELECT 1 FROM evidences e
    JOIN suggestions s ON s.id = e.suggestion_id
    JOIN indicators i ON i.id = s.indicator_id
    JOIN documents d ON d.id = e.document_id AND d.project_id = i.project_id
    WHERE i.project_id = ? AND NOT EXISTS (
      SELECT 1 FROM evidence_quote_verification_cache c
      WHERE c.project_id = i.project_id AND c.evidence_id = e.id AND c.algorithm_version = 1
    ) LIMIT 1`).get(projectId);
  if (missing) prepareEvidenceQuoteCache(projectId, db);
}

let activeDb: Database.Database | null = null;
let currentDbPath: string | null = null;

export type DbConnection = Database.Database;
type DocumentDbRow = Omit<DocumentRecord, 'masked' | 'is_past_final_report'> & {
  masked: number | null;
  is_past_final_report: number | null;
};

export function openReadonlyDatabase(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

// 이미 있는 DB 에 쓰기 연결만 연다. openDatabase() 와 달리 스키마 변경·인용 금지 근거 이관을
// 돌리지 않으므로, 운영 도구가 지정한 행 밖의 데이터를 건드리지 않는다.
export function openExistingDatabaseForWrite(dbPath: string): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function execAlterIgnoreDuplicateColumn(db: Database.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('duplicate column')) {
      throw err;
    }
  }
}

export function migrateProjectMetadata(db: Database.Database): void {
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE projects ADD COLUMN project_year INTEGER`);
  for (const column of ['country', 'region', 'partner_ministry', 'project_type', 'kdi_cid', 'implementing_org', 'partner_government_org', 'pilot_label', 'metadata_source']) {
    execAlterIgnoreDuplicateColumn(db, `ALTER TABLE projects ADD COLUMN ${column} TEXT`);
  }
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE projects ADD COLUMN is_ended INTEGER`);
}

export function migrateDocumentAiMetadata(db: Database.Database): void {
  if (db.inTransaction) throw new Error('Document AI metadata migration requires its own transaction');
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE documents ADD COLUMN masked INTEGER`);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE documents ADD COLUMN approved_ai TEXT NOT NULL DEFAULT 'solar'`);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE documents ADD COLUMN is_past_final_report INTEGER`);

  const columns = db.pragma('table_info(documents)') as Array<{ name: string; notnull: number }>;
  if (!columns.some((column) => ['masked', 'is_past_final_report'].includes(column.name) && column.notnull)) return;

  // Earlier versions filled these values without confirmation. Rebuild once so
  // both columns can hold unknown, keeping all other columns, indexes and triggers.
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'").get() as { sql: string };
  const dependentSql = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'documents' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  let replacement = table.sql.replace(/^CREATE TABLE (?:IF NOT EXISTS )?["`\[]?documents["`\]]?/i, 'CREATE TABLE documents_ai_migration');
  for (const name of ['masked', 'is_past_final_report']) {
    replacement = replacement.replace(new RegExp(`(${name}\\s+INTEGER)\\s+NOT NULL(?:\\s+DEFAULT\\s+[^,\\s)]+)?`, 'i'), '$1');
  }
  if (replacement === table.sql || /(?:masked|is_past_final_report)\s+INTEGER\s+NOT NULL/i.test(replacement)) {
    throw new Error('Cannot safely migrate document AI metadata schema');
  }
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const names = columns.map((column) => quote(column.name)).join(', ');
  const values = columns.map((column) => ['masked', 'is_past_final_report'].includes(column.name) ? 'NULL' : quote(column.name)).join(', ');
  // These triggers belong to other tables but refer to documents. SQLite
  // validates their bodies during RENAME, when the old table is temporarily
  // absent, so preserve and restore them in the same transaction.
  const crossTableTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'trg_evquote_paragraph_insert', 'trg_evquote_paragraph_update', 'trg_evquote_paragraph_delete',
      'trg_evquote_sentence_insert', 'trg_evquote_sentence_update', 'trg_evquote_sentence_delete',
      'trg_report_revision_paragraph_insert', 'trg_report_revision_paragraph_update', 'trg_report_revision_paragraph_delete',
      'trg_report_revision_sentence_insert', 'trg_report_revision_sentence_update', 'trg_report_revision_sentence_delete'
    ) AND sql IS NOT NULL`).all() as Array<{ name: string; sql: string }>;
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const trigger of crossTableTriggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      db.exec(replacement);
      db.exec(`INSERT INTO documents_ai_migration (${names}) SELECT ${values} FROM documents`);
      db.exec('DROP TABLE documents');
      db.exec('ALTER TABLE documents_ai_migration RENAME TO documents');
      for (const item of dependentSql) db.exec(item.sql);
      for (const trigger of crossTableTriggers) db.exec(trigger.sql);
    })();
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON');
  }
}

// A graph import is immutable after its transaction commits. Receipts let us
// visit new imports (including imports made after a rollback) without rescanning
// already migrated graphs. Review histories are append-only, so their rowids
// provide an independent incremental cursor for references to pruned graphs.
export function migrateReviewSnapshots(db: Database.Database): void {
  db.transaction(() => {
    const pending = db.prepare(`SELECT i.project_id, i.id FROM ontology_imports i
      WHERE NOT EXISTS (SELECT 1 FROM ontology_graph_migration_receipts m WHERE m.project_id = i.project_id AND m.import_id = i.id)
        AND (EXISTS (SELECT 1 FROM ontology_nodes n WHERE n.import_id = i.id)
          OR EXISTS (SELECT 1 FROM ontology_edges e WHERE e.import_id = i.id))`)
      .all() as Array<{project_id: string; id: string}>;
    const keys = db.prepare(`INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type)
      SELECT project_id, import_id, id, node_type FROM ontology_nodes WHERE import_id = ?`);
    const candidates = db.prepare(`INSERT OR IGNORE INTO ontology_relation_candidates
      SELECT e.project_id, e.import_id, e.source_id, e.target_id, e.relation_field FROM ontology_edges e
      JOIN ontology_imports i ON i.id = e.import_id
      WHERE e.import_id = ? AND i.source_kind = 'generated' AND e.relation_field IN ('extends_to', 'targets')`);
    const receipt = db.prepare('INSERT INTO ontology_graph_migration_receipts VALUES (?, ?)');
    // The original migration inserted all surviving node types before trying to
    // infer a type for references whose own graph no longer exists.
    for (const row of pending) keys.run(row.id);
    const watermark = db.prepare('SELECT COALESCE(MAX(last_rowid), 0) AS last FROM ontology_review_migration_watermarks WHERE kind = ?');
    const previousNote = (watermark.get('note') as {last: number}).last;
    const previousLink = (watermark.get('link') as {last: number}).last;
    const maxNote = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM ontology_note_reviews').get() as {last: number}).last;
    const maxLink = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM ontology_link_reviews').get() as {last: number}).last;
    if (maxNote > previousNote || maxLink > previousLink) {
      db.prepare(`INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type)
        SELECT refs.project_id, refs.import_id, refs.node_id,
          COALESCE((SELECT CASE WHEN COUNT(DISTINCT k.node_type) = 1 THEN MIN(k.node_type) END
            FROM ontology_review_node_keys k WHERE k.project_id = refs.project_id
              AND k.node_id = refs.node_id AND k.node_type != '종류 불명'), '종류 불명')
        FROM (SELECT project_id, import_id, node_id FROM ontology_note_reviews WHERE rowid > ?
          UNION SELECT project_id, import_id, source_id FROM ontology_link_reviews WHERE rowid > ?
          UNION SELECT project_id, import_id, target_id FROM ontology_link_reviews WHERE rowid > ?) refs`)
        .run(previousNote, previousLink, previousLink);
      const mark = db.prepare('INSERT OR IGNORE INTO ontology_review_migration_watermarks VALUES (?, ?)');
      mark.run('note', maxNote);
      mark.run('link', maxLink);
    }
    for (const row of pending) {
      candidates.run(row.id);
      receipt.run(row.project_id, row.id);
    }
  })();
}

export function openDatabase(customPath?: string): Database.Database {
  const dbPath = customPath ?? process.env.AIEAS_DB_PATH ?? ':memory:';

  if (activeDb && currentDbPath === dbPath) {
    return activeDb;
  }

  if (activeDb) {
    activeDb.close();
    activeDb = null;
    currentDbPath = null;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_TABLES_SQL);
  migratePortfolioLevels(db);
  migrateProjectMetadata(db);
  backfillReviewEvidenceKeys(db);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE ontology_imports ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'vault'`);
  migrateReviewSnapshots(db);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE ontology_imports ADD COLUMN model_name TEXT`);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE ontology_imports ADD COLUMN document_success_count INTEGER NOT NULL DEFAULT 0`);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE ontology_imports ADD COLUMN document_failure_count INTEGER NOT NULL DEFAULT 0`);
  execAlterIgnoreDuplicateColumn(db, `ALTER TABLE ontology_imports ADD COLUMN discarded_quote_count INTEGER NOT NULL DEFAULT 0`);
  markInterruptedOntologyRunsFailed(db);
  markInterruptedSynthesisRunsFailed(db);

  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE documents ADD COLUMN inclusion_source TEXT NOT NULL DEFAULT 'auto'`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE documents ADD COLUMN doctype_source TEXT NOT NULL DEFAULT 'auto'`
  );
  migrateDocumentAiMetadata(db);
  db.exec(EVIDENCE_QUOTE_CACHE_SQL);
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN parent_id TEXT REFERENCES indicators(id) ON DELETE SET NULL`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN source_location TEXT`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN is_unknown_level INTEGER NOT NULL DEFAULT 0`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicators ADD COLUMN is_orphaned INTEGER NOT NULL DEFAULT 0`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE paragraphs ADD COLUMN table_index INTEGER`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE paragraphs ADD COLUMN table_cols INTEGER`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE paragraphs ADD COLUMN table_row INTEGER`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE paragraphs ADD COLUMN table_col INTEGER`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE paragraphs ADD COLUMN grid_coord_version INTEGER`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicator_baselines ADD COLUMN conflict_id TEXT`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE indicator_baselines ADD COLUMN other_doc_id TEXT`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE evidences ADD COLUMN is_citation_banned INTEGER NOT NULL DEFAULT 0`
  );
  execAlterIgnoreDuplicateColumn(
    db,
    `ALTER TABLE confirmations ADD COLUMN edited_verdict_status TEXT CHECK(edited_verdict_status IS NULL OR edited_verdict_status IN ('실현', '추진 중', '기대', '미확인', '근거 충돌'))`
  );

  try {
    const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='indicator_baselines'`).get() as { sql: string } | undefined;
    if (tableInfo && tableInfo.sql.includes('UNIQUE(indicator_id)')) {
      db.exec(`
        CREATE TABLE indicator_baselines_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          document_name TEXT NOT NULL,
          target_value TEXT NOT NULL,
          selected_at TEXT NOT NULL,
          conflict_id TEXT,
          other_doc_id TEXT
        );
        INSERT INTO indicator_baselines_new (id, project_id, indicator_id, document_id, document_name, target_value, selected_at)
          SELECT id, project_id, indicator_id, document_id, document_name, target_value, selected_at FROM indicator_baselines;
        DROP TABLE indicator_baselines;
        ALTER TABLE indicator_baselines_new RENAME TO indicator_baselines;
        CREATE INDEX IF NOT EXISTS idx_baselines_project_id ON indicator_baselines(project_id);
        CREATE INDEX IF NOT EXISTS idx_baselines_indicator_id ON indicator_baselines(indicator_id);
      `);
    }
  } catch {}

  // 새 열에 대한 인덱스는 ALTER 마이그레이션 뒤에 생성
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_indicators_parent_id ON indicators(parent_id)`);
  } catch {}
  try {
    const info = db.pragma('index_info(idx_ontology_sources_summary)') as Array<{ cid: number; name: string }>;
    if (info.length < 7) {
      db.exec(`DROP INDEX IF EXISTS idx_ontology_sources_summary`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_sources_summary ON ontology_sources(project_id, import_id, id, json_extract(data_json, '$.document_id'), json_extract(data_json, '$.title'), json_extract(data_json, '$.doc_date'), json_type(data_json, '$.evidence_metadata'))`);
    }
  } catch {}

  // 기존 DB 이관: 기존 근거를 금지 문장과 다시 대조해 플래그·가림을 채움 (#20 검수 2회차 2번: 오류를 삼키지 않고 던짐)
  migrateExistingEvidencesForCitationBan(db);

  activeDb = db;
  currentDbPath = dbPath;
  return db;
}

export function markInterruptedOntologyRunsFailed(db: Database.Database = getDatabase()): number {
  const result = db.prepare(`UPDATE ontology_generation_runs SET state = 'failed', error_message = '서버가 재시작되어 진행 중 실행이 중단되었습니다.', updated_at = ? WHERE state IN ('queued', 'running')`).run(new Date().toISOString());
  return result.changes;
}

export function markInterruptedSynthesisRunsFailed(db: Database.Database = getDatabase()): number {
  return db.prepare(`UPDATE ontology_synthesis_runs SET state = 'failed', error_message = '앱 재시작으로 중단 — 다시 실행해 주세요', finished_at = ? WHERE state IN ('queued', 'running')`).run(new Date().toISOString()).changes;
}

export function closeDatabase(): void {
  if (activeDb) {
    activeDb.close();
    activeDb = null;
    currentDbPath = null;
  }
}

export function getDatabase(): Database.Database {
  if (!activeDb) {
    return openDatabase();
  }
  return activeDb;
}

export function backupDatabase(
  targetPath: string,
  db: Database.Database = getDatabase()
): Promise<void> {
  return db.backup(targetPath).then(() => {});
}

// ---------------- Project operations ----------------
export function createProject(project: ProjectRecord, db: Database.Database = getDatabase()): void {
  if (!project.name || project.name.trim().length === 0) {
    throw new Error('사업 이름은 비어 있을 수 없습니다.');
  }
  const stmt = db.prepare(`
    INSERT INTO projects (id, name, created_at, project_year, country, region, partner_ministry, project_type, kdi_cid, implementing_org, partner_government_org, is_ended, pilot_label, metadata_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(project.id, project.name.trim(), project.created_at, project.project_year ?? null, project.country ?? null,
    project.region ?? null, project.partner_ministry ?? null, project.project_type ?? null, project.kdi_cid ?? null,
    project.implementing_org ?? null, project.partner_government_org ?? null, project.is_ended ?? null, project.pilot_label ?? null, project.metadata_source ?? null);
}

export function updateProjectMetadata(projectId: string, metadata: ProjectMetadata, db: Database.Database = getDatabase()): void {
  const result = db.prepare(`UPDATE projects SET project_year = ?, country = ?, region = ?, partner_ministry = ?, project_type = ?, kdi_cid = ?, implementing_org = ?, partner_government_org = ?, is_ended = ?, pilot_label = ?, metadata_source = ? WHERE id = ?`).run(
    metadata.project_year ?? null, metadata.country ?? null, metadata.region ?? null, metadata.partner_ministry ?? null,
    metadata.project_type ?? null, metadata.kdi_cid ?? null, metadata.implementing_org ?? null,
    metadata.partner_government_org ?? null, metadata.is_ended ?? null, metadata.pilot_label ?? null, metadata.metadata_source ?? null, projectId);
  if (result.changes === 0) throw new Error('사업을 찾을 수 없습니다.');
}

export function getProject(id: string, db: Database.Database = getDatabase()): ProjectRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  return stmt.get(id) as ProjectRecord | undefined;
}

export function listProjects(db: Database.Database = getDatabase()): ProjectRecord[] {
  const stmt = db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`);
  return stmt.all() as ProjectRecord[];
}

export function listProjectsWithCount(db: Database.Database = getDatabase()): ProjectWithCount[] {
  const stmt = db.prepare(`
    WITH ranked_suggestions AS (
      SELECT id, indicator_id, ROW_NUMBER() OVER (PARTITION BY indicator_id ORDER BY created_at DESC, rowid DESC) AS rank
      FROM suggestions
    ), ranked_confirmations AS (
      SELECT id, indicator_id, suggestion_id, confirmation_type,
        ROW_NUMBER() OVER (PARTITION BY indicator_id, suggestion_id ORDER BY created_at DESC, rowid DESC) AS rank
      FROM confirmations
    ), indicator_counts AS (
      SELECT i.project_id, COUNT(s.id) AS review_total, COUNT(c.id) AS reviewed_count,
        SUM(CASE WHEN c.confirmation_type = '보완 필요' THEN 1 ELSE 0 END) AS needs_revision_count
      FROM indicators i
      LEFT JOIN ranked_suggestions s ON s.indicator_id = i.id AND s.rank = 1
      LEFT JOIN ranked_confirmations c ON c.indicator_id = i.id AND c.suggestion_id = s.id AND c.rank = 1
      GROUP BY i.project_id
    ), latest_evaluators AS (
      SELECT i.project_id, c.confirmer_name,
        ROW_NUMBER() OVER (PARTITION BY i.project_id ORDER BY c.created_at DESC, c.rowid DESC) AS rank
      FROM confirmations c JOIN indicators i ON i.id = c.indicator_id
    ), document_counts AS (
      SELECT project_id, COUNT(*) AS document_count FROM documents GROUP BY project_id
    )
    SELECT p.*, COALESCE(d.document_count, 0) AS document_count,
      COALESCE(ic.review_total, 0) AS review_total, COALESCE(ic.reviewed_count, 0) AS reviewed_count,
      COALESCE(ic.needs_revision_count, 0) AS needs_revision_count, ev.confirmer_name AS evaluator_name
    FROM projects p
    LEFT JOIN document_counts d ON d.project_id = p.id
    LEFT JOIN indicator_counts ic ON ic.project_id = p.id
    LEFT JOIN latest_evaluators ev ON ev.project_id = p.id AND ev.rank = 1
    ORDER BY p.created_at DESC
  `);
  // Only the latest graph's six reviewable node types contribute to the
  // list. Build no evidence, citation, link, or display data here.
  const noteCounts = db.prepare(`
    SELECT p.id AS project_id, COUNT(*) AS total
    FROM projects p
    JOIN ontology_nodes n ON n.project_id = p.id
      AND n.import_id = (SELECT id FROM ontology_imports i WHERE i.project_id = p.id ORDER BY imported_at DESC, rowid DESC LIMIT 1)
    WHERE n.node_type IN ('indicator', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint')
    GROUP BY p.id
  `).all() as Array<{project_id: string; total: number}>;
  const counts = new Map(noteCounts.map((row) => [row.project_id, row.total]));
  const reviews = db.prepare(`
    SELECT r.project_id, r.import_id, r.node_id, r.status, k.node_type
    FROM ontology_note_reviews r
    JOIN ontology_review_node_keys k ON k.project_id = r.project_id AND k.import_id = r.import_id AND k.node_id = r.node_id
    ORDER BY r.rowid
  `).all() as Array<{project_id: string; import_id: string; node_id: string; status: string; node_type: string}>;
  const byProject = new Map<string, typeof reviews>();
  for (const review of reviews) {
    const group = byProject.get(review.project_id) ?? [];
    group.push(review);
    byProject.set(review.project_id, group);
  }

  // Batch query for latest PDM and PCP documents across all projects (single query, at most 2 rows per project)
  db.function('aieas_is_past_final_report', { deterministic: true }, (_docType: unknown, past: unknown) => Number(!isConfirmedNonPastReport({
    is_past_final_report: typeof past === 'number' ? past : null,
  })));
  const keyDocs = db.prepare(`
    WITH kinds(doc_type) AS (VALUES ('성과관리표'), ('국문 PCP'))
    SELECT d.id, d.project_id, d.file_name, d.doc_type, d.created_at
    FROM projects p CROSS JOIN kinds k
    JOIN documents d ON d.id = (
      SELECT candidate.id FROM documents candidate
      WHERE candidate.project_id = p.id AND candidate.doc_type = k.doc_type
        AND candidate.is_included = 1
        AND aieas_is_past_final_report(candidate.doc_type, candidate.is_past_final_report) = 0
        AND candidate.status = '추출 완료'
      ORDER BY candidate.created_at DESC, candidate.rowid DESC LIMIT 1
    )
  `).all() as ProjectDocumentSummary[];

  const docMap = new Map<string, { pdm?: ProjectDocumentSummary; pcp?: ProjectDocumentSummary }>();
  for (const doc of keyDocs) {
    const group = docMap.get(doc.project_id) ?? {};
    if (doc.doc_type === '성과관리표') group.pdm = doc;
    else if (doc.doc_type === '국문 PCP') group.pcp = doc;
    docMap.set(doc.project_id, group);
  }

  const resolvers = reviewResolversForProjects(db, reviews);
  return (stmt.all() as ProjectWithCount[]).map((project) => {
    const history = byProject.get(project.id) ?? [];
    let reviewed = 0, needsRevision = 0;
    const resolvedProject = resolvers.get(project.id);
    if (history.length && counts.has(project.id) && resolvedProject) {
      const nodes = new Map(resolvedProject.nodes.filter((node) => ['indicator', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint'].includes(node.node_type)).map((node) => [node.id, node.node_type]));
      const resolver = resolvedProject.resolver;
      const latest = new Map<string, string>();
      // This matches getNoteReviewData: rowid orders history, split results
      // are excluded and both resolved id and node type must match.
      for (const review of history) {
        const resolved = resolver.resolve(review.import_id, review.node_id, review.node_type);
        if (!resolved.split && nodes.get(resolved.id) === resolved.type) latest.set(resolved.id, review.status);
      }
      reviewed = latest.size;
      needsRevision = [...latest.values()].filter((status) => status === '보완 필요').length;
    }
    const projectDocs = docMap.get(project.id);
    return {
      ...project,
      has_pdm: projectDocs?.pdm ? 1 : 0,
      has_pcp: projectDocs?.pcp ? 1 : 0,
      pdm_document: projectDocs?.pdm ?? null,
      pcp_document: projectDocs?.pcp ?? null,
      review_total: project.review_total + (counts.get(project.id) ?? 0),
      reviewed_count: project.reviewed_count + reviewed,
      needs_revision_count: (project.needs_revision_count ?? 0) + needsRevision,
    };
  });
}

// ---------------- Document operations ----------------
export function createDocument(
  doc: Omit<DocumentRecord, 'masked' | 'approved_ai' | 'is_past_final_report'> &
    Partial<Pick<DocumentRecord, 'masked' | 'approved_ai' | 'is_past_final_report'>>,
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    INSERT INTO documents (
      id, project_id, file_name, file_type, status, doc_type,
      is_included, excluded_reason, masked, approved_ai, is_past_final_report,
      inclusion_source, doctype_source, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    stmt.run(
      doc.id,
      doc.project_id,
      doc.file_name,
      doc.file_type,
      doc.status,
      doc.doc_type,
      doc.is_included,
      doc.excluded_reason,
      doc.masked == null ? null : Number(doc.masked),
      doc.approved_ai ?? 'solar',
      doc.is_past_final_report == null ? null : Number(doc.is_past_final_report),
      doc.inclusion_source ?? 'auto',
      doc.doctype_source ?? 'auto',
      doc.created_at
    );
    prepareEvidenceQuoteCacheIfNeeded(doc.project_id, db);
  })();
}

export function getDocument(id: string, db: Database.Database = getDatabase()): DocumentRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM documents WHERE id = ?`);
  const row = stmt.get(id) as DocumentDbRow | undefined;
  return row ? { ...row, masked: row.masked === null ? null : row.masked === 1, is_past_final_report: row.is_past_final_report === null ? null : row.is_past_final_report === 1 } : undefined;
}

export function listDocuments(projectId: string, db: Database.Database = getDatabase()): DocumentRecord[] {
  const stmt = db.prepare(`SELECT * FROM documents WHERE project_id = ? ORDER BY created_at ASC`);
  return (stmt.all(projectId) as DocumentDbRow[]).map((row) => ({
    ...row,
    masked: row.masked === null ? null : row.masked === 1,
    is_past_final_report: row.is_past_final_report === null ? null : row.is_past_final_report === 1,
  }));
}

export function isDocumentInProject(
  documentId: string,
  projectId: string,
  db: Database.Database = getDatabase()
): boolean {
  const stmt = db.prepare(`SELECT 1 FROM documents WHERE id = ? AND project_id = ?`);
  return stmt.get(documentId, projectId) !== undefined;
}

export function getDocumentInProject(
  documentId: string,
  projectId: string,
  db: Database.Database = getDatabase()
): DocumentRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM documents WHERE id = ? AND project_id = ?`);
  const row = stmt.get(documentId, projectId) as DocumentDbRow | undefined;
  return row ? { ...row, masked: row.masked === null ? null : row.masked === 1, is_past_final_report: row.is_past_final_report === null ? null : row.is_past_final_report === 1 } : undefined;
}

export function updateDocumentAiMetadata(
  projectId: string,
  documentId: string,
  values: { masked?: boolean; approved_ai?: string; is_past_final_report?: boolean | null },
  db: Database.Database = getDatabase()
): boolean {
  const result = db.prepare(`
    UPDATE documents SET masked = COALESCE(?, masked), approved_ai = COALESCE(?, approved_ai),
      is_past_final_report = CASE WHEN ? THEN ? ELSE is_past_final_report END
    WHERE project_id = ? AND id = ?
  `).run(values.masked === undefined ? null : Number(values.masked), values.approved_ai ?? null,
    values.is_past_final_report !== undefined ? 1 : 0, values.is_past_final_report == null ? null : Number(values.is_past_final_report), projectId, documentId);
  return result.changes === 1;
}

export function updateDocumentStatus(
  id: string,
  status: '추출 완료' | '읽지 못함',
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`UPDATE documents SET status = ? WHERE id = ?`);
  stmt.run(status, id);
}

export function updateDocumentInclusion(
  id: string,
  isIncluded: boolean,
  reason?: string | null,
  source: ClassificationSource = 'user',
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    UPDATE documents
    SET is_included = ?, excluded_reason = ?, inclusion_source = ?
    WHERE id = ?
  `);
  stmt.run(isIncluded ? 1 : 0, reason ?? null, source, id);
}

export function updateDocumentType(
  id: string,
  docType: DocType,
  source: ClassificationSource = 'user',
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    UPDATE documents
    SET is_past_final_report = CASE WHEN ? = '종료평가보고서' AND (doc_type IS NULL OR doc_type != '종료평가보고서') THEN 1 ELSE is_past_final_report END,
        doc_type = ?, doctype_source = ?
    WHERE id = ?
  `);
  stmt.run(docType, docType, source, id);
}

export function updateDocumentClassification(
  id: string,
  docType: DocType,
  isIncluded: boolean,
  excludedReason?: string | null,
  doctypeSource: ClassificationSource = 'auto',
  inclusionSource: ClassificationSource = 'auto',
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    UPDATE documents
    SET is_past_final_report = CASE WHEN ? = '종료평가보고서' AND (doc_type IS NULL OR doc_type != '종료평가보고서') THEN 1 ELSE is_past_final_report END,
        doc_type = ?, is_included = ?, excluded_reason = ?,
        doctype_source = ?, inclusion_source = ?
    WHERE id = ?
  `);
  stmt.run(docType, docType, isIncluded ? 1 : 0, excludedReason ?? null, doctypeSource, inclusionSource, id);
}

// ---------------- Paragraph operations ----------------
export function insertParagraphs(paragraphs: ParagraphRecord[], db: Database.Database = getDatabase()): void {
  const insert = db.prepare(`
    INSERT INTO paragraphs (id, document_id, sequence_no, location, content, table_index, table_cols, table_row, table_col, grid_coord_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: ParagraphRecord[]) => {
    for (const item of items) {
      insert.run(
        item.id,
        item.document_id,
        item.sequence_no,
        item.location,
        item.content,
        item.table_index ?? null,
        item.table_cols ?? null,
        item.table_row ?? null,
        item.table_col ?? null,
        item.grid_coord_version ?? null
      );
    }
    const projectForDocument = db.prepare('SELECT project_id FROM documents WHERE id = ?');
    const projects = new Set(items.flatMap(item => {
      const row = projectForDocument.get(item.document_id) as { project_id: string } | undefined;
      return row ? [row.project_id] : [];
    }));
    for (const projectId of projects) prepareEvidenceQuoteCacheIfNeeded(projectId, db);
  });

  insertMany(paragraphs);
}

export function getParagraphsByDocument(documentId: string, db: Database.Database = getDatabase()): ParagraphRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM paragraphs
    WHERE document_id = ?
    ORDER BY sequence_no ASC
  `);
  return stmt.all(documentId) as ParagraphRecord[];
}

export function getParagraph(
  documentId: string,
  location: string,
  db: Database.Database = getDatabase()
): ParagraphRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM paragraphs
    WHERE document_id = ? AND location = ?
    LIMIT 1
  `);
  return stmt.get(documentId, location) as ParagraphRecord | undefined;
}

export function getParagraphsByProject(
  projectId: string,
  onlyIncluded: boolean = true,
  db: Database.Database = getDatabase()
): ParagraphRecord[] {
  const sql = `
    SELECT p.*
    FROM paragraphs p
    JOIN documents d ON p.document_id = d.id
    WHERE d.project_id = ? ${onlyIncluded ? 'AND d.is_included = 1' : ''}
    ORDER BY d.created_at ASC, p.sequence_no ASC
  `;
  const stmt = db.prepare(sql);
  return stmt.all(projectId) as ParagraphRecord[];
}

// ---------------- Sentence operations (추출 단계 문장 단위 플래그 저장) ----------------
export function insertSentences(sentences: SentenceRecord[], db: Database.Database = getDatabase()): void {
  if (sentences.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: SentenceRecord[]) => {
    for (const item of items) {
      insert.run(
        item.id,
        item.document_id,
        item.paragraph_id,
        item.sequence_no,
        item.location,
        item.content,
        item.is_citation_banned
      );
    }
    const projectForParagraph = db.prepare('SELECT d.project_id FROM paragraphs p JOIN documents d ON d.id = p.document_id WHERE p.id = ?');
    const projects = new Set(items.flatMap(item => {
      const row = projectForParagraph.get(item.paragraph_id) as { project_id: string } | undefined;
      return row ? [row.project_id] : [];
    }));
    for (const projectId of projects) prepareEvidenceQuoteCacheIfNeeded(projectId, db);
  });

  insertMany(sentences);
}

export function listSentencesByDocument(documentId: string, db: Database.Database = getDatabase()): SentenceRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM sentences
    WHERE document_id = ?
    ORDER BY sequence_no ASC
  `);
  return stmt.all(documentId) as SentenceRecord[];
}

export function getBannedSentencesByProject(projectId: string, db: Database.Database = getDatabase()): SentenceRecord[] {
  const stmt = db.prepare(`
    SELECT s.*
    FROM sentences s
    JOIN paragraphs p ON s.paragraph_id = p.id
    JOIN documents d ON p.document_id = d.id
    WHERE d.project_id = ? AND s.is_citation_banned = 1
    ORDER BY s.sequence_no ASC
  `);
  return stmt.all(projectId) as SentenceRecord[];
}

// ---------------- Indicator operations ----------------
export function createIndicator(indicator: IndicatorRecord, db: Database.Database = getDatabase()): void {
  const stmt = db.prepare(`
    INSERT INTO indicators (
      id, project_id, level, name, ovi, mov, target_value,
      parent_id, source_doc_id, source_location, sort_order, is_baseline, is_unknown_level, is_orphaned, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    indicator.id,
    indicator.project_id,
    indicator.level,
    indicator.name,
    indicator.ovi,
    indicator.mov,
    indicator.target_value,
    indicator.parent_id ?? null,
    indicator.source_doc_id ?? null,
    indicator.source_location ?? null,
    indicator.sort_order ?? 0,
    indicator.is_baseline,
    indicator.is_unknown_level ? 1 : 0,
    indicator.is_orphaned ? 1 : 0,
    indicator.created_at
  );
}

export function createIndicators(indicators: IndicatorRecord[], db: Database.Database = getDatabase()): void {
  const stmt = db.prepare(`
    INSERT INTO indicators (
      id, project_id, level, name, ovi, mov, target_value,
      parent_id, source_doc_id, source_location, sort_order, is_baseline, is_unknown_level, is_orphaned, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((items: IndicatorRecord[]) => {
    for (const item of items) {
      stmt.run(
        item.id,
        item.project_id,
        item.level,
        item.name,
        item.ovi,
        item.mov,
        item.target_value,
        item.parent_id ?? null,
        item.source_doc_id ?? null,
        item.source_location ?? null,
        item.sort_order ?? 0,
        item.is_baseline,
        item.is_unknown_level ? 1 : 0,
        item.is_orphaned ? 1 : 0,
        item.created_at
      );
    }
  });

  tx(indicators);
}

export function updateIndicatorHierarchy(
  indicatorId: string,
  parentId: string | null,
  sourceDocId: string | null,
  sourceLocation: string | null,
  sortOrder: number,
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    UPDATE indicators
    SET parent_id = ?,
        source_doc_id = COALESCE(source_doc_id, ?),
        source_location = COALESCE(source_location, ?),
        sort_order = ?
    WHERE id = ?
  `);
  stmt.run(parentId, sourceDocId, sourceLocation, sortOrder, indicatorId);
}


export function getIndicator(id: string, db: Database.Database = getDatabase()): IndicatorRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM indicators WHERE id = ?`);
  return stmt.get(id) as IndicatorRecord | undefined;
}

export function isIndicatorInProject(
  indicatorId: string,
  projectId: string,
  db: Database.Database = getDatabase()
): boolean {
  const stmt = db.prepare(`SELECT 1 FROM indicators WHERE id = ? AND project_id = ?`);
  return stmt.get(indicatorId, projectId) !== undefined;
}

export function getIndicatorInProject(
  indicatorId: string,
  projectId: string,
  db: Database.Database = getDatabase()
): IndicatorRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM indicators WHERE id = ? AND project_id = ?`);
  return stmt.get(indicatorId, projectId) as IndicatorRecord | undefined;
}

export function listIndicators(projectId: string, db: Database.Database = getDatabase()): IndicatorRecord[] {
  const stmt = db.prepare(`SELECT * FROM indicators WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, rowid ASC`);
  return stmt.all(projectId) as IndicatorRecord[];
}

// ---------------- Indicator Conflict operations ----------------
export function saveIndicatorConflict(
  conflict: IndicatorConflictRecord,
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO indicator_conflicts (
      id, project_id, indicator_id,
      doc_a_id, doc_a_name, doc_a_value, doc_a_location,
      doc_b_id, doc_b_name, doc_b_value, doc_b_location,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    conflict.id,
    conflict.project_id,
    conflict.indicator_id,
    conflict.doc_a_id,
    conflict.doc_a_name,
    conflict.doc_a_value,
    conflict.doc_a_location ?? null,
    conflict.doc_b_id,
    conflict.doc_b_name,
    conflict.doc_b_value,
    conflict.doc_b_location ?? null,
    conflict.created_at
  );
}

export function getIndicatorConflict(
  indicatorId: string,
  db: Database.Database = getDatabase()
): IndicatorConflictRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM indicator_conflicts WHERE indicator_id = ?`);
  return stmt.get(indicatorId) as IndicatorConflictRecord | undefined;
}

export function listIndicatorConflicts(
  projectId: string,
  db: Database.Database = getDatabase()
): IndicatorConflictRecord[] {
  const stmt = db.prepare(`SELECT * FROM indicator_conflicts WHERE project_id = ? ORDER BY created_at ASC`);
  return stmt.all(projectId) as IndicatorConflictRecord[];
}

export function deleteIndicatorConflict(
  id: string,
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`DELETE FROM indicator_conflicts WHERE id = ?`);
  stmt.run(id);
}

// ---------------- Indicator Baseline operations ----------------
export function saveIndicatorBaseline(
  baseline: IndicatorBaselineRecord,
  db: Database.Database = getDatabase()
): void {
  const saveTx = db.transaction(() => {
    if (baseline.conflict_id) {
      db.prepare(`DELETE FROM indicator_baselines WHERE indicator_id = ? AND conflict_id = ?`).run(
        baseline.indicator_id,
        baseline.conflict_id
      );
    } else if (baseline.other_doc_id) {
      db.prepare(`DELETE FROM indicator_baselines WHERE indicator_id = ? AND other_doc_id = ?`).run(
        baseline.indicator_id,
        baseline.other_doc_id
      );
    } else {
      db.prepare(`DELETE FROM indicator_baselines WHERE indicator_id = ?`).run(baseline.indicator_id);
    }

    const stmt = db.prepare(`
      INSERT INTO indicator_baselines (
        id, project_id, indicator_id, document_id, document_name, target_value, selected_at, conflict_id, other_doc_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      baseline.id,
      baseline.project_id,
      baseline.indicator_id,
      baseline.document_id,
      baseline.document_name,
      baseline.target_value,
      baseline.selected_at,
      baseline.conflict_id ?? null,
      baseline.other_doc_id ?? null
    );

    const updateIndicatorStmt = db.prepare(`
      UPDATE indicators
      SET is_baseline = 1
      WHERE id = ?
    `);
    updateIndicatorStmt.run(baseline.indicator_id);
  });

  saveTx();
}

export function deleteIndicatorBaseline(
  indicatorId: string,
  _resetTargetValue?: string | null,
  db: Database.Database = getDatabase()
): void {
  const deleteTx = db.transaction(() => {
    db.prepare(`DELETE FROM indicator_baselines WHERE indicator_id = ?`).run(indicatorId);
    db.prepare(`UPDATE indicators SET is_baseline = 0 WHERE id = ?`).run(indicatorId);
  });

  deleteTx();
}

export function deleteIndicatorsByProject(
  projectId: string,
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`DELETE FROM indicators WHERE project_id = ?`);
  stmt.run(projectId);
}

/**
 * SQLite 의 foreign_key_list 를 조회하여 indicators 테이블을 참조하는
 * 모든 외부 테이블과 외래 키 컬럼 목록을 동적으로 반환한다 (#19 2회차).
 * (indicators 테이블 자체의 자기 참조 parent_id 는 제외)
 */
export function getIndicatorReferencingTables(
  db: Database.Database = getDatabase()
): Array<{ schema: string; table: string; column: string }> {
  const tables = db
    .prepare("SELECT schema, name FROM pragma_table_list WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ schema: string; name: string }>;

  const refCols: Array<{ schema: string; table: string; column: string }> = [];
  for (const t of tables) {
    if (t.name === 'indicators') continue;
    try {
      const fks = db.prepare(`PRAGMA ${t.schema}.foreign_key_list("${t.name}")`).all() as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      for (const fk of fks) {
        if (fk.table === 'indicators') {
          refCols.push({ schema: t.schema, table: t.name, column: fk.from });
        }
      }
    } catch {
      // pragma 조회 실패 시 건너뜀
    }
  }
  return refCols;
}

/**
 * 지표 이력 점수 계산: 확정 이력(1000점), 제안 이력(10점), 기타 참조 테이블(1점) (#19 2회차)
 */
export function getIndicatorHistoryScores(ambiguousIds: string[], db: Database.Database = getDatabase()): Map<string, number> {
  const historyScores = new Map<string, number>();
  if (ambiguousIds.length) {
    const ids = JSON.stringify(ambiguousIds);
    const addCounts = (sql: string, weight: number) => {
      try {
        const rows = db.prepare(sql).all(ids) as Array<{ id: string; count: number }>;
        for (const row of rows) historyScores.set(row.id, (historyScores.get(row.id) ?? 0) + row.count * weight);
      } catch { /* Match the legacy score's tolerance of missing reference tables. */ }
    };
    addCounts('SELECT indicator_id AS id, COUNT(*) AS count FROM confirmations WHERE indicator_id IN (SELECT value FROM json_each(?)) GROUP BY indicator_id', 1000);
    addCounts('SELECT indicator_id AS id, COUNT(*) AS count FROM suggestions WHERE indicator_id IN (SELECT value FROM json_each(?)) GROUP BY indicator_id', 10);
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    for (const ref of getIndicatorReferencingTables(db)) {
      if (['confirmations', 'suggestions', 'indicator_conflicts', 'indicator_baselines'].includes(ref.table)) continue;
      const column = quote(ref.column);
      addCounts(`SELECT ${column} AS id, COUNT(*) AS count FROM ${quote(ref.schema)}.${quote(ref.table)} WHERE ${column} IN (SELECT value FROM json_each(?)) GROUP BY ${column}`, 1);
    }
  }
  return historyScores;
}

export function getIndicatorHistoryScore(
  indicatorId: string,
  db: Database.Database = getDatabase()
): number {
  let score = 0;
  try {
    const conf = db
      .prepare('SELECT COUNT(*) as c FROM confirmations WHERE indicator_id = ?')
      .get(indicatorId) as { c: number } | undefined;
    score += (conf?.c ?? 0) * 1000;
  } catch {}

  try {
    const sugg = db
      .prepare('SELECT COUNT(*) as c FROM suggestions WHERE indicator_id = ?')
      .get(indicatorId) as { c: number } | undefined;
    score += (sugg?.c ?? 0) * 10;
  } catch {}

  try {
    const refCols = getIndicatorReferencingTables(db);
    for (const ref of refCols) {
      if (
        ref.table === 'confirmations' ||
        ref.table === 'suggestions' ||
        ref.table === 'indicator_conflicts' ||
        ref.table === 'indicator_baselines'
      ) {
        continue;
      }
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM "${ref.schema}"."${ref.table}" WHERE "${ref.column}" = ?`)
        .get(indicatorId) as { c: number } | undefined;
      score += (row?.c ?? 0);
    }
  } catch {}

  return score;
}

export function replaceProjectToc(
  projectId: string,
  newIndicators: IndicatorRecord[],
  newConflicts: IndicatorConflictRecord[],
  baselinesToKeep: IndicatorBaselineRecord[],
  db: Database.Database = getDatabase()
): void {
  const tx = db.transaction(() => {
    // 0. 재부착 전 기준은 지표 참조의 일부다. 지표 고아 판별이 끝날 때까지
    // 기준 테이블을 비운다. 명시적으로 다시 붙일 기준만 아래에서 복원한다.
    db.prepare(`DELETE FROM indicator_conflicts WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM indicator_baselines WHERE project_id = ?`).run(projectId);

    // 1. 기존 프로젝트 지표 목록 조회
    const existingIndicators = db
      .prepare(`SELECT * FROM indicators WHERE project_id = ?`)
      .all(projectId) as IndicatorRecord[];

    const existingById = new Map<string, IndicatorRecord>();
    for (const ind of existingIndicators) {
      existingById.set(ind.id, ind);
    }

    const newIds = new Set(newIndicators.map((i) => i.id));

    // 2. 신규 및 갱신 지표 처리 (id 유지, is_orphaned=0 해제)
    const updateIndStmt = db.prepare(`
      UPDATE indicators
      SET level = ?,
          name = ?,
          ovi = ?,
          mov = ?,
          target_value = ?,
          parent_id = ?,
          source_doc_id = ?,
          source_location = ?,
          sort_order = ?,
          is_baseline = 0,
          is_unknown_level = ?,
          is_orphaned = 0
      WHERE id = ?
    `);

    const insertIndStmt = db.prepare(`
      INSERT INTO indicators (
        id, project_id, level, name, ovi, mov, target_value,
        parent_id, source_doc_id, source_location, sort_order, is_baseline, is_unknown_level, is_orphaned, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)
    `);

    for (const ind of newIndicators) {
      if (existingById.has(ind.id)) {
        updateIndStmt.run(
          ind.level,
          ind.name,
          ind.ovi,
          ind.mov ?? null,
          ind.target_value ?? null,
          ind.parent_id ?? null,
          ind.source_doc_id ?? null,
          ind.source_location ?? null,
          ind.sort_order ?? 0,
          ind.is_unknown_level ? 1 : 0,
          ind.id
        );
      } else {
        insertIndStmt.run(
          ind.id,
          ind.project_id,
          ind.level,
          ind.name,
          ind.ovi,
          ind.mov ?? null,
          ind.target_value ?? null,
          ind.parent_id ?? null,
          ind.source_doc_id ?? null,
          ind.source_location ?? null,
          ind.sort_order ?? 0,
          ind.is_unknown_level ? 1 : 0,
          ind.created_at
        );
      }
    }

    // 3. 문서에서 사라진 지표 처리:
    // sqlite 의 foreign_key_list 를 조회해 indicators 를 참조하는 모든 테이블을 동적으로 확인
    // 하나라도 행이 있으면 지우지 않고 is_orphaned=1 로 보존, 없으면 삭제 (#19 2회차)
    const refCols = getIndicatorReferencingTables(db);
    const checkStmts = refCols.map((r) =>
      db.prepare(`SELECT 1 FROM "${r.schema}"."${r.table}" WHERE "${r.column}" = ? LIMIT 1`)
    );
    const deleteIndStmt = db.prepare(`DELETE FROM indicators WHERE id = ?`);
    const markOrphanedStmt = db.prepare(`
      UPDATE indicators
      SET is_orphaned = 1,
          parent_id = NULL,
          is_baseline = 0
      WHERE id = ?
    `);

    for (const oldInd of existingIndicators) {
      if (!newIds.has(oldInd.id)) {
        let hasReference = baselinesToKeep.some((baseline) => baseline.indicator_id === oldInd.id);
        for (const stmt of checkStmts) {
          if (stmt.get(oldInd.id) !== undefined) {
            hasReference = true;
            break;
          }
        }

        if (!hasReference) {
          deleteIndStmt.run(oldInd.id);
        } else {
          markOrphanedStmt.run(oldInd.id);
        }
      }
    }

    // 새 충돌에 안전하게 재부착되지 않은 선택도 이력으로 유지한다.
    // UI가 conflict_id 누락을 보고 '다시 확인 필요'로 표시한다.
    db.prepare(`DELETE FROM indicator_baselines WHERE project_id = ?`).run(projectId);

    // 4. 신규 충돌 저장
    if (newConflicts.length > 0) {
      const insertConflict = db.prepare(`
        INSERT INTO indicator_conflicts (
          id, project_id, indicator_id, doc_a_id, doc_a_name, doc_a_value, doc_a_location,
          doc_b_id, doc_b_name, doc_b_value, doc_b_location, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const conf of newConflicts) {
        insertConflict.run(
          conf.id,
          conf.project_id,
          conf.indicator_id,
          conf.doc_a_id,
          conf.doc_a_name,
          conf.doc_a_value,
          conf.doc_a_location ?? null,
          conf.doc_b_id,
          conf.doc_b_name,
          conf.doc_b_value,
          conf.doc_b_location ?? null,
          conf.created_at
        );
      }
    }

    // 5. 재부착할 기준 저장 및 해당 지표 is_baseline = 1 갱신
    if (baselinesToKeep.length > 0) {
      const insertBaseline = db.prepare(`
        INSERT INTO indicator_baselines (
          id, project_id, indicator_id, document_id, document_name, target_value, selected_at, conflict_id, other_doc_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateIndBaseline = db.prepare(`
        UPDATE indicators SET is_baseline = 1 WHERE id = ?
      `);
      for (const b of baselinesToKeep) {
        insertBaseline.run(
          b.id,
          b.project_id,
          b.indicator_id,
          b.document_id,
          b.document_name,
          b.target_value,
          b.selected_at,
          b.conflict_id ?? null,
          b.other_doc_id ?? null
        );
        updateIndBaseline.run(b.indicator_id);
      }
    }
  });

  tx();
}

export function getIndicatorBaseline(
  indicatorId: string,
  db: Database.Database = getDatabase()
): IndicatorBaselineRecord | undefined {
  const stmt = db.prepare(`SELECT * FROM indicator_baselines WHERE indicator_id = ? ORDER BY selected_at DESC LIMIT 1`);
  return stmt.get(indicatorId) as IndicatorBaselineRecord | undefined;
}

export function getIndicatorBaselines(
  indicatorId: string,
  db: Database.Database = getDatabase()
): IndicatorBaselineRecord[] {
  const stmt = db.prepare(`SELECT * FROM indicator_baselines WHERE indicator_id = ? ORDER BY selected_at ASC`);
  return stmt.all(indicatorId) as IndicatorBaselineRecord[];
}

export function listIndicatorBaselines(
  projectId: string,
  db: Database.Database = getDatabase()
): IndicatorBaselineRecord[] {
  const stmt = db.prepare(`SELECT * FROM indicator_baselines WHERE project_id = ? ORDER BY selected_at ASC`);
  return stmt.all(projectId) as IndicatorBaselineRecord[];
}


export function validateEvidenceRecord(ev: EvidenceRecord): void {
  if (!ev.quote || ev.quote.trim().length === 0) {
    throw new Error('근거 인용(quote)은 비어 있거나 공백일 수 없습니다.');
  }
  if (!ev.document_id || ev.document_id.trim().length === 0) {
    throw new Error('근거 문서 ID(document_id)는 비어 있거나 공백일 수 없습니다.');
  }
  if (!ev.location || ev.location.trim().length === 0) {
    throw new Error('근거 위치(location)는 비어 있거나 공백일 수 없습니다.');
  }
  if (!ev.speaker || ev.speaker.trim().length === 0) {
    throw new Error('근거 말한 사람(speaker)은 비어 있거나 공백일 수 없습니다.');
  }
}

// ---------------- Suggestion & Evidence operations ----------------
export function saveSuggestion(
  suggestion: SuggestionRecord,
  evidences: EvidenceRecord[],
  db: Database.Database = getDatabase()
): void {
  // Code-level check constraint enforcement
  assertVerdictStatus(suggestion.verdict_status);

  // RQ-10: 근거 네 항목(인용, 문서 id, 위치, 말한 사람)이 비거나 공백뿐이면 거부
  for (const ev of evidences) {
    validateEvidenceRecord(ev);
  }

  const insertSuggestion = db.prepare(`
    INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertEvidence = db.prepare(`
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker, is_citation_banned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const saveTx = db.transaction(() => {
    insertSuggestion.run(
      suggestion.id,
      suggestion.indicator_id,
      suggestion.verdict_status,
      suggestion.error_reason,
      suggestion.proposal_text,
      suggestion.created_at
    );

    for (const ev of evidences) {
      insertEvidence.run(
        ev.id,
        suggestion.id,
        ev.quote,
        ev.document_id,
        ev.location,
        ev.speaker,
        ev.is_citation_banned ?? 0
      );
    }
    const row = db.prepare('SELECT project_id FROM indicators WHERE id = ?').get(suggestion.indicator_id) as { project_id: string } | undefined;
    if (row) prepareEvidenceQuoteCacheIfNeeded(row.project_id, db);
  });

  saveTx();
}

function excludeHoldoutEvidence<T extends EvidenceRecord>(evidences: T[], db: Database.Database): T[] {
  if (!evidences.length) return evidences;
  const documentIds = [...new Set(evidences.map(evidence => evidence.document_id))];
  const documents = db.prepare(`SELECT id, doc_type, is_past_final_report FROM documents
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(documentIds)) as Array<{ id: string; doc_type: string | null; is_past_final_report: number | null }>;
  const excluded = new Set(documents.filter(document => !isConfirmedNonPastReport(document)).map(document => document.id));
  return evidences.filter(evidence => !excluded.has(evidence.document_id));
}

export function getLatestSuggestion(
  indicatorId: string,
  db: Database.Database = getDatabase()
): (SuggestionRecord & { evidences: EvidenceRecord[] }) | undefined {
  const stmt = db.prepare(`
    SELECT * FROM suggestions
    WHERE indicator_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `);
  const suggestion = stmt.get(indicatorId) as SuggestionRecord | undefined;
  if (!suggestion) return undefined;

  const evStmt = db.prepare(`SELECT * FROM evidences WHERE suggestion_id = ?`);
  const evidences = excludeHoldoutEvidence(evStmt.all(suggestion.id) as EvidenceRecord[], db);

  return { ...suggestion, evidences };
}

export function getEarliestSuggestion(
  indicatorId: string,
  db: Database.Database = getDatabase()
): (SuggestionRecord & { evidences: EvidenceRecord[] }) | undefined {
  const stmt = db.prepare(`
    SELECT * FROM suggestions
    WHERE indicator_id = ?
    ORDER BY rowid ASC
    LIMIT 1
  `);
  const suggestion = stmt.get(indicatorId) as SuggestionRecord | undefined;
  if (!suggestion) return undefined;

  const evStmt = db.prepare(`SELECT * FROM evidences WHERE suggestion_id = ?`);
  const evidences = excludeHoldoutEvidence(evStmt.all(suggestion.id) as EvidenceRecord[], db);

  return { ...suggestion, evidences };
}

export function listSuggestions(
  indicatorId: string,
  db: Database.Database = getDatabase()
): (SuggestionRecord & { evidences: EvidenceRecord[] })[] {
  const stmt = db.prepare(`
    SELECT * FROM suggestions
    WHERE indicator_id = ?
    ORDER BY rowid DESC
  `);
  const suggestions = stmt.all(indicatorId) as SuggestionRecord[];

  const evStmt = db.prepare(`SELECT * FROM evidences WHERE suggestion_id = ?`);
  return suggestions.map((s) => ({
    ...s,
    evidences: excludeHoldoutEvidence(evStmt.all(s.id) as EvidenceRecord[], db),
  }));
}

/**
 * 특정 지표의 제안(및 딸린 근거)을 새 제안으로 교체하는 함수 (fix-r1).
 * - 기존 확정 이력(confirmations)이 참조하는 suggestion_id 는 외래키 보호를 위해 보존하고,
 *   가장 이른 제안(AI 최초 제안)도 확정 이력이 있는 경우 보존한다.
 * - 확정 이력이 참조하지 않는 기존 제안(및 그 근거)은 지우고, 새 제안을 최신(가장 큰 rowid)으로 넣는다.
 */
export function replaceIndicatorSuggestions(
  indicatorId: string,
  suggestion: SuggestionRecord,
  evidences: EvidenceRecord[],
  db: Database.Database = getDatabase()
): { deletedSuggestionIds: string[]; keptSuggestionIds: string[] } {
  assertVerdictStatus(suggestion.verdict_status);
  for (const ev of evidences) {
    validateEvidenceRecord(ev);
  }

  const allSuggestions = db
    .prepare(`SELECT id FROM suggestions WHERE indicator_id = ? ORDER BY rowid ASC`)
    .all(indicatorId) as Array<{ id: string }>;

  const referencedRows = db
    .prepare(
      `SELECT DISTINCT suggestion_id FROM confirmations WHERE indicator_id = ? AND suggestion_id IS NOT NULL`
    )
    .all(indicatorId) as Array<{ suggestion_id: string }>;

  const hasConfirmations =
    (
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM confirmations WHERE indicator_id = ?`)
        .get(indicatorId) as { cnt: number }
    ).cnt > 0;

  const protectedIds = new Set<string>(referencedRows.map((r) => r.suggestion_id));
  if (hasConfirmations && allSuggestions.length > 0) {
    protectedIds.add(allSuggestions[0].id);
  }

  const deletedSuggestionIds: string[] = [];
  const keptSuggestionIds: string[] = [];
  for (const row of allSuggestions) {
    if (protectedIds.has(row.id)) {
      keptSuggestionIds.push(row.id);
    } else {
      deletedSuggestionIds.push(row.id);
    }
  }

  const deleteSuggestionStmt = db.prepare(`DELETE FROM suggestions WHERE id = ?`);
  const insertSuggestionStmt = db.prepare(`
    INSERT INTO suggestions (id, indicator_id, verdict_status, error_reason, proposal_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEvidenceStmt = db.prepare(`
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker, is_citation_banned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const delId of deletedSuggestionIds) {
      deleteSuggestionStmt.run(delId);
    }

    insertSuggestionStmt.run(
      suggestion.id,
      suggestion.indicator_id,
      suggestion.verdict_status,
      suggestion.error_reason,
      suggestion.proposal_text,
      suggestion.created_at
    );

    for (const ev of evidences) {
      insertEvidenceStmt.run(
        ev.id,
        suggestion.id,
        ev.quote,
        ev.document_id,
        ev.location,
        ev.speaker,
        ev.is_citation_banned ?? 0
      );
    }
    const row = db.prepare('SELECT project_id FROM indicators WHERE id = ?').get(suggestion.indicator_id) as { project_id: string } | undefined;
    if (row) prepareEvidenceQuoteCacheIfNeeded(row.project_id, db);
  });

  tx();

  return { deletedSuggestionIds, keptSuggestionIds };
}

/**
 * 시험 전용 원시 INSERT 진입점:
 * 코드 레벨의 사전 검증(validateEvidenceRecord)을 거치지 않고 직접 evidences 테이블에 INSERT하여
 * 데이터베이스 CHECK 제약조건을 직접 검증한다.
 */
export function insertRawEvidenceForTesting(
  evidence: {
    id?: string;
    suggestion_id: string;
    quote: string;
    document_id: string;
    location: string;
    speaker: string;
    is_citation_banned?: number;
  },
  db: Database.Database = getDatabase()
): void {
  const stmt = db.prepare(`
    INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker, is_citation_banned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    evidence.id ?? 'ev-test-' + Math.random().toString(36).slice(2, 9),
    evidence.suggestion_id,
    evidence.quote,
    evidence.document_id,
    evidence.location,
    evidence.speaker,
    evidence.is_citation_banned ?? 0
  );
}

// ---------------- Review (S4) operations ----------------
export function getParagraphWithSurroundings(
  documentId: string,
  location: string,
  db: Database.Database = getDatabase(),
  bannedSentences?: string[]
): ParagraphContext | null {
  const target = getParagraph(documentId, location, db);
  if (!target) return null;

  const stmt = db.prepare(`
    SELECT * FROM paragraphs
    WHERE document_id = ? AND sequence_no >= ? AND sequence_no <= ?
    ORDER BY sequence_no ASC
  `);
  const surroundings = stmt.all(
    documentId,
    target.sequence_no - 1,
    target.sequence_no + 1
  ) as ParagraphRecord[];

  let projectBanned = bannedSentences;
  if (!projectBanned) {
    const doc = getDocument(documentId, db);
    if (doc?.project_id) {
      projectBanned = getBannedSentencesByProject(doc.project_id, db).map((s) => s.content);
    } else {
      projectBanned = [];
    }
  }

  const maskPara = (p: ParagraphRecord): ParagraphRecord => ({
    ...p,
    content: maskForbiddenSentenceInContent(p.content, projectBanned),
  });

  const maskedTarget = maskPara(target);
  const maskedSurroundings = surroundings.map(maskPara);
  const previous = maskedSurroundings.find((p) => p.sequence_no === target.sequence_no - 1);
  const next = maskedSurroundings.find((p) => p.sequence_no === target.sequence_no + 1);

  return {
    target: maskedTarget,
    previous,
    next,
    surroundings: maskedSurroundings,
  };
}

/** Request-scoped safety inputs, bound to one project and database connection. */
export type ProjectCitationContext = {
  projectId: string;
  db: Database.Database;
  sentences: string[];
  originalSentences: string[];
  index: ForbiddenSentenceIndex;
};
export function getProjectCitationContext(projectId: string, db: Database.Database = getDatabase()): ProjectCitationContext {
  const originalSentences = getBannedSentencesByProject(projectId, db).map(s => s.content);
  const sentences = [...new Set(originalSentences)];
  return { projectId, db, sentences, originalSentences, index: createForbiddenSentenceIndex(sentences) };
}
export function resolveProjectCitationContext(projectId: string, db: Database.Database, context?: ProjectCitationContext): ProjectCitationContext {
  if (!context) return getProjectCitationContext(projectId, db);
  if (context.projectId !== projectId || context.db !== db) throw new Error('Citation context does not match project and database');
  return context;
}

function groupByIndicator<T extends { indicator_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    let group = grouped.get(row.indicator_id);
    if (!group) grouped.set(row.indicator_id, group = []);
    group.push(row);
  }
  return grouped;
}

// Batch the reads while preserving the suggestion explicitly linked by each confirmation.
function loadReviewBatch(
  projectId: string,
  db: Database.Database,
  banned: string[],
  banIndex: ForbiddenSentenceIndex,
  historyOnly = false,
  indicatorIds?: string[],
) {
  // History shows only the latest suggestion for each indicator. Review/report
  // also need suggestions referenced by confirmations, including older ones.
  let selection = historyOnly
    ? `s.rowid IN (SELECT (SELECT rowid FROM suggestions WHERE indicator_id = i.id ORDER BY rowid DESC LIMIT 1)
        FROM indicators i WHERE i.project_id = ?)`
    : `s.indicator_id IN (SELECT id FROM indicators WHERE project_id = ?)
        OR s.id IN (SELECT c.suggestion_id FROM confirmations c JOIN indicators i ON i.id = c.indicator_id WHERE i.project_id = ?)`;
  const params: Array<string> = historyOnly ? [projectId] : [projectId, projectId];
  if (!historyOnly && indicatorIds) {
    selection = `(${selection}) AND s.indicator_id IN (SELECT value FROM json_each(?))`;
    params.push(JSON.stringify(indicatorIds));
  }
  const suggestions = db.prepare(`SELECT s.* FROM suggestions s WHERE ${selection} ORDER BY s.rowid DESC`).all(...params) as SuggestionRecord[];
  const evidenceRows = excludeHoldoutEvidence(db.prepare(`SELECT e.* FROM evidences e JOIN suggestions s ON s.id = e.suggestion_id WHERE ${selection} ORDER BY e.rowid`).all(...params) as EvidenceRecord[], db);
  const evidences = new Map<string, EvidenceRecord[]>();
  for (const row of evidenceRows) {
    const list = evidences.get(row.suggestion_id) ?? [];
    list.push(row);
    evidences.set(row.suggestion_id, list);
  }
  const byId = new Map<string, SuggestionRecord & { evidences: EvidenceRecord[] }>();
  const latest = new Map<string, SuggestionRecord & { evidences: EvidenceRecord[] }>();
  for (const suggestion of suggestions) {
    const entry = { ...suggestion, evidences: evidences.get(suggestion.id) ?? [] };
    byId.set(suggestion.id, entry);
    if (!latest.has(suggestion.indicator_id)) latest.set(suggestion.indicator_id, entry);
  }
  const confirmations = historyOnly ? [] : db.prepare(`SELECT c.* FROM confirmations c JOIN indicators i ON i.id = c.indicator_id
    WHERE i.project_id = ? ${indicatorIds ? 'AND i.id IN (SELECT value FROM json_each(?))' : ''}
    ORDER BY c.created_at DESC, c.rowid DESC`).all(...(indicatorIds ? [projectId, JSON.stringify(indicatorIds)] : [projectId])) as ConfirmationRecord[];
  const latestConfirmation = new Map<string, ConfirmationRecord>();
  for (const confirmation of confirmations) if (!latestConfirmation.has(confirmation.indicator_id)) latestConfirmation.set(confirmation.indicator_id, confirmation);

  const pairMap = new Map<string, [string, string]>();
  for (const e of evidenceRows) {
    const k = `${e.document_id}\0${e.location}`;
    if (!pairMap.has(k)) pairMap.set(k, [e.document_id, e.location]);
  }
  const docLocPairs = Array.from(pairMap.values());
  const paragraphs = docLocPairs.length ? db.prepare(`
    WITH targets AS (
      SELECT p.document_id, p.sequence_no
      FROM json_each(?) j
      JOIN documents d ON d.id = json_extract(j.value, '$[0]') AND d.project_id = ?
      JOIN paragraphs p ON p.document_id = d.id AND p.location = json_extract(j.value, '$[1]')
    ),
    needed AS (
      SELECT DISTINCT t.document_id, (t.sequence_no + d.diff) AS seq
      FROM targets t
      JOIN (SELECT 0 AS diff UNION ALL SELECT -1 UNION ALL SELECT 1) d
    )
    SELECT p.id, p.document_id, p.sequence_no, p.location, p.content, p.table_index, p.table_cols, p.table_row, p.table_col, p.grid_coord_version
    FROM paragraphs p
    JOIN needed n ON p.document_id = n.document_id AND p.sequence_no = n.seq
    ORDER BY p.rowid
  `).all(JSON.stringify(docLocPairs), projectId) as ParagraphRecord[] : [];

  const locations = new Map<string, ParagraphRecord>();
  const sequences = new Map<string, ParagraphRecord[]>();
  const key = (doc: string, value: string | number) => JSON.stringify([doc, value]);
  for (const paragraph of paragraphs) {
    const location = key(paragraph.document_id, paragraph.location);
    if (!locations.has(location)) locations.set(location, paragraph);
    const seq = key(paragraph.document_id, paragraph.sequence_no);
    const rows = sequences.get(seq) ?? [];
    rows.push(paragraph);
    sequences.set(seq, rows);
  }
  const masked = new Map<ParagraphRecord, ParagraphRecord>();
  const mask = (paragraph: ParagraphRecord) => {
    let result = masked.get(paragraph);
    if (!result) {
      result = { ...paragraph, content: maskForbiddenSentenceInContent(paragraph.content, banned, banIndex) };
      masked.set(paragraph, result);
    }
    return result;
  };
  const context = (documentId: string, location: string): ParagraphContext | undefined => {
    const target = locations.get(key(documentId, location));
    if (!target) return undefined;
    const surroundings = [target.sequence_no - 1, target.sequence_no, target.sequence_no + 1]
      .flatMap(seq => sequences.get(key(documentId, seq)) ?? []).map(mask);
    return { target: mask(target), previous: surroundings.find(p => p.sequence_no === target.sequence_no - 1),
      next: surroundings.find(p => p.sequence_no === target.sequence_no + 1), surroundings };
  };
  return { latest, byId, latestConfirmation, context };
}

export function getReviewData(
  projectId: string,
  db: Database.Database = getDatabase(),
  citationContext?: ProjectCitationContext
): ReviewPageData | null {
  const project = getProject(projectId, db);
  if (!project) return null;

  const indicators = listIndicators(projectId, db);
  const documents = listDocuments(projectId, db);
  const conflicts = listIndicatorConflicts(projectId, db);
  const baselines = listIndicatorBaselines(projectId, db);
  const docMap = new Map(documents.map((d) => [d.id, d]));

  const unreadableDocuments = documents.filter((d) => d.status === '읽지 못함');
  const attributions = listProjectAttributions(projectId, db);
  let context: ProjectCitationContext;
  try {
    context = resolveProjectCitationContext(projectId, db, citationContext);
  } catch {
    // Never return review text when its project safety context cannot be read.
    return null;
  }
  const { sentences: bannedSentences, index: banIndex } = context;
  const batch = loadReviewBatch(projectId, db, bannedSentences, banIndex, false);
  const conflictsByIndicator = groupByIndicator(conflicts);
  const baselinesByIndicator = groupByIndicator(baselines);
  const reviewIndicators: ReviewIndicatorItem[] = indicators.map((ind) => {
    const indConflicts = conflictsByIndicator.get(ind.id) ?? [];
    const indBaselines = baselinesByIndicator.get(ind.id) ?? [];
    const conflict = indConflicts[0] ?? null;
    const baseline = indBaselines[0] ?? null;
    const latest = batch.latest.get(ind.id);
    const latestConfirmation = batch.latestConfirmation.get(ind.id) ?? null;
    const attribution = attributions[ind.id] ?? null;

    if (!latest) {
      return {
        indicator: ind,
        suggestion: null,
        conflict,
        conflicts: indConflicts,
        baseline,
        baselines: indBaselines,
        latestConfirmation,
        attribution,
      };
    }

    const reviewEvidences: ReviewEvidence[] = latest.evidences.map((ev) => {
      const doc = docMap.get(ev.document_id);
      const document_name = doc?.file_name ?? ev.document_id;
      const paragraph_context =
        batch.context(ev.document_id, ev.location);

      // 표시 직전 가림 (#20 검수 2회차 1번): 플래그·대체 문구·정규식에 더해 그 사업의 금지 문장과 8자 이상 겹치는지 대조해 가림
      const maskedEv = maskEvidenceIfCitationBanned(ev, bannedSentences, banIndex);

      return {
        ...maskedEv,
        is_citation_banned: maskedEv.is_citation_banned === 1 ? 1 : 0,
        document_name,
        paragraph_context,
      };
    });

    return {
      indicator: ind,
      suggestion: {
        ...latest,
        evidences: reviewEvidences,
      },
      conflict,
      conflicts: indConflicts,
      baseline,
      baselines: indBaselines,
      latestConfirmation,
      attribution,
    };
  });

  const latestConfirmerName = getLatestConfirmerName(projectId, db);

  const reviewData: ReviewPageData = {
    project,
    indicators: reviewIndicators,
    unreadableDocuments,
    latestConfirmerName,
  };

  // Ensure any project-banned overlap cannot escape through any serialized review field.
  const redactedStrings = new Map<string, string>();
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let masked = redactedStrings.get(value);
      if (masked === undefined) {
        masked = banIndex(value) ? '[인용 금지 문장]' : value;
        redactedStrings.set(value, masked);
      }
      return masked;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      const res: Record<string, unknown> = {};
      for (const k of Object.keys(value)) {
        res[k] = redact((value as Record<string, unknown>)[k]);
      }
      return res;
    }
    return value;
  };
  return redact(reviewData) as ReviewPageData;
}

// ---------------- Confirmation operations (Append-Only) ----------------
export function validateConfirmationRecord(confirmation: ConfirmationRecord): void {
  assertConfirmationType(confirmation.confirmation_type);

  if (!confirmation.confirmer_name || confirmation.confirmer_name.trim().length === 0) {
    throw new Error('확정자 이름은 비어 있거나 공백일 수 없습니다.');
  }

  if (confirmation.confirmation_type === '수정 후 확정') {
    if (!confirmation.edited_text || confirmation.edited_text.trim().length === 0) {
      throw new Error('수정 후 확정은 수정본이 비어 있을 수 없습니다.');
    }
    if (!confirmation.reason || confirmation.reason.trim().length === 0) {
      throw new Error('수정 후 확정은 사유가 비어 있을 수 없습니다.');
    }
    if (confirmation.edited_verdict_status !== undefined && confirmation.edited_verdict_status !== null) {
      assertVerdictStatus(confirmation.edited_verdict_status);
    }
  }
}

export function createConfirmation(
  confirmation: CreateConfirmationInput,
  db: Database.Database = getDatabase()
): ConfirmationRecord {
  validateConfirmationRecord(confirmation as ConfirmationRecord);

  // 5대 요구사항 경계 (#20 검수 5번, #20 검수 2회차 3번): 수정본·사유에 금지 문장과 8자 이상 겹침 검사 (저장 거부 및 사유 표시)
  // 그 사업에 금지 문장이 0개면 비교 대상 없음 (전역 목록 대체 삭제)
  const ind = getIndicator(confirmation.indicator_id, db);
  let bannedSentences: string[] = [];
  if (ind?.project_id) {
    const stmt = db.prepare(`
      SELECT s.content
      FROM sentences s
      JOIN paragraphs p ON s.paragraph_id = p.id
      JOIN documents d ON p.document_id = d.id
      WHERE d.project_id = ? AND s.is_citation_banned = 1
    `);
    bannedSentences = (stmt.all(ind.project_id) as { content: string }[]).map((r) => r.content);
  }

  if (confirmation.edited_text) {
    if (
      isCitationBannedSentence(confirmation.edited_text) ||
      hasForbiddenSentenceOverlap(confirmation.edited_text, bannedSentences, 8)
    ) {
      throw new Error('수정본에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.');
    }
  }

  if (confirmation.reason) {
    if (
      isCitationBannedSentence(confirmation.reason) ||
      hasForbiddenSentenceOverlap(confirmation.reason, bannedSentences, 8)
    ) {
      throw new Error('사유에 인용 금지 문장과 8자 이상 겹치는 내용이 포함되어 있어 저장할 수 없습니다.');
    }
  }

  // 결정 (b): AI 제안이 하나도 없는 지표는 확정할 수 없다
  const earliestSuggestion = getEarliestSuggestion(confirmation.indicator_id, db);
  if (!earliestSuggestion) {
    throw new Error('AI 제안이 없는 지표는 확정할 수 없습니다.');
  }

  // 결정 (a): "AI 최초 제안" = 그 지표에 처음 저장된 제안(삽입 순서/rowid 기준 가장 이른 suggestion).
  // 재제안이 있어도 최초 제안은 바뀌지 않는다. initial_proposal 을 호출자가 넘기지 않고 저장 모듈이 스스로 결정한다.
  const initialProposal = earliestSuggestion.proposal_text ?? null;

  // 각 이력 줄에는 그 확정 시점의 최신 제안 id(삽입 순서/rowid 기준 최신 suggestion)를 저장 모듈이 스스로 결정하여 남긴다.
  const latestSuggestion = getLatestSuggestion(confirmation.indicator_id, db);
  const suggestionId = latestSuggestion?.id ?? null;

  let editedVerdictStatus: VerdictStatus | null =
    confirmation.confirmation_type === '수정 후 확정' && confirmation.edited_verdict_status
      ? confirmation.edited_verdict_status
      : null;

  // 연결 제안 판정과 같으면 NULL 로 정규화 (#23)
  if (
    editedVerdictStatus !== null &&
    latestSuggestion &&
    editedVerdictStatus === latestSuggestion.verdict_status
  ) {
    editedVerdictStatus = null;
  }

  if (editedVerdictStatus) {
    assertVerdictStatus(editedVerdictStatus);
  }

  const id = confirmation.id ?? 'conf-' + crypto.randomUUID();
  const createdAt = confirmation.created_at ?? new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO confirmations (
      id, indicator_id, suggestion_id, confirmation_type,
      initial_proposal, edited_text, edited_verdict_status, reason, confirmer_name, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    confirmation.indicator_id,
    suggestionId,
    confirmation.confirmation_type,
    initialProposal,
    confirmation.edited_text ? confirmation.edited_text.trim() : null,
    editedVerdictStatus,
    confirmation.reason ? confirmation.reason.trim() : null,
    confirmation.confirmer_name.trim(),
    createdAt
  );

  return {
    id,
    indicator_id: confirmation.indicator_id,
    suggestion_id: suggestionId,
    confirmation_type: confirmation.confirmation_type,
    initial_proposal: initialProposal,
    edited_text: confirmation.edited_text ? confirmation.edited_text.trim() : null,
    edited_verdict_status: editedVerdictStatus,
    reason: confirmation.reason ? confirmation.reason.trim() : null,
    confirmer_name: confirmation.confirmer_name.trim(),
    created_at: createdAt,
    ai_verdict_status: latestSuggestion?.verdict_status ?? null,
  };
}

export function listConfirmations(
  indicatorId: string,
  db: Database.Database = getDatabase()
): ConfirmationRecord[] {
  const stmt = db.prepare(`
    SELECT
      c.*,
      s.verdict_status AS ai_verdict_status
    FROM confirmations c
    LEFT JOIN suggestions s ON c.suggestion_id = s.id
    WHERE c.indicator_id = ?
    ORDER BY c.created_at ASC, c.rowid ASC
  `);
  return stmt.all(indicatorId) as ConfirmationRecord[];
}

export function getLatestConfirmation(
  indicatorId: string,
  db: Database.Database = getDatabase()
): ConfirmationRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM confirmations
    WHERE indicator_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `);
  return stmt.get(indicatorId) as ConfirmationRecord | undefined;
}

export function getLatestConfirmerName(
  projectId: string,
  db: Database.Database = getDatabase()
): string | undefined {
  const stmt = db.prepare(`
    SELECT c.confirmer_name
    FROM confirmations c
    JOIN indicators i ON c.indicator_id = i.id
    WHERE i.project_id = ?
    ORDER BY c.created_at DESC
    LIMIT 1
  `);
  const row = stmt.get(projectId) as { confirmer_name: string } | undefined;
  return row?.confirmer_name;
}

export function getHistoryPageData(
  projectId: string,
  db: Database.Database = getDatabase()
): HistoryPageData | null {
  const project = getProject(projectId, db);
  if (!project) return null;

  const indicators = listIndicators(projectId, db);
  const documents = listDocuments(projectId, db);
  const docMap = new Map(documents.map((d) => [d.id, d]));
  const attributions = listProjectAttributions(projectId, db);
  const { sentences: bannedSentences, index: banIndex } = getProjectCitationContext(projectId, db);
  const batch = loadReviewBatch(projectId, db, bannedSentences, banIndex, true);
  const confirmationRows = db.prepare(`SELECT c.*, s.verdict_status AS ai_verdict_status
    FROM confirmations c JOIN indicators i ON i.id = c.indicator_id
    LEFT JOIN suggestions s ON c.suggestion_id = s.id
    WHERE i.project_id = ? ORDER BY c.created_at ASC, c.rowid ASC`).all(projectId) as ConfirmationRecord[];
  const confirmationsByIndicator = groupByIndicator(confirmationRows);

  const indicatorsWithConfirmations: IndicatorWithConfirmations[] = indicators.map((ind) => {
    const latestSugg = batch.latest.get(ind.id);
    const confirmations = confirmationsByIndicator.get(ind.id) ?? [];
    const latestConf = confirmations.length > 0 ? confirmations[confirmations.length - 1] : null;

    let latestSuggestionWithContext: (SuggestionRecord & { evidences: ReviewEvidence[] }) | null = null;
    if (latestSugg) {
      const reviewEvidences: ReviewEvidence[] = latestSugg.evidences.map((ev) => {
        const doc = docMap.get(ev.document_id);
        const document_name = doc?.file_name ?? ev.document_id;
        const paragraph_context =
          batch.context(ev.document_id, ev.location);
        const maskedEv = maskEvidenceIfCitationBanned(ev, bannedSentences, banIndex);
        return {
          ...maskedEv,
          document_name,
          paragraph_context,
        };
      });
      latestSuggestionWithContext = {
        ...latestSugg,
        evidences: reviewEvidences,
      };
    }

    return {
      indicator: ind,
      latestSuggestion: latestSuggestionWithContext,
      confirmations,
      latestConfirmation: latestConf,
      attribution: attributions[ind.id] ?? null,
    };
  });

  const latestConfirmerName = getLatestConfirmerName(projectId, db);

  return {
    project,
    indicators: indicatorsWithConfirmations,
    latestConfirmerName,
  };
}

// ---------------- ToC (S3) operations ----------------
export function getTocData(
  projectId: string,
  db: Database.Database = getDatabase()
): TocPageData | null {
  const project = getProject(projectId, db);
  if (!project) return null;

  const documents = listDocuments(projectId, db);
  const bannedSentences = getBannedSentencesByProject(projectId, db).map((sentence) => sentence.content);
  const pdmDoc = documents.find((d) => d.doc_type === '성과관리표' && d.is_included === 1 && isConfirmedNonPastReport(d)) ?? null;
  const hasPdm = pdmDoc !== null;

  const indicators = listIndicators(projectId, db);
  const conflicts = listIndicatorConflicts(projectId, db);
  const baselines = listIndicatorBaselines(projectId, db);

  const docMap = new Map(documents.map((d) => [d.id, d]));

  const conflictsByIndicator = groupByIndicator(conflicts);
  const baselinesByIndicator = groupByIndicator(baselines);
  const pdmParas = pdmDoc ? getParagraphsByDocument(pdmDoc.id, db) : [];
  const parsed = pdmDoc ? parsePdmParagraphs(pdmParas, pdmDoc.id) : [];
  const parsedByKey = new Map<string, typeof parsed[number]>();
  let duplicate = false;
  for (const item of parsed) {
    const key = getIndicatorNaturalKey(item.level, item.name, item.ovi);
    if (parsedByKey.has(key)) duplicate = true;
    else parsedByKey.set(key, item);
  }
  const standardLevels = ['영향', '중기성과', '단기성과', '산출물', '활동'];
  const items: TocItem[] = indicators.map((ind) => {
    const isUnknown = Boolean(ind.is_unknown_level) || !standardLevels.includes(ind.level);
    const indConflicts = conflictsByIndicator.get(ind.id) ?? [];
    const indBaselines = baselinesByIndicator.get(ind.id) ?? [];
    return {
      indicator: {
        ...ind,
        is_unknown_level: isUnknown,
        is_orphaned: ind.is_orphaned ? 1 : 0,
      },
      planDetails: parsedByKey.get(getIndicatorNaturalKey(ind.level, ind.name, ind.ovi))?.planDetails,
      sourceDocument: ind.source_doc_id ? docMap.get(ind.source_doc_id) ?? null : null,
      conflict: indConflicts[0] ?? null,
      conflicts: indConflicts,
      baseline: indBaselines[0] ?? null,
      baselines: indBaselines,
      is_unknown_level: isUnknown,
    };
  });

  const reasonDocument = pdmReasonDocument(documents);
  let warningMessage: string | null = !pdmDoc ? exclusionReasonForDocument({ kind: 'pdm', document: reasonDocument && {
    ...reasonDocument,
    file_name: maskTextIfForbiddenSentenceOverlap(reasonDocument.file_name, bannedSentences, 8),
  } }) : null;
  if (pdmDoc) {
    const hasTable = pdmParas.some((p) => p.table_row != null && p.table_col != null);
    const hasLegacyTable = pdmParas.some((p) => p.table_row != null && p.table_col != null && p.grid_coord_version !== 1);
    const warnings: string[] = [];
    if (!hasTable || items.length === 0) warnings.push('성과관리표에서 표를 찾지 못했습니다');
    else if (duplicate) warnings.push('같은 지표가 두 번 나옵니다');
    if (hasLegacyTable) warnings.push('표 다시 읽기 필요(자료를 다시 올리면 정확히 읽습니다)');
    warningMessage = warnings.join(' · ') || null;
  }

  return {
    project,
    hasPdm,
    pdmDocument: pdmDoc,
    items,
    conflicts,
    baselines,
    warningMessage,
  };
}

// ---------------- Report targets (RQ-20, D04, D33) ----------------
export function getReportTargets(
  projectId: string,
  db: Database.Database = getDatabase(),
  citationContext?: ProjectCitationContext,
  indicatorIds?: string[],
): ReportTargetIndicator[] {
  const indicatorIdSet = indicatorIds ? new Set(indicatorIds) : null;
  const indicators = listIndicators(projectId, db).filter(indicator => !indicatorIdSet || indicatorIdSet.has(indicator.id));
  const documents = listDocuments(projectId, db);
  const docMap = new Map(documents.map((d) => [d.id, d]));
  const { sentences: bannedSentences, index: banIndex } = resolveProjectCitationContext(projectId, db, citationContext);
  const batch = loadReviewBatch(projectId, db, bannedSentences, banIndex, false, indicatorIds);
  const targets: ReportTargetIndicator[] = [];

  for (const ind of indicators) {
    const latestConf = batch.latestConfirmation.get(ind.id);
    if (!latestConf) continue;

    // RQ-20, D04: "확정"과 "수정 후 확정"만 보고서 대상. "보완 필요", "채택 제외"는 제외.
    if (
      latestConf.confirmation_type !== '확정' &&
      latestConf.confirmation_type !== '수정 후 확정'
    ) {
      continue;
    }

    // 확정 기록에 연결된 제안(suggestion_id) 조회 (최신 제안 사용 금지, #23)
    const linkedSugg = latestConf.suggestion_id
      ? batch.byId.get(latestConf.suggestion_id)
      : null;

    const verdictStatus = computeResultTocItemStatus(latestConf, linkedSugg).verdictStatus!;
    const isUnverifiedVerdict = verdictStatus === '미확인';

    let confirmedText = '';
    if (latestConf.confirmation_type === '수정 후 확정' && latestConf.edited_text) {
      confirmedText = latestConf.edited_text;
    } else {
      confirmedText =
        latestConf.initial_proposal ?? linkedSugg?.proposal_text ?? '';
    }

    const evidences: ReviewEvidence[] = (linkedSugg?.evidences ?? []).map((ev) => {
      const doc = docMap.get(ev.document_id);
      const document_name = doc?.file_name ?? ev.document_id;
      const paragraph_context =
        batch.context(ev.document_id, ev.location);
      const maskedEv = maskEvidenceIfCitationBanned(ev, bannedSentences, banIndex);
      return {
        ...maskedEv,
        document_name,
        paragraph_context,
      };
    });

    targets.push({
      indicator: ind,
      latestConfirmation: latestConf,
      confirmedText,
      verdictStatus,
      isUnverifiedVerdict,
      evidences,
    });
  }

  return targets;
}


// ---------------- Indicator Attribution operations (RQ-16) ----------------
export function saveIndicatorAttribution(
  projectId: string,
  indicatorId: string,
  text: string,
  db: Database.Database = getDatabase()
): void {
  if (!isIndicatorInProject(indicatorId, projectId, db)) {
    throw new Error('해당 사업에 속한 지표가 아닙니다.');
  }

  const now = new Date().toISOString();
  const id = 'attr-' + crypto.randomUUID();

  const stmt = db.prepare(`
    INSERT INTO indicator_attributions (id, project_id, indicator_id, attribution_text, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(indicator_id) DO UPDATE SET
      attribution_text = excluded.attribution_text,
      updated_at = excluded.updated_at
  `);

  stmt.run(id, projectId, indicatorId, text.trim(), now);
}

export function getIndicatorAttribution(
  indicatorId: string,
  db: Database.Database = getDatabase()
): string | null {
  const stmt = db.prepare(`
    SELECT attribution_text FROM indicator_attributions WHERE indicator_id = ?
  `);
  const row = stmt.get(indicatorId) as { attribution_text: string } | undefined;
  return row?.attribution_text ?? null;
}

export function listProjectAttributions(
  projectId: string,
  db: Database.Database = getDatabase()
): Record<string, string> {
  const stmt = db.prepare(`
    SELECT indicator_id, attribution_text FROM indicator_attributions WHERE project_id = ?
  `);
  const rows = stmt.all(projectId) as Array<{ indicator_id: string; attribution_text: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.indicator_id] = r.attribution_text;
  }
  return map;
}

export function getAttributionsForReport(
  projectId: string,
  db: Database.Database = getDatabase()
): Array<{ indicatorId: string; indicatorName: string; attributionText: string }> {
  const stmt = db.prepare(`
    SELECT a.indicator_id, i.name as indicator_name, a.attribution_text
    FROM indicator_attributions a
    JOIN indicators i ON a.indicator_id = i.id
    WHERE a.project_id = ?
    ORDER BY i.created_at ASC
  `);
  const rows = stmt.all(projectId) as Array<{
    indicator_id: string;
    indicator_name: string;
    attribution_text: string;
  }>;
  return rows.map((r) => ({
    indicatorId: r.indicator_id,
    indicatorName: r.indicator_name,
    attributionText: r.attribution_text,
  }));
}

/**
 * 사업별 기여 귀속 조회 함수 (#20 검수 10번, #22 연계 정본)
 * - 지표별 1행, 사업 격리
 */
export function getAttributionsForProject(
  projectId: string,
  db: Database.Database = getDatabase()
): IndicatorAttributionRecord[] {
  const stmt = db.prepare(`
    SELECT id, project_id, indicator_id, attribution_text, updated_at
    FROM indicator_attributions
    WHERE project_id = ?
    ORDER BY rowid ASC
  `);
  return stmt.all(projectId) as IndicatorAttributionRecord[];
}

// ---------------- Suggestion by ID ----------------
export function getSuggestionById(
  suggestionId: string,
  db: Database.Database = getDatabase()
): (SuggestionRecord & { evidences: EvidenceRecord[] }) | undefined {
  const stmt = db.prepare(`SELECT * FROM suggestions WHERE id = ?`);
  const suggestion = stmt.get(suggestionId) as SuggestionRecord | undefined;
  if (!suggestion) return undefined;

  const evStmt = db.prepare(`SELECT * FROM evidences WHERE suggestion_id = ?`);
  const evidences = excludeHoldoutEvidence(evStmt.all(suggestion.id) as EvidenceRecord[], db);

  return { ...suggestion, evidences };
}

// ---------------- Result ToC operations (S7, FE-12, RQ-23, D05, D26, D28) ----------------

/**
 * 확정 기록 및 제안 정보를 바탕으로 결과 ToC 표시 상태 및 판정 상태를 계산하는 순수 함수
 * (RQ-23, D05, D26, D28, NOTES-23)
 */
export function computeResultTocItemStatus(
  confirmation: Pick<ConfirmationRecord, 'confirmation_type' | 'edited_verdict_status'> | null | undefined,
  suggestion: Pick<SuggestionRecord, 'verdict_status'> | null | undefined
): {
  displayKind: ResultTocDisplayKind;
  verdictStatus: VerdictStatus | null;
} {
  if (!confirmation) {
    return {
      displayKind: '미확정',
      verdictStatus: null,
    };
  }

  if (confirmation.confirmation_type === '보완 필요') {
    return {
      displayKind: '보완 필요',
      verdictStatus: null,
    };
  }

  if (confirmation.confirmation_type === '채택 제외') {
    return {
      displayKind: '채택 제외',
      verdictStatus: null,
    };
  }

  // '확정' 또는 '수정 후 확정'
  // '수정 후 확정'의 판정 상태는 평가자가 수정한 판정이 있으면 그것, 없으면 AI 제안 판정 (#23 결정)
  const verdictStatus: VerdictStatus =
    confirmation.confirmation_type === '수정 후 확정' && confirmation.edited_verdict_status
      ? confirmation.edited_verdict_status
      : suggestion?.verdict_status ?? '미확인';
  return {
    displayKind: verdictStatus,
    verdictStatus,
  };
}

/**
 * 결과 ToC 화면(S7)에 필요한 데이터 조회 함수 (FE-12, RQ-23, RQ-26, UC-07, UC-14, UC-17)
 * - 성과 경로와 각 항목의 최신 확정 판정 매핑
 * - 확정 종류별 표시 상태(색/점선/취소선/미확정) 계산
 * - orphaned 지표(is_orphaned=1)는 "문서에서 사라진 지표"로 분리
 */
export function getResultTocData(
  projectId: string,
  db: Database.Database = getDatabase(),
  citationContext?: ProjectCitationContext
): ResultTocPageData | null {
  const project = getProject(projectId, db);
  if (!project) return null;

  const documents = listDocuments(projectId, db);
  const bannedSentences = resolveProjectCitationContext(projectId, db, citationContext).sentences;
  const pdmDoc = documents.find((d) => d.doc_type === '성과관리표' && d.is_included === 1 && isConfirmedNonPastReport(d)) ?? null;
  const hasPdm = pdmDoc !== null;

  const indicators = listIndicators(projectId, db);
  const safeText = (value: string | null | undefined) => value == null ? value : maskTextIfForbiddenSentenceOverlap(value, bannedSentences, 8);

  let warningMessage: string | null = null;
  if (!hasPdm) {
    const reasonDocument = pdmReasonDocument(documents);
    warningMessage = exclusionReasonForDocument({ kind: 'pdm', document: reasonDocument && {
      ...reasonDocument,
      file_name: maskTextIfForbiddenSentenceOverlap(reasonDocument.file_name, bannedSentences, 8),
    } });
  } else if (indicators.length === 0) {
    warningMessage = '성과관리표에서 지표를 찾지 못했습니다';
  }

  let totalConfirmedCount = 0;

  const items: ResultTocItem[] = indicators.map((ind) => {
    const latestConf = getLatestConfirmation(ind.id, db) ?? null;
    let sugg: SuggestionRecord | null = null;
    if (latestConf?.suggestion_id) {
      sugg = getSuggestionById(latestConf.suggestion_id, db) ?? null;
    }
    if (!sugg && !latestConf) {
      sugg = getLatestSuggestion(ind.id, db) ?? null;
    }

    if (latestConf !== null) {
      totalConfirmedCount++;
    }

    const { displayKind, verdictStatus } = computeResultTocItemStatus(latestConf, sugg);
    const isOrphaned = Boolean(ind.is_orphaned);

    return {
      indicator: {
        ...ind,
        name: safeText(ind.name)!,
        ovi: safeText(ind.ovi)!,
        target_value: ind.target_value === null ? null : safeText(ind.target_value)!,
        is_orphaned: isOrphaned ? 1 : 0,
      },
      latestConfirmation: latestConf ? {
        ...latestConf,
        initial_proposal: safeText(latestConf.initial_proposal),
        edited_text: safeText(latestConf.edited_text),
        reason: safeText(latestConf.reason),
        confirmer_name: safeText(latestConf.confirmer_name)!,
      } : null,
      latestSuggestion: sugg ? { ...sugg, proposal_text: safeText(sugg.proposal_text)! } : null,
      displayKind,
      verdictStatus,
      isOrphaned,
    };
  });

  const activeItems = items.filter((item) => !item.isOrphaned);
  const orphanedItems = items.filter((item) => item.isOrphaned);

  const confirmedNoteCount = getConfirmedNoteCount(projectId, db);
  return {
    project,
    items,
    activeItems,
    orphanedItems,
    totalConfirmedCount,
    indicatorConfirmedCount: items.filter(item => item.latestConfirmation && ['확정', '수정 후 확정'].includes(item.latestConfirmation.confirmation_type)).length,
    hasAnyConfirmation: totalConfirmedCount > 0,
    hasPdm,
    warningMessage,
    noteConfirmedCount: confirmedNoteCount,
  };
}

// ---------------- Report operations (FE-11) ----------------
export function saveReportDraft(
  projectId: string,
  contentJson: string,
  db: Database.Database = getDatabase()
): ReportRecord {
  const id = 'rep-' + crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO reports (id, project_id, content_json, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, projectId, contentJson, createdAt);

  return {
    id,
    project_id: projectId,
    content_json: contentJson,
    created_at: createdAt,
  };
}

export function getLatestReportDraft(
  projectId: string,
  db: Database.Database = getDatabase()
): ReportRecord | undefined {
  const stmt = db.prepare(`
    SELECT * FROM reports
    WHERE project_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `);
  return stmt.get(projectId) as ReportRecord | undefined;
}

/** Project-scoped lookup used when a person selects a saved report version. */
export function getReportDraftById(projectId: string, reportId: string, db: Database.Database = getDatabase()): ReportRecord | undefined {
  return db.prepare('SELECT * FROM reports WHERE project_id = ? AND id = ?').get(projectId, reportId) as ReportRecord | undefined;
}

export interface ReportDraftListRecord {
  id: string;
  created_at: string;
  draft_number: number | null;
  is_finalized: number;
  finalized_at: string | null;
  finalized_role: string | null;
}

/** Return only version metadata; never transfer saved report bodies for a selector. */
export function listReportDraftRecords(projectId: string, db: Database.Database = getDatabase()): ReportDraftListRecord[] {
  return db.prepare(`SELECT id, created_at,
      CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.draft_number') ELSE NULL END AS draft_number,
      CASE WHEN json_valid(content_json) AND json_type(content_json, '$.report_finalization') IS NOT NULL THEN 1 ELSE 0 END AS is_finalized,
      CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.report_finalization.confirmed_at') ELSE NULL END AS finalized_at,
      CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.report_finalization.role') ELSE NULL END AS finalized_role
    FROM reports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId) as ReportDraftListRecord[];
}

// ---------------- Outcome Final Results (S2, S8, S10) ----------------
export class EvidenceQuoteCacheNotReady extends Error {
  constructor() {
    super('근거 확인을 준비 중입니다.');
    this.name = 'EvidenceQuoteCacheNotReady';
  }
}

export function getOutcomeFinalResults(
  projectId: string,
  db: Database.Database = getDatabase()
): OutcomeFinalResultsData {
  const rows = db.prepare(`
    SELECT
      i.id AS indicator_id,
      i.name AS indicator_name,
      i.level,
      i.ovi,
      i.mov,
      i.target_value,
      i.is_orphaned,
      i.source_doc_id,
      c.id AS confirmation_id,
      c.confirmation_type,
      c.initial_proposal,
      c.edited_text,
      c.edited_verdict_status,
      c.confirmer_name,
      c.created_at AS confirmed_at,
      s.id AS suggestion_id,
      s.verdict_status AS suggestion_verdict_status,
      s.proposal_text AS suggestion_proposal_text,
      (SELECT b.target_value FROM indicator_baselines b WHERE b.indicator_id = i.id ORDER BY b.selected_at DESC, b.rowid DESC LIMIT 1) AS baseline_value
    FROM indicators i
    LEFT JOIN confirmations c ON c.indicator_id = i.id AND c.id = (
      SELECT c2.id FROM confirmations c2
      WHERE c2.indicator_id = i.id
      ORDER BY c2.created_at DESC, c2.rowid DESC
      LIMIT 1
    )
    LEFT JOIN suggestions s ON s.id = COALESCE(c.suggestion_id, CASE WHEN c.id IS NULL THEN (
      SELECT s2.id FROM suggestions s2
      WHERE s2.indicator_id = i.id
      ORDER BY s2.created_at DESC, s2.rowid DESC
      LIMIT 1
    ) END)
    WHERE i.project_id = ?
    ORDER BY i.sort_order ASC, i.created_at ASC, i.rowid ASC
  `).all(projectId) as Array<{
    indicator_id: string;
    indicator_name: string;
    level: string;
    ovi: string | null;
    mov: string | null;
    target_value: string | null;
    is_orphaned: number;
    source_doc_id: string | null;
    confirmation_id: string | null;
    confirmation_type: '확정' | '수정 후 확정' | '보완 필요' | '채택 제외' | null;
    initial_proposal: string | null;
    edited_text: string | null;
    edited_verdict_status: VerdictStatus | null;
    confirmer_name: string | null;
    confirmed_at: string | null;
    suggestion_id: string | null;
    suggestion_verdict_status: VerdictStatus | null;
    suggestion_proposal_text: string | null;
    baseline_value: string | null;
  }>;

  const bannedSentences = getBannedSentencesByProject(projectId, db).map((sentence) => sentence.content);
  const safeText = (value: string) => maskTextIfForbiddenSentenceOverlap(value, bannedSentences, 8);
  // 보고서와 같은 문단 대조의 저장 결과를 읽는다.
  const evidences = excludeHoldoutEvidence(db.prepare(`
    SELECT e.*, i.id AS indicator_id, d.is_included, cache.verified AS quote_verified
    FROM indicators i
    JOIN confirmations c ON c.id = (
      SELECT c2.id FROM confirmations c2 WHERE c2.indicator_id = i.id
      ORDER BY c2.created_at DESC, c2.rowid DESC LIMIT 1
    )
    JOIN evidences e ON e.suggestion_id = c.suggestion_id
    JOIN documents d ON d.id = e.document_id AND d.project_id = i.project_id
    LEFT JOIN evidence_quote_verification_cache cache ON cache.project_id = i.project_id AND cache.evidence_id = e.id AND cache.algorithm_version = 1
    WHERE i.project_id = ? AND c.confirmation_type IN ('확정', '수정 후 확정')
  `).all(projectId) as Array<EvidenceRecord & { indicator_id: string; is_included: number; quote_verified: number | null }>, db);
  const documents = new Map(listDocuments(projectId, db).map((document) => [document.id, document]));
  const evidenceDocuments = new Map<string, string[]>();
  for (const evidence of evidences) {
    const ids = evidenceDocuments.get(evidence.indicator_id) ?? [];
    ids.push(evidence.document_id);
    evidenceDocuments.set(evidence.indicator_id, ids);
  }
  const citableCounts = new Map<string, number>();
  for (const evidence of evidences) {
    if (evidence.is_included !== 1 || evidence.is_citation_banned === 1) continue;
    if (evidence.quote_verified == null) throw new EvidenceQuoteCacheNotReady();
    if (evidence.quote_verified === 1) {
      citableCounts.set(evidence.indicator_id, (citableCounts.get(evidence.indicator_id) ?? 0) + 1);
    }
  }

  const STAGE_ORDER: Array<{ key: OutcomeStageKey; label: OutcomeStageLabel }> = [
    { key: 'activity', label: '활동' },
    { key: 'output', label: '산출물' },
    { key: 'outcome-short', label: '단기' },
    { key: 'outcome-mid', label: '중장기' },
    { key: 'impact', label: '영향' },
  ];

  const mapLevelToStage = (level: string): { key: OutcomeStageKey; label: OutcomeStageLabel } => {
    switch (level) {
      case '활동':
        return { key: 'activity', label: '활동' };
      case '산출':
      case '산출물':
        return { key: 'output', label: '산출물' };
      case '단기':
      case '단기성과':
        return { key: 'outcome-short', label: '단기' };
      case '중기':
      case '중기성과':
      case '중장기':
      case '중장기성과':
      case '중·장기성과':
      case '중/장기성과':
        return { key: 'outcome-mid', label: '중장기' };
      case '영향':
      default:
        return { key: 'impact', label: '영향' };
    }
  };

  const resultsByStage = new Map<OutcomeStageKey, OutcomeIndicatorFinalResult[]>();
  for (const { key } of STAGE_ORDER) {
    resultsByStage.set(key, []);
  }

  let confirmedCount = 0;

  for (const row of rows) {
    const stage = mapLevelToStage(row.level);
    const isConfirmed = row.confirmation_type === '확정' || row.confirmation_type === '수정 후 확정';
    if (isConfirmed) confirmedCount++;

    const targetValue = safeText(row.target_value ?? row.ovi ?? 'PDM에 없음');
    const baselineValue = safeText(row.baseline_value || 'PDM에 없음');

    // 보고서 달성표는 목표값 전체를 표시하고 단위를 별도 추출하지 않는다.
    // 단위 열에서는 숫자 뒤의 배율까지 유지하며 목표값이 없으면 보고서와 같이 ovi를 쓴다.
    const rawTarget = row.target_value ?? row.ovi ?? '';
    const unitMatch = rawTarget.match(/(?:\d[\d,.]*\s*)?((?:억|천만|백만|십만|만|천|백)?(?:명|건|개|회|점|식|원|개월|년|일)|%)/);
    const unit = safeText(unitMatch?.[1] ?? 'PDM에 없음');
    const confirmation = row.confirmation_type ? {
      confirmation_type: row.confirmation_type,
      edited_verdict_status: row.edited_verdict_status,
    } : null;
    const suggestion = row.suggestion_verdict_status ? { verdict_status: row.suggestion_verdict_status } : null;
    const { displayKind, verdictStatus } = computeResultTocItemStatus(confirmation, suggestion);
    const reportIncluded = isReportTargetDocumentIncluded(row.source_doc_id, evidenceDocuments.get(row.indicator_id) ?? [], documents);
    const statusDisplay = isConfirmed && !reportIncluded ? '근거 미확인' : displayKind === '미확정' ? '검토 중' : displayKind === '미확인' ? '근거 미확인' : displayKind;
    const actualValue = isConfirmed && !reportIncluded ? '—' : isConfirmed
      ? safeText((row.confirmation_type === '수정 후 확정' && row.edited_text) || row.initial_proposal || row.suggestion_proposal_text || '')
      : confirmation ? '—' : '검토 중';
    const evidenceCount = isConfirmed && row.suggestion_id ? citableCounts.get(row.indicator_id) ?? 0 : 0;

    const item: OutcomeIndicatorFinalResult = {
      indicator_id: row.indicator_id,
      indicator_name: safeText(row.indicator_name),
      level: safeText(row.level),
      stage_key: stage.key,
      stage_label: stage.label,
      target_value: targetValue,
      baseline_value: baselineValue,
      unit,
      is_confirmed: isConfirmed,
      confirmation_type: (row.confirmation_type === '확정' || row.confirmation_type === '수정 후 확정') ? row.confirmation_type : null,
      actual_value: actualValue,
      verdict_status: verdictStatus,
      status_display: statusDisplay,
      evidence_count: evidenceCount,
      is_orphaned: Boolean(row.is_orphaned),
      review_href: `/projects/${encodeURIComponent(projectId)}/review?indicatorId=${encodeURIComponent(row.indicator_id)}`,
      report_href: `/projects/${encodeURIComponent(projectId)}/report#achievement-row-${encodeURIComponent(row.indicator_id)}`,
    };

    resultsByStage.get(stage.key)!.push(item);
  }

  const stages: OutcomeStageRow[] = STAGE_ORDER.map(({ key, label }) => ({
    stage_key: key,
    stage_label: label,
    indicators: resultsByStage.get(key) ?? [],
  }));

  return {
    projectId,
    stages,
    hasConfirmedResults: confirmedCount > 0,
    totalIndicators: rows.length,
    confirmedCount,
  };
}
