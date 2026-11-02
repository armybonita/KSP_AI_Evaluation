import type { OntologyProjectEdge, OntologyProjectNode } from '@/server/ontology/store';

export const INITIAL_TOC_COLUMNS = [
  { key: 'activity', label: '활동' },
  { key: 'output', label: '산출물' },
  { key: 'outcome-short', label: '단기성과' },
  { key: 'outcome-mid', label: '중/장기성과' },
  { key: 'impact', label: '영향' },
] as const;

export type InitialTocColumnKey = (typeof INITIAL_TOC_COLUMNS)[number]['key'];

// 다섯 칸에 대응하지 않는 단계는 추정하지 않고 보존한다.
const PDM_STAGE_TO_COLUMN: Record<string, InitialTocColumnKey> = {
  활동: 'activity',
  산출: 'output',
  산출물: 'output',
  단기성과: 'outcome-short',
  중기성과: 'outcome-mid',
  중장기성과: 'outcome-mid',
  '중·장기성과': 'outcome-mid',
  '중/장기성과': 'outcome-mid',
  영향: 'impact',
};

const DIRECT_TYPE_TO_COLUMN: Partial<Record<string, InitialTocColumnKey>> = {
  activity: 'activity',
  output: 'output',
  'outcome-short': 'outcome-short',
  'outcome-mid': 'outcome-mid',
  impact: 'impact',
};

export const GRAPH_RELATIONS = ['generates', 'induces', 'extends_to', 'targets', 'promotes', 'hinders'] as const;

export const GRAPH_LANES = [
  { key: 'activity', label: '활동' },
  { key: 'output', label: '산출물' },
  { key: 'outcome-short', label: '단기성과' },
  { key: 'outcome-mid', label: '중장기성과' },
] as const;
const FACTOR_COLUMNS = 4;
const NODE_WIDTH = 196;
const LANE_STEP = 232;
const TOP = 54;
const ROW_GAP = 22;
const LEFT = 24;

export function initialTocColumnForNode(node: Pick<OntologyProjectNode, 'type' | 'pdmStage'>): InitialTocColumnKey | null {
  const direct = DIRECT_TYPE_TO_COLUMN[node.type];
  if (direct) return direct;
  if (node.type !== 'indicator' || !node.pdmStage) return null;
  return PDM_STAGE_TO_COLUMN[node.pdmStage] ?? null;
}

export function buildInitialTocColumns(nodes: readonly OntologyProjectNode[]) {
  return INITIAL_TOC_COLUMNS.map((column) => ({
    ...column,
    nodes: nodes.filter((node) => initialTocColumnForNode(node) === column.key),
  }));
}

export function buildUnassignedIndicators(nodes: readonly OntologyProjectNode[]) {
  return nodes.filter((node) => (node.type === 'indicator' || node.type === 'impact') && initialTocColumnForNode(node) === null);
}

export interface UnmappedIndicatorStageCount {
  stage: string;
  count: number;
}

export interface UnmappedIndicatorSummary {
  totalCount: number;
  emptyCount: number;
  invalidCount: number;
  byStoredStage: UnmappedIndicatorStageCount[];
  invalidByStage: UnmappedIndicatorStageCount[];
}

export function summarizeUnmappedIndicatorStages(
  nodes: readonly Pick<OntologyProjectNode, 'type' | 'pdmStage'>[],
): UnmappedIndicatorSummary {
  let emptyCount = 0;
  let invalidCount = 0;
  const storedCounts = new Map<string, number>();
  const invalidCounts = new Map<string, number>();

  for (const node of nodes) {
    if ((node.type !== 'indicator' && node.type !== 'impact') || initialTocColumnForNode(node) !== null) continue;
    const rawStage = node.pdmStage ?? '';
    if (rawStage.trim() === '') {
      emptyCount += 1;
      continue;
    }
    storedCounts.set(rawStage, (storedCounts.get(rawStage) ?? 0) + 1);
    invalidCount += 1;
    invalidCounts.set(rawStage, (invalidCounts.get(rawStage) ?? 0) + 1);
  }

  return {
    totalCount: emptyCount + invalidCount,
    emptyCount,
    invalidCount,
    byStoredStage: [...storedCounts.entries()].map(([stage, count]) => ({ stage, count })),
    invalidByStage: [...invalidCounts.entries()].map(([stage, count]) => ({ stage, count })),
  };
}

export function formatUnmappedIndicatorNotice(summary: UnmappedIndicatorSummary): string | null {
  if (summary.totalCount === 0) return null;
  const invalidDetail = summary.invalidByStage.length
    ? `: ${summary.invalidByStage.map(({ stage, count }) => `${stage} ${count}개`).join(', ')}`
    : '';
  return `칸 미지정 지표 ${summary.totalCount}개 (빈 단계 ${summary.emptyCount}개, 5칸 외 단계 ${summary.invalidCount}개${invalidDetail}). AI가 다른 칸으로 추정하지 않습니다.`;
}

