/** Synthetic-only startup benchmark. Run with TMPDIR set to a private scratch directory.
 * npx tsx scripts/benchmark-db-startup.ts seed|backfill|sql|open|list <database>
 * Each action can be timed independently under an external 60-second timeout.
 * Set BENCHMARK_ASSERT=1 for generous first/reopen/list regression limits.
 * Run list against the database after open so review snapshots are present.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { CREATE_TABLES_SQL } from './schema';
import { backfillReviewEvidenceKeys } from './review-evidence-keys';
import { closeDatabase, listProjectsWithCount, openDatabase } from './db';

const [mode, path] = process.argv.slice(2);
if (!process.env.TMPDIR || !path || !path.startsWith(`${process.env.TMPDIR}/`)) throw new Error('Set TMPDIR and supply a database path beneath it');
const time = <T>(label: string, f: () => T): T => {
  const start = performance.now();
  const result = f();
  const seconds = (performance.now() - start) / 1000;
  console.log(`${label}: ${seconds.toFixed(3)}s`);
  // Generous automated limits allow slower CI machines; target PC limits are
  // 10s, 1s and 0.5s respectively and are reported as measured values.
  const limits: Record<string, number> = { 'first-open': 20, 'second-open': 3, 'list-projects': 2 };
  if (process.env.BENCHMARK_ASSERT === '1' && limits[label]) assert.ok(seconds <= limits[label], `${label} exceeded ${limits[label]}s`);
  return result;
};
if (mode === 'seed') {
  if (existsSync(path)) throw new Error('Refusing to overwrite existing database');
  const db = new Database(path);
  db.exec(CREATE_TABLES_SQL);
  const p = db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)');
  const d = db.prepare('INSERT INTO documents(id,project_id,file_name,file_type,status,doc_type,is_included,created_at) VALUES (?,?,?,?,?,?,?,?)');
  const para = db.prepare('INSERT INTO paragraphs(id,document_id,sequence_no,location,content) VALUES (?,?,?,?,?)');
  const i = db.prepare('INSERT INTO indicators(id,project_id,level,name,ovi,created_at) VALUES (?,?,?,?,?,?)');
  const sug = db.prepare('INSERT INTO suggestions(id,indicator_id,verdict_status,created_at) VALUES (?,?,?,?)');
  const conf = db.prepare('INSERT INTO confirmations(id,indicator_id,suggestion_id,confirmation_type,confirmer_name,created_at) VALUES (?,?,?,?,?,?)');
  const imp = db.prepare('INSERT INTO ontology_imports(id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor,source_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const node = db.prepare('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,?,?,?)');
  const source = db.prepare('INSERT INTO ontology_sources(id,project_id,import_id,data_json) VALUES (?,?,?,?)');
  const snippet = db.prepare('INSERT INTO ontology_snippets(id,project_id,import_id,data_json) VALUES (?,?,?,?)');
  const review = db.prepare('INSERT INTO ontology_note_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const key = db.prepare('INSERT INTO ontology_review_node_keys VALUES (?,?,?,?)');
  const alias = db.prepare('INSERT INTO ontology_review_node_aliases VALUES (?,?,?,?)');
  const edge = db.prepare('INSERT INTO ontology_edges(id,project_id,import_id,source_id,target_id,relation_field) VALUES (?,?,?,?,?,?)');
  time('seed', () => db.transaction(() => {
    for (let a = 0; a < 8; a++) {
      const project = `project-${a}`; p.run(project, `가상 사업 ${a}`, '2026-01-01');
      for (let j = 0; j < 50; j++) {
        const doc = `${project}-doc-${j}`; d.run(doc, project, '가상 문서', 'txt', '추출 완료', j % 2 ? '국문 PCP' : '성과관리표', 1, '2026-01-01');
        for (let k = 0; k < 100; k++) para.run(`${doc}-paragraph-${k}`, doc, k, `쪽 ${k}`, '가상 문단 '.repeat(30));
      }
      for (let j = 0; j < 40; j++) {
        const indicator = `${project}-indicator-${j}`; i.run(indicator, project, '산출', '가상 지표', '가상 값', '2026-01-01');
        for (let k = 0; k < 4; k++) {
          const s = `${indicator}-suggestion-${k}`; sug.run(s, indicator, '미확인', `2026-01-0${k+1}`);
          for (let l = 0; l < 2; l++) conf.run(`${s}-confirmation-${l}`, indicator, s, l ? '보완 필요' : '확정', '가상 평가자', `2026-01-0${l+1}`);
        }
      }
      for (let b = 0; b < 3; b++) {
        const run = `${project}-import-${b}`;
        imp.run(run, project, '가상', `2026-01-0${b+1}`, 2000, 500, 50, 3000, 0, 0, '가상', 'generated');
        for (let j = 0; j < 2000; j++) node.run(`node-${j}`, project, run, j % 2 ? 'indicator' : 'output', `가상 점 ${j}`, JSON.stringify({ evidence: [`snippet-${j}`] }));
        for (let j = 0; j < 3000; j++) snippet.run(`snippet-${j}`, project, run, JSON.stringify({source:`source-${j%50}`,locator:`쪽 ${j}`,quote:`가상 근거 ${j}`,proves:[`node-${j%2000}`]}));
        for (let j = 0; j < 50; j++) {
          const metadata: Record<string, unknown> = {};
          for (let k = j; k < 3000; k += 50) metadata[`snippet-${k}`] = {supports:[`node-${k%2000}`]};
          source.run(`source-${j}`, project, run, JSON.stringify({title:`가상 출처 ${j}`,evidence_metadata:metadata}));
        }
        for (let j = 0; j < 500; j++) edge.run(`edge-${j}`, project, run, `node-${j}`, `node-${j+1}`, 'targets');
      }
      for (let j = 0; j < 12; j++) {
        const run = `${project}-import-0`;
        const id = `node-${j}`;
        key.run(project, run, id, j % 2 ? 'indicator' : 'output');
        review.run(`${project}-review-${j}`, project, run, id, j % 2 ? '확정' : '보완 필요', '가상 검토', '가상 노트', '관측됨', '', '', '가상 평가자', '2026-01-01');
        if (j < 4) alias.run(project, run, id, id);
      }
    }
  })());
  db.close();
} else if (mode === 'backfill') {
  const db = new Database(path); time('evidence-backfill', () => backfillReviewEvidenceKeys(db)); db.close();
} else if (mode === 'sql') {
  const db = new Database(path);
  time('node-keys', () => db.exec('INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type) SELECT project_id, import_id, id, node_type FROM ontology_nodes'));
  time('review-node-keys', () => db.exec(`INSERT OR IGNORE INTO ontology_review_node_keys (project_id, import_id, node_id, node_type)
    SELECT refs.project_id, refs.import_id, refs.node_id,
      COALESCE((SELECT CASE WHEN COUNT(DISTINCT k.node_type) = 1 THEN MIN(k.node_type) END FROM ontology_review_node_keys k WHERE k.project_id = refs.project_id AND k.node_id = refs.node_id AND k.node_type != '종류 불명'), '종류 불명')
    FROM (SELECT project_id, import_id, node_id FROM ontology_note_reviews UNION SELECT project_id, import_id, source_id FROM ontology_link_reviews UNION SELECT project_id, import_id, target_id FROM ontology_link_reviews) refs`));
  time('relation-candidates', () => db.exec("INSERT OR IGNORE INTO ontology_relation_candidates SELECT e.project_id, e.import_id, e.source_id, e.target_id, e.relation_field FROM ontology_edges e JOIN ontology_imports i ON i.id = e.import_id WHERE i.source_kind = 'generated' AND e.relation_field IN ('extends_to', 'targets')"));
  db.close();
} else if (mode === 'open') {
  time('first-open', () => openDatabase(path)); closeDatabase();
  time('second-open', () => openDatabase(path)); closeDatabase();
} else if (mode === 'list') {
  const db = new Database(path); time('list-projects', () => listProjectsWithCount(db)); db.close();
} else throw new Error('Unknown mode');
