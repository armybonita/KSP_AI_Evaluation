// Synthetic database benchmark. Only use a disposable copy under TMPDIR.
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { openDatabase, listProjectsWithCount, getOutcomeFinalResults } from './db';
import TocPage from '../../app/projects/[projectId]/toc/page';

async function main() {
const [mode, path] = process.argv.slice(2);
if (!process.env.TMPDIR || !path?.startsWith(`${process.env.TMPDIR}/`)) throw new Error('Use a disposable database under TMPDIR');
if (mode === 'seed') {
  const db = new Database(path, { fileMustExist: true });
  const project = db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)');
  const doc = db.prepare('INSERT INTO documents(id,project_id,file_name,file_type,status,doc_type,is_included,created_at) VALUES (?,?,?,?,?,?,?,?)');
  // Duplicate the complete synthetic project, including its historical graph,
  // documents, paragraphs, reviews and indicator evidence, inside this copy.
  // Node and source IDs are project-scoped; globally unique IDs and foreign keys
  // receive the same suffix. The source database is never opened by this script.
  const projectTables = [
    'documents', 'indicators', 'indicator_conflicts', 'indicator_baselines',
    'indicator_attributions', 'reports', 'ontology_imports', 'ontology_generation_runs',
    'ontology_nodes', 'ontology_edges', 'ontology_sources', 'ontology_snippets',
    'ontology_relation_candidates', 'ontology_review_node_keys', 'ontology_graph_migration_receipts',
    'ontology_review_node_aliases', 'ontology_review_node_titles', 'ontology_link_reviews',
    'ontology_review_evidence_keys', 'ontology_note_reviews', 'ontology_portfolio_level_reviews', 'ontology_check_issues',
    'ontology_quote_verification_cache', 'ontology_quote_verification_cache_v2',
    'ontology_review_evidence_backfills',
  ];
  const globalIds = new Set(['documents', 'indicators', 'indicator_conflicts', 'indicator_baselines',
    'indicator_attributions', 'reports', 'ontology_imports', 'ontology_generation_runs',
    'ontology_link_reviews', 'ontology_note_reviews', 'ontology_portfolio_level_reviews', 'paragraphs', 'sentences', 'suggestions',
    'evidences', 'confirmations']);
  const references: Record<string, string[]> = {
    indicators: ['parent_id', 'source_doc_id'],
    indicator_conflicts: ['indicator_id', 'doc_a_id', 'doc_b_id'],
    indicator_baselines: ['indicator_id', 'document_id', 'conflict_id', 'other_doc_id'],
    indicator_attributions: ['indicator_id'], paragraphs: ['document_id'],
    sentences: ['document_id', 'paragraph_id'], suggestions: ['indicator_id'],
    evidences: ['suggestion_id', 'document_id'], confirmations: ['indicator_id', 'suggestion_id'],
    ontology_link_review_details: ['review_id'],
  };
  const cloneRows = (table: string, where: string, suffix: string) => {
    const columns = (db.pragma(`table_info(${table})`) as Array<{name: string}>).map((column) => column.name);
    const selections = columns.map((column) => {
      if (column === 'project_id') return '?';
      if (column === 'import_id' || (column === 'id' && globalIds.has(table)) || references[table]?.includes(column)) return `"${column}" || ?`;
      return `"${column}"`;
    });
    const params = columns.flatMap((column) => column === 'project_id' ? [`project-${suffix}`]
      : column === 'import_id' || (column === 'id' && globalIds.has(table)) || references[table]?.includes(column) ? [`-large-${suffix}`] : []);
    db.prepare(`INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(',')}) SELECT ${selections.join(',')} FROM ${table} WHERE ${where}`).run(...params);
  };
  db.transaction(() => {
    for (const suffix of ['1', '2']) {
      project.run(`project-${suffix}`, `대형 가상 사업 ${suffix}`, '2025-01-01');
      // Project-scoped rows are cloned first, followed by their dependent rows.
      for (const table of projectTables) cloneRows(table, "project_id='project-0'", suffix);
      cloneRows('paragraphs', "document_id IN (SELECT id FROM documents WHERE project_id='project-0')", suffix);
      cloneRows('sentences', "document_id IN (SELECT id FROM documents WHERE project_id='project-0')", suffix);
      cloneRows('suggestions', "indicator_id IN (SELECT id FROM indicators WHERE project_id='project-0')", suffix);
      cloneRows('evidences', "suggestion_id IN (SELECT s.id FROM suggestions s JOIN indicators i ON i.id=s.indicator_id WHERE i.project_id='project-0')", suffix);
      cloneRows('confirmations', "indicator_id IN (SELECT id FROM indicators WHERE project_id='project-0')", suffix);
      cloneRows('ontology_link_review_details', "review_id IN (SELECT id FROM ontology_link_reviews WHERE project_id='project-0')", suffix);
    }
  })();
  db.transaction(() => {
    for (let p = 0; p < 20; p++) {
      const projectId = `project-${p}`;
      if (p > 2) project.run(projectId, `가상 사업 ${p}`, '2025-01-01');
      const existing = p <= 2 ? 45 : 0;
      for (let i = existing; i < 400; i++) {
        const kind = i % 10 === 0 ? '성과관리표' : i % 10 === 1 ? '국문 PCP' : '사업계획서';
        doc.run(`benchmark-${projectId}-doc-${i}`, projectId, `가상 문서 ${i}`, 'txt', '추출 완료', kind, 1, '2025-01-01');
      }
      if (p > 2) {
        // Small additional reviewed projects accompany the three large projects.
        const importId = `benchmark-import-${p}`;
        db.prepare(`INSERT INTO ontology_imports(id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor) VALUES (?, ?, 'fake', '2030-01-01', 100, 0, 0, 0, 0, 0, 'benchmark')`).run(importId, projectId);
        for (let n = 0; n < 100; n++) {
          const id = `node-${n}`;
          db.prepare(`INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,'indicator','가상 노트','{}')`).run(id,projectId,importId);
          db.prepare(`INSERT INTO ontology_review_node_keys(project_id,import_id,node_id,node_type) VALUES (?,?,?,'indicator')`).run(projectId,importId,id);
          db.prepare(`INSERT INTO ontology_note_reviews(id,project_id,import_id,node_id,status,text,original_text,outcome_state,reason,error_type,reviewer,created_at) VALUES (?,?,?,?,'확정','가상','가상','미확인','','','담당','2030-01-01')`).run(`review-${p}-${n}`,projectId,importId,id);
          db.prepare(`INSERT INTO paragraphs(id,document_id,sequence_no,location,content) SELECT ?,?,sequence_no,location,content FROM paragraphs WHERE id = (SELECT id FROM paragraphs WHERE document_id IN (SELECT id FROM documents WHERE project_id='project-0') ORDER BY rowid LIMIT 1 OFFSET ?)`).run(`paragraph-${p}-${n}`,`benchmark-${projectId}-doc-${n}`,n);
        }
      }
    }
  })();
  db.close();
} else if (mode === 'measure') {
  process.env.AIEAS_DB_PATH = path;
  process.env.AIEAS_AUTH_MODE = 'local';
  const db = openDatabase(path);
  for (const table of ['projects', 'documents', 'indicators', 'paragraphs', 'ontology_nodes', 'ontology_snippets', 'ontology_note_reviews']) {
    console.log(`${table}:`, db.prepare(`SELECT count(*) AS n FROM ${table}`).get());
  }
  console.log('documents per project:', db.prepare('SELECT project_id, count(*) AS n FROM documents GROUP BY project_id').all());
  console.log('large project sizes:', db.prepare(`SELECT p.id,
    (SELECT count(*) FROM documents d WHERE d.project_id=p.id) AS documents,
    (SELECT count(*) FROM ontology_nodes n WHERE n.project_id=p.id) AS nodes,
    (SELECT count(*) FROM ontology_note_reviews r WHERE r.project_id=p.id) AS reviews,
    (SELECT count(*) FROM paragraphs q JOIN documents d ON d.id=q.document_id WHERE d.project_id=p.id) AS paragraphs,
    (SELECT sum(length(q.content)) FROM paragraphs q JOIN documents d ON d.id=q.document_id WHERE d.project_id=p.id) AS characters
    FROM projects p WHERE p.id IN ('project-0', 'project-1', 'project-2') ORDER BY p.id`).all());
  console.log('paragraph characters:', db.prepare('SELECT sum(length(content)) AS n FROM paragraphs').get());
  console.log('projects with documents, paragraphs and reviews:', db.prepare(`SELECT count(*) AS n FROM projects p WHERE EXISTS (SELECT 1 FROM documents d JOIN paragraphs q ON q.document_id=d.id WHERE d.project_id=p.id) AND EXISTS (SELECT 1 FROM ontology_note_reviews r WHERE r.project_id=p.id)`).get());
  const source = readFileSync('src/server/store/db.ts', 'utf8');
  const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const list = section('export function listProjectsWithCount(', '// ---------------- Document operations');
  const outcome = section('export function getOutcomeFinalResults(', '  const STAGE_ORDER:');
  for (const [label, sql] of [
    ['project-list', list.match(/const stmt = db\.prepare\(`([\s\S]*?)`\)/)?.[1]],
    ['key-documents', list.match(/const keyDocs = db\.prepare\(`([\s\S]*?)`\)/)?.[1]],
    ['outcome', outcome.match(/db\.prepare\(`([\s\S]*?)`\)/)?.[1]],
  ] as const) {
    if (!sql) throw new Error(`Cannot locate ${label} query`);
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    console.log(`PLAN ${label}`, label === 'outcome' ? stmt.all('project-0') : stmt.all());
  }
  for (let n = 1; n <= 2; n++) {
    for (const [label, fn] of [
      ['listProjectsWithCount', () => listProjectsWithCount(db)],
      ['getOutcomeFinalResults', () => getOutcomeFinalResults('project-0', db)],
      ['TocPage', () => TocPage({ params: Promise.resolve({ projectId: 'project-0' }) })],
    ] as const) {
      const start = performance.now();
      await fn();
      console.log(`${label} ${n}: ${(performance.now() - start).toFixed(2)} ms`);
    }
  }
  db.close();
} else throw new Error('Use seed or measure');

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
