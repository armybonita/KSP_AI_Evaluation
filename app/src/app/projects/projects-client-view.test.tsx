import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectWithCount } from '@/server/store/types';
import { ProjectsClientView } from './projects-client-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('./actions', () => ({ createProjectAction: vi.fn(), updateProjectMetadataAction: vi.fn() }));

const project: ProjectWithCount = {
  id: 'p1', name: '가상 평가 사업', created_at: '2026-01-01', project_year: 2025,
  country: '가상국', region: '가상지역', partner_ministry: '가상 부처', project_type: '종료평가',
  kdi_cid: 'CID-1', implementing_org: '가상 수행기관', partner_government_org: '가상 정부기관',
  is_ended: 1, pilot_label: '파일럿 1', metadata_source: '종료평가보고서', document_count: 1,
  has_pdm: 0, has_pcp: 0, review_total: 0, reviewed_count: 0, needs_revision_count: null,
};

describe('사업 목록 카드 화면', () => {
  it('사업 메타를 표시하고 PDM이 없으면 초기 ToC 진입을 잠근다', () => {
    const markup = renderToStaticMarkup(<ProjectsClientView initialProjects={[project]} canCreate={false} canManageMetadata={false} />);
    expect(markup).toContain('가상국 · 가상 평가 사업');
    expect(markup).toContain('협력국 부처: </dt><dd class="inline text-gray-900">가상 부처');
    expect(markup).toContain('종료');
    expect(markup).toContain('파일럿 1');
    expect(markup).toContain('PM · PO');
    expect(markup).toContain('평가자: 평가팀');
    expect(markup).toContain('open-toc-locked-p1');
    expect(markup).toMatch(/<a[^>]*data-testid="project-card-open-p1"[^>]*href="\/projects\/p1\/documents"/);
    expect(markup).toContain('연도');
    expect(markup).toContain('지역');
    expect(markup).toContain('검색');
    expect(markup).not.toContain('사업 메타 정보 편집');
  });

  it('기획팀 사업 카드에는 종합 결과 진입만 제공한다', () => {
    const markup = renderToStaticMarkup(<ProjectsClientView initialProjects={[project]} canCreate={false} canManageMetadata={false} canOpenInitialToc={false} canRegisterDocuments={false} isPlanningViewer />);
    expect(markup).toContain('종합 결과 보기');
    expect(markup).not.toContain('PDM·PCP 사전 등록 / 자료 등록');
    expect(markup).not.toContain('초기 ToC 열기');
    expect(markup).not.toContain('open-pdm-p1');
    expect(markup).not.toContain('open-pcp-p1');
  });

  it('두 자료(PDM·국문 PCP)가 모두 등록된 사업은 카드의 자료 대기 배지와 상단 등록 안내 대신 두 자료와 열기 링크가 보인다', () => {
    const projectWithBoth: ProjectWithCount = {
      ...project,
      has_pdm: 1,
      has_pcp: 1,
      pdm_document: {
        id: 'doc-pdm-1',
        project_id: 'p1',
        file_name: '가상_성과관리표.docx',
        doc_type: '성과관리표',
        created_at: '2026-02-15T09:00:00Z',
      },
      pcp_document: {
        id: 'doc-pcp-1',
        project_id: 'p1',
        file_name: '가상_국문PCP.pdf',
        doc_type: '국문 PCP',
        created_at: '2026-02-16T10:00:00Z',
      },
    };

    const markup = renderToStaticMarkup(
      <ProjectsClientView initialProjects={[projectWithBoth]} canCreate={false} canManageMetadata={false} canRegisterDocuments canOpenInitialToc />
    );

    // 자료 대기 배지와 상단 안내가 숨겨진다
    expect(markup).not.toContain('자료 대기');
    expect(markup).not.toContain('PDM 사전 등록 안내');

    // 두 자료의 파일명과 올린 날짜, 열기 버튼이 표시된다
    expect(markup).toContain('가상_성과관리표.docx');
    expect(markup).toContain('2026-02-15');
    expect(markup).toContain('open-pdm-p1');
    expect(markup).toContain('/projects/p1/documents?docId=doc-pdm-1');

    expect(markup).toContain('가상_국문PCP.pdf');
    expect(markup).toContain('2026-02-16');
    expect(markup).toContain('open-pcp-p1');
    expect(markup).toContain('/projects/p1/documents?docId=doc-pcp-1');

    // 두 자료가 다 있으면 generic 등록 버튼 대신 초기 ToC 열기만 보인다
    expect(markup).not.toContain('PDM·PCP 사전 등록 / 자료 등록');
    expect(markup).toContain('open-toc-p1');
    expect(markup).toMatch(/<a[^>]*data-testid="project-card-open-p1"[^>]*href="\/projects\/p1\/toc"/);
  });

  it('한쪽 자료만 등록된 사업은 있는 쪽은 열기, 없는 쪽은 등록 필요와 자료 등록 링크가 보인다', () => {
    const projectWithPdmOnly: ProjectWithCount = {
      ...project,
      has_pdm: 1,
      has_pcp: 0,
      pdm_document: {
        id: 'doc-pdm-only',
        project_id: 'p1',
        file_name: '성과관리표_단독.docx',
        doc_type: '성과관리표',
        created_at: '2026-03-01T00:00:00Z',
      },
      pcp_document: null,
    };

    const markup = renderToStaticMarkup(
      <ProjectsClientView initialProjects={[projectWithPdmOnly]} canCreate={false} canManageMetadata={false} canRegisterDocuments canOpenInitialToc />
    );

    // PDM은 열기, PCP는 등록 필요
    expect(markup).toContain('성과관리표_단독.docx');
    expect(markup).toContain('open-pdm-p1');
    expect(markup).toContain('register-pcp-p1');
    expect(markup).toContain('/projects/p1/documents');
  });

  it('두 자료가 모두 없는 사업은 카드의 자료 대기 배지와 두 자료 모두 등록 필요가 표시된다', () => {
    const projectEmpty: ProjectWithCount = {
      ...project,
      has_pdm: 0,
      has_pcp: 0,
      pdm_document: null,
      pcp_document: null,
    };

    const markup = renderToStaticMarkup(
      <ProjectsClientView initialProjects={[projectEmpty]} canCreate={false} canManageMetadata={false} canRegisterDocuments canOpenInitialToc />
    );

    expect(markup).toContain('자료 대기');
    expect(markup).toContain('register-pdm-p1');
    expect(markup).toContain('register-pcp-p1');
  });

  it('자료가 갖춰진 사업과 미등록 사업이 함께 있을 때 해당 카드에만 안내한다', () => {
    const complete: ProjectWithCount = {
      ...project, id: 'complete', name: '자료가 있는 사업', has_pdm: 1, has_pcp: 1,
      pdm_document: { id: 'pdm', project_id: 'complete', file_name: 'pdm.pdf', doc_type: '성과관리표', created_at: '2026-01-01' },
      pcp_document: { id: 'pcp', project_id: 'complete', file_name: 'pcp.pdf', doc_type: '국문 PCP', created_at: '2026-01-01' },
    };
    const incomplete = { ...project, id: 'missing', name: '자료가 빠진 사업', pdm_document: null, pcp_document: null };
    const markup = renderToStaticMarkup(<ProjectsClientView initialProjects={[complete, incomplete]} canCreate={false} canManageMetadata={false} canRegisterDocuments />);
    const completeCard = markup.match(/<article[^>]*data-testid="project-card-complete"[\s\S]*?<\/article>/)?.[0];
    const missingCard = markup.match(/<article[^>]*data-testid="project-card-missing"[\s\S]*?<\/article>/)?.[0];
    expect(completeCard).toBeDefined();
    expect(missingCard).toBeDefined();
    expect(completeCard).not.toContain('PDM 사전 등록 안내');
    expect(missingCard).toContain('PDM 사전 등록 안내');
  });

  it('손님에게는 사업 목록이 보이지 않는다', () => {
    const markup = renderToStaticMarkup(
      <ProjectsClientView initialProjects={[]} canCreate={false} canManageMetadata={false} canRegisterDocuments={false} canOpenInitialToc={false} />
    );
    expect(markup).toContain('empty-projects-notice');
    expect(markup).not.toContain('open-pdm');
    expect(markup).not.toContain('open-pcp');
  });
});
