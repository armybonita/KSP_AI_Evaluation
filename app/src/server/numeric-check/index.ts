export interface NumericCheckResult {
  passed: boolean;
  unmatchedTokens: string[];
}

/**
 * 문장에서 숫자 및 숫자+단위 표현을 추출한다.
 * 예: 80%, 3.5점, 100명, 10건, 24시간, 10억원, 2회 등
 */
export function extractNumericTokens(text: string): string[] {
  // 숫자(정수, 쉼표 천 단위 구분, 소수점) + 뒤따르는 단위(한글, 기호, 영문 등)
  // 쉼표는 바로 뒤에 정확히 숫자 세 자리가 오고 그 뒤가 숫자가 아닐 때만 천 단위 구분자로 본다.
  const regex = /(?<![\d.]|\d,(?=\d{3}(?!\d)))(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?\s*(?:[%점명건개회차호원년월일분초배억만천A-Za-z]+)?/g;
  const matches = text.match(regex);
  return matches ? matches.map((m) => m.trim()) : [];
}

/**
 * RQ-12, D03: AI 문장의 수치·단위가 그 문장의 인용 원문에 그대로 없으면 그 문장을 버린다(코드 검사).
 * 숫자 토큰 경계를 엄격히 지켜 숫자+단위를 토큰 단위로 대조한다.
 * 쉼표는 바로 뒤에 정확히 숫자 세 자리가 오고 그 뒤가 숫자가 아닐 때만 천 단위 구분자로 본다.
 * 그 밖의 쉼표 뒤 숫자는 별개 숫자 토큰으로 검사한다.
 */
export function checkNumericConsistency(
  sentence: string,
  quotes: string | string[]
): NumericCheckResult {
  const quoteList = Array.isArray(quotes) ? quotes : [quotes];
  const tokens = extractNumericTokens(sentence);
  const unmatchedTokens: string[] = [];

  for (const token of tokens) {
    const match = token.match(/^((?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?)\s*(.*)$/);
    if (!match) continue;

    const [, num, unit] = match;
    const escapedNum = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedUnit = unit ? unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

    // 토큰 경계: 앞은 숫자/소수점/천단위구분자쉼표 뒤가 아니어야 하고, 뒤는 숫자/소수점/천단위구분자쉼표 앞이 아니어야 함
    const tokenRegex = new RegExp(
      `(?<![\\d.]|\\d,(?=\\d{3}(?!\\d)))${escapedNum}(?![\\d.]|,\\d{3}(?!\\d))\\s*${escapedUnit}`
    );

    const foundInAnyQuote = quoteList.some((quote) => tokenRegex.test(quote));

    if (!foundInAnyQuote) {
      unmatchedTokens.push(token);
    }
  }

  return {
    passed: unmatchedTokens.length === 0,
    unmatchedTokens,
  };
}
