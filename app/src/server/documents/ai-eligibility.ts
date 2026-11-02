import { isConfirmedNonPastReport } from './holdout';
import type { DocumentRecord } from '../store/types';

export type AiDocumentEligibilityInput = Pick<
  DocumentRecord,
  'masked' | 'approved_ai' | 'is_past_final_report'
> & Partial<Pick<DocumentRecord, 'doc_type'>>;

export interface AiDocumentEligibility {
  eligible: boolean;
  reasons: string[];
}

/** Shared D66 gate for document-derived AI inputs. */
function checkAiDocumentEligibility(
  document: AiDocumentEligibilityInput,
  provider?: string | null
): AiDocumentEligibility {
  const reasons: string[] = [];
  if (document.masked !== true) reasons.push('개인정보 마스킹 미완료');
  if (typeof document.approved_ai !== 'string' || document.approved_ai.trim() === '') {
    reasons.push('AI 사용 승인 정보 없음');
  } else if (document.approved_ai.trim().toLowerCase() === 'none') {
    reasons.push('AI 사용 미승인');
  }
  if (provider === null) reasons.push('제외: AI 제공자 확인 불가');
  else if (provider !== undefined && !provider) reasons.push('제외: AI 제공자 확인 불가');
  else if (provider !== undefined && (typeof document.approved_ai === 'string' && document.approved_ai.trim() && document.approved_ai.trim().toLowerCase() !== 'none' && document.approved_ai.trim().toLowerCase() !== provider)) {
    reasons.push(`제외: approved_ai=${document.approved_ai} ≠ ${provider}`);
  }
  if (!isConfirmedNonPastReport(document)) {
    reasons.push(document.is_past_final_report === true ? '과거 종료평가보고서' : '과거 종료평가보고서 여부 미확인');
  }
  return { eligible: reasons.length === 0, reasons };
}

export function getAiDocumentEligibility(document: AiDocumentEligibilityInput): AiDocumentEligibility {
  return checkAiDocumentEligibility(document);
}

export function getAiDocumentEligibilityForProvider(document: AiDocumentEligibilityInput, provider: string | null): AiDocumentEligibility {
  const normalized = typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : null;
  return checkAiDocumentEligibility(document, normalized);
}

export function isAiDocumentEligible(document: AiDocumentEligibilityInput, provider: string | null): boolean {
  return getAiDocumentEligibilityForProvider(document, provider).eligible;
}

/** Indexed-query equivalent of the shared eligibility gate for trusted internal table aliases. */
export function aiDocumentEligibilitySql(alias: string): string {
  return `(${alias}.masked = 1
    AND TRIM(COALESCE(${alias}.approved_ai, '')) <> ''
    AND LOWER(TRIM(${alias}.approved_ai)) <> 'none'
    AND ${alias}.is_past_final_report = 0
    AND ? IS NOT NULL
    AND LOWER(TRIM(${alias}.approved_ai)) = LOWER(TRIM(?)))`;
}
