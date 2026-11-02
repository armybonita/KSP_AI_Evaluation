import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, createProject, getDocument, openDatabase, updateDocumentType } from '../store';
import { uploadDocumentsAction } from '../../app/projects/[projectId]/documents/actions';
import { getAiDocumentEligibilityForProvider } from './ai-eligibility';

vi.mock('../extract', () => ({
  extractDocument: async () => ({ status: '추출 완료', paragraphs: [{ sequence_no: 1, location: 'p1', content: '가상 사업 종료평가보고서' }] }),
}));

describe('upload AI metadata', () => {
  let uploadDir: string;
  let previousUploadDir: string | undefined;
  beforeAll(() => {
    previousUploadDir = process.env.AIEAS_UPLOAD_DIR;
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-upload-ai-'));
    process.env.AIEAS_UPLOAD_DIR = uploadDir;
    const db = openDatabase(':memory:');
    createProject({ id: 'project', name: '가상 사업', created_at: '2026-01-01' }, db);
  });
  afterAll(() => {
    closeDatabase();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    if (previousUploadDir === undefined) delete process.env.AIEAS_UPLOAD_DIR;
    else process.env.AIEAS_UPLOAD_DIR = previousUploadDir;
  });

  async function upload(selection?: string, masked = 'true') {
    const form = new FormData();
    form.append('files', new File(['%PDF-1.4'], 'dummy.pdf', { type: 'application/pdf' }));
    form.set('masked', masked);
    form.set('approved_ai', 'solar');
    if (selection !== undefined) form.set('is_past_final_report', selection);
    const result = await uploadDocumentsAction('project', form);
    expect(result.success).toBe(true);
    return getDocument(result.uploadedDocumentIds[0])!;
  }

  it('blocks a classified final report unless the uploader explicitly selects the current project', async () => {
    const unknown = await upload();
    expect(unknown).toMatchObject({ doc_type: '종료평가보고서', masked: true, is_past_final_report: null });
    expect(getAiDocumentEligibilityForProvider(unknown, 'solar')).toEqual({ eligible: false, reasons: ['과거 종료평가보고서 여부 미확인'] });
    const current = await upload('false');
    expect(current).toMatchObject({ doc_type: '종료평가보고서', masked: true, is_past_final_report: false });
    expect(getAiDocumentEligibilityForProvider(current, 'solar').eligible).toBe(true);
    const past = await upload('true');
    expect(past.is_past_final_report).toBe(true);
    expect(getDocument(current.id)).toMatchObject({ doc_type: '종료평가보고서', is_past_final_report: false });
  });

  it('rejects an approved AI value outside the allowed set', async () => {
    const form = new FormData();
    form.append('files', new File(['%PDF-1.4'], 'dummy.pdf', { type: 'application/pdf' }));
    form.set('masked', 'true');
    form.set('approved_ai', 'xyz');
    const result = await uploadDocumentsAction('project', form);
    expect(result.success).toBe(false);
    expect(result.uploadedDocumentIds).toEqual([]);
  });

  it('does not infer masking from a missing form field', async () => {
    const missing = await upload('false', 'unknown');
    expect(missing.masked).toBeNull();
    expect(getAiDocumentEligibilityForProvider(missing, 'solar').eligible).toBe(false);
  });

  it('blocks a later final-report classification until confirmed', async () => {
    const current = await upload('false');
    updateDocumentType(current.id, '기타');
    updateDocumentType(current.id, '종료평가보고서');
    expect(getDocument(current.id)?.is_past_final_report).toBe(true);
  });
});
