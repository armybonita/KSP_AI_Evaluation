import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processUploadedFile } from './service';
import { getAiDocumentEligibilityForProvider } from './ai-eligibility';
import { hasEligiblePdm } from './pdm-eligibility';
import { projectPdmExclusionReason, isProjectPdmRegistered } from '../project-pdm';
import { syncTocForProject } from '../toc';
import { closeDatabase, createProject, getTocData, listDocuments, listProjectsWithCount, openDatabase } from '../store';

async function documentWithTable(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const rows = [
    ['단계', '서술', '지표(OVI)', '검증수단(MoV)', '목표값'],
    ['산출물', '가상 교육', '참여자 수', '가상 자료', '10명'],
  ];
  const table = rows.map(row => `<w:tr>${row.map(cell => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(paragraph).join('')}<w:tbl>${table}</w:tbl></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('과거 종료평가보고서 분류와 PDM 선택', () => {
  let uploadDir: string;
  let previousUploadDir: string | undefined;
  beforeEach(() => {
    previousUploadDir = process.env.AIEAS_UPLOAD_DIR;
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aieas-holdout-'));
    process.env.AIEAS_UPLOAD_DIR = uploadDir;
    openDatabase(':memory:');
    createProject({ id: 'p', name: '가상 사업', created_at: '2026-01-01' });
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    if (previousUploadDir === undefined) delete process.env.AIEAS_UPLOAD_DIR;
    else process.env.AIEAS_UPLOAD_DIR = previousUploadDir;
  });

  it('사람이 이번 사업의 자료로 고른 종료평가보고서는 과거 보고서로 바꾸지 않는다', async () => {
    const file = await documentWithTable(['가상 사업', '종료 평가 보고서', '가상 본문']);
    const result = await processUploadedFile('p', 'current.docx', file, { masked: true, approved_ai: 'solar', is_past_final_report: false });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('가상 업로드 실패');
    expect(result.document).toMatchObject({ doc_type: '종료평가보고서', is_past_final_report: false });
    expect(getAiDocumentEligibilityForProvider(result.document, 'solar').eligible).toBe(true);
  });

  it('사업명 다음 종료평가보고서 제목과 PDM 표는 과거 보고서이며 선택하지 않는다', async () => {
    const file = await documentWithTable(['가상 사업', '종료 평가 보고서', '성과관리표 PDM']);
    // 과거 여부를 고르지 않아도 제목 분류를 유지하고 분석에서 제외한다.
    const result = await processUploadedFile('p', 'holdout.docx', file, { masked: true, approved_ai: 'solar' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('가상 업로드 실패');
    expect(result.document).toMatchObject({ doc_type: '종료평가보고서', is_past_final_report: null });
    expect(getAiDocumentEligibilityForProvider(result.document, 'solar').eligible).toBe(false);
    expect(isProjectPdmRegistered('p')).toBe(false);
    expect(syncTocForProject('p')?.hasPdm).toBe(false);
    expect(listProjectsWithCount()[0].pdm_document).toBeNull();
  });

  it('목차 뒤 본문의 언급은 정상 PDM을 과거 보고서로 바꾸지 않는다', async () => {
    const file = await documentWithTable(['가상 사업', '성과관리표 PDM', '목차', '종료평가보고서', '본 사업의 지표']);
    const result = await processUploadedFile('p', 'current.docx', file, { masked: true, approved_ai: 'solar', is_past_final_report: false });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('가상 업로드 실패');
    expect(result.document).toMatchObject({ doc_type: '성과관리표', is_past_final_report: false });
    expect(isProjectPdmRegistered('p')).toBe(true);
    expect(syncTocForProject('p')?.hasPdm).toBe(true);
    expect(getTocData('p')?.pdmDocument?.id).toBe(result.document.id);
    expect(listProjectsWithCount()[0].pdm_document?.id).toBe(result.document.id);
  });

  it('제목 영역의 인용 문장과 여섯 번째 문단 이후의 단어는 제목으로 오인하지 않는다', async () => {
    const file = await documentWithTable([
      '가상 사업', '성과관리표 PDM', '과거 종료평가보고서를 참고하였다.',
      '사업 추진 개요', '사업 활동', '종료평가보고서',
    ]);
    const result = await processUploadedFile('p', 'normal.docx', file, { is_past_final_report: false });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('가상 업로드 실패');
    expect(result.document).toMatchObject({ doc_type: '성과관리표', is_past_final_report: false });
    expect(syncTocForProject('p')?.pdmDocument?.id).toBe(result.document.id);
  });

  it.each([undefined, true, false])('첫 문단 이후 제목의 표는 과거 여부 %s에 따라 선택한다', async (past) => {
    const file = await documentWithTable(['가상 사업', '설명', '설명', '설명', '설명', '종료평가보고서', '성과관리표 PDM']);
    const result = await processUploadedFile('p', 'fixture.docx', file, { masked: true, approved_ai: 'solar', is_past_final_report: past });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('가상 업로드 실패');
    expect(result.document).toMatchObject({ doc_type: '성과관리표', is_past_final_report: past ?? null });
    expect(getAiDocumentEligibilityForProvider(result.document, 'solar').eligible).toBe(past === false);
    expect(isProjectPdmRegistered('p')).toBe(past === false);
    expect(hasEligiblePdm(listDocuments('p'))).toBe(isProjectPdmRegistered('p'));
    if (past !== false) {
      expect(projectPdmExclusionReason('p')).toContain(past ? '과거 종료평가보고서로 표시되어' : '과거 보고서 여부가 미확인');
      expect(getTocData('p')?.warningMessage).toBe(projectPdmExclusionReason('p'));
    }
    const toc = syncTocForProject('p');
    expect(toc?.hasPdm).toBe(past === false);
    expect(toc?.items.length ?? -1).toBe(past === false ? 1 : 0);
    expect(listProjectsWithCount()[0].pdm_document?.id ?? null).toBe(past === false ? result.document.id : null);
  });

});
