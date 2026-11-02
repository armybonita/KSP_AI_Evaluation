import { getProject } from '@/server/store';
import { isProjectHiddenFromViewer } from '@/server/project-visibility';
import { viewerFromHeaders, viewerCan } from '@/server/viewer';
import { loadSyntheticOntologyGraphs } from '@/server/ontology/fixtures';
import { getProjectOntology, getProjectOntologyGraph, replaceProjectOntology } from '@/server/ontology/store';
import { getLatestGenerationRun } from '@/server/ontology/generation-store';
import { startProjectOntologyGeneration } from '@/server/ontology/generation-service';
import { listDocuments, getParagraphsByDocument } from '@/server/store';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const { projectId } = await params;
  if (await isProjectHiddenFromViewer(projectId, request.headers)) return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  if (!getProject(projectId)) return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  if (!viewerCan(viewerFromHeaders(request.headers), 'review') && !viewerCan(viewerFromHeaders(request.headers), 'opinion')) return Response.json({ error: '이 역할에는 접근 권한이 없습니다.' }, { status: 403 });
  if (!isProjectPdmRegistered(projectId)) return Response.json({ error: projectPdmExclusionReason(projectId) }, { status: 409 });
  const graphs = loadSyntheticOntologyGraphs();
  return Response.json({
    availableVaults: graphs.map(({ code, projectName }) => ({ code, name: projectName })),
    ...getProjectOntology(projectId),
    graph: getProjectOntologyGraph(projectId),
    generation: getLatestGenerationRun(projectId),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(request: Request, { params }: RouteContext) {
  const { projectId } = await params;
  if (await isProjectHiddenFromViewer(projectId, request.headers)) return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  if (!getProject(projectId)) return Response.json({ error: '사업을 찾을 수 없습니다.' }, { status: 404 });
  const viewer = viewerFromHeaders(request.headers);
  if (!viewerCan(viewer, 'review')) {
    return Response.json({ error: '이 역할에는 이 작업 권한이 없습니다.' }, { status: 403 });
  }
  if (!isProjectPdmRegistered(projectId)) return Response.json({ error: projectPdmExclusionReason(projectId) }, { status: 409 });
  let body: { code?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '요청을 확인할 수 없습니다.' }, { status: 400 });
  }
  if (body.action === 'generate') {
    const docs = listDocuments(projectId).filter((doc) => doc.is_included === 1 && doc.status === '추출 완료' && getParagraphsByDocument(doc.id).length > 0);
    if (!docs.length) return Response.json({ error: '포함·추출 완료된 문단이 없습니다.' }, { status: 409 });
    const run = startProjectOntologyGeneration(projectId, viewer.kind === 'member' ? viewer.login : 'guest');
    if (!run) return Response.json({ error: '이 사업의 온톨로지 생성이 이미 진행 중입니다.', generation: getLatestGenerationRun(projectId) }, { status: 409 });
    return Response.json({ generation: run }, { status: 202, headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }
  const { code } = body;
  const graph = loadSyntheticOntologyGraphs().find((candidate) => candidate.code === code);
  if (!graph) return Response.json({ error: '선택할 수 없는 가상 사업입니다.' }, { status: 400 });
  try {
    replaceProjectOntology(projectId, graph, viewer.kind === 'member' ? viewer.login : 'guest');
    return Response.json({ ...getProjectOntology(projectId), graph: getProjectOntologyGraph(projectId) }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('온톨로지 저장 실패', error);
    return Response.json({ error: '온톨로지를 저장하지 못했습니다.' }, { status: 500 });
  }
}
