import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentViewer } from '@/server/viewer';
import PortfolioPage from './page';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ refresh: vi.fn() }), usePathname: () => '' }));
vi.mock('@/server/viewer', async (original) => ({ ...await original<typeof import('@/server/viewer')>(), currentViewer: vi.fn() }));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: () => true }));
vi.mock('@/server/store/portfolio', () => ({ getPortfolioPageData: () => ({
  projectId: 'project', projectName: '가상 사업', importId: 'import',
  outcomes: [{ id: 'outcome', type: 'outcome-short', title: '가상 성과', text: '', outcomeFamily: '지식 네트워킹', aiLevel: '', reviewStatus: '확정', outcomeState: '관측됨', evidenceEligible: true, evidenceObserved: true, teamLevel: null, teamLevelSource: null, history: [] }],
  summary: { projectId: 'project', projectName: '가상 사업', knowledge: { level: null, emptyReason: 'no_family_outcomes' }, cooperation: { level: null, emptyReason: 'team_level_missing' }, quadrant: null },
}) }));

describe('포트폴리오 편집 권한', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([['PO', false], ['평가팀', true], ['Admin', true]] as const)('%s 역할에 저장 권한을 반영한다', async (role, canEdit) => {
    vi.mocked(currentViewer).mockResolvedValue({ kind: 'member', login: 'test', role });
    const markup = renderToStaticMarkup(await PortfolioPage({ params: Promise.resolve({ projectId: 'project' }) }));
    expect(/<button\b[^>]*>수정 저장<\/button>/.test(markup)).toBe(canEdit);
    expect(markup.includes('<select')).toBe(canEdit);
    if (canEdit) expect(markup).toContain('Lv5');
  });
});
