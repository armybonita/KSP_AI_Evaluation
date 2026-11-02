/** User-facing reason for an ineligible performance management document. */
export function exclusionReasonForDocument(input:
  { kind: 'pdm'; document?: { file_name: string; is_past_final_report?: boolean | number | null } }
): string {
  const doc = input.document;
  if (!doc) return '성과관리표가 없습니다. PDM 자료를 등록해 주세요.';
  if (doc.is_past_final_report == null) return `성과관리표 ${doc.file_name}의 과거 보고서 여부가 미확인이라 분석에서 뺐습니다. 자료 화면에서 확인해 주세요.`;
  if (doc.is_past_final_report === true || doc.is_past_final_report === 1) return `성과관리표 ${doc.file_name}은 과거 종료평가보고서로 표시되어 뺐습니다. 자료 화면에서 확인해 주세요.`;
  return `성과관리표 ${doc.file_name}의 포함 및 추출 상태를 자료 화면에서 확인해 주세요.`;
}
