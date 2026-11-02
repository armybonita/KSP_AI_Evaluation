import { NextRequest } from 'next/server';
import {
  generateReportDocx,
  getSavedReportDraftWithStatus,
} from '@/server/report';
import { viewerCan, viewerFromHeaders } from '@/server/viewer';
import { getProject } from '@/server/store';
import { isProjectHiddenFromViewer } from '@/server/project-visibility';
import { isProjectPdmRegistered, projectPdmExclusionReason } from '@/server/project-pdm';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await context.params;

  if (!projectId || projectId.trim().length === 0) {
    return new Response('사업 식별자가 유효하지 않습니다.', { status: 400 });
  }

  const project = getProject(projectId);
  if (!project || (await isProjectHiddenFromViewer(projectId, request.headers))) {
    return new Response(`사업 '${projectId}'를 찾을 수 없습니다.`, { status: 404 });
  }

  const viewer = viewerFromHeaders(request.headers);
  const planner = viewer.kind === 'member' && viewer.role === '기획팀';
  if (!planner && !viewerCan(viewer, 'review')) return new Response('이 역할에는 접근 권한이 없습니다.', { status: 403 });
  if (!isProjectPdmRegistered(projectId)) {
    return new Response(projectPdmExclusionReason(projectId), { status: 409, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const reportId = new URL(request.url).searchParams.get('reportId') || undefined;
  const saved = getSavedReportDraftWithStatus(projectId, undefined, undefined, undefined, reportId);
  const draft = saved.draft;

  if (planner) {
    if (!draft?.report_finalization) return new Response('기획팀은 평가팀 최종 확정본만 내려받을 수 있습니다.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (draft && saved.isOutdated) {
    return new Response('확정 내용이 바뀌었습니다. 초안을 다시 만드세요.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (!draft) {
    return new Response('저장된 초안이 없습니다. 먼저 초안을 만드세요.', {
      status: 409,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const buffer = await generateReportDocx(draft);

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="report_${projectId}.docx"`,
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
