"use server";
import { assertProjectVisibleToCurrentViewer } from "@/server/project-visibility";
import { currentViewer, ROLE_BLOCKED_MESSAGE, viewerCan } from "@/server/viewer";
import { isProjectPdmRegistered, projectPdmExclusionReason } from "@/server/project-pdm";
import { getProjectOntologyEvidenceSource } from "@/server/store/ontology";
import { getBannedSentencesByProject } from "@/server/store/db";
import {
  maskTextIfForbiddenSentenceOverlap,
  isEvidenceCitationBanned,
} from "@/server/store/citation-ban";
import {
  getNoteReviewData,
  saveNoteReview,
  confirmNoteLink,
  rejectNoteLink,
} from "@/server/store/note-review";

export async function saveNoteReviewAction(
  projectId: string,
  importId: string,
  nodeId: string,
  input: {
    status: string;
    text: string;
    outcomeState: string;
    reason: string;
    errorType: string;
  },
) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review') && !(viewerCan(viewer, 'opinion') && input.status === '수정 의견'))
    return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (viewer.kind !== 'member') return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  try {
    saveNoteReview(projectId, importId, nodeId, input, viewer.login);
    return { success: true as const, data: getNoteReviewData(projectId) };
  } catch (error) {
    const known = [
      "현재 사업의 노트를 찾을 수 없습니다.",
      "잘못된 검토 값입니다.",
      "새 이력으로 수정을 시작해 주십시오.",
      "판단 문안을 입력해 주십시오.",
      "사유를 입력해 주십시오.",
      "오류 유형을 선택해 주십시오.",
      "인용 금지 문장이 포함되어 저장할 수 없습니다.",
    ];
    const message =
      error instanceof Error && known.includes(error.message)
        ? error.message
        : "검토 내용을 저장하지 못했습니다.";
    return { success: false as const, error: message };
  }
}

export async function getNoteSourceAction(
  projectId: string,
  evidenceId: string,
) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'review') && !viewerCan(viewer, 'opinion')) return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  const allowed = getNoteReviewData(projectId)
    .items.flatMap((i) => [...i.evidence, ...i.contradictions])
    .find((e) => e.id === evidenceId);
  if (!allowed || allowed.quote === "[인용 금지 문장]")
    return { success: false as const, error: "인용할 수 없는 근거입니다." };
  const source = getProjectOntologyEvidenceSource(projectId, evidenceId);
  if (!source)
    return { success: false as const, error: "원문 위치를 찾을 수 없습니다." };
  const banned = getBannedSentencesByProject(projectId).map((s) => s.content);
  if (isEvidenceCitationBanned({ quote: source.quote }, banned))
    return { success: false as const, error: "인용 금지 문장입니다." };
  return {
    success: true as const,
    source: {
      sourceTitle: maskTextIfForbiddenSentenceOverlap(
        source.sourceTitle,
        banned,
        8,
      ),
      paragraphs: source.paragraphs.map((p) => ({
        ...p,
        location: maskTextIfForbiddenSentenceOverlap(p.location, banned, 8),
        content: maskTextIfForbiddenSentenceOverlap(p.content, banned, 8),
      })),
    },
  };
}

export async function confirmNoteLinkAction(
  projectId: string,
  importId: string,
  sourceId: string,
  targetId: string,
  relation?: string,
) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'confirm'))
    return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (viewer.kind !== 'member') return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  try {
    confirmNoteLink(projectId, importId, sourceId, targetId, viewer.login, undefined, relation);
    return { success: true as const, data: getNoteReviewData(projectId) };
  } catch (error) {
    return {
      success: false as const,
      error: error instanceof Error && ["현재 사업의 연결 후보를 찾을 수 없습니다.", "사유와 오류 유형을 입력해 주십시오.", "인용 금지 문장이 포함되어 저장할 수 없습니다."].includes(error.message) ? error.message : "연결 후보를 확정하지 못했습니다.",
    };
  }
}

export async function rejectNoteLinkAction(projectId: string, importId: string, sourceId: string, targetId: string, relation: string, reason: string, errorType: string) {
  await assertProjectVisibleToCurrentViewer(projectId);
  const viewer = await currentViewer();
  if (!viewerCan(viewer, 'confirm')) return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (viewer.kind !== 'member') return { success: false as const, error: ROLE_BLOCKED_MESSAGE };
  if (!isProjectPdmRegistered(projectId)) return { success: false as const, error: projectPdmExclusionReason(projectId) };
  try {
    rejectNoteLink(projectId, importId, sourceId, targetId, relation, reason, errorType, viewer.login);
    return { success: true as const, data: getNoteReviewData(projectId) };
  } catch (error) {
    return { success: false as const, error: error instanceof Error && ["사유와 오류 유형을 입력해 주십시오.", "인용 금지 문장이 포함되어 저장할 수 없습니다."].includes(error.message) ? error.message : "연결 후보를 기각하지 못했습니다." };
  }
}
