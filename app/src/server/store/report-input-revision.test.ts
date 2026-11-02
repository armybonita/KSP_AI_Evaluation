import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './schema';
import { reportDraftCount, reportInputFingerprint } from './report-input';
import { getReportDraftById, listReportDraftRecords, saveReportDraft } from './db';

describe('report input revision triggers', () => {
  it('tracks direct SQL changes in only the owning project', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    try {
      const project = db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)');
      project.run('p1', '가상 사업 1', '2026-01-01');
      project.run('p2', '가상 사업 2', '2026-01-01');
      const fingerprint = (id: string) => reportInputFingerprint(id, db);
      const p1Before = fingerprint('p1');
      const p2Before = fingerprint('p2');

      db.prepare('INSERT INTO documents(id,project_id,file_name,file_type,status,created_at) VALUES (?,?,?,?,?,?)')
        .run('d1', 'p1', '가상 자료', 'txt', '추출 완료', '2026-01-01');
      const afterDocument = fingerprint('p1');
      expect(afterDocument).not.toBe(p1Before);
      expect(fingerprint('p2')).toBe(p2Before);

      db.prepare('INSERT INTO paragraphs(id,document_id,sequence_no,location,content) VALUES (?,?,?,?,?)')
        .run('para1', 'd1', 1, '쪽 1', '가상 문단');
      const afterParagraph = fingerprint('p1');
      expect(afterParagraph).not.toBe(afterDocument);
      db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('바뀐 가상 문단', 'para1');
      expect(fingerprint('p1')).not.toBe(afterParagraph);
    } finally {
      db.close();
    }
  });

  it('tracks ontology review and source edits issued as direct SQL', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    try {
      db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)').run('p', '가상 사업', '2026-01-01');
      db.prepare(`INSERT INTO ontology_imports(id,project_id,vault_code,imported_at,node_count,edge_count,source_count,snippet_count,error_count,warning_count,executor)
        VALUES ('imp','p','virtual','2026-01-01',0,0,0,0,0,0,'virtual')`).run();
      const fingerprint = () => reportInputFingerprint('p', db);
      const baseline = fingerprint();
      db.prepare('INSERT INTO ontology_nodes(id,project_id,import_id,node_type,title,data_json) VALUES (?,?,?,?,?,?)')
        .run('node', 'p', 'imp', 'outcome-short', '가상 노드', '{}');
      const afterNode = fingerprint();
      expect(afterNode).not.toBe(baseline);
      db.prepare('INSERT INTO ontology_note_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('review', 'p', 'imp', 'node', '확정', '가상 검토', '가상 원문', '관측됨', '', '', '가상 검토자', '2026-01-01');
      const afterReview = fingerprint();
      expect(afterReview).not.toBe(afterNode);
      db.prepare('INSERT INTO ontology_sources(id,project_id,import_id,data_json) VALUES (?,?,?,?)')
        .run('source', 'p', 'imp', JSON.stringify({ title: '가상 출처' }));
      const afterSource = fingerprint();
      expect(afterSource).not.toBe(afterReview);
      db.prepare('UPDATE ontology_sources SET data_json = ? WHERE id = ?')
        .run(JSON.stringify({ title: '수정된 가상 출처' }), 'source');
      expect(fingerprint()).not.toBe(afterSource);
    } finally {
      db.close();
    }
  });

  it('keeps finalized copies out of the next draft number and scopes version lookup', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    try {
      db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)').run('p1', '가상 사업 1', '2026-01-01');
      db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)').run('p2', '가상 사업 2', '2026-01-01');
      const first = saveReportDraft('p1', JSON.stringify({ draft_number: 1, project_id: 'p1' }), db);
      saveReportDraft('p1', JSON.stringify({ draft_number: 1, project_id: 'p1', report_finalization: { role: '평가팀', confirmed_at: '2026-01-01' } }), db);
      saveReportDraft('p1', JSON.stringify({ draft_number: 2, project_id: 'p1' }), db);
      expect(reportDraftCount('p1', db)).toBe(2);
      expect(getReportDraftById('p1', first.id, db)?.id).toBe(first.id);
      expect(getReportDraftById('p2', first.id, db)).toBeUndefined();
      expect(listReportDraftRecords('p1', db)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('does not skip draft numbers when unnumbered legacy drafts exist', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    try {
      db.prepare('INSERT INTO projects(id,name,created_at) VALUES (?,?,?)').run('p1', '가상 사업 1', '2026-01-01');
      saveReportDraft('p1', JSON.stringify({ project_id: 'p1' }), db);
      saveReportDraft('p1', JSON.stringify({ project_id: 'p1' }), db);
      expect(reportDraftCount('p1', db)).toBe(2);
      saveReportDraft('p1', JSON.stringify({ draft_number: 3, project_id: 'p1' }), db);
      expect(reportDraftCount('p1', db)).toBe(3);
      saveReportDraft('p1', JSON.stringify({ draft_number: 4, project_id: 'p1' }), db);
      expect(reportDraftCount('p1', db)).toBe(4);
    } finally {
      db.close();
    }
  });
});
