import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/server/ai/types';
import { fitJudgmentRequest, JUDGMENT_MAX_REQUEST_BYTES } from './synthesis-request';

const measure = (messages: ChatMessage[]) => Buffer.byteLength(JSON.stringify({ model: '가상 모델', messages, reasoning_effort: 'low', response_format: { type: 'json_object' } }), 'utf8');
const makeTask = (id: string, quoteLength = 800) => ({ payload: { group: { id, name: '가상 항목', nodes: Array.from({ length: 8 }, (_, i) => ({ id: `${id}-${i}`, title: '긴 제목'.repeat(100), evidence: [{ id: `p-${i}`, quote: '가상"근거'.repeat(quoteLength) }] })) } } });

describe('판정 요청 크기', () => {
  it('전체 전송 JSON의 바이트 크기로 그룹을 나누고 남은 그룹을 다음 요청으로 보낸다', () => {
    const pending = Array.from({ length: 5 }, (_, i) => makeTask(`g-${i}`, 50));
    const sent: string[] = [];
    let calls = 0;
    while (pending.length) {
      const fitted = fitJudgmentRequest(pending, 4, '판정 지침', measure);
      expect(measure(fitted.messages)).toBeLessThanOrEqual(JUDGMENT_MAX_REQUEST_BYTES);
      sent.push(...fitted.included.map(t => t.payload.group.id));
      pending.splice(0, pending.length, ...fitted.overflow);
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(sent).toEqual(['g-0', 'g-1', 'g-2', 'g-3', 'g-4']);
  });

  it('단일 그룹이 너무 크면 제목을 120자로 자르고 인용을 줄여 제한을 지킨다', () => {
    const original = makeTask('g');
    const fitted = fitJudgmentRequest([original], 4, '판정 지침', measure);
    expect(measure(fitted.messages)).toBeLessThanOrEqual(JUDGMENT_MAX_REQUEST_BYTES);
    const nodes = fitted.included[0].payload.group.nodes;
    expect(nodes.every(node => [...node.title].length <= 120)).toBe(true);
    expect(nodes.flatMap(node => node.evidence).length).toBeLessThan(8);
    expect(original.payload.group.nodes).toHaveLength(8);
  });

  it('인용을 모두 빼도 크기 한도를 맞출 수 없는 요청은 보내지 않고 실패한다', () => {
    const task = { payload: { ...makeTask('g', 1).payload, indicator: { target: '가'.repeat(20_000) } } };
    expect(() => fitJudgmentRequest([task], 4, '판정 지침', measure)).toThrow('판정 요청이 크기 한도를 초과했습니다.');
  });
});
