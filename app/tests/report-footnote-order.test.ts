import { describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TemplateSections } from '../src/app/projects/[projectId]/report/template-sections';
import { EvidencePanel } from '../src/app/projects/[projectId]/report/report-client-view';
import type { ReportDraftData, ReportSentenceItem } from '../src/server/report/types';

describe('보고서 화면 각주 번호 대응', () => {
  it('문장 superscript 순서와 각주 목록의 번호-근거 대응을 보존한다', () => {
    const html = renderToStaticMarkup(createElement(TemplateSections, {
      draft: {
        footnotes: [
          { number: 1, evidence_id: 'ev-a', document_name: '가상 자료 A', location: '1쪽' },
          { number: 2, evidence_id: 'ev-b', document_name: '가상 자료 B', location: '2쪽' },
        ],
        report_sections: [{
          id: 'footnote-order',
          title: '가상 절',
          level: 1,
          sentences: [{
            indicator_id: 'fixture-indicator',
            indicator_name: '가상 지표',
            sentence: '가상 문장',
            evidence_id: 'ev-b',
            evidence_ids: ['ev-b', 'ev-a'],
          }],
        }],
      } as any,
      onSelect: () => {},
    }));

    const firstRef = html.indexOf('<sup>[2]</sup>');
    const secondRef = html.indexOf('<sup>[1]</sup>');
    expect(firstRef).toBeGreaterThanOrEqual(0);
    expect(secondRef).toBeGreaterThan(firstRef);

    const footnoteList = html.slice(html.indexOf('근거 각주'));
    expect(footnoteList).toContain('[1] 가상 자료 A · 1쪽');
    expect(footnoteList).toContain('[2] 가상 자료 B · 2쪽');
    expect(footnoteList.indexOf('[1] 가상 자료 A · 1쪽')).toBeLessThan(footnoteList.indexOf('[2] 가상 자료 B · 2쪽'));
  });

  it('신형 저장본 표 각주를 누르면 저장된 근거를 선택하고 패널에 보여준다', () => {
    const draft = {
      version: 2, summary_format: 1,
      footnotes: [{ number: 1, evidence_id: 'ev', quote: '가상 근거 원문', document_name: '가상 자료', location: '1쪽', review_status: '확정', confirmer_role: '평가팀', confirmed_at: '2026-01-01' }],
      report_sections: [{ id: 'overview', title: '가상 절', level: 1, table: { columns: ['항목'], rows: [[{ text: '가상 값', source: 'ai', evidence_ids: ['ev'] }]] } }],
    } as unknown as ReportDraftData;
    const onSelect = vi.fn();
    const root = TemplateSections({ draft, onSelect });
    const buttons: Array<{ onClick: () => void; testId?: string }> = [];
    const visit = (node: ReactNode): void => {
      Children.forEach(node, child => {
        if (!isValidElement(child)) return;
        const props = child.props as { children?: ReactNode; onClick?: () => void; 'data-testid'?: string };
        if (child.type === 'button' && props.onClick) buttons.push({ onClick: props.onClick, testId: props['data-testid'] });
        if (props.children) visit(props.children);
      });
    };
    visit(root);
    const footnote = buttons.find((button) => button.testId === 'report-footnote-1');
    expect(footnote).toBeDefined();
    footnote!.onClick();
    const selected = onSelect.mock.calls[0][0] as ReportSentenceItem;
    expect(selected.evidence_ids).toEqual(['ev']);
    const panel = renderToStaticMarkup(createElement(EvidencePanel, { projectId: 'virtual', sentence: selected, allowSnapshot: draft.summary_format === 1 }));
    for (const value of ['report-evidence-panel', '가상 근거 원문', '가상 자료', '확정', '평가팀', '2026-01-01']) expect(panel).toContain(value);
    expect(panel).not.toContain('outdated-evidence-panel-notice');
  });
});
