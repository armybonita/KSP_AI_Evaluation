import { describe, expect, it } from 'vitest';
import { paragraphsPerRequestFromEnv } from '@/server/ontology/generator';

describe('paragraphsPerRequestFromEnv', () => {
  it('falls back to 30 when unset or invalid', () => {
    for (const raw of [undefined, '', ' ', 'x', '0', '-1', '2.5', '201']) expect(paragraphsPerRequestFromEnv(raw), String(raw)).toBe(30);
  });
  it('accepts whole numbers from 1 to 200', () => {
    expect(paragraphsPerRequestFromEnv('8')).toBe(8);
    expect(paragraphsPerRequestFromEnv(' 200 ')).toBe(200);
  });
});
