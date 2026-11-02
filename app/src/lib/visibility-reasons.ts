export type OmittedItem = { name: string; reason: string };
export type OmissionCause = 'past' | 'unknownPast' | 'pending' | 'noEvidence' | 'excluded' | 'outdated' | 'noPdm';

export function omissionReason(cause: OmissionCause, pendingCount = 1): string {
  switch (cause) {
    case 'past': return '과거 종료평가보고서라 분석 제외';
    case 'unknownPast': return '과거 보고서 여부 미확인';
    case 'pending': return `아직 확정 전(검토 ${pendingCount}건 남음)`;
    case 'noEvidence': return '근거 문단 없음';
    case 'excluded': return '채택 제외';
    case 'outdated': return '초안이 확정 변경 전 판(새 초안 필요)';
    case 'noPdm': return '성과관리표(PDM) 미등록';
  }
}
