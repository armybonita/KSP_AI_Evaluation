import { describe, expect, it } from 'vitest';
import type { ParagraphRecord } from '@/server/store/types';
import { getIndicatorNaturalKey, parsePdmParagraphs, parsePdmParagraphsLegacy } from './baseline-key';

function eippParagraphs(gridVersion?: number): ParagraphRecord[] {
  const cells = [
    [1, 1, '분류'], [1, 2, '구분'], [1, 3, '실적 및 목표'],
    [2, 4, '2024년'], [2, 5, '2025년'],
    [3, 1, 'Outcome'], [3, 2, '가상 정책 개선'], [3, 3, '정책 이행률'], [3, 4, '70%'], [3, 5, '80%'],
  ] as const;
  return cells.map(([table_row, table_col, content], sequence_no) => ({
    id: `p${sequence_no}`, document_id: 'd', sequence_no, location: `¶${sequence_no}`, content,
    table_index: 0, table_cols: 5, table_row, table_col,
    ...(gridVersion == null ? {} : { grid_coord_version: gridVersion }),
  }));
}

describe('legacy EIPP grid coordinates', () => {
  it('retains the original parser values for old coordinates', () => {
    const [item] = parsePdmParagraphs(eippParagraphs(), 'd');
    expect(item.mov).toBe('70%');
    expect(item.planDetails).toBeUndefined();
  });

  it('uses year columns only when extraction recorded the grid coordinate version', () => {
    const [item] = parsePdmParagraphs(eippParagraphs(1), 'd');
    expect(item.mov).toBeNull();
    expect(item.target_value).toBe('80%');
    expect(item.planDetails).toContainEqual({ label: '2024', value: '70%' });
    expect(item.planDetails).toContainEqual({ label: '2025', value: '80%' });
  });
  it('keeps legacy results and keys when old and grid tables share a document', () => {
    const grid = eippParagraphs(1).map(p => ({ ...p, id: `g${p.id}`, table_index: 1 }));
    const legacy = eippParagraphs().map(p => ({ ...p, id: `l${p.id}`, location: `legacy-${p.location}`, sequence_no: p.sequence_no + grid.length, table_index: 2 }));
    const combined = [...grid, ...legacy];
    const before = parsePdmParagraphsLegacy(combined, 'd').filter(p => p.source_location.startsWith('legacy-'));
    const after = parsePdmParagraphs(combined, 'd').filter(p => p.source_location.startsWith('legacy-'));
    expect(after).toEqual(before);
    expect(getIndicatorNaturalKey('Outcome', '가상', '지표')).toBe('Outcome:::가상:::지표');
    expect(parsePdmParagraphs(combined, 'd').find(p => !p.source_location.startsWith('legacy-'))?.target_value).toBe('80%');
  });

});
