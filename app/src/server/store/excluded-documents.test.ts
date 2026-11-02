import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, createDocument, createProject, getDatabase, openDatabase } from './index';
import { excludedDocumentSummary } from './excluded-documents';

describe('document-only exclusion notice', () => {
  beforeEach(() => {
    const db = openDatabase(':memory:');
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'unknown', project_id: 'p', file_name: '공통 금지 이름.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: null, created_at: '2026-01-01' }, db);
    createDocument({ id: 'past', project_id: 'p', file_name: '과거 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: true, created_at: '2026-01-02' }, db);
    createDocument({ id: 'current', project_id: 'p', file_name: '현재 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-03' }, db);
    createProject({ id: 'other', name: '다른 가상 사업', created_at: '2026-01-01' }, db);
    createDocument({ id: 'excluded', project_id: 'p', file_name: '제외 문서.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 0, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: true, created_at: '2026-01-04' }, db);
    createDocument({ id: 'other-past', project_id: 'other', file_name: '다른 사업.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: true, created_at: '2026-01-04' }, db);
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)').run('para', 'current', '1쪽', '공통 금지 이름');
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, 1, ?, ?, 1)').run('banned', 'current', 'para', '1쪽', '공통 금지 이름');
  });
  afterEach(() => closeDatabase());

  it('counts included documents using one documents query without reading names or content', () => {
    const db = getDatabase();
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((query: string) => { sql.push(query); return prepare(query); }) as typeof db.prepare);
    const summary = excludedDocumentSummary('p', db);
    expect(summary).toEqual({ unconfirmed: 1, past: 1 });
    const reads = sql.filter(query => /^\s*SELECT/i.test(query));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/\bCOUNT\s*\(/i);
    expect(reads[0]).toMatch(/\bFROM\s+documents\b/i);
    expect(reads[0]).not.toMatch(/\bfile_name\b/i);
    expect(reads.join('\n')).not.toMatch(/\b(paragraphs|sentences|ontology_nodes|ontology_snippets|evidences)\b/i);
  });

  it('returns zero counts when no included documents match', () => {
    expect(excludedDocumentSummary('missing', getDatabase())).toEqual({ unconfirmed: 0, past: 0 });
  });

  it('prepares notice data for review and report in under 20ms with 20,000 nodes and snippets', () => {
    const db = getDatabase();
    db.prepare(`INSERT INTO ontology_imports (id, project_id, vault_code, imported_at, node_count, edge_count, source_count, snippet_count, error_count, warning_count, executor)
      VALUES ('large', 'p', 'fake', '2026-02-01', 20000, 0, 0, 20000, 0, 0, 'test')`).run();
    const insertNode = db.prepare('INSERT INTO ontology_nodes (id, project_id, import_id, node_type, title, data_json) VALUES (?, ?, ?, ?, ?, ?)');
    const insertSnippet = db.prepare('INSERT INTO ontology_snippets (id, project_id, import_id, data_json) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (let index = 0; index < 20_000; index++) {
        insertNode.run(`node-${index}`, 'p', 'large', 'output', `가상 노드 ${index}`, '{}');
        insertSnippet.run(`snippet-${index}`, 'p', 'large', '{}');
      }
    })();
    const started = performance.now();
    expect(excludedDocumentSummary('p', db)).toMatchObject({ unconfirmed: 1, past: 1 });
    expect(performance.now() - started).toBeLessThanOrEqual(20);
  }, 20_000);
});
