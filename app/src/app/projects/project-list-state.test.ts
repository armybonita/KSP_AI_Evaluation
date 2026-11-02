import { describe, expect, it } from 'vitest';
import type { ProjectWithCount } from '@/server/store/types';
import { filterProjects, projectReviewStatus } from './project-list-state';

const rows: ProjectWithCount[] = [
  { id: 'one', name: '헝가리 가상사업', created_at: '2026-01-01', project_year: 2025, country: '헝가리', region: '중부', partner_ministry: '가상 부처', document_count: 2, has_pdm: 1, has_pcp: 1, review_total: 4, reviewed_count: 2, needs_revision_count: 1 },
  { id: 'two', name: '우즈베키스탄 가상사업', created_at: '2026-01-02', project_year: 2026, country: '우즈베키스탄', region: '중앙아시아', partner_ministry: '가상 부처2', document_count: 1, has_pdm: 0, has_pcp: 0, review_total: 0, reviewed_count: 0, needs_revision_count: null },
];

describe('사업 목록 필터', () => {
  it('연도·국가·지역·상태 필터를 함께 적용한다', () => {
    expect(filterProjects(rows, { year: '2025', country: '헝가리', region: '중부', status: '검토 중 (2/4)', search: '' }).map((p) => p.id)).toEqual(['one']);
  });

  it('검색은 사업명·국가·부처에 적용하고 결과가 없으면 빈 목록을 돌려준다', () => {
    expect(filterProjects(rows, { year: '', country: '', region: '', status: '', search: '가상 부처2' }).map((p) => p.id)).toEqual(['two']);
    expect(filterProjects(rows, { year: '', country: '', region: '', status: '', search: '없는 검색어' })).toEqual([]);
  });

  it('PDM 미등록 사업은 자료 대기, 등록 뒤에는 진행 상황을 표시한다', () => {
    expect(projectReviewStatus(rows[1])).toBe('자료 대기');
    expect(projectReviewStatus(rows[0])).toBe('검토 중 (2/4)');
  });
});
