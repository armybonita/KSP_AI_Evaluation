import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDocument, createProject, getDocument, getDocumentInProject, listDocuments, migrateDocumentAiMetadata, openDatabase, closeDatabase } from './db';
import { getAiDocumentEligibilityForProvider } from '../documents/ai-eligibility';
import { CREATE_TABLES_SQL } from './schema';

describe('document AI metadata migration', () => {
  it('migrates existing documents with unknown flags and the approved provider default', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, file_name TEXT NOT NULL,
      file_type TEXT NOT NULL, status TEXT NOT NULL, doc_type TEXT,
      is_included INTEGER NOT NULL DEFAULT 1, excluded_reason TEXT,
      inclusion_source TEXT NOT NULL DEFAULT 'auto', doctype_source TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL
    ); INSERT INTO documents (id, project_id, file_name, file_type, status, created_at)
      VALUES ('fake-doc', 'fake-project', 'dummy.docx', 'docx', '추출 완료', '2026-01-01');`);
    migrateDocumentAiMetadata(db);
    expect(db.prepare('SELECT masked, approved_ai, is_past_final_report FROM documents WHERE id = ?').get('fake-doc'))
      .toEqual({ masked: null, approved_ai: 'solar', is_past_final_report: null });
    db.close();
  });

  it('rebuilds old constrained metadata once and preserves related rows and indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, masked INTEGER NOT NULL DEFAULT 1,
      approved_ai TEXT NOT NULL DEFAULT 'solar', is_past_final_report INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_documents_ai_test ON documents(approved_ai);
      CREATE TABLE child (id TEXT, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE);
      INSERT INTO documents(id) VALUES ('doc'); INSERT INTO child VALUES ('child', 'doc');`);
    migrateDocumentAiMetadata(db);
    expect(db.prepare('SELECT * FROM documents').get()).toEqual({ id: 'doc', masked: null, approved_ai: 'solar', is_past_final_report: null });
    expect(db.prepare('SELECT * FROM child').get()).toEqual({ id: 'child', document_id: 'doc' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_documents_ai_test'").get()).toBeTruthy();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare('UPDATE documents SET masked = 1, is_past_final_report = 0').run();
    migrateDocumentAiMetadata(db);
    expect(db.prepare('SELECT masked, is_past_final_report FROM documents').get()).toEqual({ masked: 1, is_past_final_report: 0 });
    db.close();
  });

  it('migrates the previous full application schema without losing document references', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL.replace('masked INTEGER,', 'masked INTEGER NOT NULL DEFAULT 1,')
      .replace('is_past_final_report INTEGER,', 'is_past_final_report INTEGER NOT NULL DEFAULT 0,'));
    db.exec(`INSERT INTO projects (id, name, created_at) VALUES ('project', '가상 사업', '2026-01-01');
      INSERT INTO documents (id, project_id, file_name, file_type, status, created_at)
      VALUES ('doc', 'project', 'dummy.pdf', 'pdf', '추출 완료', '2026-01-01');
      INSERT INTO paragraphs (id, document_id, sequence_no, location, content)
      VALUES ('paragraph', 'doc', 1, 'p1', '가상 근거');`);
    const cacheTriggersBefore = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND (name LIKE 'trg_evquote_paragraph_%' OR name LIKE 'trg_evquote_sentence_%')
      ORDER BY name`).all();
    expect(cacheTriggersBefore).toHaveLength(6);
    migrateDocumentAiMetadata(db);
    expect(db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND (name LIKE 'trg_evquote_paragraph_%' OR name LIKE 'trg_evquote_sentence_%')
      ORDER BY name`).all()).toEqual(cacheTriggersBefore);
    expect(db.prepare('SELECT masked, approved_ai, is_past_final_report FROM documents').get())
      .toEqual({ masked: null, approved_ai: 'solar', is_past_final_report: null });
    expect(db.prepare('SELECT document_id, content FROM paragraphs').get()).toEqual({ document_id: 'doc', content: '가상 근거' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_documents_project_id'").get()).toBeTruthy();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('refuses migration inside another transaction before touching related data', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, masked INTEGER NOT NULL DEFAULT 1,
      approved_ai TEXT NOT NULL DEFAULT 'solar', is_past_final_report INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE child (document_id TEXT REFERENCES documents(id) ON DELETE CASCADE);
      INSERT INTO documents(id) VALUES ('doc'); INSERT INTO child VALUES ('doc');`);
    db.transaction(() => {
      expect(() => migrateDocumentAiMetadata(db)).toThrow();
      expect(db.prepare('SELECT * FROM child').get()).toEqual({ document_id: 'doc' });
      expect(db.prepare('SELECT masked, is_past_final_report FROM documents').get()).toEqual({ masked: 1, is_past_final_report: 0 });
    })();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('keeps omitted flags null through every document reader and blocks AI', () => {
    const db = openDatabase(':memory:');
    try {
      createProject({ id: 'project', name: '가상', created_at: '2026-01-01' }, db);
      createDocument({ id: 'doc', project_id: 'project', file_name: 'dummy.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, created_at: '2026-01-01' }, db);
      for (const doc of [getDocument('doc', db), getDocumentInProject('doc', 'project', db), listDocuments('project', db)[0]]) {
        expect(doc).toMatchObject({ masked: null, approved_ai: 'solar', is_past_final_report: null });
        expect(getAiDocumentEligibilityForProvider(doc!, 'solar')).toEqual({ eligible: false, reasons: ['개인정보 마스킹 미완료', '과거 종료평가보고서 여부 미확인'] });
      }
    } finally { closeDatabase(); }
  });
});
