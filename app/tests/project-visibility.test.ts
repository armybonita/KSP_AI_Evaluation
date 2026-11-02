import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { headers } from 'next/headers';
import {
  closeDatabase,
  createDocument,
  createProject,
  getDocument,
  openDatabase,
} from '../src/server/store';
import * as projectStore from '../src/server/store';
import * as reportPageState from '../src/app/projects/[projectId]/review/review-page-state';
import * as historyPageState from '../src/app/projects/[projectId]/history/history-page-state';
import * as resultPageState from '../src/app/projects/[projectId]/result/result-page-state';
import * as documentActions from '../src/app/projects/[projectId]/documents/actions';
import * as tocActions from '../src/app/projects/[projectId]/toc/actions';
import ProjectsPage from '../src/app/projects/page';
import { getProjectsAction } from '../src/app/projects/actions';
import ProjectLayout from '../src/app/projects/[projectId]/layout';
import ReportPage from '../src/app/projects/[projectId]/report/page';
import ReviewPage from '../src/app/projects/[projectId]/review/page';
import HistoryPage from '../src/app/projects/[projectId]/history/page';
import ResultTocPage from '../src/app/projects/[projectId]/result/page';
import DocumentsPage from '../src/app/projects/[projectId]/documents/page';
import TocPage from '../src/app/projects/[projectId]/toc/page';
import { GET as downloadReport } from '../src/app/projects/[projectId]/report/download/route';
import { updateDocumentTypeAction } from '../src/app/projects/[projectId]/documents/actions';
import { isGuestHiddenProjectName } from '../src/server/project-visibility';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

const originalAuthMode = process.env.AIEAS_AUTH_MODE;

function addProject(id: string, name: string): void {
  createProject({ id, name, created_at: new Date().toISOString() });
}

function addDocument(id: string, projectId: string): void {
  createDocument({
    id,
    project_id: projectId,
    file_name: `${id}.docx`,
    file_type: 'docx',
    status: '추출 완료',
    doc_type: '사업계획서',
    is_included: 1,
    excluded_reason: null, is_past_final_report: false,
    created_at: new Date().toISOString(),
  });
}

