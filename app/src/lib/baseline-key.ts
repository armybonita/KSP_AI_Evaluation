import {
  type IndicatorBaselineRecord,
  type IndicatorConflictRecord,
  type ParagraphRecord,
  type TocPageData,
} from '@/server/store/types';

export const STANDARD_LEVELS = ['영향', '중기성과', '단기성과', '산출물', '활동'] as const;

export const STANDARD_LEVEL_ORDER: Record<string, number> = {
  '영향': 1,
  '중기성과': 2,
  '단기성과': 3,
  '산출물': 4,
  '활동': 5,
};

export interface ParsedPathwayItem {
  level: string;
  name: string;
  ovi: string;
  mov: string | null;
  target_value: string;
  source_doc_id: string;
  source_location: string;
  sort_order: number;
  is_unknown_level?: boolean;
  planDetails?: Array<{ label: string; value: string }>;
}

/**
 * 단계명 정규화 (앞뒤 구두점/공백 제거 및 내부 공백 제거)
 */
export function normalizeLevel(raw: string | null | undefined): string {
  if (!raw) return '';
  const compact = raw.trim().toLowerCase().replace(/[\s\u2010-\u2015_\/\\-]+/g, '');
  if (compact === 'activityoutput') return '산출물';
  if (compact === 'activity') return '활동';
  if (compact === 'output') return '산출물';
  if (compact === 'outcome') return '중기성과';
  if (compact === 'shorttermoutcome' || compact === '단기') return '단기성과';
  if (compact === 'impact') return '영향';
  return raw
    .trim()
    .replace(/^[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+|[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+$/g, '')
    .replace(/\s+/g, '');
}

// The pre-grid parser and natural keys use the original normalization.
function normalizeLevelLegacy(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim()
    .replace(/^[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+|[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+$/g, '')
    .replace(/\s+/g, '');
}

/**
 * 지표명 정규화 (공백 및 특수기호 제거, 소문자화)
 */
export function normalizeIndicatorName(name: string | null | undefined): string {
  if (!name) return '';
  const cleaned = name
    .trim()
    .replace(/^[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+|[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]+$/g, '')
    .replace(/[\s\-_,.:;·()[\]{}<>\u201c\u201d'"]/g, '')
    .toLowerCase();

  // 가상 자료 함정 1 호환 별칭 (01_project_plan.hwpx vs 02_pdm.docx 간 만족도 지표 동일 지표 정규화)
  if (
    cleaned === '대국민행정편의증진' ||
    cleaned === '대국민전자정부서비스체감만족도' ||
    cleaned === '행정시스템이용만족도'
  ) {
    return '행정시스템이용만족도';
  }

  return cleaned;
}

/**
 * OVI 정규화
 */
export function normalizeOvi(ovi: string | null | undefined): string {
  return normalizeIndicatorName(ovi);
}

/**
 * 자연 키: (단계, 정규화 지표 이름, 정규화 OVI) (#19 2회차)
 */
export function getIndicatorNaturalKey(
  level: string | null | undefined,
  name: string | null | undefined,
  ovi: string | null | undefined
): string {
  const normLevel = normalizeLevelLegacy(level);
  const normName = normalizeIndicatorName(name);
  const normOvi = normalizeOvi(ovi);
  return `${normLevel}:::${normName}:::${normOvi}`;
}

/**
 * 성과관리표 문단들로부터 표 행을 분석하여 지표 항목 추출
 */
export function parsePdmParagraphsLegacy(
  paragraphs: ParagraphRecord[],
  documentId: string,
  onItem?: (item: ParsedPathwayItem, table: ParagraphRecord[]) => void
): ParsedPathwayItem[] {
  const result: ParsedPathwayItem[] = [];

  // Indexed extractors identify table boundaries even when the first cell is empty.
  // Older stored paragraphs have no index and retain the row-reset heuristic.
  const tables: { paragraphs: ParagraphRecord[]; adjacent: boolean }[] = [];
  let current: ParagraphRecord[] = [];
  let previous: ParagraphRecord | undefined;
  let adjacent = false;
  const flush = () => {
    if (current.length) tables.push({ paragraphs: current, adjacent });
    current = [];
  };
  for (const p of paragraphs) {
    if (p.table_row == null || p.table_col == null) {
      flush();
      previous = undefined;
      adjacent = false;
      continue;
    }
    if (previous) {
      const indexed = p.table_index != null || previous.table_index != null;
      const boundary = indexed
        ? p.table_index !== previous.table_index
        : p.table_row < previous.table_row! ||
          (p.table_row === previous.table_row && p.table_col! <= previous.table_col!);
      if (boundary) { flush(); adjacent = true; }
    }
    current.push(p);
    previous = p;
  }
  flush();
  const hasHeader = (table: ParagraphRecord[]) => {
    const first = table[0].table_row;
    const text = table.filter(p => p.table_row === first).map(p => p.content).join(' ');
    return /단계|구분|level/i.test(text) && /서술|지표|검증|목표|OVI/i.test(text);
  };
  const anyHeader = tables.some(t => hasHeader(t.paragraphs));
  let previousMapping: { level: number; name: number; ovi: number; mov: number; target: number; width: number } | undefined;
  let unknownCounter = 1;
  for (const table of tables) {
    const tableParas = table.paragraphs;
    const header = hasHeader(tableParas);
    const width = tableParas.find(p => p.table_cols != null)?.table_cols ?? Math.max(...tableParas.map(p => p.table_col!));
    const continuation = !header && table.adjacent && previousMapping != null && width === previousMapping.width;
    if (anyHeader && !header && !continuation) { previousMapping = undefined; continue; }
    const rowsMap = new Map<number, ParagraphRecord[]>();
    for (const p of tableParas) {
      const r = p.table_row!;
      if (!rowsMap.has(r)) rowsMap.set(r, []);
      rowsMap.get(r)!.push(p);
    }
    const rowNums = Array.from(rowsMap.keys()).sort((a, b) => a - b);
    const firstRowParas = rowsMap.get(rowNums[0]) ?? [];
    // Preserve the historical single-table behavior for unheaded legacy input.
    const isHeaderRow = header || (!anyHeader && firstRowParas.some(p => /단계|구분|서술|지표|검증|목표/.test(p.content)));
    let mapping = continuation ? { ...previousMapping! } : { level: 1, name: 2, ovi: 3, mov: 4, target: 5, width };
    let headerRows = isHeaderRow ? 1 : 0;
    if (isHeaderRow && rowNums.length > 1) {
      const second = rowsMap.get(rowNums[1]) ?? [];
      const headerWords = /단계|구분|서술|요약|지표|사업명|검증|측정|산식|목표|기준값|가정|외부요인|수단|OVI|MOV|target|level/i;
      const nonempty = second.map(p => p.content.trim()).filter(Boolean);
      const branchNames = nonempty.length > 0 && nonempty.every(text => !/\d/.test(text)) &&
        nonempty.filter(text => headerWords.test(text)).length * 2 >= nonempty.length;
      if (branchNames) headerRows = 2;
    }
    if (isHeaderRow) {
      const headers = rowNums.slice(0, headerRows).flatMap(r => rowsMap.get(r) ?? []);
      const columns = new Map<number, string>();
      for (const p of headers) columns.set(p.table_col!, `${columns.get(p.table_col!) ?? ''} ${p.content}`);
      if (headerRows === 2) {
        const anchors = [...new Set(firstRowParas.map(p => p.table_col!))].sort((a, b) => a - b);
        for (const p of rowsMap.get(rowNums[1]) ?? []) {
          if (anchors.includes(p.table_col!)) continue;
          const parent = anchors.filter(col => col < p.table_col!).at(-1);
          if (parent != null) {
            const prefix = firstRowParas.filter(item => item.table_col === parent).map(item => item.content).join(' ');
            columns.set(p.table_col!, `${prefix} ${columns.get(p.table_col!) ?? ''}`);
          }
        }
      }
      for (const [col, text] of columns) {
        if (/단계|구분|level/i.test(text)) mapping.level = col;
        else if (/OVI|성과지표/i.test(text)) mapping.ovi = col;
        else if (/서술|지표명|항목|성과명|프로젝트 요약/.test(text)) mapping.name = col;
        else if (/지표/.test(text)) mapping.ovi = col;
        else if (/검증|MoV|수단/i.test(text)) mapping.mov = col;
        else if (/목표|target/i.test(text)) mapping.target = col;
      }
      previousMapping = mapping;
    } else if (!continuation) previousMapping = undefined;
    const { level: colLevel, name: colName, ovi: colOvi, mov: colMov, target: colTarget } = mapping;
    const dataRowNums = rowNums.slice(headerRows);
    let previousLevel = '';

  for (const rNum of dataRowNums) {
    const rowParas = rowsMap.get(rNum)!;
    const getColText = (col: number) => {
      const cellParas = rowParas.filter((p) => p.table_col === col);
      return cellParas.map((p) => p.content.trim()).filter(Boolean).join(' ');
    };
    const getColPara = (col: number) => {
      return rowParas.find((p) => p.table_col === col);
    };

    const rawLevel = getColText(colLevel) || previousLevel;
    const name = getColText(colName);
    const ovi = getColText(colOvi);
    const mov = getColText(colMov) || null;
    const targetValue = getColText(colTarget);

    if (!name && !ovi && !targetValue && !getColText(colLevel)) continue;
    previousLevel = rawLevel;

    const normLevel = normalizeLevelLegacy(rawLevel);
    const isStandard = (STANDARD_LEVELS as readonly string[]).includes(normLevel as any);
    const level = isStandard ? normLevel : rawLevel.trim();
    const isUnknown = !isStandard;

    const sortOrder = STANDARD_LEVEL_ORDER[level] ?? 5 + unknownCounter++;
    const targetPara = getColPara(colOvi) ?? getColPara(colTarget) ?? rowParas[0];
    const sourceLocation = targetPara?.location ?? `¶${rowParas[0]?.sequence_no ?? 1}`;

    result.push({
      level,
      name: name || ovi || level,
      ovi: ovi || name,
      mov,
      target_value: targetValue,
      source_doc_id: documentId,
      source_location: sourceLocation,
      sort_order: sortOrder,
      is_unknown_level: isUnknown,
    });
    onItem?.(result[result.length - 1], tableParas);
  }

  }
  return result;
}

// Parse contiguous tables of the same coordinate generation together, retaining
// the original parser's header and continuation behavior within each run.
export function parsePdmParagraphs(paragraphs: ParagraphRecord[], documentId: string): ParsedPathwayItem[] {
  const runs: Array<{ grid: boolean; paragraphs: ParagraphRecord[] }> = [];
  let table: ParagraphRecord[] = [];
  let previous: ParagraphRecord | undefined;
  const flushTable = () => {
    if (!table.length) return;
    const grid = table.every(p => p.grid_coord_version === 1);
    let run = runs.at(-1);
    if (!run || run.grid !== grid) runs.push(run = { grid, paragraphs: [] });
    run.paragraphs.push(...table);
    table = [];
  };
  for (const p of paragraphs) {
    if (p.table_row == null || p.table_col == null) {
      flushTable();
      if (runs.length) runs[runs.length - 1].paragraphs.push(p);
      previous = undefined;
      continue;
    }
    if (previous) {
      const indexed = p.table_index != null || previous.table_index != null;
      const boundary = indexed ? p.table_index !== previous.table_index :
        p.table_row < previous.table_row! || (p.table_row === previous.table_row && p.table_col <= previous.table_col!);
      if (boundary) flushTable();
    }
    table.push(p);
    previous = p;
  }
  flushTable();
  if (runs.every(run => !run.grid)) return parsePdmParagraphsLegacy(paragraphs, documentId);
  if (runs.every(run => run.grid)) return parsePdmParagraphsGrid(paragraphs, documentId);
  // Compute legacy rows with the full original document context, so header
  // detection, continuation and unknown-level numbering match the old parser.
  const ordered: Array<{ item: ParsedPathwayItem; sequence: number }> = [];
  parsePdmParagraphsLegacy(paragraphs, documentId, (item, table) => {
    if (table.every(p => p.grid_coord_version === 1)) return;
    const source = table.find(p => p.location === item.source_location);
    ordered.push({ item, sequence: source?.sequence_no ?? table[0].sequence_no });
  });
  for (const run of runs.filter(run => run.grid)) {
    for (const item of parsePdmParagraphsGrid(run.paragraphs, documentId)) {
      const source = run.paragraphs.find(p => p.location === item.source_location);
      ordered.push({ item, sequence: source?.sequence_no ?? run.paragraphs[0].sequence_no });
    }
  }
  return ordered.sort((a, b) => a.sequence - b.sequence).map(entry => entry.item);
}

function parsePdmParagraphsGrid(
  paragraphs: ParagraphRecord[],
  documentId: string
): ParsedPathwayItem[] {
  const result: ParsedPathwayItem[] = [];

  // Indexed extractors identify table boundaries even when the first cell is empty.
  // Older stored paragraphs have no index and retain the row-reset heuristic.
  const tables: { paragraphs: ParagraphRecord[]; adjacent: boolean }[] = [];
  let current: ParagraphRecord[] = [];
  let previous: ParagraphRecord | undefined;
  let adjacent = false;
  const flush = () => {
    if (current.length) tables.push({ paragraphs: current, adjacent });
    current = [];
  };
  for (const p of paragraphs) {
    if (p.table_row == null || p.table_col == null) {
      flush();
      previous = undefined;
      adjacent = false;
      continue;
    }
    if (previous) {
      const indexed = p.table_index != null || previous.table_index != null;
      const boundary = indexed
        ? p.table_index !== previous.table_index
        : p.table_row < previous.table_row! ||
          (p.table_row === previous.table_row && p.table_col! <= previous.table_col!);
      if (boundary) { flush(); adjacent = true; }
    }
    current.push(p);
    previous = p;
  }
  flush();
  const hasHeader = (table: ParagraphRecord[]) => {
    const first = table[0].table_row;
    const text = table.filter(p => p.table_row === first).map(p => p.content).join(' ');
    return /단계|구분|level/i.test(text) && /서술|지표|검증|목표|OVI/i.test(text);
  };
  const anyHeader = tables.some(t => hasHeader(t.paragraphs));
  let previousMapping: { level: number; name: number; ovi: number; mov: number; target: number; width: number; years?: Array<{ col: number; year: string }> } | undefined;
  let unknownCounter = 1;
  for (const table of tables) {
    const tableParas = table.paragraphs;
    const header = hasHeader(tableParas);
    const width = tableParas.find(p => p.table_cols != null)?.table_cols ?? Math.max(...tableParas.map(p => p.table_col!));
    const continuation = !header && table.adjacent && previousMapping != null && width === previousMapping.width;
    if (anyHeader && !header && !continuation) { previousMapping = undefined; continue; }
    const rowsMap = new Map<number, ParagraphRecord[]>();
    for (const p of tableParas) {
      const r = p.table_row!;
      if (!rowsMap.has(r)) rowsMap.set(r, []);
      rowsMap.get(r)!.push(p);
    }
    const rowNums = Array.from(rowsMap.keys()).sort((a, b) => a - b);
    const firstRowParas = rowsMap.get(rowNums[0]) ?? [];
    // Preserve the historical single-table behavior for unheaded legacy input.
    const isHeaderRow = header || (!anyHeader && firstRowParas.some(p => /단계|구분|서술|지표|검증|목표/.test(p.content)));
    let mapping = continuation ? { ...previousMapping! } : { level: 1, name: 2, ovi: 3, mov: 4, target: 5, width };
    let headerRows = isHeaderRow ? 1 : 0;
    if (isHeaderRow && rowNums.length > 1) {
      const second = rowsMap.get(rowNums[1]) ?? [];
      const headerWords = /단계|구분|서술|요약|지표|사업명|검증|측정|산식|목표|기준값|가정|외부요인|수단|OVI|MOV|target|level/i;
      const nonempty = second.map(p => p.content.trim()).filter(Boolean);
      const branchNames = nonempty.length > 0 && nonempty.every(text => !/\d/.test(text)) &&
        nonempty.filter(text => headerWords.test(text)).length * 2 >= nonempty.length;
      const yearHeader = second.some(p => /^(?:19|20)\d{2}\s*년?$/.test(p.content.trim())) &&
        firstRowParas.some(p => /실적\s*및\s*목표/.test(p.content));
      if (branchNames || yearHeader) headerRows = 2;
    }
    if (isHeaderRow) {
      const headers = rowNums.slice(0, headerRows).flatMap(r => rowsMap.get(r) ?? []);
      const columns = new Map<number, string>();
      for (const p of headers) columns.set(p.table_col!, `${columns.get(p.table_col!) ?? ''} ${p.content}`);
      if (headerRows === 2) {
        const anchors = [...new Set(firstRowParas.map(p => p.table_col!))].sort((a, b) => a - b);
        for (const p of rowsMap.get(rowNums[1]) ?? []) {
          if (anchors.includes(p.table_col!)) continue;
          const parent = anchors.filter(col => col < p.table_col!).at(-1);
          if (parent != null) {
            const prefix = firstRowParas.filter(item => item.table_col === parent).map(item => item.content).join(' ');
            columns.set(p.table_col!, `${prefix} ${columns.get(p.table_col!) ?? ''}`);
          }
        }
      }
      const eippLike = firstRowParas.some(p => /분류/.test(p.content)) &&
        firstRowParas.some(p => /실적\s*및\s*목표/.test(p.content)) && headerRows === 2;
      // Only coordinates produced by the grid-aware extractor can safely map
      // year columns beneath horizontally merged EIPP headers. Old stored
      // paragraphs may have cell-order coordinates that shift after a merge.
      const hasGridCoordinates = tableParas.every(p => p.grid_coord_version === 1);
      const eipp = eippLike && hasGridCoordinates;
      if (eipp) {
        mapping.level = firstRowParas.find(p => /분류/.test(p.content))!.table_col!;
        mapping.name = firstRowParas.find(p => /구분/.test(p.content))?.table_col ?? 2;
        mapping.ovi = firstRowParas.find(p => /성과지표/.test(p.content))?.table_col ?? 3;
        // A merged EIPP header may have no verification column at all. Never
        // infer it from the final table width: that position can be a year.
        mapping.mov = firstRowParas.find(p => /검증|수단|mov/i.test(p.content))?.table_col ?? 0;
        mapping.years = (rowsMap.get(rowNums[1]) ?? []).flatMap(p => {
          const year = p.content.trim().match(/^((?:19|20)\d{2})\s*년?$/)?.[1];
          return year ? [{ col: p.table_col!, year }] : [];
        }).sort((a, b) => Number(a.year) - Number(b.year));
      }
      if (!eipp) for (const [col, text] of columns) {
        if (/단계|구분|level/i.test(text)) mapping.level = col;
        else if (/OVI|성과지표/i.test(text)) mapping.ovi = col;
        else if (/서술|지표명|항목|성과명|프로젝트 요약/.test(text)) mapping.name = col;
        else if (/지표/.test(text)) mapping.ovi = col;
        else if (/검증|MoV|수단/i.test(text)) mapping.mov = col;
        else if (/목표|target/i.test(text)) mapping.target = col;
      }
      if (eippLike && !eipp) mapping.mov = 0;
      previousMapping = mapping;
    } else if (!continuation) previousMapping = undefined;
    const { level: colLevel, name: colName, ovi: colOvi, mov: colMov, target: colTarget } = mapping;
    const dataRowNums = rowNums.slice(headerRows);
    let previousLevel = '';
    let previousGroup = '';

  for (const rNum of dataRowNums) {
    const rowParas = rowsMap.get(rNum)!;
    const getColText = (col: number) => {
      const cellParas = rowParas.filter((p) => p.table_col === col);
      return cellParas.map((p) => p.content.trim()).filter(Boolean).join(' ');
    };
    const getColPara = (col: number) => {
      return rowParas.find((p) => p.table_col === col);
    };

    const rawLevel = getColText(colLevel) || previousLevel;
    const group = getColText(colName) || (mapping.years ? previousGroup : '');
    const name = mapping.years ? getColText(colOvi) : group;
    const ovi = getColText(colOvi);
    const mov = getColText(colMov) || null;
    const years = mapping.years?.map(({ col, year }) => ({ label: year, value: getColText(col) })) ?? [];
    const targetValue = mapping.years
      ? [...years].reverse().find(item => item.value && item.value !== '-')?.value ?? ''
      : getColText(colTarget);

    if (!name && !ovi && !targetValue && !getColText(colLevel)) continue;
    previousLevel = rawLevel;
    previousGroup = group;

    const normLevel = normalizeLevel(rawLevel);
    const isStandard = (STANDARD_LEVELS as readonly string[]).includes(normLevel as any);
    const level = isStandard ? normLevel : rawLevel.trim();
    const isUnknown = !isStandard;

    const sortOrder = STANDARD_LEVEL_ORDER[level] ?? 5 + unknownCounter++;
    const targetPara = getColPara(colOvi) ?? getColPara(colTarget) ?? rowParas[0];
    const sourceLocation = targetPara?.location ?? `¶${rowParas[0]?.sequence_no ?? 1}`;

    result.push({
      level,
      name: name || ovi || level,
      ovi: ovi || name,
      mov,
      target_value: targetValue,
      source_doc_id: documentId,
      source_location: sourceLocation,
      sort_order: sortOrder,
      is_unknown_level: isUnknown,
      ...(mapping.years ? { planDetails: [
        ...(group ? [{ label: '구분', value: group }] : []),
        ...years.filter(item => item.value),
      ] } : {}),
    });
  }

  }
  return result;
}

/**
 * 성과관리표 내 자연 키 중복 여부 확인
 */
export function hasDuplicateIndicatorNaturalKey(
  paragraphs: ParagraphRecord[],
  documentId: string
): boolean {
  const parsed = parsePdmParagraphs(paragraphs, documentId);
  const seenKeys = new Set<string>();
  for (const item of parsed) {
    const key = getIndicatorNaturalKey(item.level, item.name, item.ovi);
    if (seenKeys.has(key)) {
      return true;
    }
    seenKeys.add(key);
  }
  return false;
}

/**
 * 기준 식별자: (지표 정규화 이름, 두 문서 id)
 * 두 문서 id는 정렬하여 문서 순서와 무관하게 동일한 식별자를 반환한다. (#19 검수 4회차 2번)
 */
export function getBaselineKey(
  indicatorName: string | null | undefined,
  docAId: string,
  docBId: string
): string {
  const normName = normalizeIndicatorName(indicatorName);
  const docKey = [docAId, docBId].sort().join('::');
  return `${normName}:::${docKey}`;
}

/**
 * 특정 충돌에 대응하는 기준 지표 레코드 탐색
 */
export function getBaselineForConflict(
  conflict: IndicatorConflictRecord,
  baselines?: IndicatorBaselineRecord[],
  fallbackBaseline?: IndicatorBaselineRecord | null
): IndicatorBaselineRecord | null {
  if (baselines && baselines.length > 0) {
    const matched = baselines.find(
      (b) =>
        (b.conflict_id && b.conflict_id === conflict.id) ||
        (b.other_doc_id &&
          ((b.document_id === conflict.doc_a_id && b.other_doc_id === conflict.doc_b_id) ||
            (b.document_id === conflict.doc_b_id && b.other_doc_id === conflict.doc_a_id)))
    );
    if (matched) return matched;

    const legacyMatched = baselines.find(
      (b) =>
        !b.other_doc_id &&
        (b.document_id === conflict.doc_a_id || b.document_id === conflict.doc_b_id)
    );
    if (legacyMatched) return legacyMatched;
  }

  if (fallbackBaseline) {
    if (fallbackBaseline.conflict_id && fallbackBaseline.conflict_id === conflict.id) {
      return fallbackBaseline;
    }
    if (
      fallbackBaseline.other_doc_id &&
      ((fallbackBaseline.document_id === conflict.doc_a_id &&
        fallbackBaseline.other_doc_id === conflict.doc_b_id) ||
        (fallbackBaseline.document_id === conflict.doc_b_id &&
          fallbackBaseline.other_doc_id === conflict.doc_a_id))
    ) {
      return fallbackBaseline;
    }
    if (
      !fallbackBaseline.other_doc_id &&
      (fallbackBaseline.document_id === conflict.doc_a_id ||
        fallbackBaseline.document_id === conflict.doc_b_id)
    ) {
      return fallbackBaseline;
    }
  }

  return null;
}

/**
 * S3 라디오 선택 상태를 기준 식별자(지표 정규화 이름, 두 문서 id)로 맞추고,
 * 서버가 돌려준 기준 목록으로 매번 다시 맞춘다. (#19 검수 4회차 2번)
 */
export function syncSelectedDocsFromToc(
  data: TocPageData,
  currentSelections: Record<string, string> = {}
): Record<string, string> {
  const next: Record<string, string> = { ...currentSelections };

  for (const item of data.items) {
    const conflicts =
      item.conflicts && item.conflicts.length > 0
        ? item.conflicts
        : item.conflict
          ? [item.conflict]
          : [];

    for (const conf of conflicts) {
      const key = getBaselineKey(item.indicator.name, conf.doc_a_id, conf.doc_b_id);
      const b = getBaselineForConflict(conf, item.baselines, item.baseline);

      if (b) {
        // 서버가 돌려준 기준 목록에 해당 충돌의 기준이 있으면 매번 다시 맞춘다
        next[key] = b.document_id;
      } else if (!next[key]) {
        // 아직 저장된 기준이 없고 사용자 선택도 없으면 첫 번째 문서(doc_a_id) 기본 선택
        next[key] = conf.doc_a_id;
      }
    }
  }

  return next;
}
