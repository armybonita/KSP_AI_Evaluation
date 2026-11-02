const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);
const SAFE_MESSAGES = new Set([
  '사업을 찾을 수 없습니다.',
  '생성 실행을 찾을 수 없습니다.',
  'frontmatter must be a mapping',
]);

/** Exposes only reviewed internal diagnostics; arbitrary exception text may contain source or credentials. */
/** Machine error codes such as UND_ERR_HEADERS_TIMEOUT carry no data and say why a call died. */
export function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

export function safeOntologyError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
  const message = error instanceof Error ? error.message : '';
  const idRule = /^온톨로지 ID 생성 규칙 불일치: (activity|output|indicator|outcome-short|outcome-mid|enabler|constraint)$/.exec(message);
  const code = safeErrorCode(error);
  const safeMessage = SAFE_MESSAGES.has(message) ? message : idRule ? idRule[0] : `내부 처리 중 예외가 발생했습니다.${code ? ` (${code})` : ''}`;
  return { name, message: safeMessage.replace(/[\r\n]+/g, ' ').slice(0, 200) };
}
