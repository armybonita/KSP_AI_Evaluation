import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from './fixtures/schema-656a639';
import { openDatabase, closeDatabase, listProjectsWithCount } from '../src/server/store/db';

it('기존 스키마의 사업·자료·확정을 보존하고 마이그레이션 후 목록을 읽는다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aieas-legacy-'));
  const path = join(directory, 'legacy.db');
  try {
    const old = new Database(path);
    old.exec(CREATE_TABLES_SQL);
    old.exec(`INSERT INTO projects VALUES ('p','가상 사업','2026-01-01');
      INSERT INTO documents (id,project_id,file_name,file_type,status,doc_type,is_included,created_at) VALUES ('d','p','plan.xlsx','xlsx','추출 완료','성과관리표',1,'2026-01-01');
      INSERT INTO indicators (id,project_id,level,name,ovi,created_at) VALUES ('i','p','산출물','가상 지표','수치','2026-01-01');
      INSERT INTO suggestions (id,indicator_id,verdict_status,proposal_text,created_at) VALUES ('s','i','미확인','제안','2026-01-01');
      INSERT INTO confirmations (id,indicator_id,suggestion_id,confirmation_type,confirmer_name,created_at) VALUES ('c','i','s','확정','평가자','2026-01-01');`);
    old.close();
    const migrated = openDatabase(path);
    expect(migrated.prepare('SELECT id, project_id, file_name, file_type, status, doc_type, is_included, created_at, is_past_final_report FROM documents WHERE id = ?').get('d'))
      .toEqual({ id: 'd', project_id: 'p', file_name: 'plan.xlsx', file_type: 'xlsx', status: '추출 완료', doc_type: '성과관리표', is_included: 1, created_at: '2026-01-01', is_past_final_report: null });
    expect(listProjectsWithCount(migrated)[0]).toMatchObject({ id: 'p', document_count: 1, has_pdm: 0, reviewed_count: 1 });
    // 이관된 미확인 자료는 제외되지만 명시적으로 이번 사업 자료임을 확인하면 기존 목록에 표시된다.
    migrated.prepare('UPDATE documents SET is_past_final_report = 0 WHERE id = ?').run('d');
    expect(listProjectsWithCount(migrated)[0]).toMatchObject({ id: 'p', document_count: 1, has_pdm: 1, reviewed_count: 1 });
    expect(migrated.prepare('SELECT confirmation_type FROM confirmations WHERE id = ?').get('c')).toEqual({ confirmation_type: '확정' });
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});
