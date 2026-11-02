import { getProject } from '@/server/store';
import { isProjectHiddenFromViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered } from '@/server/project-pdm';
import { viewerCan, viewerFromHeaders } from '@/server/viewer';
import { getLatestSynthesisRun, prepareSynthesisResponse } from '@/server/store/synthesis-store';
import { startProjectSynthesis } from '@/server/ontology/synthesis-service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
type RouteContext = { params: Promise<{ projectId: string }> };
const noStore = { 'Cache-Control': 'no-store, max-age=0' };

async function authorize(request: Request, projectId: string, write: boolean): Promise<Response | null> {
  if (await isProjectHiddenFromViewer(projectId, request.headers) || !getProject(projectId)) return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  // Reads must still reach the stale notice after the only PDM is excluded; only new runs need a registered PDM.
  if (write && !isProjectPdmRegistered(projectId)) return Response.json({ error: '성과관리표를 먼저 포함 상태로 등록해야 합니다.' }, { status: 409 });
  const viewer = viewerFromHeaders(request.headers);
  if (!viewerCan(viewer, 'review') && (write || !viewerCan(viewer, 'opinion'))) return Response.json({ error: '이 역할에는 접근 권한이 없습니다.' }, { status: 403 });
  return null;
}

export async function GET(request: Request, { params }: RouteContext) {
  const { projectId } = await params;
  const denied = await authorize(request, projectId, false);
  if (denied) return denied;
  return Response.json(prepareSynthesisResponse(projectId, getLatestSynthesisRun(projectId)), { headers: noStore });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { projectId } = await params;
  const denied = await authorize(request, projectId, true);
  if (denied) return denied;
  const run = startProjectSynthesis(projectId);
  if (!run) return Response.json({ error: '이 사업의 항목 종합이 이미 진행 중입니다.', synthesis: prepareSynthesisResponse(projectId, getLatestSynthesisRun(projectId)).synthesis }, { status: 409, headers: noStore });
  return Response.json({ synthesis: run }, { status: 202, headers: noStore });
}
