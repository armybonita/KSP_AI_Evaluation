import { isProjectHiddenFromViewer } from '@/server/project-visibility';
import { getProjectOntologyEvidenceSource } from '@/server/ontology/store';
import { getProject } from '@/server/store';
import { viewerCan, viewerFromHeaders } from '@/server/viewer';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ projectId: string; evidenceId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { projectId, evidenceId } = await params;
  if (await isProjectHiddenFromViewer(projectId, request.headers) || !getProject(projectId)) {
    return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  }
  if (!viewerCan(viewerFromHeaders(request.headers), 'review')) return Response.json({ error: '이 역할에는 접근 권한이 없습니다.' }, { status: 403 });
  if (!isProjectPdmRegistered(projectId)) return Response.json({ error: projectPdmExclusionReason(projectId) }, { status: 409 });

  const sourceView = getProjectOntologyEvidenceSource(projectId, evidenceId);
  if (!sourceView) return Response.json({ error: '원문을 찾을 수 없습니다.' }, { status: 404 });
  return Response.json(sourceView, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
