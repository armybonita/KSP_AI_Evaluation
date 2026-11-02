import { describe, expect, it } from 'vitest';
import { loginRedirectLocation, loginRedirectUrl } from '../src/lib/login-redirect';

describe('login redirect', () => {
  it('retains the requested path for configured and empty base paths', () => {
    expect(loginRedirectLocation('/app', '/app/projects')).toBe('/oauth2/start?rd=%2Fapp%2Fprojects');
    expect(loginRedirectLocation('/app/', '/app/projects')).toBe('/oauth2/start?rd=%2Fapp%2Fprojects');
    expect(loginRedirectLocation('', '/projects?view=one')).toBe('/oauth2/start?rd=%2Fprojects%3Fview%3Done');
  });
  it.each(['//evil.example/path', 'https://evil.example/', '/\\evil.example', '/%2f%2fevil.example', '/other'])('rejects unsafe or out-of-base rd %s', (rd) => {
    expect(loginRedirectLocation('/app', rd)).toBe('/oauth2/start?rd=%2Fapp%2Fprojects');
  });
  it('accepts only a syntactically valid request host', () => {
    const location = loginRedirectLocation('/app', '/app/projects');
    expect(loginRedirectUrl('example.test:443', 'https:', location)).toBe('https://example.test/oauth2/start?rd=%2Fapp%2Fprojects');
    expect(loginRedirectUrl('example.test', 'https:', location)).toBe('https://example.test/oauth2/start?rd=%2Fapp%2Fprojects');
    for (const host of [['evil.test', 'valid.test'].join('@'), 'valid.test/path', 'valid.test\r\nLocation: https://evil.test', 'valid.test,evil.test']) expect(loginRedirectUrl(host, 'https:', location)).toBeNull();
  });
});
