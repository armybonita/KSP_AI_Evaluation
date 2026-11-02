import type { ReportAchievementItem, ReportDraftData, ReportFootnote, ReportSection, ReportSentenceItem, ReportTemplate } from './types';
import { isEvidenceCitationBanned } from '../store/citation-ban';

function emptyEvidence(message: string): Pick<ReportSection, 'empty_message'> {
  return { empty_message: `※ 근거 자료 미확보: ${message}` };
}

export function buildReportSections(
  format: 'ksp' | 'eipp',
  achievementRows: ReportAchievementItem[],
  performanceSentences: ReportSentenceItem[],
  contributingSentences: ReportSentenceItem[]
): ReportSection[] {
  const evidenceText = '확정된 평가 판단과 연결된 근거 스니펫';
  const sentenceSection = (id: string, title: string, sentences: ReportSentenceItem[], empty: string, level = 4): ReportSection => ({
    id, title, level, sentences, ...(sentences.length ? {} : emptyEvidence(empty)),
  });
  const factorSection = (id: string, title: string, level = 5): ReportSection => sentenceSection(id, title, contributingSentences, evidenceText, level);
  if (format === 'eipp') {
    return [
      { id: 'eipp-results', title: '2. 사업별 모니터링 및 평가 결과', level: 2, children: [
        { id: 'eipp-overview', title: '1) 사업 개요', level: 3, ...emptyEvidence('사업 개요·수행체계 및 현황·기타') },
        { id: 'eipp-achievements', title: '2) 사업의 성과', level: 3, children: [
          { id: 'eipp-indicators', title: '성과지표 및 실적', level: 4, rows: achievementRows, ...(achievementRows.length ? {} : emptyEvidence(evidenceText)) },
          { id: 'eipp-analysis', title: '성과 분석', level: 4, children: [
            { id: 'eipp-financing', title: '재원연계형', level: 5, ...emptyEvidence('재원연계형으로 분류된 성과와 근거 스니펫') },
            { id: 'eipp-policy', title: '정책수립 및 집행 촉진형', level: 5, ...emptyEvidence('정책수립 및 집행 촉진형으로 분류된 성과와 근거 스니펫') },
            { id: 'eipp-trade', title: '교역·교류 촉진형', level: 5, ...emptyEvidence('교역·교류 촉진형으로 분류된 성과와 근거 스니펫') },
            { id: 'eipp-incidental', title: '부수적 성과', level: 5, ...emptyEvidence('부수적 성과로 분류된 성과와 근거 스니펫') },
            sentenceSection('eipp-unclassified', '성과 서술 (분류 미확인)', performanceSentences, evidenceText, 5),
            factorSection('eipp-factors', '성과 발현 기여요인', 5),
            { id: 'eipp-constraints', title: '제약요인 및 대응 노력', level: 5, ...emptyEvidence('제약요인과 대응 노력의 근거 스니펫') },
            { id: 'eipp-lessons', title: '성과 촉진을 위한 교훈', level: 5, ...emptyEvidence('PO가 확정한 교훈 근거') },
          ] },
          { id: 'eipp-monitoring', title: '향후 성과 모니터링 계획', level: 4, children: [
            { id: 'eipp-monitoring-plan', title: '향후 성과 모니터링 계획', level: 5, ...emptyEvidence('예견 스니펫 또는 N+1 이후 지표') },
            { id: 'eipp-monitoring-contact', title: '협력국 담당자 정보', level: 5, content: '개인정보는 보고서나 볼트에 복사하지 않고 원본 위치만 적습니다.' },
            { id: 'eipp-monitoring-notes', title: '향후 성과 모니터링 참고 사항', level: 5, ...emptyEvidence('모니터링 참고 사항의 근거') },
          ] },
        ] },
        { id: 'eipp-evaluation', title: '3) 종합평가 및 제언', level: 3, children: [
          { id: 'eipp-overall', title: '종합평가 (적절성·효율성·효과성·지속가능성)', level: 4, ...emptyEvidence('평가 기준별 사람 확정 내용') },
          { id: 'eipp-recommendations', title: '제언', level: 4, ...emptyEvidence('위험관리 및 대처방안·전년도 사업 환류·개별 사업 환류·EIPP 프로그램 환류 근거') },
        ] },
      ] },
    ];
  }
  return [
    { id: 'ksp-overview', title: '1. 사업 개요', level: 2, children: [
      { id: 'ksp-project', title: '사업 개요', level: 3, ...emptyEvidence('사업명(국문·영문)·협력국·협력부처·예산·사업 분야·수행체계 메타데이터') },
    ] },
    { id: 'ksp-results', title: '2. 종료평가 종합 결과', level: 2, children: [
      { id: 'ksp-assessment', title: '1) 종합 평가', level: 3, children: [
        { id: 'ksp-indicators', title: '성과지표', level: 4, rows: achievementRows, ...(achievementRows.length ? {} : emptyEvidence(evidenceText)) },
        { id: 'ksp-performance', title: '사업성과 평가', level: 4, children: [
          { id: 'ksp-major', title: '주요 성과', level: 5, ...emptyEvidence('주요 성과로 확정된 outcome 노드와 입증 스니펫') },
          { id: 'ksp-incidental', title: '기타 성과 — 부수적 성과 및 교훈', level: 5, ...emptyEvidence('부수적 성과 및 확정된 교훈 근거') },
          sentenceSection('ksp-unclassified', '성과 서술 (분류 미확인)', performanceSentences, evidenceText, 5),
          { id: 'ksp-implications', title: '시사점', level: 5, children: [
            factorSection('ksp-factors', '기여요인', 6),
            { id: 'ksp-constraints', title: '제약요인', level: 6, ...emptyEvidence('제약요인의 근거 스니펫') },
            { id: 'ksp-responses-lessons', title: '대응 노력과 교훈', level: 6, ...emptyEvidence('대응 노력 및 PO 확정 교훈의 근거') },
          ] },
          { id: 'ksp-monitoring', title: '성과 모니터링 계획', level: 5, ...emptyEvidence('예견 스니펫 또는 N+1 이후 지표') },
        ] },
      ] },
      { id: 'ksp-interview', title: '2) 종료평가 인터뷰', level: 3, children: [
        { id: 'ksp-interview-q1', title: '지식공유의 유용성 (Q1)', level: 4, content: '확인할 사항: 지식공유가 사업 참여자와 정책 실무에 유용했는지. 종료평가 인터뷰 기록이 있으면 근거와 함께 기록.' },
        { id: 'ksp-interview-q2', title: '정책제언 적합성 (Q2)', level: 4, content: '확인할 사항: 정책제언이 협력국의 수요와 여건에 적합했는지. 종료평가 인터뷰 기록이 있으면 근거와 함께 기록.' },
        { id: 'ksp-interview-q3', title: '정책실무자·고위정책결정자 관심도 (Q3)', level: 4, content: '확인할 사항: 정책실무자와 고위정책결정자의 관심 및 참여 근거.' },
        { id: 'ksp-interview-q4', title: '주요 성과 인식 (Q4)', level: 4, content: '확인할 사항: 인터뷰 참여자가 인식한 주요 성과와 관련 스니펫.' },
        { id: 'ksp-interview-q5', title: '정책제언 이행·후속조치 (Q5, Q5a~d)', level: 4, content: '확인할 사항: 정책제언의 이행 상태와 후속조치별 근거.' },
        { id: 'ksp-interview-other', title: '개선사항 / 기타 의견', level: 4, content: '확인할 사항: 개선사항 및 기타 의견. 개인정보는 포함하지 않고 원문 위치를 기록.' },
      ] },
      { id: 'ksp-feedback', title: '3) 교훈 및 기타 참고사항 (환류)', level: 3, ...emptyEvidence('환류로 확정된 교훈 근거') },
      { id: 'ksp-summary', title: '4) 총평', level: 3, ...emptyEvidence('사람이 확정한 총평 근거') },
    ] },
    { id: 'ksp-pdm', title: '3. PDM에 따른 성과관리 현황', level: 2, ...emptyEvidence('PDM 단계별 성과관리 근거') },
    { id: 'ksp-midterm', title: '4. 중간평가', level: 2, ...emptyEvidence('중간평가 개요·설문 결과·피드백 근거') },
  ];
}


