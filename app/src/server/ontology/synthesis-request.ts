import type { ChatMessage } from '@/server/ai/types';

export const JUDGMENT_MAX_REQUEST_BYTES = 30_000;
type Quote = { id: string; quote: string };
type JudgmentPayload = { group: { id: string; name: string; nodes: Array<{ id: string; title: string; evidence: Quote[]; edges?: unknown[] }> }; indicator?: object };
type JudgmentTask = { payload: JudgmentPayload };

/** Fit complete serialized request bodies; omitted tasks are returned for subsequent calls. */
export function fitJudgmentRequest<T extends JudgmentTask>(tasks: T[], step: number, system: string, measure: (messages: ChatMessage[]) => number): { included: T[]; overflow: T[]; messages: ChatMessage[] } {
  const included = [...tasks];
  const overflow: T[] = [];
  const messages = (): ChatMessage[] => [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(included.length === 1 ? { step, ...included[0].payload } : { step, tasks: included.map(task => task.payload) }) }];
  while (included.length > 1 && measure(messages()) > JUDGMENT_MAX_REQUEST_BYTES) overflow.unshift(included.pop()!);
  if (included.length === 1 && measure(messages()) > JUDGMENT_MAX_REQUEST_BYTES) {
    const task = included[0];
    const nodes = task.payload.group.nodes.map(node => ({ ...node, title: [...node.title].slice(0, 120).join(''), evidence: [...node.evidence] }));
    included[0] = { ...task, payload: { ...task.payload, group: { ...task.payload.group, nodes } } };
    while (measure(messages()) > JUDGMENT_MAX_REQUEST_BYTES) {
      const last = [...nodes].reverse().find(node => node.evidence.length);
      if (!last) throw new Error('판정 요청이 크기 한도를 초과했습니다.');
      last.evidence.pop();
      // Empty nodes supply no usable evidence and need not occupy request space.
      if (!last.evidence.length) nodes.splice(nodes.indexOf(last), 1);
    }
  }
  return { included, overflow, messages: messages() };
}
