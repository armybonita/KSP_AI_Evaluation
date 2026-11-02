export const VERDICT_STATUSES = [
  '실현',
  '추진 중',
  '기대',
  '미확인',
  '근거 충돌',
] as const;

export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export function isVerdictStatus(value: unknown): value is VerdictStatus {
  return (
    typeof value === 'string' &&
    (VERDICT_STATUSES as readonly string[]).includes(value)
  );
}

export function assertVerdictStatus(value: unknown): asserts value is VerdictStatus {
  if (!isVerdictStatus(value)) {
    throw new Error(
      `허용되지 않은 판정 상태입니다: "${String(value)}". 허용값: ${VERDICT_STATUSES.join(', ')}`
    );
  }
}

export const SPEAKERS = ['KDI', '협력국', '심사위원', '수행기관'] as const;
export type Speaker = (typeof SPEAKERS)[number];

export function isSpeaker(value: unknown): value is Speaker {
  return (
    typeof value === 'string' && (SPEAKERS as readonly string[]).includes(value)
  );
}

export const DOC_TYPES = [
  '사업계획서',
  '국문 PCP',
  '성과관리표',
  '출장결과보고서',
  '종료평가보고서',
  '심사 의견',
  '반영비교표',
  '기타',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export function isDocType(value: unknown): value is DocType {
  return (
    typeof value === 'string' &&
    (DOC_TYPES as readonly string[]).includes(value)
  );
}

export interface ProjectRecord {
  id: string;
  name: string;
  created_at: string;
  project_year?: number | null;
  country?: string | null;
  region?: string | null;
  partner_ministry?: string | null;
  project_type?: string | null;
  kdi_cid?: string | null;
  implementing_org?: string | null;
  partner_government_org?: string | null;
  is_ended?: number | null;
  pilot_label?: string | null;
  metadata_source?: '종료평가보고서' | '등록 정보' | null;
}

export interface ProjectDocumentSummary {
  id: string;
  project_id: string;
  file_name: string;
  doc_type: DocType;
  created_at: string;
}

export interface ProjectWithCount extends ProjectRecord {
  document_count: number;
  has_pdm: number;
  has_pcp: number;
  pdm_document?: ProjectDocumentSummary | null;
  pcp_document?: ProjectDocumentSummary | null;
  review_total: number;
  reviewed_count: number;
  needs_revision_count: number | null;
  evaluator_name?: string | null;
}

export type ProjectMetadata = Pick<ProjectRecord,
  'project_year' | 'country' | 'region' | 'partner_ministry' | 'project_type' |
  'kdi_cid' | 'implementing_org' | 'partner_government_org' | 'is_ended' | 'pilot_label' | 'metadata_source'>;

export type ClassificationSource = 'auto' | 'user';

export interface DocumentRecord {
  id: string;
  project_id: string;
  file_name: string;
  file_type: string;
  status: '추출 완료' | '읽지 못함';
  doc_type: DocType | null;
  is_included: number;
  excluded_reason: string | null;
  masked?: boolean | null;
  approved_ai?: string;
  is_past_final_report?: boolean | null;
  inclusion_source?: ClassificationSource;
  doctype_source?: ClassificationSource;
  created_at: string;
}

export interface ParagraphRecord {
  id: string;
  document_id: string;
  sequence_no: number;
  location: string;
  content: string;
  table_index?: number | null;
  table_cols?: number | null;
  table_row?: number | null;
  table_col?: number | null;
  grid_coord_version?: number | null;
}

export interface SentenceRecord {
  id: string;
  document_id: string;
  paragraph_id: string;
  sequence_no: number;
  location: string;
  content: string;
  is_citation_banned: number;
}

export interface IndicatorRecord {
  id: string;
  project_id: string;
  level: '영향' | '중기성과' | '단기성과' | '산출물' | '활동' | string;
  name: string;
  ovi: string;
  mov: string | null;
  target_value: string | null;
  parent_id?: string | null;
  source_doc_id?: string | null;
  source_location?: string | null;
  sort_order?: number;
  is_baseline: number;
  is_unknown_level?: boolean | number;
  is_orphaned?: number;
  created_at: string;
}

export interface IndicatorConflictRecord {
  id: string;
  project_id: string;
  indicator_id: string;
  doc_a_id: string;
  doc_a_name: string;
  doc_a_value: string;
  doc_a_location?: string | null;
  doc_b_id: string;
  doc_b_name: string;
  doc_b_value: string;
  doc_b_location?: string | null;
  created_at: string;
}

export interface IndicatorBaselineRecord {
  id: string;
  project_id: string;
  indicator_id: string;
  document_id: string;
  document_name: string;
  target_value: string;
  selected_at: string;
  conflict_id?: string | null;
  other_doc_id?: string | null;
}

export interface TocItem {
  indicator: IndicatorRecord;
  planDetails?: Array<{ label: string; value: string }>;
  sourceDocument?: DocumentRecord | null;
  conflict?: IndicatorConflictRecord | null;
  conflicts?: IndicatorConflictRecord[];
  baseline?: IndicatorBaselineRecord | null;
  baselines?: IndicatorBaselineRecord[];
  children?: TocItem[];
  is_unknown_level?: boolean;
}

export interface TocPageData {
  project: ProjectRecord;
  hasPdm: boolean;
  pdmDocument?: DocumentRecord | null;
  items: TocItem[];
  conflicts: IndicatorConflictRecord[];
  baselines: IndicatorBaselineRecord[];
  warningMessage?: string | null;
}

export interface SuggestionRecord {
  id: string;
  indicator_id: string;
  verdict_status: VerdictStatus;
  error_reason: string | null;
  proposal_text: string | null;
  created_at: string;
}

export interface EvidenceRecord {
  id: string;
  suggestion_id: string;
  quote: string;
  document_id: string;
  location: string;
  speaker: string;
  is_citation_banned?: number;
}

export interface ParagraphContext {
  target: ParagraphRecord;
  previous?: ParagraphRecord;
  next?: ParagraphRecord;
  surroundings: ParagraphRecord[];
}

export interface ReviewEvidence extends EvidenceRecord {
  document_name: string;
  paragraph_context?: ParagraphContext;
  is_citation_banned?: number;
}

export interface IndicatorAttributionRecord {
  id: string;
  project_id: string;
  indicator_id: string;
  attribution_text: string;
  updated_at: string;
}

export const CONFIRMATION_TYPES = [
  '확정',
  '수정 후 확정',
  '보완 필요',
  '채택 제외',
] as const;

export type ConfirmationType = (typeof CONFIRMATION_TYPES)[number];

export function isConfirmationType(value: unknown): value is ConfirmationType {
  return (
    typeof value === 'string' &&
    (CONFIRMATION_TYPES as readonly string[]).includes(value)
  );
}

export function assertConfirmationType(
  value: unknown
): asserts value is ConfirmationType {
  if (!isConfirmationType(value)) {
    throw new Error(
      `허용되지 않은 확정 종류입니다: "${String(value)}". 허용값: ${CONFIRMATION_TYPES.join(', ')}`
    );
  }
}

export interface ConfirmationRecord {
  id: string;
  indicator_id: string;
  suggestion_id?: string | null;
  confirmation_type: ConfirmationType;
  initial_proposal?: string | null;
  edited_text?: string | null;
  edited_verdict_status?: VerdictStatus | null;
  reason?: string | null;
  confirmer_name: string;
  created_at: string;
  ai_verdict_status?: VerdictStatus | null;
}

export type CreateConfirmationInput = Omit<
  ConfirmationRecord,
  'id' | 'created_at' | 'initial_proposal' | 'suggestion_id' | 'ai_verdict_status'
> & {
  id?: string;
  created_at?: string;
};

export interface ReviewIndicatorItem {
  indicator: IndicatorRecord;
  suggestion:
    | (SuggestionRecord & {
        evidences: ReviewEvidence[];
      })
    | null;
  conflict?: IndicatorConflictRecord | null;
  conflicts?: IndicatorConflictRecord[];
  baseline?: IndicatorBaselineRecord | null;
  baselines?: IndicatorBaselineRecord[];
  latestConfirmation?: ConfirmationRecord | null;
  attribution?: string | null;
}

export interface ReviewPageData {
  project: ProjectRecord;
  indicators: ReviewIndicatorItem[];
  unreadableDocuments: DocumentRecord[];
  latestConfirmerName?: string;
}

export interface IndicatorWithConfirmations {
  indicator: IndicatorRecord;
  latestSuggestion: (SuggestionRecord & { evidences: ReviewEvidence[] }) | null;
  confirmations: ConfirmationRecord[];
  latestConfirmation: ConfirmationRecord | null;
  attribution?: string | null;
}

export interface HistoryPageData {
  project: ProjectRecord;
  indicators: IndicatorWithConfirmations[];
  selectedIndicatorId?: string;
  latestConfirmerName?: string;
}

export type ResultTocDisplayKind =
  | '실현'
  | '추진 중'
  | '기대'
  | '미확인'
  | '근거 충돌'
  | '보완 필요'
  | '채택 제외'
  | '미확정';

export interface ResultTocItem {
  indicator: IndicatorRecord;
  latestConfirmation: ConfirmationRecord | null;
  latestSuggestion: SuggestionRecord | null;
  displayKind: ResultTocDisplayKind;
  verdictStatus: VerdictStatus | null;
  isOrphaned: boolean;
}

export interface ResultTocPageData {
  project: ProjectRecord;
  items: ResultTocItem[];
  activeItems: ResultTocItem[];
  orphanedItems: ResultTocItem[];
  totalConfirmedCount: number;
  indicatorConfirmedCount?: number;
  noteConfirmedCount?: number;
  hasAnyConfirmation: boolean;
  hasPdm: boolean;
  warningMessage?: string | null;
}

export interface ReportRecord {
  id: string;
  project_id: string;
  content_json: string;
  created_at: string;
}

export interface ReportTargetIndicator {
  indicator: IndicatorRecord;
  latestConfirmation: ConfirmationRecord;
  confirmedText: string;
  verdictStatus: VerdictStatus;
  isUnverifiedVerdict: boolean;
  evidences: ReviewEvidence[];
}

export type OutcomeStageKey = 'activity' | 'output' | 'outcome-short' | 'outcome-mid' | 'impact';
export type OutcomeStageLabel = '활동' | '산출물' | '단기' | '중장기' | '영향';

export interface OutcomeIndicatorFinalResult {
  indicator_id: string;
  indicator_name: string;
  level: string;
  stage_key: OutcomeStageKey;
  stage_label: OutcomeStageLabel;
  target_value: string;
  baseline_value: string;
  unit: string;
  is_confirmed: boolean;
  confirmation_type: '확정' | '수정 후 확정' | null;
  actual_value: string;
  verdict_status: VerdictStatus | null;
  status_display: string;
  evidence_count: number;
  is_orphaned: boolean;
  review_href: string;
  report_href: string;
}

export interface OutcomeStageRow {
  stage_key: OutcomeStageKey;
  stage_label: OutcomeStageLabel;
  indicators: OutcomeIndicatorFinalResult[];
}

export interface OutcomeFinalResultsData {
  projectId: string;
  stages: OutcomeStageRow[];
  hasConfirmedResults: boolean;
  totalIndicators: number;
  confirmedCount: number;
}


