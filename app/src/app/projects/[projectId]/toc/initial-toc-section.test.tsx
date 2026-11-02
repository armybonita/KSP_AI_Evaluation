import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OntologyProjectGraph } from '@/server/ontology/store';
import { InitialTocSection, getGraphReviewHref, getReviewItemHref, mergeGraphWithPdmIndicators } from './initial-toc-section';

const graph: OntologyProjectGraph = {
  importId: 'fixture-import',
  nodes: [
    { id: 'OUT-S-01', type: 'outcome-short', title: '가상 단기 성과', description: '', pdmStage: null, planDetails: [{ label: '계획', value: '가상 계획' }] },
    { id: 'FAC-E-01', type: 'enabler', title: '가상 기여요인', description: '', pdmStage: null, planDetails: [] },
  ],
  edges: [{ source: 'OUT-S-01', target: 'FAC-E-01', relation: 'promotes' }],
};

describe('초기 ToC 화면', () => {
  it('PDM이 없으면 계획 기준선을 잠그고', () => {
    const markup = renderToStaticMarkup(<InitialTocSection graph={graph} fallbackNodes={[]} hasPdm={false} projectId="project-1" reviewNodeIds={[]} />);
    expect(markup).toContain('초기 ToC 잠김');
    expect(markup).not.toContain('초기 ToC 보기 전환');
  });

  it('단순 ToC와 상세 그래프 전환, 5단계 화살표 및 상태 기반 실제 성과를 제공한다', () => {
    const markup = renderToStaticMarkup(<InitialTocSection graph={graph} fallbackNodes={[]} hasPdm projectId="project-1" reviewNodeIds={['OUT-S-01']} />);
    expect(markup).toContain('단순 ToC');
    expect(markup).toContain('상세 그래프');
    expect(markup).toContain('활동');
    expect(markup).toContain('산출');
    expect(markup).toContain('단기성과');
    expect(markup).toContain('중/장기성과');
    expect(markup).toContain('다음 단계로');
    expect(markup).toContain('미검토');
    expect(markup).not.toContain('기등록');
    expect(markup).toContain('가상 단기 성과');
  });

  it('PDM 계획 점이 있으면 단순 ToC 에는 PDM 계획만 보이고 AI 온톨로지 점은 빠진다', () => {
    const pdm = [{ id: 'IND-PDM-01', type: 'indicator', title: '가상 PDM 산출 지표', description: '', pdmStage: '산출물', planDetails: [{ label: '목표값', value: '3건' }] }];
    const markup = renderToStaticMarkup(<InitialTocSection graph={graph} fallbackNodes={pdm} hasPdm projectId="project-1" reviewNodeIds={[]} />);
    const table = markup.slice(markup.indexOf('<table'), markup.indexOf('</table>'));
    expect(table).toContain('가상 PDM 산출 지표');
    expect(table).not.toContain('가상 단기 성과');
  });

  it('요인은 PDM 필터와 상태 조회에 없는 그래프 점도 표시하고 같은 ID와 종류의 상태만 붙인다', () => {
    const factorGraph = { ...graph, nodes: [...graph.nodes,
      { id: 'FAC-C-01', type: 'constraint', title: '가상 제약요인', description: '', pdmStage: null, planDetails: [] },
    ] };
    const pdm = [{ id: 'IND-PDM-01', type: 'indicator', title: '가상 PDM 지표', description: '', pdmStage: '산출물', planDetails: [] }];
    const markup = renderToStaticMarkup(<InitialTocSection graph={factorGraph} fallbackNodes={pdm} hasPdm projectId="project-1" reviewNodeIds={[]} noteItems={[
      { id: 'FAC-E-01', type: 'enabler', title: '가상 기여요인', status: '확정' },
      { id: 'FAC-C-01', type: 'enabler', title: '다른 종류', status: '확정' },
      { id: 'FAC-C-01', type: 'constraint', title: '가상 제약요인', status: '미검토' },
      { id: 'not-in-graph', type: 'constraint', title: '그래프에 없는 요인', status: '확정' },
    ]} />);
    expect(markup).toContain('<span data-testid="toc-factor-name">가상 기여요인</span>: <span data-testid="toc-factor-status">확정</span>');
    expect(markup).toContain('<span data-testid="toc-factor-name">가상 제약요인</span>: <span data-testid="toc-factor-status">미검토</span>');
    expect(markup).not.toContain('그래프에 없는 요인');
  });

  it('새 그래프의 상태가 없거나 이름이 바뀌면 검사 전 이름을 가린다', () => {
    const factorGraph = { ...graph, nodes: [...graph.nodes,
      { id: 'FAC-C-01', type: 'constraint', title: '비보도 새 제약', description: '', pdmStage: null, planDetails: [] },
    ] };
    const markup = renderToStaticMarkup(<InitialTocSection graph={factorGraph} fallbackNodes={[]} hasPdm projectId="project-1" reviewNodeIds={[]} noteItems={[
      { id: 'FAC-E-01', type: 'enabler', title: '이전 이름', status: '확정' },
    ]} />);
    expect(markup.match(/data-testid="toc-factor-name">\[확인 필요\]/g)).toHaveLength(2);
    expect(markup).not.toContain('가상 기여요인');
    expect(markup).not.toContain('비보도 새 제약');
  });

  it('금지 표시된 그래프 요인 이름은 기존과 같이 가린다', () => {
    const markup = renderToStaticMarkup(<InitialTocSection graph={graph} fallbackNodes={[]} hasPdm projectId="project-1" reviewNodeIds={[]} noteItems={[
      { id: 'FAC-E-01', type: 'enabler', title: '[인용 금지 문장]', status: '확정' },
    ]} />);
    expect(markup).toContain('<span data-testid="toc-factor-name">[인용 금지 문장]</span>: <span data-testid="toc-factor-status">확정</span>');
    expect(markup).not.toContain('가상 기여요인');
  });

  it('실제 상태를 확정 성과 자료에서 읽고 활동·영향 단계도 임의 등록 처리하지 않는다', () => {
    const outcomeResults = {
      projectId: 'project-1', totalIndicators: 1, confirmedCount: 1, hasConfirmedResults: true,
      stages: [
        { stage_key: 'activity' as const, stage_label: '활동' as const, indicators: [{ indicator_id: 'actual-activity', indicator_name: '확정된 활동', level: '활동', stage_key: 'activity' as const, stage_label: '활동' as const, target_value: '', baseline_value: '', unit: '', is_confirmed: true, confirmation_type: '확정' as const, actual_value: '실제 이수', verdict_status: '실현' as const, status_display: '실현', evidence_count: 1, is_orphaned: false, review_href: '', report_href: '' }] },
        { stage_key: 'output' as const, stage_label: '산출물' as const, indicators: [] },
        { stage_key: 'outcome-short' as const, stage_label: '단기' as const, indicators: [] },
        { stage_key: 'outcome-mid' as const, stage_label: '중장기' as const, indicators: [] },
        { stage_key: 'impact' as const, stage_label: '영향' as const, indicators: [] },
      ],
    };
    const markup = renderToStaticMarkup(<InitialTocSection graph={graph} fallbackNodes={[]} hasPdm projectId="project-1" reviewNodeIds={[]} outcomeFinalResults={outcomeResults} />);
    expect(markup).toContain('확정된 활동');
    expect(markup).toContain('기등록 · 실제 이수');
    expect(markup).toContain('actual-unreviewed-impact');
    expect(markup).toContain('미검토');
  });

  it('온톨로지 그래프가 없어도 등록된 PDM 지표를 계획 칸에 표시한다', () => {
    const markup = renderToStaticMarkup(<InitialTocSection
      graph={{ importId: null, nodes: [], edges: [] }}
      fallbackNodes={[{ id: 'IND-01', type: 'indicator', title: 'PDM 지표', description: '', pdmStage: '단기성과', planDetails: [{ label: '목표값', value: '3건' }] }]}
      hasPdm
      projectId="project-1"
      reviewNodeIds={[]}
    />);
    expect(markup).toContain('PDM 지표');
    expect(markup).toContain('목표값: 3건');
  });

  it('검토 이동 URL은 사업에 존재하는 동일 ID만 만들고 ID를 인코딩한다', () => {
    expect(getReviewItemHref('project 1', 'OUT-S/01', ['OUT-S/01'])).toBe('/projects/project%201/review?nodeId=OUT-S%2F01');
    expect(getReviewItemHref('project-1', 'missing-node', ['OUT-S-01'])).toBeNull();
  });

  it.each(['중/장기성과', '영향', '활동'])('그래프의 %s 지표는 같은 ID 검토 항목으로 이동한다', (pdmStage) => {
    const node = { id: 'IND-01', type: 'indicator' as const, title: '지표', description: '', pdmStage, planDetails: [] };
    expect(getGraphReviewHref('project-1', node, ['IND-01'])).toBe('/projects/project-1/review?nodeId=IND-01');
    expect(getGraphReviewHref('project-1', node, [])).toBeNull();
  });

  it('그래프가 있어도 ID가 다른 기존 PDM 지표를 병합해 보존한다', () => {
    const fallback: OntologyProjectGraph['nodes'][number] = { id: 'PDM-01', type: 'indicator', title: 'PDM 계획 지표', description: '', pdmStage: '영향', planDetails: [{ label: '목표값', value: '2건' }] };
    const merged = mergeGraphWithPdmIndicators(graph.nodes, [fallback]);
    expect(merged.map((node) => node.id)).toContain('PDM-01');
    expect(merged.find((node) => node.id === 'PDM-01')?.planDetails).toContainEqual({ label: '목표값', value: '2건' });
    const sameIdWithPdmDetails = { ...graph.nodes[0], planDetails: [{ label: '목표값', value: '3건' }] };
    const enriched = mergeGraphWithPdmIndicators(graph.nodes, [sameIdWithPdmDetails]);
    expect(enriched).toHaveLength(graph.nodes.length);
    expect(enriched[0].planDetails).toContainEqual({ label: '목표값', value: '3건' });
  });

  it('PDM 성과표와 성과관리 최종결과 표를 화면 상단에 5개 단계로 표시한다', () => {
    const outcomeResults = {
      projectId: 'project-1',
      totalIndicators: 3,
      confirmedCount: 1,
      hasConfirmedResults: true,
      stages: [
        {
          stage_key: 'activity' as const,
          stage_label: '활동' as const,
          indicators: [
            {
              indicator_id: 'ind-act',
              indicator_name: '직무 교육',
              level: '활동',
              stage_key: 'activity' as const,
              stage_label: '활동' as const,
              target_value: '500명 이수',
              baseline_value: '0명',
              unit: '명',
              is_confirmed: true,
              confirmation_type: '확정' as const,
              actual_value: '500명 완수',
              verdict_status: '실현' as const,
              status_display: '실현',
              evidence_count: 2,
              is_orphaned: false,
              review_href: '/projects/project-1/review?indicatorId=ind-act',
              report_href: '/projects/project-1/report#achievement-row-ind-act',
            },
          ],
        },
        {
          stage_key: 'output' as const,
          stage_label: '산출물' as const,
          indicators: [
            {
              indicator_id: 'ind-out',
              indicator_name: '행정 플랫폼',
              level: '산출물',
              stage_key: 'output' as const,
              stage_label: '산출물' as const,
              target_value: '1식 구축',
              baseline_value: 'PDM에 없음',
              unit: '식',
              is_confirmed: false,
              confirmation_type: null,
              actual_value: '검토 중',
              verdict_status: null,
              status_display: '검토 중',
              evidence_count: 0,
              is_orphaned: false,
              review_href: '/projects/project-1/review?indicatorId=ind-out',
              report_href: '/projects/project-1/report#achievement-row-ind-out',
            },
          ],
        },
        {
          stage_key: 'outcome-short' as const,
          stage_label: '단기' as const,
          indicators: [],
        },
        {
          stage_key: 'outcome-mid' as const,
          stage_label: '중장기' as const,
          indicators: [],
        },
        {
          stage_key: 'impact' as const,
          stage_label: '영향' as const,
          indicators: [],
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <InitialTocSection
        graph={graph}
        fallbackNodes={[]}
        hasPdm
        projectId="project-1"
        reviewNodeIds={[]}
        outcomeFinalResults={outcomeResults}
      />
    );

    // 표 영역 확인
    expect(markup).toContain('PDM 성과표 및 성과관리 최종결과');
    expect(markup).toContain('PDM 성과표 (계획)');
    expect(markup).toContain('성과관리 최종결과');

    // 5단계 라벨 확인
    expect(markup).toContain('활동');
    expect(markup).toContain('산출물');
    expect(markup).toContain('단기');
    expect(markup).toContain('중장기');
    expect(markup).toContain('영향');

    // 활동 지표 (확정: 실현, 2건)
    expect(markup).toContain('직무 교육');
    expect(markup).toContain('500명 이수');
    expect(markup).toContain('0명');
    expect(markup).toContain('500명 완수');
    expect(markup).toContain('실현');
    expect(markup).toContain('2건');
    expect(markup).toContain('review-link-ind-act');
    expect(markup).toContain('report-link-ind-act');

    // 산출물 지표 (미확정: 검토 중, PDM에 없음)
    expect(markup).toContain('행정 플랫폼');
    expect(markup).toContain('검토 중');
    expect(markup).toContain('PDM에 없음');

    // 지표가 없는 단계 (단기, 중장기, 영향)의 PDM에 없음 확인
    expect(markup).toContain('outcome-row-outcome-short-empty');
    expect(markup).toContain('outcome-row-impact-empty');
  });
});
