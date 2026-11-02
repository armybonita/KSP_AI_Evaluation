import { isConfirmedNonPastReport } from './holdout';
import type { DocumentRecord } from '../store/types';

export function hasEligiblePdm(documents: DocumentRecord[]): boolean {
  return documents.some((document) => document.doc_type === '성과관리표' && isConfirmedNonPastReport(document) && document.is_included === 1 && document.status === '추출 완료');
}

export function pdmReasonDocument(documents: DocumentRecord[]): DocumentRecord | undefined {
  const candidates = documents.filter(d => d.doc_type === '성과관리표');
  return candidates.find(d => d.is_included === 1 && d.status === '추출 완료' && !isConfirmedNonPastReport(d)) ?? candidates[0];
}
