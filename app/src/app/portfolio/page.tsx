import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import { getPortfolioSummaries } from '@/server/store/portfolio';
import { currentViewer } from '@/server/viewer';
import { axisLabel } from './axis-label';

export const dynamic = 'force-dynamic';
const PAGE_SIZE = 50;

export default async function PortfolioOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'review')) notFound();
  const requestedPage = Number((await searchParams).page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 1_000_000) : 1;
  const { rows, hasNext } = viewer.kind === 'guest'
    ? { rows: [], hasNext: false }
    : getPortfolioSummaries(page, PAGE_SIZE);

  return <main className="min-h-screen bg-gray-50 px-4 py-6 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="border-b border-gray-200 pb-4">
        <Link href="/projects" className="text-xs font-semibold text-blue-600 hover:text-blue-800">&larr; 사업 목록</Link>
        <h1 className="mt-2 text-2xl font-bold text-gray-900">전체 사업 포트폴리오</h1>
        <p className="mt-1 text-sm text-gray-600">기준: 볼트 R05(평가팀 확인 전 제안값)</p>
      </header>
      <section aria-labelledby="all-projects-title" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 id="all-projects-title" className="text-lg font-bold text-gray-900">사업별 축과 사분면</h2>
        <p className="mt-1 text-sm text-gray-600">확정된 관측·입증 성과 중 적격한 인용 근거가 있는 평가팀 레벨의 축별 최댓값입니다.</p>
        <div className="mt-4 overflow-x-auto">
          <table aria-label="전체 사업 포트폴리오 사분면" className="min-w-[900px] w-full border-collapse text-left text-sm">
            <thead><tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
              <th scope="col" className="px-3 py-2">사업</th>
              <th scope="col" className="px-3 py-2">지식활용 축</th>
              <th scope="col" className="px-3 py-2">협력확장 축</th>
              <th scope="col" className="px-3 py-2">사분면</th>
            </tr></thead>
            <tbody>{rows.length ? rows.map((summary) => <tr key={summary.projectId} className="border-b border-gray-100 last:border-0">
              <th scope="row" className="px-3 py-3 text-left font-semibold text-gray-900"><Link href={`/projects/${summary.projectId}/portfolio`} className="text-blue-700 hover:underline">{summary.projectName}</Link></th>
              <td className="px-3 py-3">{summary.summary ? axisLabel(summary.summary.knowledge) : '아직 계산 안 됨 — 사업 ⑨ 화면을 열면 계산'}</td>
              <td className="px-3 py-3">{summary.summary ? axisLabel(summary.summary.cooperation) : '아직 계산 안 됨 — 사업 ⑨ 화면을 열면 계산'}</td>
              <td className="px-3 py-3 font-medium">{summary.summary ? summary.summary.quadrant ?? '확인 필요: 한 축의 값이 비어 있음' : '아직 계산 안 됨 — 사업 ⑨ 화면을 열면 계산'}</td>
            </tr>) : <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-500">사업이 없습니다.</td></tr>}</tbody>
          </table>
        </div>
        <nav aria-label="포트폴리오 페이지" className="mt-4 flex items-center gap-4 text-sm">
          {page > 1 && <Link href={`/portfolio?page=${page - 1}`} className="text-blue-700 hover:underline">이전</Link>}
          <span>{page}쪽</span>
          {hasNext && <Link href={`/portfolio?page=${page + 1}`} className="text-blue-700 hover:underline">다음</Link>}
        </nav>
      </section>
    </div>
  </main>;
}
