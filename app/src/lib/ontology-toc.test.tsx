import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OntologyProjectEdge, OntologyProjectNode } from '@/server/ontology/store';
import { buildInitialTocColumns, buildOntologyDisplayIds, GRAPH_LANES, GRAPH_RELATIONS, INITIAL_TOC_COLUMNS, initialTocColumnForNode, layoutOntologyGraph } from './ontology-toc';
import { formatUnmappedIndicatorNotice, summarizeUnmappedIndicatorStages } from './ontology-toc';
import { InitialTocTable, OntologyGraphView } from '@/app/projects/[projectId]/ontology/ontology-views';

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures/w17-stage4/ontology-graph.json'), 'utf8')) as {
  nodes: Record<string, { id: string; type: string; title: string; description?: string; pdm_stage?: string; fm?: Record<string, string> }>;
  edges: OntologyProjectEdge[];
};

const nodes: OntologyProjectNode[] = Object.values(fixture.nodes).map((node) => ({
  id: node.id,
  type: node.type,
  title: node.title,
  description: node.description ?? '',
  pdmStage: node.pdm_stage ?? node.fm?.pdm_stage ?? null,
  planDetails: [],
}));

describe('W-17 stage 4 initial ToC and graph layout', () => {
  it('sorts expanded numeric node ids after their two digit predecessors', () => {
    const expanded: OntologyProjectNode[] = ['ACT-PABCDE-D12345-99', 'ACT-PABCDE-D12345-100'].map((id) => ({ id, type: 'activity', title: id, description: '', pdmStage: null, planDetails: [] }));
    const layout = layoutOntologyGraph({ nodes: expanded, edges: [] });
    expect(layout.nodes.map((node) => node.id)).toEqual(['ACT-PABCDE-D12345-99', 'ACT-PABCDE-D12345-100']);
  });
  it('places impact and its goal in the impact column', () => {
    const withImpactGoal = nodes.map((node) => node.id === 'IND-S4-IMPACT'
      ? { ...node, planDetails: [{ label: '목표값', value: '가상 목표 3건' }] }
      : node);
    const impactColumn = buildInitialTocColumns(withImpactGoal).find((column) => column.key === 'impact')!;
    expect(impactColumn.nodes.map((node) => node.id)).toContain('IND-S4-IMPACT');

    const markup = renderToStaticMarkup(<InitialTocTable nodes={withImpactGoal} selectedId={null} onSelect={() => undefined} />);
    expect(markup).toContain('참고 기준선');
    expect(renderToStaticMarkup(<InitialTocTable nodes={[]} selectedId={null} onSelect={() => undefined} />)).toContain('PDM에 없음');
    expect(markup).toContain('미검토');
    expect(markup).toContain('가상 영향 지표');
    expect(markup).toContain('목표값: 가상 목표 3건');
  });

  it('classifies stored point types and indicator PDM stages into the five columns', () => {
    expect(INITIAL_TOC_COLUMNS.map(({ label }) => label)).toEqual(['활동', '산출물', '단기성과', '중/장기성과', '영향']);
    const columnByNode = new Map(nodes.map((node) => [node.id, initialTocColumnForNode(node)]));
    expect(columnByNode.get('ACT-S4-01')).toBe('activity');
    expect(columnByNode.get('OPT-S4-01')).toBe('output');
    expect(columnByNode.get('OUT-S-S4-01')).toBe('outcome-short');
    expect(columnByNode.get('OUT-M-S4-01')).toBe('outcome-mid');
    expect(columnByNode.get('IND-S4-IMPACT')).toBe('impact');
    expect(columnByNode.get('IND-S4-SHORT')).toBe('outcome-short');
    expect(columnByNode.get('FAC-E-S4-01')).toBeNull();
    expect(initialTocColumnForNode({ type: 'indicator', pdmStage: '투입' })).toBeNull();
    expect(initialTocColumnForNode({ type: 'indicator', pdmStage: '' })).toBeNull();
    expect(initialTocColumnForNode({ type: 'indicator', pdmStage: null })).toBeNull();
    expect(initialTocColumnForNode({ type: 'indicator', pdmStage: '사전단계' })).toBeNull();
  });

  it('draws only the five approved relations and returns identical coordinates for identical input', () => {
    const input = { nodes, edges: fixture.edges };
    const first = layoutOntologyGraph(input);
    const second = layoutOntologyGraph(input);
    expect(first).toEqual(second);
    const fixtureRelations = ['generates', 'induces', 'extends_to', 'promotes', 'hinders'];
    expect(new Set(first.edges.map((edge) => edge.relation))).toEqual(new Set(fixtureRelations));
    expect(first.edges.map((edge) => edge.relation).sort()).toEqual([...fixtureRelations].sort());
    expect(GRAPH_RELATIONS).toContain('targets');
  });

  it('places twenty factor points in non-overlapping grid positions', () => {
    const layout = layoutOntologyGraph({ nodes, edges: fixture.edges });
    const factors = layout.nodes.filter((node) => node.type === 'enabler' || node.type === 'constraint');
    expect(factors).toHaveLength(20);
    expect(layout.columnLabels).toEqual(GRAPH_LANES.map(({ label }) => label));
    expect(factors.filter((node) => node.type === 'enabler').every((node) => node.x < 488)).toBe(true);
    expect(factors.filter((node) => node.type === 'constraint').every((node) => node.x >= 488)).toBe(true);
    for (let leftIndex = 0; leftIndex < factors.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < factors.length; rightIndex++) {
        const left = factors[leftIndex];
        const right = factors[rightIndex];
        const overlap = left.x < right.x + right.width && left.x + left.width > right.x
          && left.y < right.y + right.height && left.y + left.height > right.y;
        expect(overlap, `${left.id} overlaps ${right.id}`).toBe(false);
      }
    }
  });

  it('renders a script-like stored name as escaped text in HTML and SVG', () => {
    const graphMarkup = renderToStaticMarkup(<OntologyGraphView nodes={nodes} edges={fixture.edges} selectedId={null} onSelect={() => undefined} />);
    const tocMarkup = renderToStaticMarkup(<InitialTocTable nodes={nodes} selectedId={null} onSelect={() => undefined} />);
    for (const markup of [graphMarkup, tocMarkup]) {
      expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(markup).not.toContain('<script>');
    }
  });

  it('preserves input, empty, and out-of-range indicators as unassigned', () => {
    const unmappedIndicators: OntologyProjectNode[] = [
      { id: 'IND-S4-INPUT-01', type: 'indicator', title: '가상 투입 지표 1', description: '', pdmStage: '투입', planDetails: [] },
      { id: 'IND-S4-INPUT-02', type: 'indicator', title: '가상 투입 지표 2', description: '', pdmStage: '투입', planDetails: [] },
      { id: 'IND-S4-EMPTY-01', type: 'indicator', title: '가상 빈 단계 지표 1', description: '', pdmStage: '', planDetails: [] },
      { id: 'IND-S4-EMPTY-02', type: 'indicator', title: '가상 빈 단계 지표 2', description: '', pdmStage: null, planDetails: [] },
      { id: 'IND-S4-OUT-01', type: 'indicator', title: '가상 허용 밖 지표 1', description: '', pdmStage: '사전단계', planDetails: [] },
      { id: 'IND-S4-OUT-02', type: 'indicator', title: '가상 허용 밖 지표 2', description: '', pdmStage: '보류단계', planDetails: [] },
    ];
    expect(initialTocColumnForNode(unmappedIndicators[0])).toBeNull();
    expect(initialTocColumnForNode(unmappedIndicators[1])).toBeNull();
    for (const indicator of unmappedIndicators.slice(2)) expect(initialTocColumnForNode(indicator)).toBeNull();

    const extendedNodes = [...nodes, ...unmappedIndicators];
    const tocNodeIds = new Set(buildInitialTocColumns(extendedNodes).flatMap((column) => column.nodes.map((node) => node.id)));
    expect(tocNodeIds.has(unmappedIndicators[0].id)).toBe(false);
    expect(tocNodeIds.has(unmappedIndicators[1].id)).toBe(false);
    for (const indicator of unmappedIndicators.slice(2)) expect(tocNodeIds.has(indicator.id)).toBe(false);

    const summary = summarizeUnmappedIndicatorStages(extendedNodes);
    expect(summary).toEqual({
      totalCount: 6,
      emptyCount: 2,
      invalidCount: 4,
      byStoredStage: [
        { stage: '투입', count: 2 },
        { stage: '사전단계', count: 1 },
        { stage: '보류단계', count: 1 },
      ],
      invalidByStage: [
        { stage: '투입', count: 2 },
        { stage: '사전단계', count: 1 },
        { stage: '보류단계', count: 1 },
      ],
    });

    const expectedNotice = '칸 미지정 지표 6개 (빈 단계 2개, 5칸 외 단계 4개: 투입 2개, 사전단계 1개, 보류단계 1개). AI가 다른 칸으로 추정하지 않습니다.';
    expect(formatUnmappedIndicatorNotice(summary)).toBe(expectedNotice);

    const layout = layoutOntologyGraph({ nodes: extendedNodes, edges: fixture.edges });
    expect(layout.columnLabels).toEqual(['활동', '산출물', '단기성과', '중장기성과']);
    // R03 시안 그래프는 지표를 그리지 않는다. 칸 미지정 지표는 단순 ToC 에 보존되고, 그래프는 빠진 수를 알린다.
    for (const indicator of unmappedIndicators) expect(layout.nodes.some((node) => node.id === indicator.id)).toBe(false);
    const indicatorCount = extendedNodes.filter((node) => node.type === 'indicator').length;
    expect(layout.omitted.find((item) => item.type === 'indicator')?.count).toBe(indicatorCount);

    const tocMarkup = renderToStaticMarkup(<InitialTocTable nodes={extendedNodes} selectedId={null} onSelect={() => undefined} />);
    const graphMarkup = renderToStaticMarkup(<OntologyGraphView nodes={extendedNodes} edges={fixture.edges} selectedId={null} onSelect={() => undefined} />);
    expect(tocMarkup).toContain(expectedNotice);
    expect(graphMarkup).toContain(expectedNotice);
    expect(tocMarkup).toContain('가상 영향 지표');
  });

  it('returns identical node and edge coordinates when nodes and edges are shuffled in different orders', () => {
    const baseline = layoutOntologyGraph({ nodes, edges: fixture.edges });
    const reversed = layoutOntologyGraph({
      nodes: [...nodes].reverse(),
      edges: [...fixture.edges].reverse(),
    });
    const interleavedNodes = [
      ...nodes.filter((_, index) => index % 3 === 1),
      ...nodes.filter((_, index) => index % 3 === 2).reverse(),
      ...nodes.filter((_, index) => index % 3 === 0),
    ];
    const interleavedEdges = [
      ...fixture.edges.filter((_, index) => index % 2 === 1),
      ...fixture.edges.filter((_, index) => index % 2 === 0).reverse(),
    ];
    const interleaved = layoutOntologyGraph({
      nodes: interleavedNodes,
      edges: interleavedEdges,
    });

    expect(reversed).toEqual(baseline);
    expect(interleaved).toEqual(baseline);
  });

  it('assigns deterministic short display IDs while preserving canonical node IDs', () => {
    const subset = nodes.filter((node) => ['ACT-S4-01', 'OPT-S4-01', 'OUT-S-S4-01', 'OUT-M-S4-01', 'FAC-E-S4-01', 'FAC-C-S4-02'].includes(node.id));
    const expected = buildOntologyDisplayIds(subset);
    const shuffled = buildOntologyDisplayIds([...subset].reverse());
    expect(shuffled).toEqual(expected);
    expect(expected.get('ACT-S4-01')).toMatch(/^ACT-\d{2}$/);
    expect(expected.get('OPT-S4-01')).toMatch(/^OPT-\d{2}$/);
    expect(expected.get('OUT-S-S4-01')).toMatch(/^OUT-S-\d{2}$/);
    expect(expected.get('OUT-M-S4-01')).toMatch(/^OUT-M-\d{2}$/);
    expect(expected.get('FAC-E-S4-01')).toMatch(/^FAC-E-\d{2}$/);
    expect(expected.get('FAC-C-S4-02')).toMatch(/^FAC-C-\d{2}$/);

    const edge: OntologyProjectEdge = { source: 'ACT-S4-01', target: 'OPT-S4-01', relation: 'generates' };
    const markup = renderToStaticMarkup(<OntologyGraphView nodes={subset} edges={[edge]} selectedId={null} onSelect={() => undefined} />);
    expect(markup).toContain('ACT-01');
    expect(markup).toContain('OPT-01');
    expect(markup).toContain('data-source="ACT-S4-01"');
    expect(markup).toContain('data-target="OPT-S4-01"');
    expect(markup).toContain('aria-label="activity: &lt;script&gt;alert(1)&lt;/script&gt; (ACT-01, 원 ID ACT-S4-01)"');
    expect(markup).toContain('data-node-id="ACT-S4-01"');
    expect(markup).toContain('<title>&lt;script&gt;alert(1)&lt;/script&gt; · 원 ID ACT-S4-01</title>');
  });

  it('draws only causal and factor node types, and counts omitted indicators and other points', () => {
    const extra: OntologyProjectNode[] = [
      { id: 'IND-X-01', type: 'indicator', title: '가상 지표 1', description: '', pdmStage: '산출물', planDetails: [] },
      { id: 'IND-X-02', type: 'indicator', title: '가상 지표 2', description: '', pdmStage: '단기성과', planDetails: [] },
      { id: 'PRJ-X', type: 'project', title: '가상 사업', description: '', pdmStage: null, planDetails: [] },
    ];
    const causal = nodes.filter((node) => ['activity', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint'].includes(node.type));
    const layout = layoutOntologyGraph({ nodes: [...causal, ...extra], edges: [{ source: 'IND-X-01', target: 'OPT-S4-01', relation: 'measures' }] });
    const drawn = new Set(layout.nodes.map((node) => node.id));
    expect(drawn.has('IND-X-01')).toBe(false);
    expect(drawn.has('IND-X-02')).toBe(false);
    expect(drawn.has('PRJ-X')).toBe(false);
    expect(layout.nodes).toHaveLength(causal.length);
    expect(layout.omitted).toEqual([{ type: 'indicator', count: 2 }, { type: 'project', count: 1 }]);
    const markup = renderToStaticMarkup(<OntologyGraphView nodes={[...causal, ...extra]} edges={[]} selectedId={null} onSelect={() => undefined} />);
    expect(markup).toContain('그리지 않은 점: 지표 2개, 사업 1개');
  });

  it('shows candidate relations as optional dashed gray edges and keeps the saved graph read-only', () => {
    const graphNodes = nodes.filter((node) => ['ACT-S4-01', 'OPT-S4-01', 'OUT-S-S4-01'].includes(node.id));
    const confirmed: OntologyProjectEdge = { source: 'ACT-S4-01', target: 'OPT-S4-01', relation: 'generates' };
    const candidate: OntologyProjectEdge = { source: 'ACT-S4-01', target: 'OPT-S4-01', relation: 'generates' };
    const unrelated: OntologyProjectEdge = { source: 'OPT-S4-01', target: 'OUT-S-S4-01', relation: 'induces' };
    const markup = renderToStaticMarkup(<OntologyGraphView nodes={graphNodes} edges={[confirmed, unrelated]} candidates={[candidate]} selectedId="ACT-S4-01" onSelect={() => undefined} />);
    expect(markup).toContain('aria-label="AI 관계 후보 표시"');
    expect(markup).toContain('data-candidate="true"');
    expect(markup).toContain('data-candidate="false"');
    expect(markup).toContain('stroke-dasharray="6 4"');
    expect(markup).toContain('stroke="#9ca3af"');
    expect(markup).toContain('후보 · generates');
    expect(markup).toContain('opacity="0.2"');
    expect(markup).not.toMatch(/<(?:button|input)[^>]*(?:저장|확정|삭제|수정)/);

    const hidden = renderToStaticMarkup(<OntologyGraphView nodes={graphNodes} edges={[confirmed, unrelated]} candidates={[candidate]} showCandidates={false} selectedId={null} onSelect={() => undefined} />);
    expect(hidden).not.toContain('data-candidate="true"');
    expect(hidden).toContain('aria-label="AI 관계 후보 표시"');
  });

  it('renders every causal and factor relation with its stored direction and style, including candidate-only graphs', () => {
    const [activity, output, short, mid, enabler, constraint] = [
      'ACT-S4-01', 'OPT-S4-01', 'OUT-S-S4-01', 'OUT-M-S4-01', 'FAC-E-S4-01', 'FAC-C-S4-02',
    ];
    const graphNodes = nodes.filter(node => [activity, output, short, mid, enabler, constraint].includes(node.id));
    const relations = [
      { source: activity, target: output, relation: 'generates', color: '#64748b', dashed: false },
      { source: output, target: short, relation: 'induces', color: '#64748b', dashed: false },
      { source: short, target: mid, relation: 'extends_to', color: '#64748b', dashed: false },
      { source: activity, target: mid, relation: 'targets', color: '#64748b', dashed: false },
      { source: enabler, target: short, relation: 'promotes', color: '#16a34a', dashed: true },
      { source: constraint, target: mid, relation: 'hinders', color: '#dc2626', dashed: true },
    ];
    const markup = renderToStaticMarkup(<OntologyGraphView nodes={graphNodes} edges={relations} selectedId={null} onSelect={() => undefined} />);
    for (const edge of relations) {
      const line = markup.match(new RegExp(`<line data-source="${edge.source}" data-target="${edge.target}" data-relation="${edge.relation}"[^>]*>`))?.[0];
      expect(line).toBeDefined();
      expect(line).toContain(`stroke="${edge.color}"`);
      expect(line).toContain('marker-end="url(#ontology-edge-arrow)"');
      expect(line?.includes('stroke-dasharray="6 4"')).toBe(edge.dashed);
    }
    const candidate = { source: short, target: mid, relation: 'extends_to' };
    const candidateOnly = renderToStaticMarkup(<OntologyGraphView nodes={graphNodes} edges={[]} candidates={[candidate]} selectedId={null} onSelect={() => undefined} />);
    const line = candidateOnly.match(/<line data-source="OUT-S-S4-01" data-target="OUT-M-S4-01"[^>]*>/)?.[0];
    expect(line).toContain('data-candidate="true"');
    expect(line).toContain('stroke="#9ca3af"');
    expect(line).toContain('stroke-dasharray="6 4"');
    expect(line).toContain('marker-end="url(#ontology-edge-arrow)"');
  });

  it('renders an explicit empty graph state without adding editing controls', () => {
    const markup = renderToStaticMarkup(<OntologyGraphView nodes={[]} edges={[]} selectedId={null} onSelect={() => undefined} />);
    expect(markup).toContain('표시할 저장 점이 없습니다.');
    expect(markup).not.toContain('<svg');
    expect(markup).not.toContain('ontology-candidate-toggle');
    expect(markup).not.toMatch(/<(?:button|input)[^>]*(?:저장|확정|삭제|수정)/);
  });

  it('places twenty-two factors including multi-line titles over 17 characters without overlapping node boxes or text regions', () => {
    const longTitledFactors: OntologyProjectNode[] = Array.from({ length: 22 }, (_, index) => {
      const seq = String(index + 1).padStart(2, '0');
      const isEnabler = index % 2 === 0;
      const title = index % 3 === 0
        ? `가상 초장기 ${isEnabler ? '기여' : '제약'}요인 세줄 줄바꿈 상자 글자 영역 비겹침 검증 항목 ${seq}`
        : index % 2 === 0
          ? `가상 장기 기여요인 두줄 줄바꿈 제목 확인 항목 ${seq}`
          : `가상 짧은 제약요인 ${seq}`;
      return {
        id: `FAC-${isEnabler ? 'E' : 'C'}-S4-${seq}`,
        type: isEnabler ? 'enabler' : 'constraint',
        title,
        description: '',
        pdmStage: null,
        planDetails: [],
      };
    });
    const nonFactorNodes = nodes.filter((node) => node.type !== 'enabler' && node.type !== 'constraint');
    const mixedNodes = [...nonFactorNodes, ...longTitledFactors];
    const layout = layoutOntologyGraph({ nodes: mixedNodes, edges: fixture.edges });
    const factors = layout.nodes.filter((node) => node.type === 'enabler' || node.type === 'constraint');

    expect(factors).toHaveLength(22);
    expect(factors.filter((node) => node.lines.length >= 2).length).toBeGreaterThanOrEqual(12);
    expect(factors.filter((node) => node.lines.length >= 3).length).toBeGreaterThanOrEqual(7);
    for (const node of layout.nodes) {
      for (const line of node.lines) {
        expect(Array.from(line).length).toBeLessThanOrEqual(17);
      }
      expect(node.height).toBe(35 + node.lines.length * 18);
    }

    for (let leftIndex = 0; leftIndex < layout.nodes.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < layout.nodes.length; rightIndex++) {
        const left = layout.nodes[leftIndex];
        const right = layout.nodes[rightIndex];
        const boxOverlap = left.x < right.x + right.width && left.x + left.width > right.x
          && left.y < right.y + right.height && left.y + left.height > right.y;
        expect(boxOverlap, `node box ${left.id} overlaps ${right.id}`).toBe(false);
      }
    }

    const textRegions = layout.nodes.flatMap((node) => {
      const typeRegion = {
        id: `${node.id}:type`,
        nodeId: node.id,
        x: node.x + 10,
        y: node.y + 6,
        width: Math.max(24, node.type.length * 7),
        height: 10,
      };
      const lineRegions = node.lines.map((line, lineIndex) => {
        const lineWidth = Math.min(node.width - 16, Math.max(12, Array.from(line).length * 10));
        return {
          id: `${node.id}:line:${lineIndex}`,
          nodeId: node.id,
          x: node.x + (node.width - lineWidth) / 2,
          y: node.y + 23 + lineIndex * 18,
          width: lineWidth,
          height: 14,
        };
      });
      return [typeRegion, ...lineRegions];
    });

    const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const region of textRegions) {
      const owner = nodeById.get(region.nodeId)!;
      expect(region.x).toBeGreaterThanOrEqual(owner.x);
      expect(region.x + region.width).toBeLessThanOrEqual(owner.x + owner.width);
      expect(region.y).toBeGreaterThanOrEqual(owner.y);
      expect(region.y + region.height).toBeLessThanOrEqual(owner.y + owner.height);
    }

    for (let leftIndex = 0; leftIndex < textRegions.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < textRegions.length; rightIndex++) {
        const left = textRegions[leftIndex];
        const right = textRegions[rightIndex];
        const textOverlap = left.x < right.x + right.width && left.x + left.width > right.x
          && left.y < right.y + right.height && left.y + left.height > right.y;
        expect(textOverlap, `text region ${left.id} overlaps ${right.id}`).toBe(false);
      }
    }

    const graphMarkup = renderToStaticMarkup(<OntologyGraphView nodes={mixedNodes} edges={fixture.edges} selectedId={null} onSelect={() => undefined} />);
    expect(graphMarkup).toContain('가상 초장기 기여요인 세줄 줄바');
    expect(graphMarkup).toContain('꿈 상자 글자 영역 비겹침 검증');
  });
});