export function defaultReportTemplate(name: string): 'ksp' | 'eipp' {
  if (/KSP/i.test(name)) return 'ksp';
  return /EIPP/i.test(name) ? 'eipp' : 'ksp';
}

export function reportTemplateSource(template: Exclude<ReportTemplate, 'legacy7'>): string {
  return template === 'eipp'
    ? 'T 종료평가보고서 EIPP (EIPP 모니터링 및 평가 가이드라인(안) 목차). 과거 종료평가보고서(holdout)는 읽지 않고 썼다.'
    : 'KSP 종료평가보고서 표준 목차. 과거 종료평가보고서(holdout)는 읽지 않고 썼다.';
}

export function prepareTemplate(draft: ReportDraftData, template: Exclude<ReportTemplate, 'legacy7'>, bannedSentences: string[] = []): void {
  const bannedIds = new Set<string>();
  const collectBannedIds = (section: ReportSection): void => {
    for (const sentence of section.sentences ?? []) {
      for (const evidence of sentence.evidences ?? []) {
        if (isEvidenceCitationBanned(evidence, bannedSentences)) bannedIds.add(evidence.id);
      }
    }
    section.children?.forEach(collectBannedIds);
  };
  const sanitizeSentenceEvidence = (section: ReportSection): void => {
    for (const sentence of section.sentences ?? []) {
      const sentenceBannedIds = new Set((sentence.evidences ?? []).filter((item) => isEvidenceCitationBanned(item, bannedSentences)).map((item) => item.id));
      if (sentenceBannedIds.size === 0) continue;
      sentence.evidences = sentence.evidences?.filter((item) => !sentenceBannedIds.has(item.id));
      sentence.evidence_ids = (sentence.evidence_ids ?? []).filter((id) => !sentenceBannedIds.has(id));
      if (sentence.evidence_id && sentenceBannedIds.has(sentence.evidence_id)) sentence.evidence_id = sentence.evidence_ids[0];
      if (!sentence.evidence_id && sentence.evidence_ids.length > 0) sentence.evidence_id = sentence.evidence_ids[0];
      if (!sentence.evidence_id) {
        delete sentence.evidence_quote;
        delete sentence.evidence_location;
        delete sentence.evidence_speaker;
        delete sentence.document_name;
      }
    }
    for (const row of section.rows ?? []) {
      if (row.evidence_id && bannedIds.has(row.evidence_id)) row.evidence_id = undefined;
    }
    section.children?.forEach(sanitizeSentenceEvidence);
  };
  // 저장 초안이 오래되었거나 외부에서 구성되었어도 플래그가 선 근거에는 각주를 붙이지 않는다.
  const sections = buildReportSections(template, draft.sections.achievement_table.rows, draft.sections.performance_analysis.sentences, draft.sections.contributing_factors.sentences ?? []);
  sections.forEach(collectBannedIds);
  sections.forEach(sanitizeSentenceEvidence);
  const mappings: Record<string, string | undefined> = template === 'ksp' ? {
    'ksp-constraints': draft.sections.constraints_and_responses.content, 'ksp-responses-lessons': draft.sections.lessons_learned.content,
    'ksp-monitoring': draft.sections.monitoring_plan.content, 'ksp-summary': draft.sections.overall_evaluation.content,
  } : {
    'eipp-constraints': draft.sections.constraints_and_responses.content, 'eipp-lessons': draft.sections.lessons_learned.content,
    'eipp-monitoring-plan': draft.sections.monitoring_plan.content, 'eipp-overall': draft.sections.overall_evaluation.content,
  };
  const applyContent = (section: ReportSection) => {
    if (mappings[section.id]) { section.content = mappings[section.id]; delete section.empty_message; }
    if ((section.id === 'ksp-factors' || section.id === 'eipp-factors') && draft.sections.contributing_factors.excluded_notice) section.content = draft.sections.contributing_factors.excluded_notice;
    section.children?.forEach(applyContent);
  };
  sections.forEach(applyContent);
  const notes = new Map<string, ReportFootnote>();
  const add = (id: string | undefined, document_name?: string, location?: string) => {
    if (id && !notes.has(id)) notes.set(id, { number: notes.size + 1, evidence_id: id, document_name, location });
  };
  const visit = (section: ReportSection) => {
    for (const row of section.rows ?? []) {
      add(row.evidence_id, row.evidence_document_name, row.evidence_location);
    }
    for (const sentence of section.sentences ?? []) {
      const ids = sentence.evidence_ids?.length ? sentence.evidence_ids : sentence.evidence_id ? [sentence.evidence_id] : [];
      for (const id of ids) {
        const evidence = sentence.evidences?.find(item => item.id === id);
        add(id, evidence?.document_name ?? sentence.document_name, evidence?.location ?? sentence.evidence_location);
      }
    }
    section.children?.forEach(visit);
  };
  sections.forEach(visit);
  draft.version = 2; draft.template = template; draft.report_sections = sections; draft.footnotes = [...notes.values()];
}
