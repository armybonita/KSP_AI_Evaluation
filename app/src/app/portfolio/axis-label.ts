import type { PortfolioAxis, PortfolioEmptyReason } from '@/lib/portfolio';

const EMPTY_REASON_LABELS: Record<PortfolioEmptyReason, string> = {
  no_outcomes: '성과 노트 없음',
  no_confirmed_outcomes: '평가팀 확인 성과 없음',
  expected_only: '확정된 성과가 기대/추정 상태뿐',
  unobserved_state: '관측·입증 상태 아님',
  ineligible_evidence: '근거 자격 없음',
  no_observed_evidence: '관측·입증 근거 없음',
  no_family_outcomes: '해당 성과군 없음',
  unclassified_family: '성과군 미분류',
  team_level_missing: '평가팀 레벨 미입력',
};

export function exclusionReasonLabel(reason: PortfolioEmptyReason): string {
  return EMPTY_REASON_LABELS[reason];
}

export function axisLabel(axis: PortfolioAxis): string {
  return axis.level ?? `확인 필요: ${EMPTY_REASON_LABELS[axis.emptyReason ?? 'no_outcomes']}`;
}
