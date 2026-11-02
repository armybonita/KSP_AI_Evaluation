import { describe, expect, it } from 'vitest';
import { safeErrorCode, safeOntologyError } from '@/server/ontology/error-safety';

describe('network error reporting', () => {
  it('keeps machine error codes and nothing else', () => {
    const timeout = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    expect(safeErrorCode(timeout)).toBe('UND_ERR_HEADERS_TIMEOUT');
    expect(safeOntologyError(timeout).message).toBe('내부 처리 중 예외가 발생했습니다. (UND_ERR_HEADERS_TIMEOUT)');
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'secret value here' }))).toBeUndefined();
    expect(safeErrorCode(null)).toBeUndefined();
  });
});
