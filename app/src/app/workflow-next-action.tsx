'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { workflowNextAction, type WorkflowScreen } from './workflow-navigation';
import { getProjectNavigationAction } from './projects/[projectId]/navigation-actions';
import type { UserRole } from '@/server/viewer';

export function WorkflowNextAction({
  projectId,
  screen,
  reviewStage,
  onReviewStageChange,
  hasPdm,
}: {
  projectId: string;
  screen: WorkflowScreen;
  reviewStage?: number;
  onReviewStageChange?: (stage: number) => void;
  /** Documents can derive this from its current list before the server shell refreshes. */
  hasPdm?: boolean;
}) {
  const [access, setAccess] = useState<{ role: UserRole; hasPdm: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    setAccess(null);
    getProjectNavigationAction(projectId).then((value) => {
      if (current) setAccess(value);
    }).catch(() => {
      if (current) setAccess(null);
    });
    return () => { current = false; };
  }, [projectId]);

  if (!access) return <div aria-hidden="true" className="h-14" />;
  const action = workflowNextAction({
    projectId,
    screen,
    role: access.role,
    hasPdm: hasPdm ?? access.hasPdm,
    reviewStage,
  });
  if (!action) return null;

  return <nav aria-label="다음 단계 이동" data-testid="workflow-action-row" className="flex justify-end border-t border-gray-200 pt-4">
    {action.reviewStage !== undefined ? (
      <button
        type="button"
        data-testid="workflow-next"
        onClick={() => onReviewStageChange?.(action.reviewStage!)}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        {action.prefixWithNext === false ? action.label : `다음: ${action.label}`}<span aria-hidden="true">→</span>
      </button>
    ) : action.href ? (
      <Link
        href={action.href}
        data-testid="workflow-next"
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        {action.prefixWithNext === false ? action.label : `다음: ${action.label}`}<span aria-hidden="true">→</span>
      </Link>
    ) : null}
  </nav>;
}
