export const POLICY_ADOPTION_FAMILY = '협력국 정책 반영';
export const COOPERATION_FAMILIES = [
  '개발협력 촉진',
  '경제협력 촉진',
  '지식 네트워킹',
] as const;
export const OUTCOME_FAMILIES = [POLICY_ADOPTION_FAMILY, ...COOPERATION_FAMILIES] as const;
export const KNOWLEDGE_LEVELS = ['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6'] as const;
export const COOPERATION_LEVELS = ['Lv1', 'Lv2', 'Lv3', 'Lv4', 'Lv5'] as const;
export const CONFIRMED_REVIEW_STATUSES = ['확정', '수정 후 확정'] as const;

export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number];
export type CooperationLevel = (typeof COOPERATION_LEVELS)[number];
export type PortfolioLevel = KnowledgeLevel | CooperationLevel;
export type OutcomeFamily = (typeof OUTCOME_FAMILIES)[number];
export type PortfolioOutcomeType = 'outcome-short' | 'outcome-mid';

export type PortfolioLevelHistory = {
  id: string;
  importId: string;
  nodeId: string;
  nodeType: PortfolioOutcomeType;
  outcomeFamily: string;
  aiLevel: string;
  teamLevel: PortfolioLevel | null;
  reviewer: string;
  createdAt: string;
};

export type PortfolioOutcome = {
  id: string;
  type: PortfolioOutcomeType;
  title: string;
  text: string;
  outcomeFamily: string;
  aiLevel: string;
  reviewStatus: string;
  outcomeState: string;
  evidenceEligible: boolean;
  evidenceObserved: boolean;
  teamLevel: PortfolioLevel | null;
  teamLevelSource: 'review_history' | 'imported' | null;
  history: PortfolioLevelHistory[];
};

export type PortfolioEmptyReason =
  | 'no_outcomes'
  | 'no_confirmed_outcomes'
  | 'expected_only'
  | 'unobserved_state'
  | 'ineligible_evidence'
  | 'no_observed_evidence'
  | 'no_family_outcomes'
  | 'unclassified_family'
  | 'team_level_missing';

export type PortfolioAxis = {
  level: PortfolioLevel | null;
  emptyReason: PortfolioEmptyReason | null;
};

export type PortfolioProjectSummary = {
  projectId: string;
  projectName: string;
  knowledge: PortfolioAxis;
  cooperation: PortfolioAxis;
  quadrant: string | null;
};

export type PortfolioPageData = {
  projectId: string;
  projectName: string;
  importId: string | null;
  outcomes: PortfolioOutcome[];
  summary: PortfolioProjectSummary;
};

export type PortfolioOutcomeInput = {
  type: string;
  outcomeFamily: string;
  reviewStatus: string;
  outcomeState: string;
  evidenceEligible: boolean;
  evidenceObserved: boolean;
  teamLevel: string | null;
};

const POLICY_FAMILY_SET = new Set<string>([POLICY_ADOPTION_FAMILY]);
const COOPERATION_FAMILY_SET = new Set<string>(COOPERATION_FAMILIES);
const ALL_FAMILY_SET = new Set<string>(OUTCOME_FAMILIES);
const CONFIRMED_STATUS_SET = new Set<string>(CONFIRMED_REVIEW_STATUSES);
const KNOWLEDGE_LEVEL_SET = new Set<string>(KNOWLEDGE_LEVELS);
const COOPERATION_LEVEL_SET = new Set<string>(COOPERATION_LEVELS);

export function portfolioLevelForFamily(family: string, value: string | null): PortfolioLevel | null {
  if (!value) return null;
  if (POLICY_FAMILY_SET.has(family) && KNOWLEDGE_LEVEL_SET.has(value)) return value as KnowledgeLevel;
  if (COOPERATION_FAMILY_SET.has(family) && COOPERATION_LEVEL_SET.has(value)) return value as CooperationLevel;
  return null;
}

export function levelsForOutcomeFamily(family: string): readonly PortfolioLevel[] {
  if (family === POLICY_ADOPTION_FAMILY) return KNOWLEDGE_LEVELS;
  if (COOPERATION_FAMILIES.includes(family as (typeof COOPERATION_FAMILIES)[number])) return COOPERATION_LEVELS;
  return [];
}

function numericLevel(level: PortfolioLevel): number {
  return Number(level.replace(/^K|^Lv/, ''));
}

