import { describe, expect, it } from 'vitest';
import { getAiDocumentEligibilityForProvider } from './ai-eligibility';
import { AiClient } from '../ai/client';

describe('AI document eligibility', () => {
  it('accepts the legacy migration defaults', () => {
    expect(getAiDocumentEligibilityForProvider({ masked: true, approved_ai: 'solar', is_past_final_report: false }, 'solar'))
      .toEqual({ eligible: true, reasons: [] });
  });

  it('reports every D66 exclusion reason', () => {
    expect(getAiDocumentEligibilityForProvider({ masked: false, approved_ai: 'none', is_past_final_report: true }, 'solar'))
      .toEqual({ eligible: false, reasons: ['개인정보 마스킹 미완료', 'AI 사용 미승인', '과거 종료평가보고서'] });
  });

  it('compares approved_ai to the actual destination and fails closed when unknown', () => {
    const doc = { masked: true, approved_ai: 'local-only', is_past_final_report: false };
    expect(getAiDocumentEligibilityForProvider(doc, 'solar').reasons).toContain('제외: approved_ai=local-only ≠ solar');
    expect(getAiDocumentEligibilityForProvider(doc, 'local-only').eligible).toBe(true);
    expect(getAiDocumentEligibilityForProvider({ ...doc, approved_ai: 'solar' }, 'solar').eligible).toBe(true);
    for (const provider of [null, undefined, '', '   ']) {
      expect(getAiDocumentEligibilityForProvider({ ...doc, approved_ai: 'solar' }, provider as string | null).reasons).toContain('제외: AI 제공자 확인 불가');
    }
  });

  it('accepts a solar-approved document through a non-fake AiClient provider path', () => {
    const previousProvider = process.env.AIEAS_AI_PROVIDER;
    try {
      delete process.env.AIEAS_AI_PROVIDER;
      const client = new AiClient({ baseUrl: 'https://example.invalid', apiKey: 'dummy', model: 'solar-pro2' });
      expect(client.provider).toBe('solar');
      expect(getAiDocumentEligibilityForProvider({ masked: true, approved_ai: 'solar', is_past_final_report: false }, client.provider).eligible).toBe(true);
    } finally {
      if (previousProvider === undefined) delete process.env.AIEAS_AI_PROVIDER;
      else process.env.AIEAS_AI_PROVIDER = previousProvider;
    }
  });

  it('respects an explicit current-project flag on a final-report type, and blocks it when unanswered', () => {
    expect(getAiDocumentEligibilityForProvider({ masked: true, approved_ai: 'solar', is_past_final_report: false, doc_type: '종료평가보고서' }, 'solar'))
      .toEqual({ eligible: true, reasons: [] });
    expect(getAiDocumentEligibilityForProvider({ masked: true, approved_ai: 'solar', is_past_final_report: null, doc_type: '종료평가보고서' }, 'solar').eligible)
      .toBe(false);
  });

  it('fails closed when past-report status is unknown', () => {
    expect(getAiDocumentEligibilityForProvider({ masked: true, approved_ai: 'solar' }, 'solar'))
      .toEqual({ eligible: false, reasons: ['과거 종료평가보고서 여부 미확인'] });
  });
});
