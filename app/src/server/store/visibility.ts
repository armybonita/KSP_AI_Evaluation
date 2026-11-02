import type Database from 'better-sqlite3';
import { getBannedSentencesByProject, getDatabase, getReportTargets, listDocuments } from './db';
import { hasForbiddenSentenceOverlap, isCitationBannedSentence } from './citation-ban';
import { omissionReason, type OmittedItem } from '../../lib/visibility-reasons';
import { getAiProvider } from '../ai';
import { getAiDocumentEligibilityForProvider } from '../documents/ai-eligibility';
import { isCitableEvidence } from './citable-evidence';
import { isReportTargetDocumentIncluded } from './report-inclusion';

/** Latest indicator decisions which do not enter report prose. */
export function indicatorOmissions(projectId: string, db: Database.Database = getDatabase()): OmittedItem[] {
  const rows = db.prepare(`SELECT i.id, i.name, c.confirmation_type AS status, c.edited_text,
    c.initial_proposal
    FROM indicators i
    LEFT JOIN confirmations c ON c.rowid = (SELECT latest.rowid FROM confirmations latest
      WHERE latest.indicator_id = i.id ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
    WHERE i.project_id = ?`).all(projectId) as Array<{
      id: string; name: string; status: string | null; edited_text: string | null;
      initial_proposal: string | null;
    }>;
  const pending = rows.filter(row => !['확정', '수정 후 확정', '채택 제외'].includes(row.status ?? '')).length;
  const banned = getBannedSentencesByProject(projectId, db).map(sentence => sentence.content);
  const reportTargetIds = rows.filter(row => ['확정', '수정 후 확정'].includes(row.status ?? '')).map(row => row.id);
  const targets = new Map((reportTargetIds.length ? getReportTargets(projectId, db, undefined, reportTargetIds) : [])
    .map(target => [target.indicator.id, target]));
  const documents = new Map(listDocuments(projectId, db).map(document => [document.id, document]));
  const provider = getAiProvider();
  const safeText = (text: string) => isCitationBannedSentence(text) || hasForbiddenSentenceOverlap(text, banned, 8)
    ? '[인용 금지 문장]' : text;
  return rows.flatMap(row => {
    const name = safeText(row.name);
    const omit = (reason: string): OmittedItem[] => [{ name, reason: safeText(reason) }];
    if (row.status === '채택 제외') return omit(omissionReason('excluded'));
    if (!['확정', '수정 후 확정'].includes(row.status ?? '')) return omit(omissionReason('pending', pending));
    const target = targets.get(row.id);
    if (!target) return omit('보고서 대상 자료 확인 불가');
    if (!target.evidences.length) return omit(omissionReason('noEvidence'));
    if (target.verdictStatus === '미확인') return omit('판정 미확인이라 서술 제외');
    if (row.status === '수정 후 확정') {
      if (!isReportTargetDocumentIncluded(target.indicator.source_doc_id, target.evidences.map(evidence => evidence.document_id), documents)) {
        return omit('평가자가 제외한 문서');
      }
      const editedText = row.edited_text ?? '';
      if (isCitationBannedSentence(editedText) || hasForbiddenSentenceOverlap(editedText, banned, 8)) return omit('금지 문장 겹침으로 서술 제외');
      return [];
    }
    const documentIds = [target.indicator.source_doc_id, ...target.evidences.map(evidence => evidence.document_id)];
    for (const documentId of documentIds) {
      if (!documentId) return omit('지표 원문 출처 문서 확인 불가');
      const document = documents.get(documentId);
      if (!document) return omit('원문 출처 문서를 확인할 수 없음');
    }
    if (!isReportTargetDocumentIncluded(target.indicator.source_doc_id, target.evidences.map(evidence => evidence.document_id), documents)) {
      return omit('평가자가 제외한 문서');
    }
    for (const documentId of documentIds) {
      const document = documents.get(documentId!)!;
      const eligibility = getAiDocumentEligibilityForProvider(document, provider);
      if (!eligibility.eligible) return omit(eligibility.reasons[0]);
    }
    const citable = target.evidences.filter(evidence => isCitableEvidence(
      evidence, evidence.paragraph_context?.target?.content, banned,
    ));
    if (!citable.length) return omit('검증 통과 근거 없음');
    const confirmedText = row.initial_proposal ?? target.confirmedText;
    if (isCitationBannedSentence(confirmedText) || hasForbiddenSentenceOverlap(confirmedText, banned, 8)) {
      return omit('금지 문장 겹침으로 서술 제외');
    }
    return [];
  });
}
