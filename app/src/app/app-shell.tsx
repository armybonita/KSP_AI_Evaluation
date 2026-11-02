'use client';

import { roleCanAccessWorkflowScreen } from '@/lib/workflow-access';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import type { UserRole } from '@/server/viewer';
import { getProjectsAction } from './projects/actions';
import { getProjectNavigationAction } from './projects/[projectId]/navigation-actions';
import { activeWorkflowMenu, visibleWorkflowMenus, workflowMenuHref } from './workflow-navigation';

export function AppShell({ children, role, login }: {
  children: React.ReactNode;
  role: UserRole;
  login: string;
}) {
  const pathname = usePathname();
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const [rememberedProjectId, setRememberedProjectId] = useState<string>();
  const [selectionRestored, setSelectionRestored] = useState(false);
  const selectedProjectId = projectId ?? rememberedProjectId;
  const selected = activeWorkflowMenu(pathname);
  const [projectNameState, setProjectNameState] = useState<{ projectId: string; name: string } | null>(null);
  const projectName = projectNameState && projectNameState.projectId === selectedProjectId ? projectNameState.name : '';
  const [navigation, setNavigation] = useState<{ projectId: string; hasPdm: boolean } | null>(null);
  const hasPdm = navigation && navigation.projectId === selectedProjectId ? navigation.hasPdm : null;

  useEffect(() => {
    try {
      if (projectId) {
        sessionStorage.setItem('aieas-selected-project', projectId);
        setRememberedProjectId(projectId);
      } else {
        setRememberedProjectId(sessionStorage.getItem('aieas-selected-project') ?? undefined);
      }
    } catch {
      setRememberedProjectId(projectId);
    } finally {
      setSelectionRestored(true);
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    if (!selectedProjectId) {
      setProjectNameState(null);
      return () => { active = false; };
    }
    getProjectsAction().then((projects) => {
      if (!active) return;
      const project = projects.find((item) => item.id === selectedProjectId);
      setProjectNameState({ projectId: selectedProjectId, name: project ? [project.country, project.name].filter(Boolean).join(' · ') : '사업' });
    }).catch(() => {
      if (active) setProjectNameState({ projectId: selectedProjectId, name: '사업' });
    });
    return () => { active = false; };
  }, [selectedProjectId]);

  useEffect(() => {
    let active = true;
    if (!selectedProjectId) {
      setNavigation(null);
      return () => { active = false; };
    }
    const refreshNavigation = () => {
      getProjectNavigationAction(selectedProjectId).then((nav) => {
        if (active) setNavigation({ projectId: selectedProjectId, hasPdm: nav?.hasPdm ?? false });
      }).catch(() => {
        if (active) setNavigation(null);
      });
    };
    refreshNavigation();
    window.addEventListener('aieas-project-navigation-updated', refreshNavigation);
    return () => {
      active = false;
      window.removeEventListener('aieas-project-navigation-updated', refreshNavigation);
    };
  }, [selectedProjectId, pathname]);
  const menus = visibleWorkflowMenus(role);

  return <>
    <header className="app-header">
      <div className="app-header-top">
        <div className="flex items-center gap-4"><Link href="/projects" className="app-brand" aria-label="AiEAS 사업 목록">AiEAS</Link><span data-testid="selected-project">{selectedProjectId ? projectName || '사업' : '사업 목록'}</span></div>
        <div className="app-header-context">
          {role === 'Admin' && projectId && <Link href={`/projects/${projectId}/history`} className="app-admin-link">Admin</Link>}
          {role === 'Admin' && <Link href="/admin/users" className="app-admin-link">사용자 권한</Link>}
          <span className="app-role">{role}</span>
          <span className="app-login">{login}</span>
          {projectId && roleCanAccessWorkflowScreen(role, 'documents') && <Link className="app-document-link" href={`/projects/${projectId}/documents`}>문서</Link>}
        </div>
      </div>
      <nav className="app-main-nav" aria-label="주 메뉴">
        {menus.map((menu) => {
          const needsPdm = ['path', 'review', 'report'].includes(menu.id);
          const loading = menu.id !== 'projects' && ((!projectId && !selectionRestored) || (!!selectedProjectId && hasPdm === null));
          const destination = menu.id === 'path' ? (role === '기획팀' ? 'result' : 'toc') : menu.id;
          const allowed = destination === 'projects' || roleCanAccessWorkflowScreen(role, destination);
          const locked = menu.id !== 'projects' && (!allowed || !selectedProjectId || (needsPdm && !hasPdm));
          const current = selected === menu.id;
          const className = current ? 'active' : undefined;
          if (loading) return <span key={menu.id} data-testid={`main-menu-placeholder-${menu.id}`} aria-hidden="true" style={{ visibility: 'hidden' }}>{menu.label}</span>;
          if (locked) return <span
            key={menu.id}
            aria-disabled="true"
            aria-current={current ? 'page' : undefined}
            title={!selectedProjectId ? '사업을 선택하면 열 수 있습니다' : '성과관리표(PDM) 등록 후 열 수 있습니다'}
            className={`locked ${className ?? ''}`}
            data-testid={`main-menu-${menu.id}`}
          >{menu.label}{selectedProjectId && needsPdm ? ' · PDM 필요' : ''}</span>;
          return <Link
            key={menu.id}
            href={menu.id === 'projects' ? '/projects' : workflowMenuHref(menu.id, selectedProjectId!, role)}
            aria-current={current ? 'page' : undefined}
            className={className}
            data-testid={`main-menu-${menu.id}`}
          >{menu.label}</Link>;
        })}
      </nav>
    </header>
    {children}
  </>;
}
