import { VerdictStatus } from '../store/types';

export function normalizeForQuoteMatch(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B`']/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F«»"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function verifyQuote(quote: string, paragraphContent: string): boolean {
  const normQuote = normalizeForQuoteMatch(quote);
  const normPara = normalizeForQuoteMatch(paragraphContent);

  if (normQuote.length === 0 || normPara.length === 0) {
    return false;
  }

  return normPara.includes(normQuote);
}

export interface VerifyEvidenceItem {
  quote: string;
  document_id: string;
  location: string;
  speaker: string;
}

export interface QuoteVerificationResult<T extends VerifyEvidenceItem> {
  passedEvidences: T[];
  discardedEvidences: T[];
  finalVerdictStatus: VerdictStatus;
}

export function verifyEvidencesAndResolveVerdict<T extends VerifyEvidenceItem>(
  evidences: T[],
  currentVerdict: VerdictStatus,
  lookupParagraph: (documentId: string, location: string) => string | undefined
): QuoteVerificationResult<T> {
  const passedEvidences: T[] = [];
  const discardedEvidences: T[] = [];

  for (const ev of evidences) {
    const paraContent = lookupParagraph(ev.document_id, ev.location);
    if (paraContent && verifyQuote(ev.quote, paraContent)) {
      passedEvidences.push(ev);
    } else {
      discardedEvidences.push(ev);
    }
  }

  // RQ-11, D11: 대조에 통과한 근거가 하나도 남지 않을 때에만 해당 판정을 "미확인"으로 내린다.
  // 통과하는 근거와 지어낸 근거를 함께 넣은 시험에서는 지어낸 근거만 버려지고 판정은 유지된다.
  const finalVerdictStatus: VerdictStatus =
    passedEvidences.length === 0 ? '미확인' : currentVerdict;

  return {
    passedEvidences,
    discardedEvidences,
    finalVerdictStatus,
  };
}
