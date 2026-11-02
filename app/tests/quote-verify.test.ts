import { describe, expect, it } from 'vitest';
import {
  normalizeForQuoteMatch,
  verifyQuote,
  verifyEvidencesAndResolveVerdict,
} from '../src/server/quote-verify';

describe('인용 대조 단위 시험 (RQ-11, D11)', () => {
  it('따옴표와 공백이 정규화되어 일치 여부를 대조한다', () => {
    const rawParagraph = '담당관은 “가상국 디지털 행정 혁신”을 적극 추진하겠다고 밝혔다.';
    const rawQuote = '"가상국   디지털  행정  혁신"';

    expect(normalizeForQuoteMatch(rawParagraph)).toBe(
      '담당관은 "가상국 디지털 행정 혁신"을 적극 추진하겠다고 밝혔다.'
    );
    expect(normalizeForQuoteMatch(rawQuote)).toBe('"가상국 디지털 행정 혁신"');
    expect(verifyQuote(rawQuote, rawParagraph)).toBe(true);
  });

  it('원문에 존재하는 인용문은 대조를 통과한다', () => {
    const paragraph = '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';
    const quote = '핵심 공무원 500명 이수 완료 달성';

    expect(verifyQuote(quote, paragraph)).toBe(true);
  });

  it('원문에 없는 지어낸 인용문은 대조에 실패한다', () => {
    const paragraph = '핵심 공무원 500명 이수 완료 달성을 현장에서 확인하였음.';
    const fakeQuote = '핵심 공무원 1,000명 전원 수료 완료';

    expect(verifyQuote(fakeQuote, paragraph)).toBe(false);
  });

  it('지어낸 근거 하나뿐인 지표는 근거가 버려지고 판정이 미확인으로 강등된다', () => {
    const mockParagraphs: Record<string, string> = {
      'doc-1#¶1': '사업 목적은 공공 데이터 연계에 있다.',
    };

    const lookup = (docId: string, loc: string) => mockParagraphs[`${docId}#${loc}`];

    const result = verifyEvidencesAndResolveVerdict(
      [
        {
          quote: '완전히 지어낸 허위 인용문입니다',
          document_id: 'doc-1',
          location: '¶1',
          speaker: 'KDI',
        },
      ],
      '실현',
      lookup
    );

    expect(result.passedEvidences.length).toBe(0);
    expect(result.discardedEvidences.length).toBe(1);
    expect(result.finalVerdictStatus).toBe('미확인');
  });

  it('통과 근거와 지어낸 근거가 혼합된 경우 지어낸 근거만 버리고 판정은 유지된다', () => {
    const mockParagraphs: Record<string, string> = {
      'doc-1#¶1': '통합 플랫폼 1식 개발 완료 및 검수 통과 확인됨.',
    };

    const lookup = (docId: string, loc: string) => mockParagraphs[`${docId}#${loc}`];

    const result = verifyEvidencesAndResolveVerdict(
      [
        {
          quote: '통합 플랫폼 1식 개발 완료',
          document_id: 'doc-1',
          location: '¶1',
          speaker: '수행기관',
        },
        {
          quote: '지어낸 가짜 인용문',
          document_id: 'doc-1',
          location: '¶1',
          speaker: '협력국',
        },
      ],
      '실현',
      lookup
    );

    expect(result.passedEvidences.length).toBe(1);
    expect(result.passedEvidences[0].quote).toBe('통합 플랫폼 1식 개발 완료');
    expect(result.discardedEvidences.length).toBe(1);
    expect(result.discardedEvidences[0].quote).toBe('지어낸 가짜 인용문');
    // 통과 근거가 남아있으므로 원래 판정 '실현' 유지!
    expect(result.finalVerdictStatus).toBe('실현');
  });
});
