import { exclusionReasonForDocument } from './documents/exclusion-reason';
import { getProjectCitationContext, listDocuments } from '@/server/store';
import { hasEligiblePdm, pdmReasonDocument } from './documents/pdm-eligibility';
import { maskTextIfForbiddenSentenceOverlap } from './store/citation-ban';

export function isProjectPdmRegistered(projectId: string): boolean {
  return hasEligiblePdm(listDocuments(projectId));
}

export function projectPdmExclusionReason(projectId: string): string {
  const document = pdmReasonDocument(listDocuments(projectId));
  if (!document) return exclusionReasonForDocument({ kind: 'pdm' });
  const bannedSentences = getProjectCitationContext(projectId).originalSentences;
  return exclusionReasonForDocument({ kind: 'pdm', document: {
    ...document,
    file_name: maskTextIfForbiddenSentenceOverlap(document.file_name, bannedSentences, 8),
  } });
}

export function assertProjectPdmRegistered(projectId: string): void {
  if (!isProjectPdmRegistered(projectId)) throw new Error(projectPdmExclusionReason(projectId));
}
