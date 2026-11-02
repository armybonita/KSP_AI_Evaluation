import { describe, expect, it } from 'vitest';
import { createForbiddenSentenceIndex, hasForbiddenSentenceOverlap } from './citation-ban';

describe('request-scoped forbidden sentence index', () => {
  it('matches the existing overlap rule including case folding and whitespace', () => {
    const bans = [' AlphaBravoCharlie Delta Echo ', 'İABCDEFG Hijkl', '짧음', '긴 한글 문장과 공백을 제거한 문자열'];
    const indexed = createForbiddenSentenceIndex(bans);
    const samples = [null, '', 'unrelated', 'bravochA', 'AlphaBravoCharlieDelta', 'i\u0307abcdefg', '긴한글문장과공백을', 'ABCDEFGH'];
    for (const ban of bans) {
      for (let start = 0; start < ban.length; start++) {
        samples.push(ban.slice(start, start + 8), ban.slice(start, start + 8).toLowerCase());
      }
    }
    for (const sample of samples) {
      const expected = hasForbiddenSentenceOverlap(sample, bans);
      expect(indexed(sample)).toBe(expected);
      expect(indexed(sample)).toBe(expected);
    }
  });

  it('does not share cached decisions between different project indexes', () => {
    const text = '가상 인용 문장에서 긴 부분 문자열';
    const banned = createForbiddenSentenceIndex([text]);
    const allowed = createForbiddenSentenceIndex(['전혀 다른 가상 문장입니다']);
    expect(banned(text)).toBe(true);
    expect(allowed(text)).toBe(false);
    expect(banned(text)).toBe(true);
    expect(allowed(text)).toBe(false);
  });
});
