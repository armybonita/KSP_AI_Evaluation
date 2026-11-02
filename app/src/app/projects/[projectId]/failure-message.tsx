'use client';

import React from 'react';
import Link from 'next/link';
import type { ProjectScreen } from './project-tabs';
import { ProjectTabs } from './project-tabs';

interface FailureMessageProps {
  message: string;
  onRetry: () => void;
  isRetrying?: boolean;
  testId?: string;
}

export function FailureMessage({
  message,
  onRetry,
  isRetrying = false,
  testId,
}: FailureMessageProps) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800"
    >
      <span className="min-w-0 flex-1 truncate text-sm" title={message}>
        오류: {message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="shrink-0 rounded bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-900 transition hover:bg-red-200 disabled:cursor-wait disabled:opacity-60"
      >
        {isRetrying ? '다시 시도 중...' : '다시 시도'}
      </button>
    </div>
  );
}

interface ProjectPageLoadFailureProps {
  projectId: string;
  activeScreen: Extract<ProjectScreen, 'history' | 'result'>;
  title: string;
  message: string;
  onRetry: () => void;
  isRetrying: boolean;
}

export function ProjectPageLoadFailure({
  projectId,
  activeScreen,
  title,
  message,
  onRetry,
  isRetrying,
}: ProjectPageLoadFailureProps) {
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="border-b border-gray-200 pb-4">
          <div className="flex items-center gap-3">
            <Link
              href="/projects"
              className="text-xs font-semibold text-blue-600 transition hover:text-blue-800"
            >
              &larr; 사업 목록
            </Link>
            <span className="text-gray-300">|</span>
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-600">
              {activeScreen === 'history' ? 'S5 확정 이력' : 'S7 결과 ToC'}
            </span>
          </div>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">{title}</h1>
          <ProjectTabs projectId={projectId} activeScreen={activeScreen} />
        </header>
        <FailureMessage
          message={message}
          onRetry={onRetry}
          isRetrying={isRetrying}
          testId="page-load-error"
        />
      </div>
    </div>
  );
}
