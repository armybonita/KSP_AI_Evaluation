'use client';

import React, { useEffect, useState, useTransition, useRef } from 'react';
import Link from 'next/link';
import { FailureMessage } from '../failure-message';
import { ProjectTabs } from '../project-tabs';
import { WorkflowNextAction } from '@/app/workflow-next-action';
import {
  DOC_TYPES,
  type DocType,
  type DocumentRecord,
  type ParagraphRecord,
  type ProjectRecord,
} from '@/server/store/types';
import { hasEligiblePdm, pdmReasonDocument } from '@/server/documents/pdm-eligibility';
import { exclusionReasonForDocument } from '@/server/documents/exclusion-reason';
import { getAiDocumentEligibilityForProvider } from '@/server/documents/ai-eligibility';
import {
  getDocumentParagraphsAction,
  updateDocumentInclusionAction,
  updateDocumentTypeAction,
  updateDocumentAiMetadataAction,
  uploadDocumentsAction,
} from './actions';

export function DocumentEvidenceWarning({ visible }: { visible: boolean }) {
  return visible ? <p role="alert" className="text-amber-800">이 문서에서 나온 기존 지식 지도 점 또는 근거가 있습니다. 기존 결과를 확인하고 지식 지도를 재생성해 주세요.</p> : null;
}

