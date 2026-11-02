import React from 'react';
import Link from 'next/link';
import type { ExcludedDocumentSummary } from '@/server/store/excluded-documents';

export function DocumentExclusionNotice({ projectId, summary }: { projectId: string; summary: ExcludedDocumentSummary }) {
  if (!summary.unconfirmed && !summary.past) return null;
  return (
    <section role="status" data-testid="document-exclusion-notice" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <p>과거 종료평가보고서 {summary.past}개·과거 여부 미확인 {summary.unconfirmed}개 문서는 분석과 근거에서 빠집니다 — <Link className="font-semibold underline" href={`/projects/${projectId}/documents`}>자료 화면에서 확인</Link></p>
    </section>
  );
}
