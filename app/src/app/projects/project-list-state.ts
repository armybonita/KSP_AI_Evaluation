import type { ProjectWithCount } from '@/server/store/types';

export interface ProjectListFilters {
  year: string;
  country: string;
  region: string;
  status: string;
  search: string;
}

export function projectReviewStatus(project: ProjectWithCount): string {
  if (!project.has_pdm) return '자료 대기';
  if (!project.review_total) return '미검토';
  if (!project.reviewed_count) return '분석 완료 · 미검토';
  return `검토 중 (${project.reviewed_count}/${project.review_total})`;
}

export function filterProjects(projects: readonly ProjectWithCount[], filters: ProjectListFilters): ProjectWithCount[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return projects.filter((project) => {
    const haystack = [project.name, project.country, project.partner_ministry].filter(Boolean).join(' ').toLocaleLowerCase();
    return (!filters.year || String(project.project_year ?? '') === filters.year)
      && (!filters.country || (project.country ?? '') === filters.country)
      && (!filters.region || (project.region ?? '') === filters.region)
      && (!filters.status || projectReviewStatus(project) === filters.status)
      && (!query || haystack.includes(query));
  });
}
