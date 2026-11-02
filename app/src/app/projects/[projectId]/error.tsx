'use client';

import { useParams, usePathname } from 'next/navigation';
import { FailureMessage } from './failure-message';
import { ProjectTabs, type ProjectScreen } from './project-tabs';

const SCREEN_TITLES: Record<ProjectScreen, string> = {
  documents: '자료 등록',
  ontology: '온톨로지',
  toc: '초기 ToC',
  review: 'AI 제안 검토',
  history: '확정 이력',
  report: '보고서 초안',
  portfolio: '⑨ 성과 수준 평가·포트폴리오',
  result: '결과 ToC',
};

export default function ProjectScreenError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error;
  const { projectId } = useParams<{ projectId: string }>();
  const pathname = usePathname();
  const pathScreen = pathname.split('/').filter(Boolean)[2] as ProjectScreen | undefined;
  const activeScreen = pathScreen && pathScreen in SCREEN_TITLES ? pathScreen : 'documents';

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="border-b border-gray-200 pb-4">
          <h1 className="text-2xl font-bold text-gray-900">
            {SCREEN_TITLES[activeScreen]}
          </h1>
          <ProjectTabs projectId={projectId} activeScreen={activeScreen} />
        </header>
        <FailureMessage
          message="화면을 불러오지 못했습니다."
          onRetry={reset}
          testId="page-load-error"
        />
      </div>
    </main>
  );
}
