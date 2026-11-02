'use client';

import { FailureMessage } from './[projectId]/failure-message';

export default function ProjectsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  void error;

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">사업 목록</h1>
        <FailureMessage
          message="사업 목록을 불러오지 못했습니다."
          onRetry={reset}
          testId="page-load-error"
        />
      </div>
    </main>
  );
}
