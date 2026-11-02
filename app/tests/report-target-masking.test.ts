import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/server/store';

describe('getReportTargets 인용 금지 마스킹', () => {
  let dbPath: string;
  let db: ReturnType<typeof store.openDatabase>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `aieas-report-target-mask-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = store.openDatabase(dbPath);
    store.createProject({ id: 'project-mask', name: '가상 사업', created_at: new Date().toISOString() }, db);
    store.createDocument({
      id: 'document-mask', project_id: 'project-mask', file_name: '가상 문서', file_type: 'txt',
      status: '추출 완료', doc_type: null, is_included: 1, excluded_reason: null, is_past_final_report: false, created_at: new Date().toISOString(),
    }, db);
    store.createIndicator({
      id: 'indicator-mask', project_id: 'project-mask', level: '활동', name: '가상 지표', ovi: 'OVI-1',
      mov: null, target_value: '1건', is_baseline: 0, created_at: new Date().toISOString(),
    }, db);
    store.insertParagraphs([{
      id: 'paragraph-mask', document_id: 'document-mask', sequence_no: 1, location: '1쪽',
      content: '협의 결과에 따라 담당자 성명은 외부에 공개하지 않기로 함. 별도 일정은 다음 주에 공유한다.',
    }], db);
    store.insertSentences([{
      id: 'sentence-mask', document_id: 'document-mask', paragraph_id: 'paragraph-mask', sequence_no: 1,
      location: '1쪽', content: '협의 결과에 따라 담당자 성명은 외부에 공개하지 않기로 함', is_citation_banned: 1,
    }], db);
    store.saveSuggestion({
      id: 'suggestion-mask', indicator_id: 'indicator-mask', verdict_status: '실현', error_reason: null,
      proposal_text: '가상 실적이 확인됐다.', created_at: new Date().toISOString(),
    }, [
      { id: 'evidence-flagged', suggestion_id: 'suggestion-mask', quote: '플래그 근거의 원문 인용', document_id: 'document-mask', location: '1쪽', speaker: '가상 발언자', is_citation_banned: 1 },
      { id: 'evidence-overlap', suggestion_id: 'suggestion-mask', quote: '담당자 성명은 외부', document_id: 'document-mask', location: '1쪽', speaker: '가상 발언자', is_citation_banned: 0 },
      { id: 'evidence-safe', suggestion_id: 'suggestion-mask', quote: '안전한 일반 인용문', document_id: 'document-mask', location: '1쪽', speaker: '가상 발언자', is_citation_banned: 0 },
    ], db);
    store.createConfirmation({ indicator_id: 'indicator-mask', confirmation_type: '확정', confirmer_name: '평가자' }, db);
  });

  afterEach(() => {
    store.closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('금지 플래그와 사업 금지문 8자 겹침을 가리고 원문 문맥도 문장 단위로 가린다', () => {
    const target = store.getReportTargets('project-mask', db)[0];
    const byId = new Map(target.evidences.map((evidence) => [evidence.id, evidence]));

    for (const id of ['evidence-flagged', 'evidence-overlap']) {
      expect(byId.get(id)?.quote).toBe('인용 금지 문장 있음');
      expect(byId.get(id)?.speaker).toBe('—');
      expect(byId.get(id)?.is_citation_banned).toBe(1);
    }
    expect(byId.get('evidence-safe')?.quote).toBe('안전한 일반 인용문');
    expect(byId.get('evidence-safe')?.speaker).toBe('가상 발언자');

    const context = byId.get('evidence-safe')?.paragraph_context;
    expect(context?.target.content).not.toContain('담당자 성명은 외부');
    expect(context?.target.content).toContain('[인용 금지 문장]');
    expect(context?.target.content).toContain('별도 일정은 다음 주에 공유한다.');
  });
});
