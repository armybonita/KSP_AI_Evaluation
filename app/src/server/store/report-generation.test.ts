import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { DocumentRecord } from './types';
import { CREATE_TABLES_SQL } from './schema';
import { createConfirmation, createDocument, createIndicator, createProject, saveSuggestion } from './db';
import { createReportDraft, isDraftValid } from '../report/service';

function document(id: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id,
    project_id: 'fake-project',
    file_name: `${id}.docx`,
    file_type: 'docx',
    status: '추출 완료',
    doc_type: '기타',
    is_included: 1,
    excluded_reason: null,
    masked: true,
    approved_ai: 'solar',
    is_past_final_report: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}


describe('report generation eligibility integration', () => {
  it('records zero evidence and excluded source reasons in a generated report', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    createProject({ id: 'fake-project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument(document('excluded', { is_included: 0 }), db);
    createIndicator({ id: 'no-evidence', project_id: 'fake-project', name: '근거 없는 지표', level: '활동', ovi: '가상 지표', mov: null, target_value: null, source_doc_id: 'excluded', is_baseline: 0, created_at: '2026-01-01' }, db);
    saveSuggestion({ id: 'suggestion', indicator_id: 'no-evidence', verdict_status: '실현', error_reason: null, proposal_text: '가상 제안', created_at: '2026-01-01' }, [], db);
    createConfirmation({ indicator_id: 'no-evidence', confirmation_type: '확정', confirmer_name: '평가자' }, db);
    const draft = await createReportDraft('fake-project', { db });
    expect(draft.confirmed_count).toBe(0);
    expect(draft.ai_exclusions).toEqual([
      { subject: 'excluded.docx', reasons: ['평가자가 제외한 문서'] },
      { subject: '근거 없는 지표', reasons: ['검증 통과 근거 없음'] },
    ]);
    db.close();
  });

  it('marks a generated report stale when an unknown past report flag is confirmed false', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_TABLES_SQL);
    createProject({ id: 'fake-project', name: '가상 사업', created_at: '2026-01-01' }, db);
    createDocument(document('source', { is_included: 0, is_past_final_report: null }), db);
    createIndicator({ id: 'indicator', project_id: 'fake-project', name: '가상 지표', level: '활동', ovi: '가상 지표', mov: null, target_value: null, source_doc_id: 'source', is_baseline: 0, created_at: '2026-01-01' }, db);
    saveSuggestion({ id: 'suggestion', indicator_id: 'indicator', verdict_status: '실현', error_reason: null, proposal_text: '가상 제안', created_at: '2026-01-01' }, [], db);
    createConfirmation({ indicator_id: 'indicator', confirmation_type: '확정', confirmer_name: '평가자' }, db);
    const draft = await createReportDraft('fake-project', { db });
    expect(isDraftValid(draft, 'fake-project', db)).toBe(true);
    db.prepare('UPDATE documents SET is_past_final_report = 0 WHERE id = ?').run('source');
    expect(isDraftValid(draft, 'fake-project', db)).toBe(false);
    db.close();
  });

});
