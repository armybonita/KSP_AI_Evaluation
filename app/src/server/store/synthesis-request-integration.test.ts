import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import { createDocument, createProject, insertParagraphs } from '@/server/store/db';
import { replaceProjectOntology } from '@/server/ontology/store';
import { synthesizeProject } from '@/server/ontology/synthesis';
import type { OntologyGraph } from '@/server/ontology/types';
import type { ChatMessage } from '@/server/ai/types';

it('실제 판정 단계에서 긴 제목 여러 그룹을 빠짐없이 나누며 전송 JSON 크기 상한을 지킨다', async () => {
  const db = new Database(':memory:'); db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'p', name: '가상 사업', created_at: '날짜' }, db);
  createDocument({ id: 'doc', project_id: 'p', file_name: '가상.txt', file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '날짜' }, db);
  const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: { source: { id: 'source', document_id: 'doc' } }, snippets: {}, nodes: {}, edges: [] };
  for (let i = 0; i < 40; i++) {
    const quote = `가상의 서로 다른 근거 ${i}`;
    insertParagraphs([{ id: `p-${i}`, document_id: 'doc', sequence_no: i + 1, location: `문단 ${i}`, content: quote }], db);
    graph.snippets[`s-${i}`] = { id: `s-${i}`, source: 'source', locator: `문단 ${i}`, quote };
    graph.nodes[`n-${i}`] = { id: `n-${i}`, type: 'output', title: `${'가'.repeat(480)} ${i}`, evidence: [`s-${i}`] };
  }
  replaceProjectOntology('p', graph, 'tester', db);
  const judgmentSizes: number[] = []; const ids: string[] = []; let groupNumber = 0;
  const measure = (messages: ChatMessage[]) => Buffer.byteLength(JSON.stringify({ model: '가상', messages, reasoning_effort: 'low', response_format: { type: 'json_object' } }), 'utf8');
  await synthesizeProject('p', { db, aiClient: { provider: 'solar', synthesisRequestBytes: measure, generateSynthesis: async messages => {
    const input = JSON.parse(messages[messages.length - 1].content);
    if (input.nodes) return { groups: Array.from({ length: Math.ceil(input.nodes.length / 8) }, (_, i) => ({ name: `가상 묶음 ${groupNumber++}`, ids: input.nodes.slice(i * 8, (i + 1) * 8).map((n: { id: string }) => n.id) })) };
    if (input.groups) return { groups: input.groups.map((g: { id: string; name: string }) => ({ name: g.name, ids: [g.id] })) };
    judgmentSizes.push(measure(messages));
    for (const task of input.tasks ?? [input]) ids.push(task.group.id);
    return { items: [] };
  } } });
  expect(judgmentSizes.length).toBeGreaterThan(1);
  expect(judgmentSizes.every(size => size <= 30_000)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(4);
  db.close();
});
