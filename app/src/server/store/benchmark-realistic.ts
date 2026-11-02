/** Synthetic project at A or B scale. Never reads actual project data. */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { CREATE_TABLES_SQL } from './schema';
import { addFixtureBranches } from './benchmark-fixture-branches';
import { addRiskBranches } from './benchmark-risk-branches';

const [path, size = 'A'] = process.argv.slice(2);
if (!path || !process.env.TMPDIR || !path.startsWith(`${process.env.TMPDIR}/`) || existsSync(path)) throw new Error('new database under TMPDIR required');
if (size !== 'A' && size !== 'B') throw new Error('size must be A or B');
const scale = size === 'A' ? { nodes: 2775, edges: 4420, snippets: 6804, paragraphChars: 550000 } : { nodes: 9837, edges: 17642, snippets: 25423, paragraphChars: 5130000 };
const db = new Database(path);
db.exec(CREATE_TABLES_SQL);
const insert = (sql: string) => db.prepare(sql);
const p = insert('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)');
const d = insert('INSERT INTO documents(id,project_id,file_name,file_type,status,doc_type,is_included,created_at) VALUES (?,?,?,?,?,?,?,?)');
const para = insert('INSERT INTO paragraphs(id,document_id,sequence_no,location,content) VALUES (?,?,?,?,?)');
const indicator = insert('INSERT INTO indicators(id,project_id,level,name,ovi,created_at) VALUES (?,?,?,?,?,?)');
const suggestion = insert('INSERT INTO suggestions(id,indicator_id,verdict_status,created_at) VALUES (?,?,?,?)');
const confirmation = insert('INSERT INTO confirmations(id,indicator_id,suggestion_id,confirmation_type,confirmer_name,created_at) VALUES (?,?,?,?,?,?)');
const evidence = insert('INSERT INTO evidences(id,suggestion_id,quote,document_id,location,speaker,is_citation_banned) VALUES (?,?,?,?,?,?,?)');
const banned = insert('INSERT INTO sentences(id,document_id,paragraph_id,sequence_no,location,content,is_citation_banned) VALUES (?,?,?,?,?,?,1)');
const imp = insert('INSERT INTO ontology_imports(id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor,source_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const node = insert('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,?,?,?)');
const snippet = insert('INSERT INTO ontology_snippets(id,project_id,import_id,data_json) VALUES (?,?,?,?)');
const source = insert('INSERT INTO ontology_sources(id,project_id,import_id,data_json) VALUES (?,?,?,?)');
const edge = insert('INSERT INTO ontology_edges(id,project_id,import_id,source_id,target_id,relation_field) VALUES (?,?,?,?,?,?)');
const key = insert('INSERT INTO ontology_review_node_keys VALUES (?,?,?,?)');
const history = insert('INSERT INTO ontology_note_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const alias = insert('INSERT INTO ontology_review_node_aliases VALUES (?,?,?,?)');
const evidenceKey = insert('INSERT INTO ontology_review_evidence_keys VALUES (?,?,?,?,?,?)');
const link = insert('INSERT INTO ontology_link_reviews VALUES (?,?,?,?,?,?,?,?)');
const detail = insert('INSERT INTO ontology_link_review_details VALUES (?,?,?,?)');
const stamp = '2026-01-01';
const bannedText = (index: number) => `가상 금지 ${String.fromCharCode(0xac00 + index).repeat(12)} 문장`;
db.transaction(() => {
  p.run('project-0', '가상 사업', stamp);
  const docs = 45, paragraphsPerDoc = 100;
  const text = '가상 문단 자료 '.repeat(Math.ceil(scale.paragraphChars / (docs * paragraphsPerDoc * 8))).slice(0, Math.ceil(scale.paragraphChars / (docs * paragraphsPerDoc)));
  for (let j = 0; j < docs; j++) {
    const doc = `project-0-doc-${j}`;
    d.run(doc, 'project-0', '가상 문서', 'txt', '추출 완료', j === 0 ? '성과관리표' : '사업계획서', 1, stamp);
    for (let k = 0; k < paragraphsPerDoc; k++) para.run(`${doc}-paragraph-${k}`, doc, k, `쪽 ${k}`, k === 0 ? `${bannedText(j)} ${text}` : text);
    banned.run(`banned-${j}`, doc, `${doc}-paragraph-0`, 0, '쪽 0', bannedText(j));
  }
  for (let j = 0; j < 14; j++) {
    const id = `indicator-${j}`, s = `suggestion-${j}`;
    indicator.run(id, 'project-0', '산출', `고유지표 ${j}`, `고유지표 ${j}`, stamp);
    suggestion.run(s, id, '실현', stamp);
    confirmation.run(`confirmation-${j}`, id, s, '확정', '가상 평가자', stamp);
    for (let k = j; k < scale.snippets; k += 14) evidence.run(`evidence-${k}`, s, k % 100 === 0 ? bannedText(k % docs) : '가상 문단 자료', `project-0-doc-${k % docs}`, `쪽 ${k % paragraphsPerDoc}`, '가상 화자', k % 1000 === 0 ? 1 : 0);
  }
  for (let runIndex = 0; runIndex < 2; runIndex++) {
    const run = `project-0-import-${runIndex}`;
    imp.run(run, 'project-0', '가상', `2026-01-0${runIndex + 1}`, scale.nodes, scale.edges, docs, scale.snippets, 0, 0, '가상', 'vault');
    for (let j = 0; j < scale.nodes; j++) {
      const id = `node-${j}`;
      node.run(id, 'project-0', run, j % 2 ? 'indicator' : 'output', `가상 노트 ${j}`, JSON.stringify({ evidence: [`snippet-${j}`] }));
      key.run('project-0', run, id, j % 2 ? 'indicator' : 'output');
    }
    for (let j = 0; j < scale.snippets; j++) snippet.run(`snippet-${j}`, 'project-0', run, JSON.stringify({ source: `source-${j % docs}`, locator: `쪽 ${j}`, quote: `가상 근거 ${j}`, proves: [`node-${j % scale.nodes}`] }));
    for (let j = 0; j < docs; j++) {
      const originals = [];
      for (let k = j; k < scale.snippets; k += docs) originals.push({ location: `쪽 ${k}`, content: (`가상 근거 ${k} ` + '가상 출처 원문입니다. '.repeat(250)) });
      source.run(`source-${j}`, 'project-0', run, JSON.stringify({ title: `가상 출처 ${j}`, ...(j < 5 ? { document_id: `project-0-doc-${j}` } : {}), original_paragraphs: originals }));
    }
    for (let j = 0; j < scale.edges; j++) edge.run(`edge-${j}`, 'project-0', run, `node-${j % scale.nodes}`, `node-${(j + 1) % scale.nodes}`, j % 2 ? 'targets' : 'supports');
  }
  for (let j = 0; j < Math.min(scale.nodes, 3500); j++) {
    history.run(`review-${j}`, 'project-0', 'project-0-import-0', `node-${j}`, j % 2 ? '확정' : '보완 필요', '가상 검토', '가상 노트', '관측됨', '', '', '가상 평가자', stamp);
    if (j < 1000) {
      alias.run('project-0', 'project-0-import-0', `node-${j}`, `node-${(j + 1) % scale.nodes}`);
      evidenceKey.run('project-0', 'project-0-import-0', `node-${j}`, `source-${j % docs}`, `쪽 ${j}`, `가상 근거 ${j}`);
      evidenceKey.run('project-0', 'project-0-import-1', `node-${j}`, `source-${j % docs}`, `쪽 ${j}`, `가상 근거 ${j}`);
    }
  }
  for (let j = 0; j < 500; j++) {
    link.run(`link-${j}`, 'project-0', 'project-0-import-0', `node-${j}`, `node-${j + 1}`, '확정', '가상 평가자', stamp);
    detail.run(`link-${j}`, 'targets', '가상 사유', '');
  }
  db.prepare('INSERT INTO reports(id,project_id,content_json,created_at) VALUES (?,?,?,?)').run('report-0', 'project-0', JSON.stringify({ version: 2, template: 'legacy7', project_id: 'project-0', project_name: '가상 사업', confirmed_count: 14, created_at: stamp, sections: { achievement_table: { title: '성과지표 달성표', rows: Array.from({ length: 14 }, (_, j) => ({ indicator_id: `indicator-${j}`, indicator_name: `고유지표 ${j}`, target_value: '1건', status_display: '실현', evidence_id: `evidence-${j}` })) }, performance_analysis: { title: '성과 분석', sentences: [] }, contributing_factors: { title: '기여요인' }, constraints_and_responses: { title: '제약요인과 대응' }, lessons_learned: { title: '교훈' }, monitoring_plan: { title: '모니터링 계획' }, overall_evaluation: { title: '종합평가' } } }), stamp);
})();
addFixtureBranches(db);
addRiskBranches(db);
console.log(JSON.stringify({ size, ...scale, docs: 45, histories: Math.min(scale.nodes, 3500), aliases: 1000, links: 500 }));
db.close();