describe('손님 사업 숨김', () => {
  beforeEach(() => {
    process.env.AIEAS_AUTH_MODE = 'proxy';
    openDatabase(':memory:');
    vi.mocked(headers).mockImplementation(async () => new Headers() as never);
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    if (originalAuthMode === undefined) {
      delete process.env.AIEAS_AUTH_MODE;
    } else {
      process.env.AIEAS_AUTH_MODE = originalAuthMode;
    }
  });

  it('요청된 기관·사업·국가 이름을 대소문자와 무관하게 판정한다', () => {
    const markedNames = [
      'KDI',
      'KSP 시범 사업',
      '국제개발협력센터 사업',
      '한국개발연구원 자료',
      '경제발전경험공유 프로그램',
      'knowledge sharing program',
      '헝가리 협력',
      'Hungarian cooperation',
      '우즈베키스탄 사업',
      'UZBEKistan project',
    ];
    const unmarkedNames = [
      'WORKSPACE 시험',
      '가상국 디지털 행정 역량 강화 사업',
      'AKDIx 프로젝트',
      'KDIx 프로젝트',
      'xKSP 프로젝트',
    ];

    for (const name of markedNames) expect(isGuestHiddenProjectName(name)).toBe(true);
    for (const name of unmarkedNames) expect(isGuestHiddenProjectName(name)).toBe(false);
  });

  it('손님 목록은 비어 있고 member 목록은 그대로 반환한다', async () => {
    addProject('proj-hidden-list', 'KDI 협력 사업');
    addProject('proj-visible-list', '가상국 디지털 행정 역량 강화 사업');

    const guestPage = await ProjectsPage();
    const guestActionProjects = await getProjectsAction();
    expect(guestPage.props.initialProjects).toEqual([]);
    expect(guestActionProjects).toEqual([]);

    vi.mocked(headers).mockImplementation(
      async () => new Headers({ 'x-auth-request-user': 'member-user' }) as never
    );
    const memberPage = await ProjectsPage();
    const memberActionProjects = await getProjectsAction();
    expect(memberPage.props.initialProjects).toHaveLength(2);
    expect(memberActionProjects).toHaveLength(2);
  });

  it('손님은 표시 대상 사업의 직접 주소, route, server action에서 404를 받는다', async () => {
    addProject('proj-hidden-direct', '우즈베키스탄 행정 사업');
    addDocument('doc-hidden-direct', 'proj-hidden-direct');

    await expect(
      ProjectLayout({
        children: null,
        params: Promise.resolve({ projectId: 'proj-hidden-direct' }),
      })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    const response = await downloadReport(
      new Request('http://localhost/projects/proj-hidden-direct/report/download') as never,
      { params: Promise.resolve({ projectId: 'proj-hidden-direct' }) }
    );
    expect(response.status).toBe(404);

    await expect(
      updateDocumentTypeAction('proj-hidden-direct', 'doc-hidden-direct', '성과관리표')
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getDocument('doc-hidden-direct')?.doc_type).toBe('사업계획서');
  });

  it('손님 page loader는 표시 대상 사업의 데이터를 읽기 전에 모두 notFound를 던진다', async () => {
    addProject('proj-hidden-rsc', 'KSP 평가 사업');

    const pageDataReaders = [
      vi.spyOn(projectStore, 'getReportTargets'),
      vi.spyOn(reportPageState, 'resolveReviewPageState'),
      vi.spyOn(historyPageState, 'resolveHistoryPageState'),
      vi.spyOn(resultPageState, 'resolveResultTocPageState'),
      vi.spyOn(documentActions, 'getDocumentsPageData'),
      vi.spyOn(tocActions, 'getTocPageDataAction'),
    ];
    const params = Promise.resolve({ projectId: 'proj-hidden-rsc' });
    const pageLoaders = [
      () => ReportPage({ params }),
      () => ReviewPage({ params }),
      () => HistoryPage({ params }),
      () => ResultTocPage({ params }),
      () => DocumentsPage({ params }),
      () => TocPage({ params }),
    ];

    for (const loadPage of pageLoaders) {
      await expect(loadPage()).rejects.toThrow('NEXT_NOT_FOUND');
    }
    for (const readPageData of pageDataReaders) {
      expect(readPageData).not.toHaveBeenCalled();
    }
  });

  it('member는 표시 대상 사업의 직접 주소와 route에 접근할 수 있다', async () => {
    addProject('proj-member-visible', '한국개발연구원 평가 사업');
    addDocument('doc-member-visible', 'proj-member-visible');
    vi.mocked(headers).mockImplementation(
      async () => new Headers({ 'x-auth-request-user': 'member-user' }) as never
    );

    const page = await ProjectLayout({
      children: 'member-content',
      params: Promise.resolve({ projectId: 'proj-member-visible' }),
    });
    expect(page).toBe('member-content');

    await updateDocumentTypeAction('proj-member-visible', 'doc-member-visible', '성과관리표');
    const reportPage = await ReportPage({
      params: Promise.resolve({ projectId: 'proj-member-visible' }),
    });
    expect(reportPage.props.project.id).toBe('proj-member-visible');

    const update = await updateDocumentTypeAction(
      'proj-member-visible',
      'doc-member-visible',
      '성과관리표'
    );
    expect(update.success).toBe(true);

  });

  it('손님은 일반 사업의 쓰기도 로그인 전 차단된다', async () => {
    addProject('proj-guest-write', '가상국 디지털 행정 역량 강화 사업');
    addDocument('doc-guest-write', 'proj-guest-write');

    await expect(updateDocumentTypeAction('proj-guest-write', 'doc-guest-write', '성과관리표')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getDocument('doc-guest-write')?.doc_type).toBe('사업계획서');
  });
});
