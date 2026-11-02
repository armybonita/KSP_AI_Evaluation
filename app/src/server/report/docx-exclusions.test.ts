import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { generateReportDocx } from './docx';
import type { ReportDraftData } from './types';

const bannedQuote = '인용할 수 없는 가상 원문 문장입니다.';

function makeDraft(template: 'legacy7' | 'ksp'): ReportDraftData {
  const sentence = {
    indicator_id: 'indicator', indicator_name: '가상 지표', sentence: '확인된 서술', evidence_id: '', evidence_ids: [],
    evidences: [{ id: 'banned', quote: bannedQuote, location: '', speaker: '', is_citation_banned: 1 }],
  };
  return {
    project_id: 'project', project_name: '가상 사업', confirmed_count: 0, created_at: '',
    ...(template === 'ksp' ? { version: 1, template, report_sections: [{ id: 'section', title: '마지막 본문', level: 1, sentences: [sentence] }] } : {}),
    sections: {
      achievement_table: { title: '성과지표 달성표', rows: [] },
      performance_analysis: { title: '성과 분석', sentences: [sentence] },
      contributing_factors: { title: '기여요인' },
      constraints_and_responses: { title: '제약요인과 대응' },
      lessons_learned: { title: '교훈' },
      monitoring_plan: { title: '모니터링 계획' },
      overall_evaluation: { title: '종합평가' },
    },
  };
}

async function bodyOf(draft: ReportDraftData) {
  const zip = await JSZip.loadAsync(await generateReportDocx(draft));
  return (await zip.file('word/document.xml')!.async('text'));
}

describe.each(['legacy7', 'ksp'] as const)('Word AI 입력 제외 부록 (%s)', (template) => {
  it('마지막에 화면의 제외 대상과 사유만 표시하고 금지 원문을 출력하지 않는다', async () => {
    const draft = makeDraft(template);
    draft.ai_exclusions = [
      { subject: '가상 자료.docx', reasons: ['마스킹 미확인', '제공자 불일치'] },
      { subject: '가상 지표', reasons: ['검증 통과 근거 없음'] },
    ];
    const body = await bodyOf(draft);
    expect(body).toContain('AI 입력 제외');
    expect(body).toContain('가상 자료.docx');
    expect(body).toContain('마스킹 미확인');
    expect(body).toContain('제공자 불일치');
    expect(body).toContain('가상 지표');
    expect(body).toContain('검증 통과 근거 없음');
    expect(body.indexOf('AI 입력 제외')).toBeGreaterThan(body.indexOf(template === 'ksp' ? '마지막 본문' : '7. 종합평가'));
    expect(body).not.toContain(bannedQuote);
  });

  it('제외 목록이 없거나 비면 부록을 만들지 않는다', async () => {
    const draft = makeDraft(template);
    expect(await bodyOf(draft)).not.toContain('AI 입력 제외');
    draft.ai_exclusions = [];
    expect(await bodyOf(draft)).not.toContain('AI 입력 제외');
  });
});
