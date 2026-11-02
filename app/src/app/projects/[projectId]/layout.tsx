import type { ReactNode } from 'react';
import { assertProjectVisibleToCurrentViewer } from '@/server/project-visibility';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await assertProjectVisibleToCurrentViewer(projectId);

  return children;
}
