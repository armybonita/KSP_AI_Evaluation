import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeForQuoteMatch, verifyQuote } from '../quote-verify';
import { describe, expect, it } from 'vitest';
import {
  assessEvidenceSufficiency,
  getManualNumericWarning,
  quoteBigramCoverage,
} from './trust';

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'fixtures', 'w17-stage3', 'source-document.json'), 'utf8')) as {
  quote: string;
  manualSentence: string;
  bigram: { quote: string; paragraph: string; expectedPercent: number };
};

describe('ontology trust helpers', () => {
  it('matches the original multiset calculation for exact substrings and surrogate boundaries', () => {
    const original = (quote: string, paragraph: string) => {
      const q = Array.from(normalizeForQuoteMatch(quote));
      const p = Array.from(normalizeForQuoteMatch(paragraph));
      if (q.length < 2) return verifyQuote(quote, paragraph) ? 100 : 0;
      const counts = (items: string[]) => {
        const result = new Map<string, number>();
        for (let i = 0; i + 1 < items.length; i++) {
          const gram = items[i] + items[i + 1];
          result.set(gram, (result.get(gram) ?? 0) + 1);
        }
        return result;
      };
      const a = counts(q), b = counts(p);
      return Math.round([...a].reduce((sum, [gram, count]) => sum + Math.min(count, b.get(gram) ?? 0), 0) / (q.length - 1) * 100);
    };
    const samples = ['가가가', '가 나', '😀가😀', '\udc00가', '\ud800가', 'a  b', '“가”'];
    for (const quote of samples) for (const paragraph of samples.map(v => `앞${v}뒤`).concat(samples)) {
      expect(quoteBigramCoverage(quote, paragraph)).toBe(original(quote, paragraph));
    }
  });
  it('computes multiset bigram coverage as a fixed integer percentage', () => {
    expect(quoteBigramCoverage(fixture.bigram.quote, fixture.bigram.paragraph)).toBe(fixture.bigram.expectedPercent);
  });

  it('uses quote verification for normalized quotes shorter than two codepoints', () => {
    expect(quoteBigramCoverage('가', '원문 가 포함')).toBe(100);
    expect(quoteBigramCoverage('나', '원문 가 포함')).toBe(0);
  });

  it('maps one or more proven records to high sufficiency', () => {
    expect(assessEvidenceSufficiency([{ evidence_level: '입증', speaker: '수행기관' }])).toEqual({
      label: '높음',
      reason: '입증 근거가 1건 있습니다.',
    });
  });

  it('marks author-based sufficiency for confirmation when only distinct speakers are available', () => {
    expect(assessEvidenceSufficiency([
      { evidence_level: '관측', speaker: '협력국' },
      { level: '관측', speaker: '수행기관' },
    ])).toMatchObject({ label: '[확인 필요]' });
  });

  it('maps observations from distinct known authors to high sufficiency', () => {
    expect(assessEvidenceSufficiency([
      { evidence_level: '관측', author: '작성 주체 A' },
      { level: '관측', author: '작성 주체 B' },
    ])).toEqual({
      label: '높음',
      reason: '서로 다른 작성 주체의 관측 근거가 2건 있습니다.',
    });
  });

  it('keeps an explicitly proven record high when another record lacks its level', () => {
    expect(assessEvidenceSufficiency([
      { evidence_level: '입증' },
      {},
    ])).toMatchObject({ label: '높음' });
  });

  it('maps a single observation to medium and same-author observations to medium', () => {
    expect(assessEvidenceSufficiency([{ evidence_level: '관측' }])).toMatchObject({ label: '보통' });
    expect(assessEvidenceSufficiency([
      { evidence_level: '관측', author: '작성 주체 A' },
      { evidence_level: '관측', author: '작성 주체 A' },
    ])).toMatchObject({ label: '보통' });
  });

  it('marks multiple observations for confirmation when author metadata is missing', () => {
    expect(assessEvidenceSufficiency([
      { evidence_level: '관측' },
      { evidence_level: '관측' },
    ])).toMatchObject({ label: '[확인 필요]' });
  });

  it('maps only inference or prediction to low sufficiency and empty input to not applicable', () => {
    expect(assessEvidenceSufficiency([
      { evidence_level: '추정' },
      { level: '예견' },
    ])).toMatchObject({ label: '낮음' });
    expect(assessEvidenceSufficiency([])).toMatchObject({ label: '해당 없음' });
  });

  it('marks missing and unrecognized evidence levels for confirmation', () => {
    expect(assessEvidenceSufficiency([{ speaker: '수행기관' }])).toMatchObject({ label: '[확인 필요]' });
    expect(assessEvidenceSufficiency([{ level: '미분류' }])).toMatchObject({ label: '[확인 필요]' });
  });

  it('returns an L1 warning for manual numeric mismatches without changing caller text', () => {
    const manualText = fixture.manualSentence;
    const originalText = manualText;
    expect(getManualNumericWarning(manualText, fixture.quote)).toEqual({
      level: 'L1',
      unmatchedTokens: ['4건'],
    });
    expect(manualText).toBe(originalText);
  });

  it('marks numeric statements for confirmation when no original quote is available', () => {
    expect(getManualNumericWarning(fixture.manualSentence, [])).toEqual({
      level: '[확인 필요]',
      reason: '대조할 수 있는 원문 인용이 없습니다.',
    });
  });

  it('returns no manual numeric warning when the quote contains the stated value', () => {
    expect(getManualNumericWarning(fixture.quote, fixture.quote)).toBeNull();
  });
});
