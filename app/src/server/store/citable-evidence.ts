import { verifyQuote } from '../quote-verify';
import { isEvidenceCitationBanned, type ForbiddenSentenceIndex } from './citation-ban';

/** 보고서와 초기 ToC가 같은 인용 자격을 적용한다. */
export function isCitableEvidence(
  evidence: { quote: string; speaker: string; is_citation_banned?: number },
  paragraphContent: string | null | undefined,
  bannedSentences: string[],
  bannedIndex?: ForbiddenSentenceIndex,
): boolean {
  return !isEvidenceCitationBanned(evidence, bannedSentences, bannedIndex) &&
    paragraphContent != null && verifyQuote(evidence.quote, paragraphContent);
}
