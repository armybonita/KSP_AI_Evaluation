import { canAccessWorkflowScreen } from '@/lib/workflow-access';
import React from 'react';
import { notFound } from 'next/navigation';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';
import { getDocumentsPageData } from './actions';
import { currentViewer, viewerCan } from '@/server/viewer';
import { getAiGatewayProvider } from '@/server/ai';
import { DocumentsClientView } from './documents-client-view';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ docId?: string; location?: string; pdm?: string }>;
}) {
  const { projectId } = await params;
  if (!projectId || typeof projectId !== 'string') {
    notFound();
  }
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!canAccessWorkflowScreen(viewer, 'documents')) return <main className="p-6" role="status">자료 등록 권한이 없습니다.</main>;

  const query = searchParams ? await searchParams : {};

  const data = await getDocumentsPageData(projectId);
  if (!data) {
    notFound();
  }

  return (
    <>
    <DocumentsClientView
      project={data.project}
      initialDocuments={data.documents}
      initialDocId={query.docId}
      initialLocation={query.location}
      pdmRequired={query.pdm === 'required'}
      aiProvider={getAiGatewayProvider()}
      canUpload={viewerCan(viewer, 'upload')}
    />
    </>
  );
}
