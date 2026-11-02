import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, createDocument, createProject, getDatabase, openDatabase } from './db';
import { AiEligibilityChangedError, createProjectEligibilityGuard, projectEligibilityFingerprint } from '../documents/eligibility-fingerprint';

describe('사업 자료 자격 지문', () => {
  beforeEach(() => {
    const db = openDatabase(':memory:');
    for (const id of ['project', 'other']) {
      createProject({ id, name: '가상 사업', created_at: '2026-01-01' }, db);
      createDocument({ id: `doc-${id}`, project_id: id, file_name: '가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
      db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, 1, ?, ?)').run(`para-${id}`, `doc-${id}`, '1쪽', '가상 문단');
      db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, 1, ?, ?, 1)').run(`sentence-${id}`, `doc-${id}`, `para-${id}`, '1쪽', '가상 금지 문장');
    }
  });
  afterEach(() => closeDatabase());

  it.each([
    ['is_included', 0], ['is_past_final_report', null], ['masked', 0],
    ['approved_ai', 'none'], ['status', '추출 대기'],
  ])('%s 변경을 감지해 관문이 중단한다', (column, value) => {
    const db = getDatabase();
    const guard = createProjectEligibilityGuard('project', db);
    db.prepare(`UPDATE documents SET ${column} = ? WHERE id = ?`).run(value, 'doc-project');
    expect(guard).toThrow(AiEligibilityChangedError);
  });

  it('금지 문장 추가·내용·해제와 문서 추가를 감지하고 다른 사업은 격리한다', () => {
    const db = getDatabase();
    const initial = projectEligibilityFingerprint('project', db);
    db.prepare('UPDATE sentences SET content = ? WHERE id = ?').run('다른 사업 문장', 'sentence-other');
    expect(projectEligibilityFingerprint('project', db)).toBe(initial);
    db.prepare('UPDATE sentences SET content = ? WHERE id = ?').run('변경된 금지 문장', 'sentence-project');
    const changed = projectEligibilityFingerprint('project', db);
    expect(changed).not.toBe(initial);
    db.prepare('UPDATE sentences SET is_citation_banned = 0 WHERE id = ?').run('sentence-project');
    const removed = projectEligibilityFingerprint('project', db);
    expect(removed).not.toBe(changed);
    db.prepare('UPDATE sentences SET is_citation_banned = 1 WHERE id = ?').run('sentence-project');
    expect(projectEligibilityFingerprint('project', db)).toBe(changed);
    createDocument({ id: 'new-doc', project_id: 'project', file_name: '새 가상.docx', file_type: 'docx', status: '추출 완료', doc_type: '기타', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '2026-01-01' }, db);
    expect(projectEligibilityFingerprint('project', db)).not.toBe(changed);
  });
});
