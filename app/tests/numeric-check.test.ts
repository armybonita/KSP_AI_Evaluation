import { describe, expect, it } from 'vitest';
import { checkNumericConsistency, extractNumericTokens } from '../src/server/numeric-check';

describe('수치 검사 단위 시험 (RQ-12, D03)', () => {
  it('문장에서 숫자와 단위를 정확히 추출한다', () => {
    const text = '만족도 80% 달성, 5점 척도에서 3.5점을 획득하고 100만명 중 500명이 참여함';
    const tokens = extractNumericTokens(text);

    expect(tokens).toContain('80%');
    expect(tokens).toContain('5점');
    expect(tokens).toContain('3.5점');
    expect(tokens).toContain('100만명');
    expect(tokens).toContain('500명');
  });

  it('제안 문장의 모든 수치+단위가 인용 원문에 있으면 통과한다', () => {
    const sentence = '행정 시스템 만족도 80% 달성을 확인하였습니다.';
    const quote = '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.';

    const result = checkNumericConsistency(sentence, quote);
    expect(result.passed).toBe(true);
    expect(result.unmatchedTokens.length).toBe(0);
  });

  it('소수점이 포함된 점수 척도 수치도 정확하게 대조 통과한다', () => {
    const sentence = '설문조사 결과 5점 척도 기준 3.5점을 기록함.';
    const quote = '대국민 전자정부 서비스 체감 만족도 5점 척도 3.5점 달성을 설정함.';

    const result = checkNumericConsistency(sentence, quote);
    expect(result.passed).toBe(true);
    expect(result.unmatchedTokens.length).toBe(0);
  });

  it('원문에 없는 수치가 제안 문장에 포함되면 검사에 실패한다 (원문에 없는 수치 금지)', () => {
    const sentence = '행정 시스템 만족도가 85%에 도달한 것으로 판단됨.';
    const quote = '행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.';

    const result = checkNumericConsistency(sentence, quote);
    expect(result.passed).toBe(false);
    expect(result.unmatchedTokens).toContain('85%');
  });

  it('문장에 수치가 전혀 없는 경우 검사를 통과한다', () => {
    const sentence = '본 사업은 가상국 행정 효율화에 크게 기여한 것으로 판단됨.';
    const quote = '가상국 행정 업무 전산화 및 공공 데이터 연계를 목표로 한다.';

    const result = checkNumericConsistency(sentence, quote);
    expect(result.passed).toBe(true);
  });

  describe('숫자 토큰 경계 검사 (부분 문자열 오탐 방지)', () => {
    it('인용이 80%일 때 제안의 8%는 토큰 경계 불일치로 실패해야 한다', () => {
      const sentence = '만족도 8% 달성을 확인하였습니다.';
      const quote = '핵심 성과지표로서 행정 시스템 이용 만족도 80% 달성을 최종 목표로 설정한다.';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(false);
      expect(result.unmatchedTokens).toContain('8%');
    });

    it('인용이 15점일 때 제안의 5점은 앞 숫자 경계 불일치로 실패해야 한다', () => {
      const sentence = '평가 결과 5점을 획득함.';
      const quote = '사업 종합 평가 결과 총 15점을 획득한 것으로 확인됨.';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(false);
      expect(result.unmatchedTokens).toContain('5점');
    });

    it('인용이 13.5점일 때 제안의 3.5점은 앞 숫자 경계 불일치로 실패해야 한다', () => {
      const sentence = '설문조사 결과 3.5점을 기록함.';
      const quote = '서비스 체감도 지표에서 총 13.5점을 기록함.';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(false);
      expect(result.unmatchedTokens).toContain('3.5점');
    });

    it('정상 일치 수치(80%, 5점, 3.5점)는 정확히 통과한다', () => {
      const sentence = '만족도 80% 달성, 5점 척도에서 3.5점을 기록함.';
      const quote = '만족도 80% 달성, 5점 척도에서 3.5점을 기록함.';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(true);
      expect(result.unmatchedTokens).toHaveLength(0);
    });

    it("숫자 뒤 쉼표가 다음 숫자로 이어지지 않는 경우('3, 다음')에도 토큰 '3'이 일치한다", () => {
      const sentence = '3, 다음';
      const quote = '3, 다음';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(true);
      expect(result.unmatchedTokens).toHaveLength(0);
    });

    it("'1,000명' 대 '1,000명' 일치", () => {
      const sentence = '1,000명';
      const quote = '1,000명';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(true);
      expect(result.unmatchedTokens).toHaveLength(0);
    });

    it("'1,000명' 대 '1,0001명' 불일치", () => {
      const sentence = '1,000명';
      const quote = '1,0001명';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(false);
      expect(result.unmatchedTokens).toContain('1,000명');
    });

    it("'80%' 대 '8%' 불일치 유지", () => {
      // 1) 제안 8% vs 인용 80%
      const r1 = checkNumericConsistency('8%', '80%');
      expect(r1.passed).toBe(false);
      expect(r1.unmatchedTokens).toContain('8%');

      // 2) 제안 80% vs 인용 8%
      const r2 = checkNumericConsistency('80%', '8%');
      expect(r2.passed).toBe(false);
      expect(r2.unmatchedTokens).toContain('80%');
    });

    it("문장 '3,4' 인용 '3' 불일치 (4가 원문에 없음)", () => {
      const sentence = '3,4';
      const quote = '3';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(false);
      expect(result.unmatchedTokens).toContain('4');
    });

    it("문장 '3,4' 인용 '3,4' 일치", () => {
      const sentence = '3,4';
      const quote = '3,4';

      const result = checkNumericConsistency(sentence, quote);
      expect(result.passed).toBe(true);
      expect(result.unmatchedTokens).toHaveLength(0);
    });
  });
});
