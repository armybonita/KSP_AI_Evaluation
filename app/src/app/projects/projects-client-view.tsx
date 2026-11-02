'use client';

import type { UserRole } from '@/server/viewer';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ProjectMetadata, ProjectWithCount } from '@/server/store/types';
import { FailureMessage } from './[projectId]/failure-message';
import { createProjectAction, updateProjectMetadataAction } from './actions';
import { filterProjects, projectReviewStatus } from './project-list-state';
import { projectCardHref } from '../workflow-navigation';

interface ProjectsClientViewProps {
  initialProjects: ProjectWithCount[];
  // #53: 손님은 사업 만들기 칸을 보지 않는다(서버에서도 거절).
  canCreate?: boolean;
  canRegisterDocuments?: boolean;
  canManageMetadata?: boolean;
  canOpenInitialToc?: boolean;
  isPlanningViewer?: boolean;
  role?: UserRole;
}

export function ProjectsClientView({ initialProjects, canCreate = true, canRegisterDocuments = true, canManageMetadata = true, canOpenInitialToc = true, isPlanningViewer = false, role = isPlanningViewer ? '기획팀' : '평가팀' }: ProjectsClientViewProps) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithCount[]>(initialProjects);
  const [projectName, setProjectName] = useState('');
  const [draftMetadata, setDraftMetadata] = useState<ProjectMetadata>({});
  const [yearFilter, setYearFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [metadataMessage, setMetadataMessage] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [createFailure, setCreateFailure] = useState<{ message: string; projectName: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const runCreate = (name: string) => {
    setValidationError(null);
    setCreateFailure(null);
    startTransition(async () => {
      try {
        const res = await createProjectAction(name, draftMetadata);
        if (res.success && res.projectId) {
          setProjectName('');
          setDraftMetadata({});
          // 새 사업 목록 맨 위에 반영 후 S2 로 이동 (FE-15, UC-01)
          router.push(`/projects/${res.projectId}/documents`);
          router.refresh();
        } else {
          setCreateFailure({
            message: res.error ?? '사업 생성 중 오류가 발생했습니다.',
            projectName: name,
          });
        }
      } catch (err) {
        setCreateFailure({
          message: err instanceof Error ? err.message : String(err),
          projectName: name,
        });
      }
    });
  };

  const filteredProjects = useMemo(() => filterProjects(projects, { year: yearFilter, country: countryFilter, region: regionFilter, status: statusFilter, search }), [projects, yearFilter, countryFilter, regionFilter, statusFilter, search]);
  const years = [...new Set(projects.map((p) => p.project_year).filter((y): y is number => Boolean(y)))].sort((a, b) => b - a);
  const countries = [...new Set(projects.map((p) => p.country).filter((x): x is string => Boolean(x)))].sort();
  const regions = [...new Set(projects.map((p) => p.region).filter((x): x is string => Boolean(x)))].sort();
  const statuses = [...new Set(projects.map(projectReviewStatus))];
  const saveMetadata = async (projectId: string, metadata: ProjectMetadata) => {
    const result = await updateProjectMetadataAction(projectId, metadata);
    setMetadataMessage((current) => ({ ...current, [projectId]: result.success ? '메타 정보를 저장했습니다.' : (result.error ?? '저장하지 못했습니다.') }));
    if (result.success) setProjects((current) => current.map((p) => p.id === projectId ? { ...p, ...metadata } : p));
  };

  const formatMetadataInput = (label: string, name: keyof ProjectMetadata, value: string | number | null | undefined) => (
    <label key={name} className="block text-xs text-gray-600">{label}
      <input name={name} type={name === 'project_year' ? 'number' : 'text'} defaultValue={value ?? ''} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900" />
    </label>
  );
  const endedSelect = (value: number | null | undefined, controlled = false) => (
    <label className="block text-xs text-gray-600">사업 상태
      <select name="is_ended" value={controlled ? (draftMetadata.is_ended == null ? '' : String(draftMetadata.is_ended)) : undefined} defaultValue={controlled ? undefined : (value == null ? '' : String(value))} onChange={controlled ? (event) => setDraftMetadata((current) => ({ ...current, is_ended: event.target.value === '' ? null : Number(event.target.value) })) : undefined} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900">
        <option value="">미등록</option><option value="0">진행 중</option><option value="1">종료</option>
      </select>
    </label>
  );
  const sourceSelect = (value: ProjectMetadata['metadata_source'], controlled = false) => (
    <label className="block text-xs text-gray-600">메타 출처
      <select name="metadata_source" value={controlled ? (draftMetadata.metadata_source ?? '') : undefined} defaultValue={controlled ? undefined : (value ?? '')} onChange={controlled ? (event) => setDraftMetadata((current) => ({ ...current, metadata_source: event.target.value === '' ? null : event.target.value as ProjectMetadata['metadata_source'] })) : undefined} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900">
        <option value="">미등록</option><option value="종료평가보고서">종료평가보고서</option><option value="등록 정보">등록 정보</option>
      </select>
    </label>
  );
  const createMetadataInput = (label: string, name: keyof ProjectMetadata) => (
    <label key={name} className="block text-xs text-gray-600">{label}
      <input type={name === 'project_year' ? 'number' : 'text'} value={draftMetadata[name] ?? ''} onChange={(event) => setDraftMetadata((current) => ({ ...current, [name]: name === 'project_year' ? (event.target.value ? Number(event.target.value) : null) : event.target.value }))} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm text-gray-900" />
    </label>
  );
  const readMetadata = (form: HTMLFormElement): ProjectMetadata => {
    const data = new FormData(form);
    const value = (name: keyof ProjectMetadata) => String(data.get(name) ?? '').trim() || null;
    const year = value('project_year');
    const source = value('metadata_source');
    return {
      project_year: year ? Number(year) : null,
      country: value('country'), region: value('region'), partner_ministry: value('partner_ministry'),
      project_type: value('project_type'), kdi_cid: value('kdi_cid'), implementing_org: value('implementing_org'),
      partner_government_org: value('partner_government_org'), is_ended: value('is_ended') == null ? null : Number(value('is_ended')),
      pilot_label: value('pilot_label'), metadata_source: source === '종료평가보고서' || source === '등록 정보' ? source : null,
    };
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = projectName.trim();
    if (!trimmed) {
      // D47: 빈 이름 오류 - 칸 아래 한 줄
      setValidationError('사업 이름을 입력해 주세요.');
      setCreateFailure(null);
      return;
    }
    runCreate(trimmed);
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* 상단 헤더 */}
        <header className="border-b border-gray-200 pb-4 flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
              ① 사업 목록
            </span>
            <h1 className="text-2xl font-bold text-gray-900">사업 목록</h1>
          </div>
          <div className="text-sm text-gray-500">AiEAS 성과평가 지원</div>
        </header>

        {/* 새 사업 만들기 카드 (SP §S1). 손님에게는 숨긴다(#53). */}
        {!canCreate && (
          <p
            data-testid="guest-create-blocked-notice"
            className="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl shadow-sm p-4"
          >
            손님 평가자는 새 사업을 만들 수 없습니다. 아래 시험 사업을 눌러 보십시오.
          </p>
        )}
        {canCreate && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4">
          <form onSubmit={handleCreate} className="space-y-2">
            <label
              htmlFor="projectNameInput"
              className="block text-sm font-semibold text-gray-800"
            >
              새 사업 만들기
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                id="projectNameInput"
                type="text"
                value={projectName}
                onChange={(e) => {
                  setProjectName(e.target.value);
                  if (validationError) setValidationError(null);
                  if (createFailure) setCreateFailure(null);
                }}
                disabled={isPending}
                placeholder="사업 이름을 입력하세요"
                data-testid="project-name-input"
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
              />
              <button
                type="submit"
                disabled={isPending}
                data-testid="project-create-button"
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {isPending ? '만드는 중...' : '만들기'}
              </button>
            </div>
            {/* D47: 실패·빈칸 한 줄 표시 */}
            {validationError && (
              <p
                role="alert"
                data-testid="project-name-error"
                className="text-sm text-red-600 mt-1 font-medium"
              >
                {validationError}
              </p>
            )}
            {createFailure && (
              <FailureMessage
                message={createFailure.message}
                onRetry={() => runCreate(createFailure.projectName)}
                isRetrying={isPending}
                testId="project-name-error"
              />
            )}
          </form>
          <details className="border-t pt-3">
            <summary className="cursor-pointer text-sm font-semibold text-gray-700">사업 메타 정보 (선택)</summary>
            <div className="grid grid-cols-1 gap-2 pt-3 sm:grid-cols-2 lg:grid-cols-3">
              {createMetadataInput('연도', 'project_year')}{createMetadataInput('국가', 'country')}{createMetadataInput('지역', 'region')}
              {createMetadataInput('협력국 부처', 'partner_ministry')}{createMetadataInput('사업 유형', 'project_type')}{createMetadataInput('KDI CID', 'kdi_cid')}
              {createMetadataInput('수행기관', 'implementing_org')}{createMetadataInput('협력국 정부기관', 'partner_government_org')}
              {endedSelect(draftMetadata.is_ended, true)}{createMetadataInput('파일럿 표시', 'pilot_label')}{sourceSelect(draftMetadata.metadata_source, true)}
            </div>
          </details>
        </div>
        )}

        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-label="사업 필터">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="text-xs font-medium text-gray-600">연도<select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"><option value="">전체</option>{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">국가<select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"><option value="">전체</option>{countries.map((country) => <option key={country}>{country}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">지역<select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"><option value="">전체</option>{regions.map((region) => <option key={region}>{region}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">검토상태<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm"><option value="">전체</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
            <label className="text-xs font-medium text-gray-600">사업명·국가·부처 검색<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="검색어" className="mt-1 block w-full rounded border border-gray-300 p-2 text-sm" /></label>
          </div>
        </section>

        <section className="space-y-3" aria-label="사업 카드 목록">
          <h2 className="px-1 text-base font-semibold text-gray-900">등록된 사업 <span className="text-sm font-normal text-gray-500">{filteredProjects.length}건</span></h2>
          {projects.length === 0 ? (
            <div data-testid="empty-projects-notice" className="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
              <p className="font-medium text-gray-600">{canCreate ? '아직 사업이 없습니다. 위에 이름을 적고 만드세요.' : '아직 사업이 없습니다.'}</p>
              <p className="mt-1 text-xs text-gray-400">사업을 만들면 자료 등록으로 이동합니다.</p>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div role="status" data-testid="empty-filtered-projects" className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-600">조건에 맞는 사업이 없습니다. 필터를 바꾸거나 검색어를 지워 보세요.</div>
          ) : (
            <div className="space-y-3" data-testid="projects-cards">
              {filteredProjects.map((project) => {
                const bothDocsRegistered = Boolean(project.pdm_document && project.pcp_document);
                const entryHref = projectCardHref({
                  projectId: project.id,
                  hasPdm: Boolean(project.has_pdm),
                  role,
                });
                return (
                <article
                  key={project.id}
                  data-testid={`project-card-${project.id}`}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest('a,button,input,select,textarea,summary,details,label')) return;
                    if (entryHref) router.push(entryHref);
                  }}
                  className={`rounded-xl border border-gray-200 bg-white p-5 shadow-sm ${entryHref ? 'cursor-pointer transition hover:border-blue-300' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><h3 className="text-lg font-bold text-gray-900">{entryHref ? <Link href={entryHref} data-testid={`project-card-open-${project.id}`} className="rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">{project.country || '국가 미등록'} · {project.name}</Link> : <span data-testid={`project-card-open-${project.id}`} aria-disabled="true">{project.country || '국가 미등록'} · {project.name} · PDM 필요</span>}</h3><p className="mt-1 text-sm text-gray-600">{project.project_year ? `${project.project_year}년 · ` : ''}{project.project_type || '사업 유형 미등록'}</p></div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{project.is_ended == null ? '종료 여부 미등록' : project.is_ended ? '종료' : '진행 중'}</span>
                    {project.pilot_label && <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{project.pilot_label}</span>}
                    {project.metadata_source && <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">메타: {project.metadata_source}</span>}
                    {!bothDocsRegistered && !project.has_pdm && <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">자료 대기</span>}
                  </div>
                  {!bothDocsRegistered && canRegisterDocuments && (
                    <section aria-label="PDM 사전 등록 안내" className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                      <p className="font-semibold">이전 연도 사업은 종료평가보고서 메타 자료를 확인하고, 당해 연도 사업은 등록 정보를 사용합니다.</p>
                      <p>초기 성과 경로를 열려면 평가팀이 성과관리표(PDM)와 국문 PCP를 먼저 자료로 등록해야 합니다. 서식이 다른 경우 원본을 보존하고 변환 결과를 확인하세요.</p>
                    </section>
                  )}
                  <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <div><dt className="inline text-gray-500">국가·지역: </dt><dd className="inline text-gray-900">{[project.country, project.region].filter(Boolean).join(' · ') || '미등록'}</dd></div>
                    <div><dt className="inline text-gray-500">협력국 부처: </dt><dd className="inline text-gray-900">{project.partner_ministry || '미등록'}</dd></div>
                    <div><dt className="inline text-gray-500">KDI CID: </dt><dd className="inline text-gray-900">{project.kdi_cid || '미등록'}</dd></div>
                    <div><dt className="inline text-gray-500">수행기관: </dt><dd className="inline text-gray-900">{project.implementing_org || '미등록'}</dd></div>
                    <div><dt className="inline text-gray-500">협력국 정부기관: </dt><dd className="inline text-gray-900">{project.partner_government_org || '미등록'}</dd></div>
                    <div><dt className="inline text-gray-500">담당 역할: </dt><dd className="inline text-gray-900">PM · PO</dd></div>
                  </dl>
                  <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3 text-sm">
                    <span className="rounded-full bg-blue-50 px-3 py-1 font-semibold text-blue-800">{projectReviewStatus(project)}</span>
                    <span className="text-gray-600">평가자: {project.evaluator_name || '평가팀'}</span>
                    <span className="font-semibold text-amber-800">보완 필요: {project.review_total && project.needs_revision_count !== null ? `${project.needs_revision_count}건` : '미집계'}</span>
                    <span className="text-gray-500">검토: {project.review_total ? `${project.reviewed_count}/${project.review_total}` : '—'}</span>
                    <span className="text-gray-500">등록 자료: {project.document_count}건</span>
                    <span className="text-gray-500">PCP {project.has_pcp ? '등록' : '미등록'}</span>
                  </div>

                  {!isPlanningViewer && canRegisterDocuments && (
                    <div data-testid={`project-registered-docs-${project.id}`} className="mt-4 rounded-xl border border-blue-100 bg-blue-50/40 p-3 text-sm">
                      <div className="text-xs font-semibold text-gray-600 mb-2">사전 등록 자료 (PDM · 국문 PCP)</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {/* PDM */}
                        <div
                          data-testid={`project-doc-pdm-${project.id}`}
                          className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-2.5 shadow-2xs"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold text-gray-500">성과관리표(PDM)</span>
                            {project.pdm_document ? (
                              <span className="block truncate text-sm font-medium text-gray-900" title={project.pdm_document.file_name}>
                                {project.pdm_document.file_name} <span className="text-xs text-gray-500 font-normal">({project.pdm_document.created_at.slice(0, 10)})</span>
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-amber-700">등록 필요</span>
                            )}
                          </div>
                          {project.pdm_document ? (
                            <Link
                              href={`/projects/${project.id}/documents?docId=${project.pdm_document.id}`}
                              data-testid={`open-pdm-${project.id}`}
                              className="rounded border border-blue-600 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 shrink-0"
                            >
                              열기
                            </Link>
                          ) : (
                            <Link
                              href={`/projects/${project.id}/documents`}
                              data-testid={`register-pdm-${project.id}`}
                              className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 shrink-0"
                            >
                              등록 필요
                            </Link>
                          )}
                        </div>

                        {/* 국문 PCP */}
                        <div
                          data-testid={`project-doc-pcp-${project.id}`}
                          className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white p-2.5 shadow-2xs"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold text-gray-500">국문 PCP</span>
                            {project.pcp_document ? (
                              <span className="block truncate text-sm font-medium text-gray-900" title={project.pcp_document.file_name}>
                                {project.pcp_document.file_name} <span className="text-xs text-gray-500 font-normal">({project.pcp_document.created_at.slice(0, 10)})</span>
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-amber-700">등록 필요</span>
                            )}
                          </div>
                          {project.pcp_document ? (
                            <Link
                              href={`/projects/${project.id}/documents?docId=${project.pcp_document.id}`}
                              data-testid={`open-pcp-${project.id}`}
                              className="rounded border border-blue-600 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 shrink-0"
                            >
                              열기
                            </Link>
                          ) : (
                            <Link
                              href={`/projects/${project.id}/documents`}
                              data-testid={`register-pcp-${project.id}`}
                              className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 shrink-0"
                            >
                              등록 필요
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {isPlanningViewer ? (project.has_pdm ? <Link href={`/projects/${project.id}/result`} data-testid={`open-result-${project.id}`} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">종합 결과 보기</Link> : <span aria-disabled="true" className="rounded-lg bg-gray-200 px-3 py-2 text-sm text-gray-500">종합 결과 보기 · PDM 필요</span>) : <>
                      {!bothDocsRegistered && canRegisterDocuments && <Link href={`/projects/${project.id}/documents`} data-testid={`project-link-${project.id}`} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">PDM·PCP 사전 등록 / 자료 등록</Link>}
                      {canOpenInitialToc && (project.has_pdm ? <Link href={`/projects/${project.id}/toc`} data-testid={`open-toc-${project.id}`} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">초기 ToC 열기</Link> : <button type="button" disabled data-testid={`open-toc-locked-${project.id}`} title="성과관리표(PDM) 등록 후 열 수 있습니다" className="cursor-not-allowed rounded-lg bg-gray-200 px-3 py-2 text-sm font-semibold text-gray-500">초기 ToC 열기 · PDM 필요</button>)}
                    </>}
                    {canManageMetadata && <details className="basis-full pt-1">
                      <summary className="cursor-pointer text-xs font-medium text-gray-600">사업 메타 정보 편집</summary>
                      <form className="grid grid-cols-1 gap-2 pt-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => { event.preventDefault(); void saveMetadata(project.id, readMetadata(event.currentTarget)); }}>
                        {formatMetadataInput('연도', 'project_year', project.project_year)}
                        {formatMetadataInput('국가', 'country', project.country)}
                        {formatMetadataInput('지역', 'region', project.region)}
                        {formatMetadataInput('협력국 부처', 'partner_ministry', project.partner_ministry)}
                        {formatMetadataInput('사업 유형', 'project_type', project.project_type)}
                        {formatMetadataInput('KDI CID', 'kdi_cid', project.kdi_cid)}
                        {formatMetadataInput('수행기관', 'implementing_org', project.implementing_org)}
                        {formatMetadataInput('협력국 정부기관', 'partner_government_org', project.partner_government_org)}
                        {endedSelect(project.is_ended)}
                        {formatMetadataInput('파일럿 표시', 'pilot_label', project.pilot_label)}
                        {sourceSelect(project.metadata_source)}
                        <button type="submit" className="self-end rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold">메타 정보 저장</button>
                        {metadataMessage[project.id] && <p role="status" className="self-center text-sm text-green-700">{metadataMessage[project.id]}</p>}
                      </form>
                    </details>}
                  </div>
                </article>
              );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
