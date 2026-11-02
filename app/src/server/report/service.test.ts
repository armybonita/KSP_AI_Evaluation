import { describe, expect, it } from 'vitest';
import type { DocumentRecord, ReportTargetIndicator } from '../store/types';
import {
  computeReportFingerprint,
  filterReportTargetsByDocumentInclusion,
  filterReportTargetsForAi as filterForProvider,
  getReportInclusionExclusions,
} from './service';

function document(id: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id,
    project_id: 'fake-project',
    file_name: `${id}.docx`,
    file_type: 'docx',
    status: '추출 완료',
    doc_type: '기타',
    is_included: 1,
    excluded_reason: null,
    masked: true,
    approved_ai: 'solar',
    is_past_final_report: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function target(id: string, sourceId: string | undefined, evidenceIds: string[]): ReportTargetIndicator {
  return {
    indicator: { id, source_doc_id: sourceId, name: `지표 ${id}` } as ReportTargetIndicator['indicator'],
    evidences: evidenceIds.map((document_id) => ({ document_id })) as ReportTargetIndicator['evidences'],
    latestConfirmation: {} as ReportTargetIndicator['latestConfirmation'],
    confirmedText: '가상 확인 문장',
    verdictStatus: '실현',
    isUnverifiedVerdict: false,
  };
}


const filterReportTargetsForAi = (targets: ReportTargetIndicator[], documents: DocumentRecord[]) => filterForProvider(targets, documents, 'solar');

describe('report AI document eligibility', () => {
  it('records a target with no verified evidence as excluded from AI input', () => {
    const item = target('no-evidence', 'approved', []);
    const result = filterReportTargetsForAi([item], [document('approved')]);
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toEqual([{ subject: '지표 no-evidence', reasons: ['검증 통과 근거 없음'] }]);
    const ineligibleSource = filterReportTargetsForAi([item], [document('approved', { masked: false })]);
    expect(ineligibleSource.eligibleTargets).toEqual([]);
    expect(ineligibleSource.exclusions).toEqual([
      { subject: '지표 no-evidence', reasons: ['검증 통과 근거 없음'] },
      { subject: 'approved.docx', reasons: ['개인정보 마스킹 미완료'] },
    ]);
  });

  it('excludes a source when its approved provider differs or is unknown', () => {
    const item = target('provider', 'source', ['source']);
    expect(filterForProvider([item], [document('source', { approved_ai: 'local-only' })], 'solar').exclusions)
      .toEqual([{ subject: 'source.docx', reasons: ['제외: approved_ai=local-only ≠ solar'] }]);
    expect(filterForProvider([item], [document('source')], null).eligibleTargets).toEqual([]);
    expect(filterForProvider([item], [document('source', { approved_ai: 'local-only' })], 'local-only').eligibleTargets).toEqual([item]);
  });

  it('excludes an unprovenanced indicator from AI input even with eligible evidence', () => {
    const noSource = target('no-source', undefined, ['approved']);
    const approved = target('approved', 'approved', ['approved']);
    const result = filterReportTargetsForAi([noSource, approved], [document('approved')]);
    expect(result.eligibleTargets.map((item) => item.indicator.id)).toEqual(['approved']);
    expect(result.exclusions).toContainEqual({ subject: '지표 no-source', reasons: ['지표 원문 출처 문서 확인 불가'] });
  });

  it('drops the whole target if any evidence is ineligible and records its reason', () => {
    const result = filterReportTargetsForAi(
      [target('eligible', 'approved', ['approved']), target('mixed', 'approved', ['approved', 'unmasked'])],
      [document('approved'), document('unmasked', { masked: false })]
    );
    expect(result.eligibleTargets.map((item) => item.indicator.id)).toEqual(['eligible']);
    expect(result.exclusions).toEqual([{ subject: 'unmasked.docx', reasons: ['개인정보 마스킹 미완료'] }]);
  });

  it('drops targets when source provenance is absent or cannot be resolved', () => {
    const result = filterReportTargetsForAi(
      [target('no-source', undefined, ['approved']), target('missing-source', 'missing', ['approved'])],
      [document('approved')]
    );
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toEqual([
      { subject: '지표 no-source', reasons: ['지표 원문 출처 문서 확인 불가'] },
      { subject: 'missing', reasons: ['원문 출처 문서를 확인할 수 없음'] },
    ]);
  });

  it('drops a target when any source document is absent from the project document index', () => {
    const result = filterReportTargetsForAi([target('missing-evidence', 'approved', ['unknown'])], [document('approved')]);
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toEqual([{ subject: 'unknown', reasons: ['근거 출처 문서를 확인할 수 없음'] }]);
  });

  it('drops the whole target when its indicator source was excluded', () => {
    const result = filterReportTargetsForAi(
      [target('excluded-indicator-source', 'excluded', ['approved'])],
      [document('excluded', { is_included: 0 }), document('approved')]
    );
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toEqual([{ subject: 'excluded.docx', reasons: ['평가자가 제외한 문서'] }]);
  });

  it('drops the whole target when any evidence source was excluded', () => {
    const result = filterReportTargetsForAi(
      [target('excluded-evidence', 'approved', ['approved', 'excluded'])],
      [document('approved'), document('excluded', { is_included: 0 })]
    );
    expect(result.eligibleTargets).toEqual([]);
    expect(result.exclusions).toEqual([{ subject: 'excluded.docx', reasons: ['평가자가 제외한 문서'] }]);
  });

  it('removes excluded-source targets from deterministic report content while retaining included documents that only fail AI eligibility', () => {
    const targets = [
      target('excluded', 'excluded', ['approved']),
      target('review-only', 'unmasked', ['unmasked']),
    ];
    const docs = [
      document('excluded', { is_included: 0 }),
      document('approved'),
      document('unmasked', { masked: false }),
    ];
    expect(filterReportTargetsByDocumentInclusion(targets, docs).map((item) => item.indicator.id))
      .toEqual(['review-only']);
    expect(getReportInclusionExclusions(targets, docs))
      .toEqual([{ subject: 'excluded.docx', reasons: ['평가자가 제외한 문서'] }]);
  });

  it('changes report fingerprints when source inclusion or AI eligibility changes', () => {
    const item = target('fingerprint', 'source', ['source']);
    const baseline = [document('source')];
    expect(computeReportFingerprint([item], [], baseline)).not.toBe(
      computeReportFingerprint([item], [], [document('source', { is_included: 0 })])
    );
    expect(computeReportFingerprint([item], [], baseline)).not.toBe(
      computeReportFingerprint([item], [], [document('source', { masked: false })])
    );
    expect(computeReportFingerprint([item], [], baseline)).not.toBe(
      computeReportFingerprint([item], [], [document('source', { approved_ai: 'none' })])
    );
    expect(computeReportFingerprint([item], [], baseline)).not.toBe(
      computeReportFingerprint([item], [], [document('source', { is_past_final_report: true })])
    );
  });
});
