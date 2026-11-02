export const REPORT_SECTION_TITLES = [
  '성과지표 달성표',
  '성과 분석',
  '기여요인',
  '제약요인과 대응',
  '교훈',
  '모니터링 계획',
  '종합평가',
] as const;

export type ReportSectionTitle = (typeof REPORT_SECTION_TITLES)[number];

export interface ReportAchievementItem {
  indicator_id: string;
  indicator_name: string;
  target_value: string;
  status_display: string; // '실현', '추진 중', '기대', '근거 충돌', '근거 미확인' (D33)
  source?: ReportSource;
  confirmation_type?: string; // '확정' | '수정 후 확정' (#22)
  edited_text?: string; // 수정 후 확정 시 수정본 (#22)
  evidence_id?: string;
  evidence_document_name?: string;
  evidence_location?: string;
  evidence_match_warning?: string;
  is_orphaned?: boolean;
}

export interface ReportSentenceEvidence {
  id: string;
  quote: string;
  location: string;
  speaker: string;
  document_name?: string;
  is_citation_banned?: number;
  review_status?: string;
  evidence_level?: string;
  confidence?: string;
  confirmer_role?: string;
  confirmed_at?: string;
  document_id?: string;
}

export type ReportSource = 'human' | 'ai' | 'document' | 'missing';
export interface ReportCell { text: string; source: ReportSource; evidence_ids?: string[]; indicator_id?: string; is_label?: boolean }

export interface ReportSentenceItem {
  source?: ReportSource;
  node_label?: string;
  indicator_id: string;
  indicator_name: string;
  sentence: string;
  evidence_id: string;
  evidence_ids: string[];
  evidences?: ReportSentenceEvidence[];
  evidence_quote?: string;
  evidence_location?: string;
  evidence_speaker?: string;
  document_name?: string;
  evidence_match_warning?: string;
}

export interface ReportDraftData {
  summary_format?: 1;
  version?: number;
  template?: ReportTemplate;
  template_source?: string;
  report_sections?: ReportSection[];
  footnotes?: ReportFootnote[];
  project_id: string;
  project_name: string;
  confirmed_count: number;
  review_pending_count?: number;
  draft_number?: number;
  report_finalization?: { role: string; confirmed_at: string };
  created_at: string;
  fingerprint?: string;
  judgment_fingerprint?: string;
  ai_exclusions?: Array<{ subject: string; reasons: string[] }>;
  fingerprint_version?: number;
  sections: {
    achievement_table: {
      title: '성과지표 달성표';
      rows: ReportAchievementItem[];
      empty_message?: string;
    };
    performance_analysis: {
      title: '성과 분석';
      sentences: ReportSentenceItem[];
      empty_message?: string;
    };
    contributing_factors: {
      title: '기여요인';
      content?: string;
      sentences?: ReportSentenceItem[];
      empty_message?: string;
      excluded_notice?: string;
      excluded_count?: number;
    };
    constraints_and_responses: {
      title: '제약요인과 대응';
      content?: string;
      empty_message?: string;
    };
    lessons_learned: {
      title: '교훈';
      content?: string;
      empty_message?: string;
    };
    monitoring_plan: {
      title: '모니터링 계획';
      content?: string;
      empty_message?: string;
    };
    overall_evaluation: {
      title: '종합평가';
      content?: string;
      empty_message?: string;
    };
  };
}

export type ReportTemplate = 'ksp' | 'eipp' | 'legacy7';
export interface ReportFootnote { number: number; evidence_id: string; document_id?: string; document_name?: string; location?: string; quote?: string; speaker?: string; review_status?: string; evidence_level?: string; confidence?: string; confirmer_role?: string; confirmed_at?: string; indicator_id?: string; indicator_name?: string }
export interface ReportSection { id: string; title: string; level: number; source?: ReportSource; table?: { columns: string[]; rows: ReportCell[][] }; content?: string; sentences?: ReportSentenceItem[]; rows?: ReportAchievementItem[]; empty_message?: string; children?: ReportSection[] }
