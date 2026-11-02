import { describe, expect, it } from 'vitest';
import type { IndicatorRecord, ParagraphRecord } from '../store';
import { getSuggestMaxInputChars, getSuggestMaxParagraphs, selectParagraphsForIndicator, selectParagraphsForText } from './paragraph-selection';

const indicator: IndicatorRecord = { id: 'i', project_id: 'p', level: '활동', name: '교육 참여', ovi: '교육 참여 확대', mov: null, target_value: '100명', is_baseline: 0, created_at: '2026-01-01' };
const paragraph = (content: string, i: number): ParagraphRecord => ({ id: String(i), document_id: 'd', sequence_no: i, location: `¶${i}`, content });
const wire = (items: ParagraphRecord[]) => JSON.stringify(items.map(({ document_id, location, content }) => ({ document_id, location, content })));

describe('제안 입력 문단 선택', () => {
  it('점수 문단과 인접 문맥만 담고 입력 순서와 무관하게 정렬한다', () => {
    const items = ['무관한 먼 문단', '표 머리', '교육 참여 100명', '단위 설명', '다른 먼 문단'].map(paragraph);
    const result = selectParagraphsForIndicator(indicator, items);
    expect(result.paragraphs.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(selectParagraphsForIndicator(indicator, items.toReversed())).toEqual(result);
  });
  it('빈 입력과 일치 없는 입력 및 문단당 길이 제한을 처리한다', () => {
    expect(selectParagraphsForText('교육', []).paragraphs).toEqual([]);
    const result = selectParagraphsForText('교육', [paragraph('가'.repeat(5000), 0), paragraph('나'.repeat(5000), 1)], 4500);
    expect(result.paragraphs[0].content).toHaveLength(4000);
    expect(wire(result.paragraphs).length).toBeLessThanOrEqual(4500);
  });
  it('환경 변수 및 직접 전달한 잘못된 제한을 기본값으로 처리한다', () => {
    for (const value of ['', '0', '-1', '1.5', '12x', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(getSuggestMaxInputChars(value)).toBe(30000);
      expect(getSuggestMaxParagraphs(value)).toBe(150);
    }
    expect(getSuggestMaxInputChars('123')).toBe(123);
    expect(getSuggestMaxParagraphs('123')).toBe(123);
    for (const value of [0, -1, NaN, Infinity]) expect(selectParagraphsForText('', [paragraph('내용', 0)], value, value).paragraphs).toHaveLength(1);
  });
  it('기준 지표 목표값과 한 글자 낱말을 반영한다', () => {
    const items = [paragraph('무관', 0), paragraph('특이값', 1), paragraph('무관', 2), paragraph('강', 3)];
    const baseline = { id: 'b', indicator_id: 'i', project_id: 'p', document_id: 'd', document_name: '문서', target_value: '특이값', selected_at: '' };
    expect(selectParagraphsForIndicator(indicator, items, baseline, 60).paragraphs[0].id).toBe('1');
    expect(selectParagraphsForText('강', items, 60).paragraphs[0].id).toBe('3');
  });
  it('짧은 수천 문단의 JSON과 개수를 제한한다', () => {
    const items = Array.from({ length: 5000 }, (_, i) => paragraph('가', i));
    const result = selectParagraphsForText('가', items, 30000, 150);
    expect(result.sentParagraphCount).toBe(150);
    expect(result.totalParagraphCount).toBe(5000);
    expect(wire(result.paragraphs).length).toBeLessThanOrEqual(30000);
    expect(wire(selectParagraphsForText('가', items, 500, 5000).paragraphs).length).toBeLessThanOrEqual(500);
  });
  it('흔한 조각보다 드문 조각을 우선하고 날짜 조각은 숫자와 일치시키지 않는다', () => {
    const items = Array.from({ length: 30 }, (_, i) => paragraph(i === 20 ? '사업 희귀' : '사업 운영', i));
    expect(selectParagraphsForText('사업 희귀', items, 70).paragraphs[0].id).toBe('20');
    const dates = [paragraph('2026-11-01', 0), paragraph('무관', 1), paragraph('목표 11명', 2)];
    expect(selectParagraphsForText('11명', dates, 70).paragraphs[0].id).toBe('2');
  });
  it('수량 단위는 짧게 잡고 긴 문단 점수를 정규화한다', () => {
    const items = [paragraph(`교육 참여 ${'무관'.repeat(200)}`, 0), paragraph('무관', 1), paragraph('교육 참여 100명에', 2)];
    expect(selectParagraphsForText('교육 참여 100명', items, 80).paragraphs[0].id).toBe('2');
  });
});
