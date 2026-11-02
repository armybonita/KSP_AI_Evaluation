/** Past final report (holdout): explicit flag wins; when unanswered, the 종료평가보고서 type counts as past. */
export function isPastFinalReport(document: {
  is_past_final_report?: number | boolean | null;
  doc_type?: string | null;
}): boolean {
  const flag = document.is_past_final_report;
  if (flag === true || flag === 1) return true;
  if (flag === false || flag === 0) return false; // 사람이 '이번 사업의 자료'로 정한 값은 존중한다.
  return document.doc_type === '종료평가보고서'; // 미확인이면 종류로 판단해 안전하게 뺀다.
}

/** Only an explicit negative answer permits document content to be used for analysis. */
export function isConfirmedNonPastReport(document: { is_past_final_report?: number | boolean | null }): boolean {
  return document.is_past_final_report === false || document.is_past_final_report === 0;
}
