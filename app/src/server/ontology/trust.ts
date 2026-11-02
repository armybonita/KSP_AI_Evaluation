import { checkNumericConsistency } from '@/server/numeric-check';
import { normalizeForQuoteMatch, verifyQuote } from '@/server/quote-verify';

/**
 * Returns the percentage of quote bigrams also present in the source paragraph.
 * Repeated bigrams are counted as a multiset, so each quote bigram contributes
 * at most once to the overlap for its corresponding occurrence.
 */
export function quoteBigramCoverage(quote: string, paragraphContent: string): number {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  const normalizedParagraph = normalizeForQuoteMatch(paragraphContent);
  const quoteCodepoints = Array.from(normalizedQuote);

  if (quoteCodepoints.length < 2) {
    return verifyQuote(quote, paragraphContent) ? 100 : 0;
  }

  // A well-formed exact substring contains every quote bigram at least as
  // often as the quote does. Lone surrogates can match inside a pair at the
  // UTF-16 level, so retain the full codepoint calculation for those inputs.
  const hasUnpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(normalizedQuote);
  if (!hasUnpairedSurrogate && normalizedParagraph.includes(normalizedQuote)) return 100;

  const quoteGrams = makeBigramCounts(quoteCodepoints);
  const paragraphGrams = makeBigramCounts(Array.from(normalizedParagraph));
  let overlap = 0;

  for (const [gram, quoteCount] of quoteGrams) {
    overlap += Math.min(quoteCount, paragraphGrams.get(gram) ?? 0);
  }

  return Math.round((overlap / (quoteCodepoints.length - 1)) * 100);
}

export type EvidenceSufficiencyLabel = '높음' | '보통' | '낮음' | '해당 없음' | '[확인 필요]';

export interface EvidenceSufficiencyResult {
  label: EvidenceSufficiencyLabel;
  reason: string;
}

export interface EvidenceSufficiencyRecord {
  evidence_level?: unknown;
  /** Importer alias for the original `evidence_level` value. */
  level?: unknown;
  /** Speaker is retained for display, but does not establish document authorship. */
  speaker?: unknown;
  /** Original author identity when the source data actually records it. */
  author?: unknown;
}

const EVIDENCE_LEVELS = new Set(['입증', '관측', '추정', '예견']);

/** Applies the codeable evidence-combination rules from R05 section 4. */
export function assessEvidenceSufficiency(
  evidences: ReadonlyArray<EvidenceSufficiencyRecord>
): EvidenceSufficiencyResult {
  if (evidences.length === 0) {
    return { label: '해당 없음', reason: '연결된 근거가 없습니다.' };
  }

  const levels = evidences.map((evidence) => evidence.evidence_level ?? evidence.level);
  const provenCount = levels.filter((level) => level === '입증').length;
  if (provenCount > 0) {
    return { label: '높음', reason: `입증 근거가 ${provenCount}건 있습니다.` };
  }

  if (levels.some((level) => typeof level !== 'string' || !EVIDENCE_LEVELS.has(level))) {
    return { label: '[확인 필요]', reason: '근거의 진술 성격이 없거나 정해진 값이 아닙니다.' };
  }

  const observationalRecords = evidences.filter((evidence, index) => levels[index] === '관측');
  if (observationalRecords.length === 0) {
    return { label: '낮음', reason: '근거가 추정 또는 예견에 한정됩니다.' };
  }
  if (observationalRecords.length === 1) {
    return { label: '보통', reason: '관측 근거가 1건 있습니다.' };
  }

  const authorNames = observationalRecords
    .map(({ author }) => author)
    .filter((author): author is string => typeof author === 'string' && author.trim().length > 0);
  if (authorNames.length !== observationalRecords.length) {
    return { label: '[확인 필요]', reason: '관측 근거의 원문 작성 주체 정보가 없어 서로 다른 작성자인지 확인할 수 없습니다.' };
  }
  const distinctAuthors = new Set(authorNames.map((author) => author.trim()));
  if (distinctAuthors.size >= 2) {
    return {
      label: '높음',
      reason: `서로 다른 작성 주체의 관측 근거가 ${observationalRecords.length}건 있습니다.`,
    };
  }

  return { label: '보통', reason: '관측 근거가 여러 건이나 같은 작성 주체의 자료입니다.' };
}

export type ManualNumericWarning =
  | { level: 'L1'; unmatchedTokens: string[] }
  | { level: '[확인 필요]'; reason: string };

/** Reports numeric mismatches for caller-classified manual or imported text. */
export function getManualNumericWarning(
  sentence: string,
  quotes: string | string[]
): ManualNumericWarning | null {
  const quoteList = (Array.isArray(quotes) ? quotes : [quotes]).filter((quote) => quote.trim().length > 0);
  if (quoteList.length === 0) {
    const result = checkNumericConsistency(sentence, []);
    return result.unmatchedTokens.length
      ? { level: '[확인 필요]', reason: '대조할 수 있는 원문 인용이 없습니다.' }
      : null;
  }

  const result = checkNumericConsistency(sentence, quoteList);
  return result.passed ? null : { level: 'L1', unmatchedTokens: result.unmatchedTokens };
}

function makeBigramCounts(codepoints: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < codepoints.length - 1; index++) {
    const gram = `${codepoints[index]}${codepoints[index + 1]}`;
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