export interface OntologyGraphInput {
  nodes: readonly OntologyProjectNode[];
  edges: readonly OntologyProjectEdge[];
  candidates?: readonly OntologyProjectEdge[];
}

export interface PositionedOntologyNode extends OntologyProjectNode {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface PositionedOntologyEdge extends OntologyProjectEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
}

export interface OntologyGraphLayout {
  width: number;
  height: number;
  columnLabels: string[];
  nodes: PositionedOntologyNode[];
  edges: PositionedOntologyEdge[];
  candidates: PositionedOntologyEdge[];
  factorY: number;
  /** Node types the R03 graph does not draw (indicators, project, partner…), with counts. */
  omitted: Array<{ type: string; count: number }>;
}

const DISPLAY_ID_PREFIX: Record<string, string> = {
  activity: 'ACT', output: 'OPT', 'outcome-short': 'OUT-S', 'outcome-mid': 'OUT-M',
  enabler: 'FAC-E', constraint: 'FAC-C',
};

/** Stable short labels for display. Original IDs remain the graph's canonical keys. */
export function buildOntologyDisplayIds(nodes: readonly OntologyProjectNode[]): Map<string, string> {
  const groups = new Map<string, OntologyProjectNode[]>();
  for (const node of nodes) {
    const prefix = DISPLAY_ID_PREFIX[node.type];
    if (!prefix) continue;
    const group = groups.get(node.type) ?? [];
    group.push(node);
    groups.set(node.type, group);
  }
  const result = new Map<string, string>();
  for (const [type, group] of groups) {
    group.sort((a, b) => compareText(a.id, b.id));
    group.forEach((node, index) => result.set(node.id, `${DISPLAY_ID_PREFIX[type]}-${String(index + 1).padStart(2, '0')}`));
  }
  return result;
}

