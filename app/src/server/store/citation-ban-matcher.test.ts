import { describe, expect, it } from 'vitest';
import { createForbiddenSentenceMatcher, hasForbiddenSentenceOverlap, maskForbiddenSentenceInContent } from './citation-ban';


// 9cd2e29의 hasForbiddenSentenceOverlap을 독립 기준으로 보존한다.
function previousOverlap(text: string | null | undefined, bannedSentences: string[], minLength = 8): boolean {
  if (!text || text.trim().length === 0) return false;
  if (!bannedSentences || bannedSentences.length === 0) return false;

  for (const banned of bannedSentences) {
    const trimmedBanned = banned.trim();
    if (trimmedBanned.length < minLength) continue;
    for (let i = 0; i <= trimmedBanned.length - minLength; i++) {
      const sub = trimmedBanned.slice(i, i + minLength);
      if (text.includes(sub)) return true;
      if (text.toLowerCase().includes(sub.toLowerCase())) return true;
    }
    const normText = text.replace(/\s+/g, '');
    const normBanned = trimmedBanned.replace(/\s+/g, '');
    if (normBanned.length >= minLength) {
      for (let i = 0; i <= normBanned.length - minLength; i++) {
        const sub = normBanned.slice(i, i + minLength);
        if (normText.includes(sub)) return true;
        if (normText.toLowerCase().includes(sub.toLowerCase())) return true;
      }
    }
  }
  return false;
}

describe('반복 인용 금지 판정', () => {
  it('기존 판정과 공백·대소문자·정규식 기호 및 짧은 문장에서 일치한다', () => {
    const banned = ['외부 공개 를 원하지 않습니다', 'AbC.(문장) XYZ', '짧은 말'];
    const matcher = createForbiddenSentenceMatcher(banned);
    for (const value of ['외부 공개를 원하지 않습니다', '외부 공개 를 원하지 않습니다', 'abc.(문장) xyz', '외부 공개', '아무 관련 없는 안전한 문장', '짧은 말', '', 'ABCx(문장) XYZ']) {
      expect(matcher(value)).toBe(hasForbiddenSentenceOverlap(value, banned));
      expect(maskForbiddenSentenceInContent(value, banned, matcher)).toBe(maskForbiddenSentenceInContent(value, banned));
    }
  });

  it('문맥에 따라 소문자가 달라지는 원문도 기존과 같이 가린다', () => {
    const banned = ['ΑΒΓΔΕΖΗΣ'];
    const text = 'ΑΒΓΔΕΖΗΣΑ';
    const matcher = createForbiddenSentenceMatcher(banned);
    expect(hasForbiddenSentenceOverlap(text, banned)).toBe(true);
    expect(matcher(text)).toBe(true);
    expect(maskForbiddenSentenceInContent(text, banned, matcher)).toBe('[인용 금지 문장]');
  });

  it('기준 판의 판정과 긴 목록 및 고정 씨앗 경계 입력에서 일치한다', () => {
    let seed = 173;
    const random = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const alphabet = [...'가나다라마바사아자차 ABCDefghΣΟΣİ.()\n\t'];
    const makeText = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join('');
    const banned = Array.from({ length: 180 }, (_, index) => `${makeText(12 + random(28))} 문장${index}`);
    banned.push('ABCDEFGH', 'ABCDEFG', 'ABCDEFGHI', 'ΑΒΓΔΕΖΗΣ', ' 앞뒤 공백\n가나다라마바사아 ', '안전        공백');
    const matcher = createForbiddenSentenceMatcher(banned);
    const inputs = ['', '        ', 'ABCDEFG', 'abcdefgh', 'xABCDEFGHy', 'ABCDEFGH\n',
      'ΑΒΓΔΕΖΗΣΑ', '가나다라\n마바사아', '무관한 문장'];
    for (let index = 0; index < 600; index++) {
      const source = banned[random(banned.length)];
      const start = random(Math.max(1, source.length - 9));
      const segment = source.slice(start, start + 7 + random(4));
      inputs.push(index % 3 === 0 ? makeText(30) : `${makeText(3)}${index % 2 ? segment.toLowerCase() : segment}${makeText(4)}`);
    }
    for (const value of inputs) {
      const expected = previousOverlap(value, banned);
      expect(hasForbiddenSentenceOverlap(value, banned), JSON.stringify(value)).toBe(expected);
      expect(matcher(value), JSON.stringify(value)).toBe(expected);
    }
  });

});
