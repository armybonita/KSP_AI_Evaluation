import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { headers } from 'next/headers';
import {
  closeDatabase,
  createProject,
  listDocuments,
  listProjects,
  openDatabase,
} from '../src/server/store';
import * as documentsService from '../src/server/documents';
import { createProjectAction } from '../src/app/projects/actions';
import { uploadDocumentsAction, updateDocumentTypeAction } from '../src/app/projects/[projectId]/documents/actions';
import { confirmVerdictAction } from '../src/app/projects/[projectId]/review/actions';
import { guestSpeakerLabel } from '../src/app/projects/[projectId]/review/review-client-view';
import { GUEST_WRITE_BLOCKED_MESSAGE } from '../src/server/viewer';

vi.mock('next/headers', () => ({ headers: vi.fn() }));

const originalAuthMode = process.env.AIEAS_AUTH_MODE;
const originalUploadDir = process.env.AIEAS_UPLOAD_DIR;

function pdfForm(name = '가상_계획서.pdf'): { form: FormData; readCalled: () => boolean } {
  const file = new File(['%PDF-1.4 가상 자료'], name, { type: 'application/pdf' });
  let called = false;
  const original = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => {
    called = true;
    return original();
  };
  const form = new FormData();
  form.append('files', file);
  return { form, readCalled: () => called };
}

describe('로그인과 역할별 쓰기 제한', () => {
  let dbPath: string;
  let uploadDir: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbPath = path.join(os.tmpdir(), `aieas-guest-write-${suffix}.db`);
    uploadDir = path.join(os.tmpdir(), `aieas-guest-upload-${suffix}`);
    process.env.AIEAS_UPLOAD_DIR = uploadDir;
    process.env.AIEAS_AUTH_MODE = 'proxy';
    openDatabase(dbPath);
    createProject({
      id: 'proj-guest-write',
      name: '가상 시험 사업',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(uploadDir)) fs.rmSync(uploadDir, { recursive: true, force: true });
    if (originalAuthMode === undefined) delete process.env.AIEAS_AUTH_MODE;
    else process.env.AIEAS_AUTH_MODE = originalAuthMode;
    if (originalUploadDir === undefined) delete process.env.AIEAS_UPLOAD_DIR;
    else process.env.AIEAS_UPLOAD_DIR = originalUploadDir;
  });

  function asGuest() {
    vi.mocked(headers).mockImplementation(async () => new Headers() as never);
  }

  function asMember() {
    vi.mocked(headers).mockImplementation(
      async () => new Headers({ 'x-auth-request-user': 'member-tester' }) as never
    );
  }

  it('손님 파일 올리기는 파일을 읽지 않고 서버에서 거절된다', async () => {
    asGuest();
    const processSpy = vi.spyOn(documentsService, 'processUploadedFile');
    const { form, readCalled } = pdfForm();

    await expect(uploadDocumentsAction('proj-guest-write', form)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(readCalled()).toBe(false);
    expect(processSpy).not.toHaveBeenCalled();
    expect(listDocuments('proj-guest-write')).toHaveLength(0);
    expect(fs.existsSync(uploadDir)).toBe(false);
  });

  it('손님 사업 만들기는 서버에서 거절되고 사업 수가 그대로다', async () => {
    asGuest();
    const before = listProjects().length;

    const res = await createProjectAction('가상 손님 사업');

    expect(res).toEqual({ success: false, error: GUEST_WRITE_BLOCKED_MESSAGE });
    expect(listProjects()).toHaveLength(before);
  });

  it('로그인 사용자는 사업 만들기와 파일 올리기가 그대로 된다', async () => {
    asMember();

    const created = await createProjectAction('가상 로그인 사업');
    expect(created.success).toBe(true);
    expect(created.projectId).toBeTruthy();

    const { form } = pdfForm();
    const res = await uploadDocumentsAction('proj-guest-write', form);
    expect(res.errors).not.toContainEqual({
      fileName: '파일 올리기',
      error: GUEST_WRITE_BLOCKED_MESSAGE,
    });
    expect(res.success).toBe(true);
    expect(res.rejected).toEqual([]);
    expect(res.uploadedDocumentIds).toHaveLength(1);
    expect(listDocuments('proj-guest-write')).toHaveLength(1);
  });

  it('손님은 확정과 문서 분류 변경도 막힌다', async () => {
    asGuest();
    await expect(confirmVerdictAction({ projectId: 'proj-guest-write', indicatorId: 'no-such-indicator', confirmationType: '승인', confirmerName: '가상 평가자' } as never)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(updateDocumentTypeAction('proj-guest-write', 'no-such-doc', '사업계획서')).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it.each([['평가팀', true], ['Admin', true], ['PO', false], ['기획팀', false]])('%s 역할의 사업 생성 권한을 검사한다', async (role, allowed) => {
    vi.stubEnv('AIEAS_ROLE_MAP', JSON.stringify({ 'member-tester': role }));
    asMember();
    const result = await createProjectAction('가상 역할 사업');
    expect(result.success).toBe(allowed);
    if (!allowed) expect(result.error).toContain('권한');
  });

  it('손님 화면은 근거 말한 사람의 협력기관 약어를 일반 이름으로 보인다', () => {
    expect(guestSpeakerLabel('KDI', true)).toBe('협력기관');
    expect(guestSpeakerLabel('KDI', false)).toBe('KDI');
    expect(guestSpeakerLabel('수행기관', true)).toBe('수행기관');
  });
});
