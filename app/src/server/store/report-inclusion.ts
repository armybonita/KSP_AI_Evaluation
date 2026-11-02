/** 보고서에 쓰는 지표와 연결 근거 중 평가자가 제외한 문서가 있는지 판정한다. */
export function isReportTargetDocumentIncluded(
  sourceId: string | null | undefined,
  evidenceDocumentIds: Iterable<string>,
  documents: ReadonlyMap<string, { is_included: number }>,
): boolean {
  const source = sourceId ? documents.get(sourceId) : undefined;
  if (source && source.is_included !== 1) return false;
  for (const documentId of evidenceDocumentIds) {
    const document = documents.get(documentId);
    if (document && document.is_included !== 1) return false;
  }
  return true;
}