/** Return the first reason an individual outcome cannot contribute to its axis. */
export function portfolioExclusionReason(outcome: PortfolioOutcomeInput): PortfolioEmptyReason | null {
  if (!ALL_FAMILY_SET.has(outcome.outcomeFamily)) return 'unclassified_family';
  if (!CONFIRMED_STATUS_SET.has(outcome.reviewStatus)) return 'no_confirmed_outcomes';
  if (!['관측됨', '관측', '입증'].includes(outcome.outcomeState)) {
    return outcome.outcomeState === '기대/추정' ? 'expected_only' : 'unobserved_state';
  }
  if (!outcome.evidenceEligible) return 'ineligible_evidence';
  if (!outcome.evidenceObserved) return 'no_observed_evidence';
  if (!portfolioLevelForFamily(outcome.outcomeFamily, outcome.teamLevel)) return 'team_level_missing';
  return null;
}

export function outcomeBelongsToAxis(outcome: PortfolioOutcomeInput, kind: 'knowledge' | 'cooperation'): boolean {
  return (kind === 'knowledge' ? POLICY_FAMILY_SET : COOPERATION_FAMILY_SET).has(outcome.outcomeFamily);
}

function axisResult(outcomes: readonly PortfolioOutcomeInput[], kind: 'knowledge' | 'cooperation'): PortfolioAxis {
  if (outcomes.length === 0) return { level: null, emptyReason: 'no_outcomes' };
  const familySet = kind === 'knowledge' ? POLICY_FAMILY_SET : COOPERATION_FAMILY_SET;
  const inAxis = outcomes.filter((outcome) => familySet.has(outcome.outcomeFamily));
  if (inAxis.length === 0) {
    const hasUnclassifiedFamily = outcomes.some((outcome) => !ALL_FAMILY_SET.has(outcome.outcomeFamily));
    if (hasUnclassifiedFamily) return { level: null, emptyReason: 'unclassified_family' };
    const hasKnownFamily = outcomes.some((outcome) => ALL_FAMILY_SET.has(outcome.outcomeFamily));
    return { level: null, emptyReason: hasKnownFamily ? 'no_family_outcomes' : 'unclassified_family' };
  }

  const confirmed = inAxis.filter((outcome) => CONFIRMED_STATUS_SET.has(outcome.reviewStatus));
  if (confirmed.length === 0) return { level: null, emptyReason: 'no_confirmed_outcomes' };
  const observed = confirmed.filter((outcome) => ['관측됨', '관측', '입증'].includes(outcome.outcomeState));
  if (observed.length === 0) return { level: null, emptyReason: confirmed.every(o => o.outcomeState === '기대/추정') ? 'expected_only' : 'unobserved_state' };
  const eligible = observed.filter((outcome) => outcome.evidenceEligible);
  if (eligible.length === 0) return { level: null, emptyReason: 'ineligible_evidence' };

  const observedEvidence = eligible.filter((outcome) => outcome.evidenceObserved);
  if (observedEvidence.length === 0) return { level: null, emptyReason: 'no_observed_evidence' };

  const levels = observedEvidence
    .map((outcome) => portfolioLevelForFamily(outcome.outcomeFamily, outcome.teamLevel))
    .filter((level): level is PortfolioLevel => level !== null);
  if (levels.length === 0) return { level: null, emptyReason: 'team_level_missing' };
  const maximum = levels.reduce((best, current) => numericLevel(current) > numericLevel(best) ? current : best);
  return { level: maximum, emptyReason: null };
}

function quadrantFor(knowledge: PortfolioAxis, cooperation: PortfolioAxis): string | null {
  if (!knowledge.level || !cooperation.level) return null;
  const highKnowledge = numericLevel(knowledge.level) >= 4;
  const highCooperation = numericLevel(cooperation.level) >= 3;
  if (highKnowledge && highCooperation) return '확장 및 선도형 (1사분면)';
  if (highKnowledge) return '지식활용 및 정책수용형 (2사분면)';
  if (highCooperation) return '플랫폼형 (4사분면)';
  return '지식 축적 및 초기 탐색형 (3사분면)';
}

export function summarizePortfolioProject(
  projectId: string,
  projectName: string,
  outcomes: readonly PortfolioOutcomeInput[],
): PortfolioProjectSummary {
  const knowledge = axisResult(outcomes, 'knowledge');
  const cooperation = axisResult(outcomes, 'cooperation');
  return {
    projectId,
    projectName,
    knowledge,
    cooperation,
    quadrant: quadrantFor(knowledge, cooperation),
  };
}
