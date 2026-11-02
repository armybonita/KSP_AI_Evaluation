import { describe, expect, it } from 'vitest';
import { hasProposalContent, safeDiagnosticSummary } from '../scripts/resuggest-smoke-assertions.cjs';
import { normalizeBaseUrl } from '../scripts/verify-resuggest.cjs';

describe('Solar 재제안 smoke 판정', () => {
  it('장식 따옴표와 공백만 있는 제안을 빈 제안으로 거부한다', () => {
    expect(hasProposalContent('“   ”')).toBe(false);
    expect(hasProposalContent('  "\'  ')).toBe(false);
  });

  it('실제 제안 문장은 따옴표를 제거한 뒤 내용이 있는 것으로 판정한다', () => {
    expect(hasProposalContent(' “제안 문장입니다.” ')).toBe(true);
  });
});

describe('재제안 smoke base URL 제한', () => {
  // public-safety-allow: test title documents the loopback-only accepted address
  it('정규화된 127.0.0.1 HTTP URL을 허용하고 trailing slash를 제거한다', () => {
    // public-safety-allow: fixture covers the accepted loopback-only URL
    expect(normalizeBaseUrl('http://127.0.0.1:33331/')).toBe('http://127.0.0.1:33331');
  });

  it.each([
    'http://localhost:33331',
    'http://[::1]:33331',
    'http://example.com:33331',
    // public-safety-allow: fixture proves HTTPS loopback is rejected
    'https://127.0.0.1:33331',
  ])('%s는 입력 URL을 노출하지 않고 거부한다', (value) => {
    let thrown: unknown;
    try {
      normalizeBaseUrl(value);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // public-safety-allow: expected diagnostic names the accepted local-only host
    expect((thrown as Error).message).toBe('expected plain HTTP on 127.0.0.1');
    expect((thrown as Error).message).not.toContain(value);
  });
});

describe('safeDiagnosticSummary', () => {
  it('Korean timeout diagnostics map to the same safe category as suggestion failures', () => {
    expect(safeDiagnosticSummary('AI 게이트웨이 타임아웃 오류')).toBe('operation timed out');
  });

  it('reports a safe category when evidence validation removes a proposal', () => {
    expect(safeDiagnosticSummary('제안 문장이 근거 수치 검증을 통과하지 못했습니다')).toBe(
      'proposal failed numeric evidence validation'
    );
  });

  it('suppresses numeric values and raw error text, even when they resemble diagnostic fields', () => {
    const summary = safeDiagnosticSummary(
      'AI 응답 JSON 파싱 실패: private-response-fragment Bearer secret-token ' +
        '(finish_reason=stop, completion_tokens=123456, reasoning_tokens=337, HTTP=503)'
    );

    expect(summary).toBe('AI JSON parse failed');
    expect(safeDiagnosticSummary(summary)).toBe(summary);
    expect(summary).not.toContain('private-response-fragment');
    expect(summary).not.toContain('secret-token');
    expect(summary).not.toContain('123456');
  });
});
