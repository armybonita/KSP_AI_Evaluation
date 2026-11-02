import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({})),
  getSavedReportDraftWithStatus: vi.fn((_projectId: string, _db: unknown, _a: unknown, _b: unknown, reportId?: string) => ({
    draft: { project_id: 'project', created_at: reportId, footnotes: [] }, isOutdated: false,
  })),
}));

vi.mock('@/server/store', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('@/server/report', () => ({ getSavedReportDraftWithStatus: mocks.getSavedReportDraftWithStatus }));
vi.mock('@/server/viewer', () => ({ currentViewer: vi.fn(async () => ({ kind: 'member', role: '평가팀' })) }));
vi.mock('@/server/project-visibility', () => ({ assertProjectVisibleToCurrentViewer: vi.fn() }));
vi.mock('@/server/project-pdm', () => ({ isProjectPdmRegistered: vi.fn(() => true), projectPdmExclusionReason: vi.fn() }));
vi.mock('@/lib/workflow-access', () => ({ canAccessWorkflowScreen: vi.fn(() => true) }));

import { getReportVersionAction } from './actions';

describe('saved report version selection', () => {
  it('loads a version without recalculating document notice data', async () => {
    const newer = await getReportVersionAction('project', 'newer');
    const older = await getReportVersionAction('project', 'older');

    expect(newer.success).toBe(true);
    expect(older.success).toBe(true);
  });
});
