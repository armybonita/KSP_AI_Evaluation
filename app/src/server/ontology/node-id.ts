import { createHash } from 'node:crypto';

const prefixes: Record<string, string> = { project: 'PRJ', partner: 'CNY', implementer: 'IMP', 'policy-area': 'POL', 'participant-org': 'ORG', activity: 'ACT', output: 'OPT', indicator: 'IND', 'outcome-short': 'OUT-S', 'outcome-mid': 'OUT-M', enabler: 'FAC-E', constraint: 'FAC-C' };
export function normalizeNodeName(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR'); }
export function nodeHash(value: string, length = 16): string { return createHash('sha256').update(value).digest('hex').slice(0, length).toUpperCase(); }
export function stableNodeId(projectCode: string, type: string, name: string): string {
  if (!prefixes[type]) throw new Error(`알 수 없는 노드 종류: ${type}`);
  return `${prefixes[type]}-${projectCode}-H${nodeHash(JSON.stringify([projectCode, type, normalizeNodeName(name)]))}`;
}