function DocumentAiMetadata({ doc, projectId, canEdit, onSaved }: {
  doc: DocumentRecord;
  projectId: string;
  canEdit: boolean;
  onSaved: (documents: DocumentRecord[]) => void;
}) {
  const [masked, setMasked] = useState('unknown');
  const [approvedAi, setApprovedAi] = useState('unknown');
  const [pastReport, setPastReport] = useState('unknown');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceWarning, setEvidenceWarning] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = () => startTransition(async () => {
    setError(null);
    setNotice(null);
    try {
      const result = await updateDocumentAiMetadataAction(projectId, doc.id, {
        masked, approved_ai: approvedAi, is_past_final_report: pastReport,
      });
      if (!result.success || !result.documents) {
        setError(result.error ?? 'AI 입력 정보 저장에 실패했습니다.');
        return;
      }
      onSaved(result.documents);
      setMasked('unknown');
      setApprovedAi('unknown');
      setPastReport('unknown');
      setNotice('저장했습니다.');
      setEvidenceWarning(Boolean(result.hasExistingEvidence));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  });

  return (
    <div className="space-y-1 text-xs" data-testid={`ai-metadata-${doc.id}`}>
      <p>가명화: {doc.masked == null ? '미확인' : doc.masked ? '완료' : '미완료'}</p>
      <p>승인 AI: {doc.approved_ai || '미확인'}</p>
      <p>종료평가보고서: {doc.is_past_final_report == null ? '미확인' : doc.is_past_final_report ? '과거 종료평가보고서' : '이번 사업의 자료'}</p>
      {doc.is_past_final_report == null && <p className="text-amber-800">과거 보고서 여부 미확인 — 확인 전에는 분석에 쓰지 않음</p>}
      {canEdit && <fieldset disabled={pending} className="space-y-1">
        <legend>AI 입력 정보 변경 (미선택은 기존 값 유지)</legend>
        <label className="block">개인정보 마스킹
          <select value={masked} onChange={(e) => setMasked(e.target.value)} className="block rounded border p-1">
            <option value="unknown">미선택</option><option value="true">마스킹 완료</option><option value="false">마스킹 미완료</option>
          </select>
        </label>
        <label className="block">AI 사용 승인
          <select value={approvedAi} onChange={(e) => setApprovedAi(e.target.value)} className="block rounded border p-1">
            <option value="unknown">미선택</option><option value="solar">Solar</option><option value="local-only">로컬 전용</option><option value="external-chat">외부 AI 사용 승인</option><option value="none">승인 안 함</option>
          </select>
        </label>
        <label className="block">종료평가보고서 여부
          <select value={pastReport} onChange={(e) => setPastReport(e.target.value)} className="block rounded border p-1">
            <option value="unknown">미선택 (기존 값 유지)</option><option value="unconfirmed">미확인으로 변경</option><option value="true">과거 종료평가보고서</option><option value="false">이번 사업의 자료다</option>
          </select>
        </label>
        <button type="button" onClick={save} className="rounded border px-2 py-1">AI 입력 정보 저장</button>
      </fieldset>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <DocumentEvidenceWarning visible={evidenceWarning} />
    </div>
  );
}

interface DocumentsClientViewProps {
  project: ProjectRecord;
  initialDocuments: DocumentRecord[];
  initialDocId?: string;
  initialLocation?: string;
  aiProvider: string | null;
  pdmRequired?: boolean;
  // #53: 손님은 파일 올리기 영역을 보지 않는다(서버에서도 거절).
  canUpload?: boolean;
}

export function DocumentsClientView({
  project,
  initialDocuments,
  initialDocId,
  initialLocation,
  aiProvider,
  pdmRequired = false,
  canUpload = true,
}: DocumentsClientViewProps) {
  const [documents, setDocuments] = useState<DocumentRecord[]>(initialDocuments);
  const [docTypeDrafts, setDocTypeDrafts] = useState<Record<string, DocType>>({});
  const [typeEvidenceWarnings, setTypeEvidenceWarnings] = useState<Record<string, boolean>>({});
  const [inclusionDrafts, setInclusionDrafts] = useState<Record<string, boolean>>({});
  const [evaluatorName, setEvaluatorName] = useState<string>('평가자A');
  const [uploadMasked, setUploadMasked] = useState(true);
  const [uploadApprovedAi, setUploadApprovedAi] = useState('solar');
  const [uploadPastFinalReport, setUploadPastFinalReport] = useState('unknown');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<{ message: string; files: File[] } | null>(null);
  const [rejectedFiles, setRejectedFiles] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [readFailures, setReadFailures] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [inclusionNotice, setInclusionNotice] = useState<string | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ documentId: string; message: string } | null>(null);
  const [documentSaveFailure, setDocumentSaveFailure] = useState<
    | { kind: 'type'; documentId: string; value: DocType; message: string }
    | { kind: 'inclusion'; documentId: string; value: boolean; reason: string | null; message: string }
    | null
  >(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => {
    if (initialDocId && initialDocuments.some((d) => d.id === initialDocId)) {
      return initialDocId;
    }
    return initialDocuments.length > 0 ? initialDocuments[0].id : null;
  });
  const [targetLocation, setTargetLocation] = useState<string | null>(initialLocation ?? null);
  const [previewParagraphs, setPreviewParagraphs] = useState<ParagraphRecord[]>([]);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isPending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 선택된 문서의 문단 미리보기 로드 (D06)
  const loadParagraphs = async (docId: string) => {
    setSelectedDocId(docId);
    setIsLoadingPreview(true);
    setPreviewFailure(null);
    try {
      const res = await getDocumentParagraphsAction(project.id, docId);
      if (res.success) {
        setPreviewParagraphs(res.paragraphs);
      } else {
        setPreviewParagraphs([]);
        setPreviewFailure({
          documentId: docId,
          message: res.error ?? '문단 미리보기를 불러오지 못했습니다.',
        });
      }
    } catch (err) {
      setPreviewParagraphs([]);
      setPreviewFailure({
        documentId: docId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // 초기 문서가 있으면 미리보기 로드 (initialDocId 우선)
  React.useEffect(() => {
    const docToLoad =
      initialDocId && initialDocuments.some((d) => d.id === initialDocId)
        ? initialDocId
        : initialDocuments.length > 0 && initialDocuments[0].status === '추출 완료'
        ? initialDocuments[0].id
        : null;

    if (docToLoad) {
      loadParagraphs(docToLoad);
    }
    if (initialLocation) {
      setTargetLocation(initialLocation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDocId, initialLocation]);


  // 파일 업로드 처리
  const runUpload = async (files: File[], previewAfterSuccess: boolean) => {
    if (files.length === 0) return;

    setIsUploading(true);
    setUploadFailure(null);
    setInclusionNotice(null);

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    formData.set('masked', String(uploadMasked));
    formData.set('approved_ai', uploadApprovedAi);
    formData.set('is_past_final_report', uploadPastFinalReport);

    try {
      const res = await uploadDocumentsAction(project.id, formData);
      setDocuments(res.documents);
      setRejectedFiles(res.rejected);
      setReadFailures(res.readFailures);

      if (res.errors.length > 0) {
        const failedFiles = res.failedIndexes.map((index) => files[index]).filter(Boolean);
        setUploadFailure({
          message: res.errors.map((e) => `${e.fileName}: ${e.error}`).join('; '),
          files: failedFiles.length > 0 ? failedFiles : files,
        });
      }

      // 처음 업로드가 모두 성공한 경우에만 새 파일을 미리 연다.
      // 실패한 묶음을 재시도할 때는 미리보기 작업을 추가로 실행하지 않는다.
      if (previewAfterSuccess && res.success) {
        const uploadedIds = new Set(res.uploadedDocumentIds);
        const firstValid = res.documents.find(
          (d) => uploadedIds.has(d.id) && d.status === '추출 완료'
        );
        if (firstValid) loadParagraphs(firstValid.id);
      }
    } catch (err) {
      setUploadFailure({
        message: err instanceof Error ? err.message : String(err),
        files,
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    runUpload(Array.from(files), true);
  };

  // 문서 종류 변경
  const runTypeChange = (docId: string, newType: DocType) => {
    setDocumentSaveFailure(null);
    setDocTypeDrafts((prev) => ({ ...prev, [docId]: newType }));
    startTransition(async () => {
      try {
        const res = await updateDocumentTypeAction(project.id, docId, newType);
        if (res.success) {
          setTypeEvidenceWarnings((prev) => ({ ...prev, [docId]: Boolean(res.hasExistingEvidence) }));
          if (res.documents) {
            setDocuments(res.documents);
          } else {
            setDocuments((prev) =>
              prev.map((d) =>
                d.id === docId
                  ? { ...d, doc_type: newType, doctype_source: 'user' }
                  : d
              )
            );
          }
          setDocTypeDrafts((prev) => {
            const next = { ...prev };
            delete next[docId];
            return next;
          });
        } else {
          setDocumentSaveFailure({
            kind: 'type',
            documentId: docId,
            value: newType,
            message: res.error ?? '문서 종류 변경에 실패했습니다.',
          });
        }
      } catch (err) {
        setDocumentSaveFailure({
          kind: 'type',
          documentId: docId,
          value: newType,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  const handleTypeChange = (docId: string, newType: string) => {
    runTypeChange(docId, newType as DocType);
  };

  // 포함 여부 변경 (D31)
  const runInclusionChange = (docId: string, isIncluded: boolean, reason: string | null) => {
    setDocumentSaveFailure(null);
    setInclusionDrafts((prev) => ({ ...prev, [docId]: isIncluded }));
    startTransition(async () => {
      try {
        const res = await updateDocumentInclusionAction(project.id, docId, isIncluded, reason);
        if (res.success) {
          if (res.documents) {
            setDocuments(res.documents);
          } else {
            setDocuments((prev) =>
              prev.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      is_included: isIncluded ? 1 : 0,
                      excluded_reason: reason,
                      inclusion_source: 'user',
                    }
                  : d
              )
            );
          }
          setInclusionDrafts((prev) => {
            const next = { ...prev };
            delete next[docId];
            return next;
          });
          if (res.notice) {
            setInclusionNotice(res.notice);
          } else {
            setInclusionNotice(null);
          }
        } else {
          setDocumentSaveFailure({
            kind: 'inclusion',
            documentId: docId,
            value: isIncluded,
            reason,
            message: res.error ?? '포함 여부 변경에 실패했습니다.',
          });
        }
      } catch (err) {
        setDocumentSaveFailure({
          kind: 'inclusion',
          documentId: docId,
          value: isIncluded,
          reason,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  const handleInclusionChange = (docId: string, isIncluded: boolean) => {
    const doc = documents.find((d) => d.id === docId);
    const reason = !isIncluded ? doc?.excluded_reason || '제외됨' : null;
    runInclusionChange(docId, isIncluded, reason);
  };

  const retryDocumentSave = () => {
    if (!documentSaveFailure) return;
    if (documentSaveFailure.kind === 'type') {
      runTypeChange(documentSaveFailure.documentId, documentSaveFailure.value);
    } else {
      runInclusionChange(
        documentSaveFailure.documentId,
        documentSaveFailure.value,
        documentSaveFailure.reason
      );
    }
  };

  const selectedDocument = documents.find((d) => d.id === selectedDocId);
  const hasPdm = hasEligiblePdm(documents);

  useEffect(() => {
    window.dispatchEvent(new Event('aieas-project-navigation-updated'));
  }, [project.id, hasPdm]);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {pdmRequired && !hasPdm && <p role="status" className="text-amber-800">{exclusionReasonForDocument({ kind: 'pdm', document: pdmReasonDocument(documents) })}</p>}
        {/* 공통 틀 상단 헤더 (SP §frame) */}
        <header className="border-b border-gray-200 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <Link
                  href="/projects"
                  className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition"
                >
                  &larr; 사업 목록
                </Link>
                <span className="text-gray-300">|</span>
                <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
                  ③ 자료 등록
                </span>
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mt-1">자료 등록</h1>
            </div>

            <div className="flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-gray-500 font-medium">사업:</span>
                <span className="font-semibold text-gray-900" data-testid="project-name-display">
                  {project.name}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="evaluatorInput" className="text-gray-500 font-medium">
                  확정자:
                </label>
                <input
                  id="evaluatorInput"
                  type="text"
                  value={evaluatorName}
                  onChange={(e) => setEvaluatorName(e.target.value)}
                  className="px-2.5 py-1 border border-gray-300 rounded-md text-sm text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500 w-28"
                  placeholder="평가자"
                />
              </div>
            </div>
          </div>

          <ProjectTabs projectId={project.id} activeScreen="documents" />
        </header>

        {/* 사업계획서 부재 시 안내 배너 (#18 검수) */}
        {documents.length > 0 && !documents.some((d) => d.doc_type === '사업계획서') && (
          <div
            role="status"
            data-testid="no-plan-notice"
            className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-center gap-2"
          >
            <span>⚠️</span>
            <span>사업계획서가 없어 다른 사업·무관 판정을 하지 않았습니다</span>
          </div>
        )}

        {/* 안내 배너 (D31: 포함으로 바꾸면 안내) */}
        {inclusionNotice && (
          <div
            role="status"
            data-testid="inclusion-notice"
            className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800 flex items-center justify-between"
          >
            <span>ℹ️ {inclusionNotice}</span>
            <button
              onClick={() => setInclusionNotice(null)}
              className="text-xs text-blue-600 hover:underline"
            >
              닫기
            </button>
          </div>
        )}

        {/* 파일 올리기 영역 (SP §s2). 손님에게는 숨긴다(#53). */}
        {!canUpload && (
          <p
            data-testid="guest-upload-blocked-notice"
            className="text-sm text-gray-600 bg-white border border-gray-200 rounded-xl shadow-sm p-4"
          >
            손님 평가자는 파일을 올릴 수 없습니다. 이미 올라 있는 시험용 가상 자료로 보실 수 있습니다.
          </p>
        )}
        {canUpload && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4">
          <fieldset className="grid gap-3 rounded-lg border border-gray-200 p-4 sm:grid-cols-3" data-testid="upload-ai-metadata">
            <legend className="px-1 text-sm font-semibold text-gray-800">AI 입력 정보</legend>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={uploadMasked} onChange={(e) => setUploadMasked(e.target.checked)} />
              개인정보 마스킹 완료
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              AI 사용 승인
              <select value={uploadApprovedAi} onChange={(e) => setUploadApprovedAi(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
                <option value="solar">Solar</option>
                <option value="local-only">로컬 전용</option>
                <option value="external-chat">외부 AI 사용 승인</option>
                <option value="none">승인 안 함</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              종료평가보고서 여부
              <select value={uploadPastFinalReport} onChange={(e) => setUploadPastFinalReport(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
                <option value="unknown">미선택 (확인 전 분석 제외)</option>
                <option value="true">과거 종료평가보고서</option>
                <option value="false">이번 사업의 자료다</option>
              </select>
            </label>
          </fieldset>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFiles(e.dataTransfer.files);
              }
            }}
            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-500 hover:bg-blue-50/30 transition cursor-pointer flex flex-col items-center justify-center space-y-2"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".hwp,.hwpx,.pdf,.doc,.docx"
              className="hidden"
              data-testid="file-upload-input"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleFiles(e.target.files);
                }
              }}
            />
            <div className="text-3xl select-none">📁</div>
            <div className="text-base font-semibold text-gray-800">
              {isUploading ? '파일 추출 및 분류 중...' : '파일 올리기'}
            </div>
            <div className="text-xs text-gray-500">
              HWP · HWPX · PDF · DOC · DOCX 여러 파일을 한 번에 올릴 수 있습니다 (끌어다 놓기 지원)
            </div>
          </div>
        </div>
        )}

        {/* 지원하지 않는 형식 거부 알림 (UC-15, SP §s2 line 91) */}
        {rejectedFiles.length > 0 && (
          <div className="space-y-2" data-testid="rejected-files-section">
            {rejectedFiles.map((rej, idx) => (
              <div
                key={idx}
                role="alert"
                data-testid={`rejected-file-${idx}`}
                className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between"
              >
                <span>
                  ✕ <strong>{rej.fileName}</strong> — {rej.reason}
                </span>
                <button
                  onClick={() => setRejectedFiles((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-xs text-red-600 hover:underline"
                >
                  지우기
                </button>
              </div>
            ))}
          </div>
        )}

        {readFailures.length > 0 && (
          <div className="space-y-2" data-testid="read-failures-section">
            {readFailures.map((failure, idx) => (
              <div
                key={idx}
                role="status"
                data-testid={'read-failure-' + idx}
                className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900"
              >
                <strong>{failure.fileName}</strong> — 읽지 못함: {failure.reason}
              </div>
            ))}
          </div>
        )}

        {/* 업로드 일반 오류 표시 */}
        {uploadFailure && (
          <FailureMessage
            message={uploadFailure.message}
            onRetry={() => runUpload(uploadFailure.files, false)}
            isRetrying={isUploading}
            testId="upload-error"
          />
        )}

        {/* 파일 목록 표 (SP §S2) */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/70 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">
              등록된 자료 ({documents.length}개)
            </h2>
            <span className="text-xs text-gray-500">행을 누르면 문단 미리보기가 열립니다</span>
          </div>

          {documents.length === 0 ? (
            <div
              data-testid="empty-documents-notice"
              className="p-12 text-center text-sm text-gray-500 space-y-1"
            >
              <p className="font-medium text-gray-600">올린 자료가 없습니다.</p>
              <p className="text-xs text-gray-400">
                {canUpload
                  ? '위의 파일 올리기 영역에 문서를 추가하세요.'
                  : '손님은 파일을 올릴 수 없습니다. 가상 자료가 담긴 시험 사업을 고르세요.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200" data-testid="documents-table">
                <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th scope="col" className="px-6 py-3 text-left">
                      파일 이름
                    </th>
                    <th scope="col" className="px-6 py-3 text-left w-48">
                      문서 종류
                    </th>
                    <th scope="col" className="px-6 py-3 text-center w-36">
                      상태
                    </th>
                    <th scope="col" className="px-6 py-3 text-left w-64">
                      포함 여부
                    </th>
                    <th scope="col" className="px-6 py-3 text-left">AI 입력 정보</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200 text-sm">
                  {documents.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    const isUnreadable = doc.status === '읽지 못함';
                    const isExcluded = doc.is_included === 0;

                    return (
                      <tr
                        key={doc.id}
                        data-testid={`doc-row-${doc.id}`}
                        onClick={() => loadParagraphs(doc.id)}
                        className={`transition cursor-pointer ${
                          isSelected ? 'bg-blue-50/80 font-medium' : 'hover:bg-gray-50'
                        }`}
                      >
                        {/* 파일 이름 */}
                        <td className="px-6 py-4">
                          <span
                            data-testid={`doc-name-${doc.id}`}
                            className="text-gray-900 font-medium"
                          >
                            {doc.file_name}
                          </span>
                          {(() => {
                            const eligibility = getAiDocumentEligibilityForProvider(doc, aiProvider);
                            return !eligibility.eligible ? (
                              <p className="mt-1 text-xs text-amber-800" data-testid={`ai-exclusion-${doc.id}`}>
                                AI 입력 제외: {eligibility.reasons.join(' · ')}
                              </p>
                            ) : null;
                          })()}
                        </td>

                        {/* 문서 종류 (D29) */}
                        <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                          <select
                            data-testid={`doc-type-select-${doc.id}`}
                            value={docTypeDrafts[doc.id] ?? doc.doc_type ?? '기타'}
                            onChange={(e) => handleTypeChange(doc.id, e.target.value)}
                            disabled={isPending}
                            className="w-full px-2.5 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                          >
                            {DOC_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <DocumentEvidenceWarning visible={Boolean(typeEvidenceWarnings[doc.id])} />
                          {documentSaveFailure?.kind === 'type' &&
                            documentSaveFailure.documentId === doc.id && (
                              <FailureMessage
                                message={documentSaveFailure.message}
                                onRetry={retryDocumentSave}
                                isRetrying={isPending}
                                testId={`doc-type-error-${doc.id}`}
                              />
                            )}
                        </td>

                        {/* 상태 (SP §s2 line 99: 추출 중 / 추출 완료 / 읽지 못함) */}
                        <td className="px-6 py-4 text-center" data-testid={`doc-status-${doc.id}`}>
                          {isUnreadable ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                              <span>⊘</span> 읽지 못함
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                              추출 완료
                            </span>
                          )}
                        </td>

                        {/* 포함 여부 및 제외 이유 (RQ-05, D14, SP §s2) */}
                        <td className="px-6 py-4 space-y-1" onClick={(e) => e.stopPropagation()}>
                          {isUnreadable ? (
                            <span
                              data-testid={`doc-inclusion-unavailable-${doc.id}`}
                              aria-label="읽지 못한 파일은 포함 여부를 선택할 수 없음"
                              title="읽지 못한 파일은 포함 여부를 선택할 수 없습니다."
                              className="inline-flex min-h-7 items-center px-2.5 py-1 text-xs font-semibold text-gray-500"
                            >
                              —
                            </span>
                          ) : (
                            <select
                              data-testid={`doc-inclusion-select-${doc.id}`}
                              value={
                                (inclusionDrafts[doc.id] ?? doc.is_included === 1)
                                  ? '포함'
                                  : '기본 제외'
                              }
                              onChange={(e) => handleInclusionChange(doc.id, e.target.value === '포함')}
                              disabled={isPending}
                              aria-describedby={isExcluded && doc.excluded_reason ? `reason-${doc.id}` : undefined}
                              className={`px-2.5 py-1 text-sm border rounded-md font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                                isExcluded
                                  ? 'bg-amber-50 text-amber-900 border-amber-300'
                                  : 'bg-white text-gray-800 border-gray-300'
                              }`}
                            >
                              <option value="포함">포함</option>
                              <option value="기본 제외">기본 제외</option>
                            </select>
                          )}

                          {documentSaveFailure?.kind === 'inclusion' &&
                            documentSaveFailure.documentId === doc.id && (
                              <FailureMessage
                                message={documentSaveFailure.message}
                                onRetry={retryDocumentSave}
                                isRetrying={isPending}
                                testId={`doc-inclusion-error-${doc.id}`}
                              />
                            )}

                          {isExcluded && doc.excluded_reason && (
                            <div
                              id={`reason-${doc.id}`}
                              data-testid={`doc-excluded-reason-${doc.id}`}
                              className="text-xs text-amber-800 pl-1"
                            >
                              └ 이유: {doc.excluded_reason}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                          <DocumentAiMetadata doc={doc} projectId={project.id} canEdit={canUpload} onSaved={setDocuments} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 문단 미리보기 패널 (D06, SP §s2 lines 92-95) */}
        {selectedDocument && (
          <div
            data-testid="paragraph-preview-panel"
            className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-gray-200 pb-3">
              <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <span>문단 미리보기:</span>
                <span className="text-blue-700">{selectedDocument.file_name}</span>
              </h3>
              <span className="text-xs text-gray-400">
                {selectedDocument.status === '읽지 못함'
                  ? '텍스트 없음'
                  : `총 ${previewParagraphs.length}개 문단`}
              </span>
            </div>

            {isLoadingPreview ? (
              <div className="py-8 text-center text-sm text-gray-500">문단 불러오는 중...</div>
            ) : previewFailure?.documentId === selectedDocument.id ? (
              <FailureMessage
                message={previewFailure.message}
                onRetry={() => loadParagraphs(previewFailure.documentId)}
                isRetrying={isLoadingPreview}
                testId="preview-error"
              />
            ) : selectedDocument.status === '읽지 못함' || previewParagraphs.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-500">
                추출된 문단이 없습니다 (읽지 못함).
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                {previewParagraphs.map((para) => {
                  const isMasked = para.content.includes('[인용 금지 문장]');
                  const isTarget = targetLocation !== null && para.location === targetLocation;
                  return (
                    <div
                      key={para.id}
                      data-testid={`preview-paragraph-${para.sequence_no}`}
                      data-highlighted={isTarget ? 'true' : undefined}
                      className={`p-3 rounded-lg text-sm flex items-start gap-4 transition ${
                        isTarget
                          ? 'bg-blue-100/90 border-2 border-blue-500 shadow-xs'
                          : 'bg-gray-50 hover:bg-gray-100/80'
                      }`}
                    >
                      <span
                        className={`font-mono text-xs font-semibold shrink-0 w-20 pt-0.5 ${
                          isTarget ? 'text-blue-900 font-bold' : 'text-gray-500'
                        }`}
                      >
                        {para.location}
                      </span>
                      <p
                        className={`flex-1 leading-relaxed ${
                          isTarget ? 'text-blue-950 font-medium' : 'text-gray-800'
                        } ${
                          isMasked ? 'italic font-medium text-amber-900 bg-amber-50/70 p-1.5 rounded' : ''
                        }`}
                      >
                        {isMasked ? (
                          <span data-testid="forbidden-quote-masked">{para.content}</span>
                        ) : (
                          `"${para.content}"`
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <WorkflowNextAction projectId={project.id} screen="documents" hasPdm={hasPdm} />
      </div>
    </div>
  );
}
