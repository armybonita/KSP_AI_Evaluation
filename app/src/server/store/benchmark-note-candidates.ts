/** Worst-shaped synthetic rename candidates: every historical review shares a source with every current node. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { CREATE_TABLES_SQL } from './schema';
import { getNoteReviewData } from './note-review';
const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 1) throw new Error('positive candidate count required');
const db = new Database(':memory:');
db.exec(CREATE_TABLES_SQL);
const stamp = '2026-01-01';
db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)').run('project-0', '가상 사업', stamp);
const imp = db.prepare('INSERT INTO ontology_imports(id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor,source_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
imp.run('old', 'project-0', '가상', '2026-01-01', count, 0, 1, 0, 0, 0, '가상', 'vault');
imp.run('new', 'project-0', '가상', '2026-01-02', count, 0, 1, 0, 0, 0, '가상', 'vault');
const node = db.prepare('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,?,?,?)');
const key = db.prepare('INSERT INTO ontology_review_node_keys VALUES (?,?,?,?)');
const review = db.prepare('INSERT INTO ontology_note_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const title = db.prepare('INSERT INTO ontology_review_node_titles VALUES (?,?,?,?)');
const evidence = db.prepare('INSERT INTO ontology_review_evidence_keys VALUES (?,?,?,?,?,?)');
db.transaction(() => {
  for (let i = 0; i < count; i++) {
    const old = `old-${i}`, current = `current-${i}`;
    const oldTitle = `가상 성과 개선 방안에 관한 분석과 검토 가상 성과 개선 방안에 관한 자료 ${i}`;
    const newTitle = `가상 성과 개선 방안에 관한 분석과 검토 가상 성과 개선 방안에 관한 내용 ${i}`;
    node.run(old, 'project-0', 'old', 'output', oldTitle, '{}');
    node.run(current, 'project-0', 'new', 'output', newTitle, '{}');
    key.run('project-0', 'old', old, 'output');
    key.run('project-0', 'new', current, 'output');
    title.run('project-0', 'old', old, oldTitle);
    review.run(`review-${i}`, 'project-0', 'old', old, '확정', '가상 검토', oldTitle, '관측됨', '', '', '가상 평가자', stamp);
    evidence.run('project-0', 'old', old, 'shared-source', '같은 위치', '같은 가상 근거');
    evidence.run('project-0', 'new', current, 'shared-source', '같은 위치', '같은 가상 근거');
  }
})();
for (let i = 0; i < 2; i++) {
  const start = performance.now();
  const result = getNoteReviewData('project-0', db);
  const seconds = (performance.now() - start) / 1000;
  const matches = result.items.reduce((sum, item) => sum + (item.renamedHistory?.length ?? 0), 0);
  assert.equal(matches, count * count);
  console.log(JSON.stringify({ count, candidatePairs: count * count, matches, iteration: i + 1, seconds: Number(seconds.toFixed(3)) }));
}
db.close();
