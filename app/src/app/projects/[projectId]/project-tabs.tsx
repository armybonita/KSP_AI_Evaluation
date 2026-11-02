'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getProjectNavigationAction } from './navigation-actions';
import { projectTabIdsForRole } from '../../workflow-navigation';

export type ProjectScreen = 'documents' | 'ontology' | 'toc' | 'review' | 'history' | 'report' | 'portfolio' | 'result';

interface ProjectTabsProps {
  projectId: string;
  activeScreen: ProjectScreen;
  selectedIndicatorId?: string;
}

const PATH_STEPS = [
  { id: 'toc', label: '② 초기 ToC', href: (projectId: string) => `/projects/${projectId}/toc` },
  { id: 'ontology', label: '② 상세 그래프', href: (projectId: string) => `/projects/${projectId}/toc?view=graph` },
  { id: 'report', label: '⑧ 종료평가보고서', href: (projectId: string) => `/projects/${projectId}/report` },
  { id: 'portfolio', label: '⑨ 포트폴리오', href: (projectId: string) => `/projects/${projectId}/portfolio` },
  { id: 'result', label: '⑩ 결과 ToC', href: (projectId: string) => `/projects/${projectId}/result` },
] as const;

export function ProjectTabs({ projectId, activeScreen }: ProjectTabsProps) {
  const [access, setAccess] = useState<{ role: 'Admin' | '평가팀' | 'PO' | '기획팀'; hasPdm: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    getProjectNavigationAction(projectId).then((value) => {
      if (active) setAccess(value);
    }).catch(() => {
      if (active) setAccess(null);
    });
    return () => { active = false; };
  }, [projectId]);

  if (!access || !['toc', 'ontology', 'report', 'portfolio', 'result'].includes(activeScreen)) return null;
  const allowed = new Set(projectTabIdsForRole(access.role));
  return <nav role="tablist" aria-label="성과 경로 단계" className="flex gap-1 mt-4 overflow-x-auto border-b border-gray-200 text-sm font-medium">
    {PATH_STEPS.filter(({ id }) => allowed.has(id)).map(({ id, label, href }) => {
      const isActive = id === activeScreen;
      const locked = !access.hasPdm;
      const className = `whitespace-nowrap px-4 py-2 ${isActive ? 'border-b-2 border-blue-600 text-blue-600 font-bold' : 'text-gray-600 hover:text-gray-900 transition'} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`;
      return locked
        ? <span key={id} role="tab" aria-selected="false" aria-disabled="true" title="성과관리표(PDM) 등록 후 열 수 있습니다" data-testid={`project-tab-${id}`} className={className}>{label} · PDM 필요</span>
        : <Link key={id} href={href(projectId)} role="tab" aria-selected={isActive} aria-current={isActive ? 'page' : undefined} data-testid={`project-tab-${id}`} className={className}>{label}</Link>;
    })}
  </nav>;
}