/** Four causal lanes with a two-category factor grid below them. */
export function layoutOntologyGraph({ nodes, edges, candidates = [] }: OntologyGraphInput): OntologyGraphLayout {
  const sortedNodes = [...nodes].sort((left, right) => compareText(left.id, right.id));
  const mainNodes = Array.from({ length: GRAPH_LANES.length }, () => [] as OntologyProjectNode[]);
  const enablers: OntologyProjectNode[] = [];
  const constraints: OntologyProjectNode[] = [];
  const other: OntologyProjectNode[] = [];
  const omittedCounts = new Map<string, number>();

  // R03 시안 그래프는 노드 유형으로만 칸을 정한다. 지표(PDM 단계로 단순 ToC 에 놓이는 것)와 사업·협력국 등은 그리지 않고 수만 알린다.
  for (const node of sortedNodes) {
    const index = GRAPH_LANES.findIndex((item) => item.key === node.type);
    if (index >= 0) {
      mainNodes[index].push(node);
    } else if (node.type === 'enabler') {
      enablers.push(node);
    } else if (node.type === 'constraint') {
      constraints.push(node);
    } else {
      omittedCounts.set(node.type, (omittedCounts.get(node.type) ?? 0) + 1);
    }
  }

  const placements: Array<{ node: OntologyProjectNode; column: number; row: number }> = [];
  mainNodes.forEach((group, column) => group.forEach((node, row) => placements.push({ node, column, row })));
  const displayIds = buildOntologyDisplayIds(sortedNodes);

  const rowHeights = new Map<number, number>();
  for (const { node, row } of placements) {
    const nodeHeight = nodeHeightFor(titleLines(node.title || node.id));
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, nodeHeight));
  }
  const rowTops = new Map<number, number>();
  let cursor = TOP;
  for (const row of [...rowHeights.keys()].sort((left, right) => left - right)) {
    rowTops.set(row, cursor);
    cursor += rowHeights.get(row)! + ROW_GAP;
  }

  const positionedNodes: PositionedOntologyNode[] = placements.map(({ node, column, row }) => {
    const title = node.title || node.id;
    const height = nodeHeightFor(titleLines(title));
    const rowHeight = rowHeights.get(row) ?? height;
    return {
      ...node,
      displayId: displayIds.get(node.id) ?? node.id,
      title,
      x: LEFT + column * LANE_STEP,
      y: (rowTops.get(row) ?? TOP) + (rowHeight - height) / 2,
      width: NODE_WIDTH,
      height,
      lines: titleLines(title),
    };
  });
  const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
  const allowed = new Set<string>(GRAPH_RELATIONS);
  const positionEdges = (input: readonly OntologyProjectEdge[]) => [...input]
    .filter((edge) => allowed.has(edge.relation) && positionedById.has(edge.source) && positionedById.has(edge.target))
    .sort((left, right) => compareText(left.source, right.source) || compareText(left.target, right.target) || compareText(left.relation, right.relation));
  const placeEdges = (input: readonly OntologyProjectEdge[]) => {
    const pairCounts = new Map<string, number>();
    return positionEdges(input).map((edge): PositionedOntologyEdge => {
    const source = positionedById.get(edge.source)!;
    const target = positionedById.get(edge.target)!;
    const fromLeft = source.x + source.width / 2;
    const toLeft = target.x + target.width / 2;
    const x1 = fromLeft <= toLeft ? source.x + source.width : source.x;
    const x2 = fromLeft <= toLeft ? target.x : target.x + target.width;
    const y1 = source.y + source.height / 2;
    const y2 = target.y + target.height / 2;
    const pairKey = `${edge.source}\u0000${edge.target}`;
    const pairIndex = pairCounts.get(pairKey) ?? 0;
    pairCounts.set(pairKey, pairIndex + 1);
    return { ...edge, x1, y1, x2, y2, labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 + pairIndex * 14 };
    });
  };
  const lastRow = Math.max(-1, ...rowHeights.keys());
  const height = lastRow < 0 ? 240 : (rowTops.get(lastRow) ?? TOP) + (rowHeights.get(lastRow) ?? 0) + ROW_GAP;
  const width = Math.max(4 * LANE_STEP, LEFT * 2 + 4 * LANE_STEP - (LANE_STEP - NODE_WIDTH));
  const mainHeight = lastRow < 0 ? TOP : (rowTops.get(lastRow) ?? TOP) + (rowHeights.get(lastRow) ?? 0);
  const factorStart = mainHeight + 100;
  const factorPlacements: PositionedOntologyNode[] = [];
  const factorRows = Math.max(Math.ceil(enablers.length / 2), Math.ceil(constraints.length / 2));
  const factorRowHeights = Array.from({ length: factorRows }, (_, row) => Math.max(0,
    ...enablers.slice(row * 2, row * 2 + 2).map(node => nodeHeightFor(titleLines(node.title || node.id))),
    ...constraints.slice(row * 2, row * 2 + 2).map(node => nodeHeightFor(titleLines(node.title || node.id))),
  ));
  const factorRowTops: number[] = [];
  let factorCursor = factorStart + 30;
  factorRowHeights.forEach((rowHeight, row) => { factorRowTops[row] = factorCursor; factorCursor += rowHeight + ROW_GAP; });
  const placeFactorGroup = (group: OntologyProjectNode[], offset: number) => group.forEach((node, index) => {
    const lines = titleLines(node.title || node.id); const row = Math.floor(index / 2); const column = offset + (index % 2);
    factorPlacements.push({ ...node, displayId: displayIds.get(node.id) ?? node.id, x: LEFT + column * LANE_STEP, y: factorRowTops[row], width: NODE_WIDTH, height: nodeHeightFor(lines), lines });
  });
  placeFactorGroup(enablers, 0);
  placeFactorGroup(constraints, 2);
  const otherStart = (factorCursor || factorStart + 30) + 24;
  const otherRows = Math.ceil(other.length / 4);
  const otherRowHeights = Array.from({ length: otherRows }, (_, row) => Math.max(0, ...other.slice(row * 4, row * 4 + 4).map(node => nodeHeightFor(titleLines(node.title || node.id)))));
  const otherRowTops: number[] = [];
  let otherCursor = otherStart;
  otherRowHeights.forEach((rowHeight, row) => { otherRowTops[row] = otherCursor; otherCursor += rowHeight + ROW_GAP; });
  other.forEach((node, index) => { const lines = titleLines(node.title || node.id); factorPlacements.push({ ...node, displayId: displayIds.get(node.id) ?? node.id, x: LEFT + (index % 4) * LANE_STEP, y: otherRowTops[Math.floor(index / 4)], width: NODE_WIDTH, height: nodeHeightFor(lines), lines }); });
  const allPositioned = [...positionedNodes, ...factorPlacements];
  const withFactors = (input: readonly OntologyProjectEdge[]) => {
    const previous = new Map(positionedById);
    allPositioned.forEach(node => positionedById.set(node.id, node));
    const result = placeEdges(input);
    previous.forEach((node, id) => positionedById.set(id, node));
    return result;
  };
  const maxBottom = Math.max(0, ...allPositioned.map(node => node.y + node.height));
  return { width, height: Math.max(height, maxBottom + ROW_GAP), columnLabels: GRAPH_LANES.map(({ label }) => label), nodes: allPositioned, edges: withFactors(edges), candidates: withFactors(candidates), factorY: factorStart, omitted: [...omittedCounts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || compareText(a.type, b.type)) };
}

function titleLines(title: string): string[] {
  const characters = Array.from(title);
  const lines: string[] = [];
  for (let index = 0; index < characters.length; index += 17) lines.push(characters.slice(index, index + 17).join(''));
  return lines.length ? lines : [''];
}

function nodeHeightFor(lines: string[]): number {
  return 35 + lines.length * 18;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}
