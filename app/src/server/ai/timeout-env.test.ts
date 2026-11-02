import { describe, expect, it } from 'vitest';
import { timeoutFromEnv } from '@/server/ai/client';

describe('timeoutFromEnv', () => {
  it('uses the fallback when unset, blank or invalid', () => {
    for (const raw of [undefined, '', '  ', 'abc', '0', '-5', '999', '1.5', '3600001']) expect(timeoutFromEnv(raw, 180_000), String(raw)).toBe(180_000);
  });
  it('accepts whole milliseconds within range', () => {
    expect(timeoutFromEnv('300000', 180_000)).toBe(300_000);
    expect(timeoutFromEnv(' 900000 ', 300_000)).toBe(900_000);
  });
});
