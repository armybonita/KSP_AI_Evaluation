/** Additional synthetic cases for review context and source metadata. */
import type Database from 'better-sqlite3';

export function addRiskBranches(db: Database.Database): void {
  db.transaction(() => {
    const doc = 'risk-doc', run = 'project-0-import-1';
    db.prepare('INSERT INTO documents(id,project_id,file_name,file_type,status,doc_type,is_included,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(doc, 'project-0', '위험 분기 가상 문서', 'txt', '추출 완료', '사업계획서', 1, '2026-01-01');
    const paragraph = db.prepare('INSERT INTO paragraphs(id,document_id,sequence_no,location,content,table_index,table_cols,table_row,table_col) VALUES (?,?,?,?,?,?,?,?,?)');
    paragraph.run('risk-previous', doc, 0, '가상 앞쪽', '금지 문장의 앞부분이 여기에', null, null, null, null);
    paragraph.run('risk-target', doc, 1, '가상 중복 위치', '금지 문장의 중간부분이 여기에', 1, 2, 1, 1);
    paragraph.run('risk-next', doc, 2, '가상 뒤쪽', '금지 문장의 뒷부분이 여기에', null, null, null, null);
    paragraph.run('risk-duplicate', doc, 4, '가상 중복 위치', '다른 문단', null, null, null, null);
    db.prepare('INSERT INTO sentences(id,document_id,paragraph_id,sequence_no,location,content,is_citation_banned) VALUES (?,?,?,?,?,?,?)')
      .run('risk-banned', doc, 'risk-previous', 0, '가상 앞쪽', '금지 문장의 앞부분이 여기에 금지 문장의 중간부분이 여기에 금지 문장의 뒷부분이 여기에', 1);
    const evidence = db.prepare('INSERT INTO evidences(id,suggestion_id,quote,document_id,location,speaker,is_citation_banned) VALUES (?,?,?,?,?,?,?)');
    evidence.run('risk-unmatched', 'suggestion-0', '가상 원문', doc, '없는 위치', '가상 화자', 0);
    evidence.run('risk-duplicate-evidence', 'suggestion-0', '가상 표 셀', doc, '가상 중복 위치', '가상 화자', 0);
    db.prepare('INSERT INTO ontology_sources(id,project_id,import_id,data_json) VALUES (?,?,?,?)').run('risk-source', 'project-0', run, JSON.stringify({ title: '가상 출처 메타', original_paragraphs: [{ location: '쪽 위험', content: '가상 인용 내용' }], evidence_metadata: { 'risk-snippet': { evidence_level: '가상 등급', speaker: '가상 작성자' } } }));
    db.prepare('INSERT INTO ontology_snippets(id,project_id,import_id,data_json) VALUES (?,?,?,?)').run('risk-snippet', 'project-0', run, JSON.stringify({ source: 'risk-source', locator: '쪽 위험', quote: '가상 인용 내용', proves: ['risk-node'] }));
    db.prepare('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,?,?,?)').run('risk-node', 'project-0', run, 'output', '가상 위험 노트', JSON.stringify({ evidence: ['risk-snippet'] }));
    db.prepare('INSERT INTO ontology_review_node_keys VALUES (?,?,?,?)').run('project-0', run, 'risk-node', 'output');
  })();
}
