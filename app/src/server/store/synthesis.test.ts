import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { OntologyCallError } from '@/server/ai/client';
import { CREATE_TABLES_SQL } from '@/server/store/schema';
import { createDocument, createIndicator, createProject, insertParagraphs } from '@/server/store/db';
import { replaceProjectOntology } from '@/server/ontology/store';
import type { OntologyGraph } from '@/server/ontology/types';
import { execute, SynthesisQueue } from '@/server/ontology/synthesis-service';
import { abortSynthesisRun, prepareSynthesisResponse, startSynthesisRun, markSynthesisRunning, saveSynthesisStage, getLatestSynthesisRun, finishSynthesisRun } from '@/server/store/synthesis-store';
import { markInterruptedSynthesisRunsFailed } from '@/server/store/db';
import { chunkSynthesisInput, judgeIndicator, reduceSynthesisNodes, synthesizeProject } from '@/server/ontology/synthesis';

function fixture() {
  const db = new Database(':memory:'); db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'p', name: '가상 사업', created_at: '2026-01-01' }, db);
  for (const [id, holdout] of [['good', false], ['past', true], ['unknown', null]] as const) {
    createDocument({ id, project_id: 'p', file_name: `${id}.txt`, file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: holdout, created_at: '2026-01-01' }, db);
    insertParagraphs([{ id: `${id}-paragraph`, document_id: id, sequence_no: 1, location: '문단', content: id === 'good' ? '가상 참여율은 80%이다.' : `${id} 비공개 문장` }], db);
  }
  createIndicator({ id: 'i', project_id: 'p', level: '단기성과', name: '가상 참여율', ovi: '', mov: '', target_value: '70% 이상', source_doc_id: 'good', is_baseline: 1, created_at: '2026-01-01' }, db);
  const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
  for (const id of ['good', 'past', 'unknown']) {
    graph.sources[`src-${id}`] = { id: `src-${id}`, document_id: id };
    graph.snippets[`snp-${id}`] = { id: `snp-${id}`, source: `src-${id}`, locator: '문단', quote: id === 'good' ? '가상 참여율은 80%이다.' : `${id} 비공개 문장` };
    graph.nodes[`node-${id}`] = { id: `node-${id}`, type: 'outcome-short', title: id === 'good' ? '가상 참여율' : `${id} 비공개 제목`, evidence: [`snp-${id}`] };
  }
  replaceProjectOntology('p', graph, 'tester', db);
  return db;
}
function item(overrides: Record<string, unknown> = {}) {
  return { id: 'IND-01', step: 5, grp: '성과지표 기준 충족 여부', name: '가상 참여율', ai: '참여율을 확인했다.', state: '관측됨', k: 'ind', target: '', actual: '80%', verify: '', met: '', cites: ['good-paragraph'], match: '', enough: '', authors: '', conflict: [], fam: '', lvl: '', conf: '', note: '', links: [], ...overrides };
}
type Prompt = { step: 4 | 5 | 6 | 7; nodes?: Array<{ id: string; title: string; description: string; evidenceCount: number }>; groups?: Array<{ id: string; name: string }>; group?: { id: string; name: string; nodes: Array<{ id: string; title: string; evidence: Array<{ id: string; quote: string }> }> }; indicator?: { id: string }; tasks?: Array<{ group: NonNullable<Prompt['group']>; indicator?: { id: string } }> };
type Message = { role: string; content: string };
const prompt = (messages: Message[]): Prompt => JSON.parse(messages[messages.length - 1].content) as Prompt;
function grouped(messages: Message[]) {
  const input = prompt(messages);
  return { groups: [{ name: '가상 항목', ids: (input.nodes ?? []).map(n => n.id) }] };
}

function largeFixture(description = '가상 설명') {
  const db = new Database(':memory:'); db.exec(CREATE_TABLES_SQL);
  createProject({ id: 'large', name: '가상 사업', created_at: '날짜' }, db);
  const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'large' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
  for (let d = 0; d < 10; d++) {
    const id = `doc-${d}`;
    createDocument({ id, project_id: 'large', file_name: `${id}.txt`, file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '날짜' }, db);
    insertParagraphs([{ id: `paragraph-${d}`, document_id: id, sequence_no: 1, location: '문단', content: '가상 사업의 공통 근거 문장입니다.' }], db);
    graph.sources[`src-${d}`] = { id: `src-${d}`, document_id: id };
    graph.snippets[`snippet-${d}`] = { id: `snippet-${d}`, source: `src-${d}`, locator: '문단', quote: '가상 사업의 공통 근거 문장입니다.' };
  }
  for (const [step, type] of [[4, 'output'], [5, 'outcome-short'], [6, 'outcome-mid'], [7, 'enabler']] as const) {
    for (let i = 0; i < 300; i++) {
      const id = `node-${step}-${i}`;
      graph.nodes[id] = { id, type, title: `가상 항목 ${step} ${i}`, description, evidence: [`snippet-${i % 10}`] };
    }
  }
  replaceProjectOntology('large', graph, 'tester', db);
  return db;
}

function judgements(input: Prompt) { return (input.tasks ?? [{ group: input.group! }]).map(task => judgement({ ...input, ...task, tasks: undefined })); }
function judgement(input: Prompt) {
  const group = input.group!;
  const evidence = group.nodes.flatMap(node => node.evidence);
  return item({ id: group.id, step: input.step, name: group.name, actual: '', cites: evidence.map(e => e.id), k: input.step === 4 ? 'opt' : input.step === 7 ? 'fac' : 'out', grp: input.step === 7 ? '기여요인' : '성과지표 외 AI 제안' });
}

describe('synthesis', () => {
  it('deduplicates normalized titles, lowers detail scores and chunks by bytes', () => {
    const node = { id: 'x', type: 'output', title: '가상 보고서', description: '', score: 1, evidence: [], edges: [] };
    const reduced = reduceSynthesisNodes([node, { ...node, id: 'y', title: '가상  보고서' }, { ...node, id: 'z', title: '장비 사양' }]);
    expect(reduced).toHaveLength(2);
    expect(reduced[0].title).toBe('가상 보고서');
    const chunks = chunkSynthesisInput(Array.from({ length: 20 }, (_, i) => ({ i, text: '가상'.repeat(20) })), 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => Buffer.byteLength(JSON.stringify(chunk)) <= 500)).toBe(true);
  });
  it('judges compatible numeric thresholds and bare numeric goals', () => {
    expect(judgeIndicator('70% 이상', '80%')).toBe('충족 (산술 비교)');
    expect(judgeIndicator('70% 이상', '60%')).toBe('미충족 (산술 비교)');
    expect(judgeIndicator('70%', '80%')).toBe('충족 (산술 비교)');
    expect(judgeIndicator('70명 이하', '80%')).toContain('판정 불가');
    expect(judgeIndicator('1 (2025)', '3')).toBe('충족 (산술 비교)');
    // A note in brackets on the actual leaves the verdict to the reviewer (round 9 decision).
    expect(judgeIndicator('5', '5 (2차 연도 제안 10개 중)')).toMatch(/^판정 불가 /);
    expect(judgeIndicator('5', '4 (잠정)')).toMatch(/^판정 불가 /);
    expect(judgeIndicator('5', '4')).toBe('미충족 (산술 비교)');
    expect(judgeIndicator('5명', '6건')).toContain('판정 불가');
    expect(judgeIndicator('5~6', '6')).toContain('판정 불가');
  });
  it('uses eligible evidence, validates model items and grounds actuals', async () => {
    const db = fixture();
    const generateSynthesis = vi.fn(async (messages: Message[]) => prompt(messages).nodes ? grouped(messages) : prompt(messages).indicator ? ({ items: [item()] }) : ({ items: [item({ id: 'invalid', name: '' })] }));
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis } });
    const sent = JSON.stringify(generateSynthesis.mock.calls);
    expect(sent).not.toContain('past 비공개'); expect(sent).not.toContain('unknown 비공개');
    expect(result.items).toContainEqual(expect.objectContaining({ id: 'IND-01', actual: '80%', met: '충족 (산술 비교)', cites: ['good-paragraph'] }));
    expect(result.discardedCount).toBeGreaterThan(0);
    db.close();
  });
  it('keeps a ToC target echoed by the model when its numbers differ from the cited actual', async () => {
    const db = fixture();
    db.prepare('UPDATE indicators SET target_value = ? WHERE id = ?').run('1 (2025)', 'i');
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('가상 참여율은 3이다.', 'good-paragraph');
    const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
    graph.sources.good = { id: 'good', document_id: 'good' };
    graph.snippets.good = { id: 'good', source: 'good', locator: '문단', quote: '가상 참여율은 3이다.' };
    graph.nodes.good = { id: 'good', type: 'outcome-short', title: '가상 참여율', evidence: ['good'] };
    replaceProjectOntology('p', graph, 'tester', db);
    const generateSynthesis = vi.fn(async (messages: Message[]) => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      if (input.indicator) return { items: [item({ target: '1 (2025)', actual: '3' })] };
      return { items: judgements(input) };
    });
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis } });
    expect(result.items.find(i => i.id === 'IND-01')).toMatchObject({ state: '관측됨', target: '1 (2025)', actual: '3', met: '충족 (산술 비교)', cites: ['good-paragraph'] });
    db.close();
  });
  it('downgrades an item with no eligible evidence', async () => {
    const db = fixture();
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async (messages: Message[]) => prompt(messages).nodes ? grouped(messages) : ({ items: [item({ cites: ['invented'], actual: '' })] }) } });
    expect(result.items.find(i => i.id === 'IND-01')).toMatchObject({ state: '미확인', cites: [], note: '근거 자료 미확보' });
    db.close();
  });
  it('groups 300 candidates per stage before judgment and limits judgment evidence to eight documents', async () => {
    const db = largeFixture();
    const groupedInputs: Prompt[] = []; const judgedInputs: Prompt[] = [];
    const generateSynthesis = vi.fn(async (messages: Message[]) => {
      const input = prompt(messages);
      if (input.nodes || input.groups) {
        if (input.nodes) groupedInputs.push(input);
        const rows = input.nodes ?? input.groups!;
        const desired = { 4: 6, 5: 2, 6: 4, 7: 6 }[input.step];
        const size = Math.ceil(rows.length / desired);
        return { groups: Array.from({ length: desired }, (_, i) => ({ name: `가상 묶음 ${'가나다라마바사아자차'[i]}`, ids: rows.slice(i * size, (i + 1) * size).map(n => n.id) })).filter(g => g.ids.length) };
      }
      judgedInputs.push(...(input.tasks ?? [{ group: input.group! }]).map(task => ({ ...input, ...task, tasks: undefined })));
      return { items: judgements(input) };
    });
    const result = await synthesizeProject('large', { groupRowsPerCall: 250, db, aiClient: { provider: 'solar', generateSynthesis } });
    for (const [step, min, max] of [[4, 6, 15], [5, 2, 8], [6, 4, 12], [7, 6, 15]] as const) {
      const grouping = groupedInputs.filter(i => i.step === step);
      expect(grouping).toHaveLength(2);
      expect(grouping[0].nodes).toHaveLength(250);
      expect(grouping[1].nodes).toHaveLength(50);
      expect(result.diagnostics[step].groupingInputNodeCount).toBe(300);
      expect(grouping[0].nodes!.every(n => Object.keys(n).sort().join(',') === 'description,evidenceCount,id,title' && n.description.length <= 120)).toBe(true);
      const total = result.items.filter(i => i.step === step).length;
      expect(total).toBeGreaterThanOrEqual(min); expect(total).toBeLessThanOrEqual(max);
      expect(result.diagnostics[step]).toMatchObject({ candidateNodeCount: 300, groupingCalls: 3, finalItemCount: total });
    }
    expect(judgedInputs.length).toBeGreaterThan(0);
    for (const call of judgedInputs) {
      const evidence = call.group!.nodes.flatMap(n => n.evidence);
      expect(evidence.length).toBeLessThanOrEqual(8);
      expect(new Set(evidence.map(e => e.id)).size).toBe(evidence.length);
    }
    expect(judgedInputs.some(call => call.group!.nodes.flatMap(n => n.evidence).length === 8)).toBe(true);
    db.close();
  });
  it('keeps matched evidence from mixed eligible sources, drops excluded provenance, and records losses', async () => {
    const db = fixture();
    const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
    graph.sources.good = { id: 'good', document_id: 'good' };
    graph.sources.past = { id: 'past', document_id: 'past' };
    graph.snippets.ok = { id: 'ok', source: 'good', locator: '문단', quote: '가상 참여율은 80%이다.' };
    graph.snippets.bad = { id: 'bad', source: 'good', locator: '문단', quote: '문단에 없는 인용입니다.' };
    graph.snippets.excluded = { id: 'excluded', source: 'past', locator: '문단', quote: 'past 비공개 문장' };
    graph.nodes.mixed = { id: 'mixed', type: 'outcome-short', title: '혼합 근거', evidence: ['ok', 'bad'] };
    graph.nodes.mismatch = { id: 'mismatch', type: 'outcome-short', title: '불일치 근거', evidence: ['bad'] };
    graph.nodes.excluded = { id: 'excluded', type: 'outcome-short', title: '제외 문서 혼합', evidence: ['ok', 'excluded'] };
    graph.nodes.banned = { id: 'banned', type: 'outcome-short', title: '이름을 밝히지 말아 달라', evidence: ['ok'] };
    replaceProjectOntology('p', graph, 'tester', db);
    const calls: Prompt[] = [];
    const generateSynthesis = vi.fn(async (messages: Message[]) => {
      const input = prompt(messages); calls.push(input);
      if (input.nodes) return grouped(messages);
      if (input.indicator) return { items: [{ invalid: true }] };
      return { items: judgements(input) };
    });
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis } });
    const grouping = calls.find(c => c.nodes)?.nodes ?? [];
    expect(grouping.map(n => n.id)).toEqual(['mixed']);
    expect(JSON.stringify(calls)).not.toContain('문단에 없는 인용');
    expect(JSON.stringify(calls)).not.toContain('past 비공개');
    expect(result.diagnostics[5]).toMatchObject({ candidateNodeCount: 4, evidenceMismatchDroppedCount: 2, forbiddenDroppedCount: 1, groupingCalls: 1, judgmentCalls: 2, discardedResponseCount: 1, finalItemCount: 2 });
    db.close();
  });
  it('regroups chunk results by name when a stage exceeds the input limit', async () => {
    const db = largeFixture('가상 설명'.repeat(80));
    const calls: Prompt[] = [];
    const generateSynthesis = vi.fn(async (messages: Message[]) => {
      const input = prompt(messages); calls.push(input);
      const rows = input.nodes ?? input.groups;
      if (rows) {
        const desired = Math.min(6, rows.length);
        const size = Math.ceil(rows.length / desired);
        return { groups: Array.from({ length: desired }, (_, i) => ({ name: `가상 묶음 ${'가나다라마바사아자차'[i]}`, ids: rows.slice(i * size, (i + 1) * size).map(row => row.id) })).filter(g => g.ids.length) };
      }
      return { items: judgements(input) };
    });
    const result = await synthesizeProject('large', { db, aiClient: { provider: 'solar', generateSynthesis } });
    for (const step of [4, 5, 6, 7] as const) {
      const chunks = calls.filter(c => c.step === step && c.nodes);
      const merged = calls.filter(c => c.step === step && c.groups);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.flatMap(c => c.nodes!).length).toBe(300);
      expect(merged).toHaveLength(1);
      expect(merged[0].groups!.every(g => Object.keys(g).sort().join(',') === 'id,name')).toBe(true);
      expect(result.diagnostics[step].groupingCalls).toBe(chunks.length + 1);
      expect(result.items.filter(i => i.step === step)).toHaveLength(6);
    }
    db.close();
  });
  it('retries only omitted IDs, ignores unknown and repeated IDs, and counts remaining omissions', async () => {
    const db = largeFixture(); const calls: Prompt[] = [];
    const generateSynthesis = vi.fn(async (messages: Message[]) => {
      const input = prompt(messages); const rows = input.nodes ?? input.groups;
      if (!rows) return { items: judgements(input) };
      calls.push(input);
      if (input.step !== 4) return { groups: [{ name: '가상 묶음', ids: rows.map(r => r.id) }] };
      const previous = calls.filter(c => c.step === 4 && Boolean(c.nodes) === Boolean(input.nodes));
      if (previous.length === 1) return { groups: [{ name: '첫 묶음', ids: [rows[0].id, rows[0].id, 'unknown'] }] };
      if (previous.length === 2) return { groups: [] };
      return { groups: [{ name: '다음 묶음', ids: rows.map(r => r.id) }] };
    });
    const result = await synthesizeProject('large', { groupRowsPerCall: 250, db, aiClient: { provider: 'solar', generateSynthesis } });
    const nodeCalls = calls.filter(c => c.step === 4 && c.nodes);
    expect(nodeCalls[1].nodes).toHaveLength(249);
    expect(nodeCalls[1].nodes!.some(n => n.id === nodeCalls[0].nodes![0].id)).toBe(false);
    expect(result.diagnostics[4]).toMatchObject({ candidateNodeCount: 300, ungroupedNodeCount: 299, discardedResponseCount: 4 });
    expect(calls.filter(c => c.step === 4 && c.groups)).toHaveLength(2);
    expect(calls.filter(c => c.step === 4 && c.groups)[1].groups).toHaveLength(1);
    expect(result.items.length).toBeGreaterThan(0); db.close();
  });
  it('saves partial completions at both budgets and preserves stage snapshots after restart', async () => {
    const db = fixture(); let clock = 0;
    const client = { provider: 'solar', generateSynthesis: async (messages: Message[]) => prompt(messages).nodes ? grouped(messages) : { items: [judgement(prompt(messages))] } };
    const run = startSynthesisRun('p', db)!; markSynthesisRunning(run.id, db);
    const partial = await synthesizeProject('p', { db, aiClient: client, maxCalls: 2, onStageComplete: result => saveSynthesisStage(run.id, result, db) });
    expect(partial.partialReason).toContain('400회');
    expect(partial.items).toHaveLength(1);
    expect(partial.inputNodeCount).toBe(1); expect(partial.diagnostics[5].groupingInputNodeCount).toBe(1);
    finishSynthesisRun(run.id, partial, db);
    expect(getLatestSynthesisRun('p', db)).toMatchObject({ state: 'partial_completed', error_message: partial.partialReason });
    const run2 = startSynthesisRun('p', db)!; markSynthesisRunning(run2.id, db);
    const timed = await synthesizeProject('p', { db, aiClient: { ...client, generateSynthesis: async messages => { clock = 11; return client.generateSynthesis(messages); } }, now: () => clock, maxDurationMs: 10, onStageComplete: result => saveSynthesisStage(run2.id, result, db) });
    expect(timed.partialReason).toBe('전체 시간 10밀리초 상한');
    const before = getLatestSynthesisRun('p', db)!.result_json;
    expect(before).not.toBeNull();
    expect(markInterruptedSynthesisRunsFailed(db)).toBe(1);
    expect(getLatestSynthesisRun('p', db)).toMatchObject({ state: 'failed', error_message: '앱 재시작으로 중단 — 다시 실행해 주세요', result_json: before }); db.close();
  });
  it('stops a model call that does not settle when the time budget expires', async () => {
    const db = fixture();
    const result = await synthesizeProject('p', { db, maxDurationMs: 200, aiClient: { provider: 'solar', generateSynthesis: async () => new Promise(() => {}) } });
    expect(result.partialReason).toBe('전체 시간 200밀리초 상한');
    expect(result.diagnostics[5].partialReason).toBe('전체 시간 200밀리초 상한'); db.close();
  });
  it('keeps completed stage items when a later model call fails and the app restarts', async () => {
    const db = fixture();
    db.prepare('UPDATE ontology_nodes SET node_type = ? WHERE id = ?').run('output', 'node-good');
    const run = startSynthesisRun('p', db)!; markSynthesisRunning(run.id, db);
    await expect(synthesizeProject('p', { db, onStageComplete: result => saveSynthesisStage(run.id, result, db), aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.step === 5) throw new OntologyCallError('invalid-response');
      return input.nodes ? grouped(messages) : { items: [judgement(input)] };
    } } })).resolves.toBeTruthy();
    // A failed model call costs that request only; earlier stage items stay saved and the reason is counted.
    const saved = JSON.parse(getLatestSynthesisRun('p', db)!.result_json!);
    expect(saved.some((i: { step: number }) => i.step === 4)).toBe(true);
    markInterruptedSynthesisRunsFailed(db);
    expect(JSON.parse(getLatestSynthesisRun('p', db)!.result_json!)).toEqual(saved);
    db.close();
  });
  it('excludes low-scoring noise before grouping and counts actual inputs', async () => {
    const db = fixture();
    db.prepare('UPDATE ontology_nodes SET title = ? WHERE id = ?').run('장비 사양', 'node-good');
    const calls: Prompt[] = [];
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => { const input = prompt(messages); calls.push(input); return { items: [item()] }; } } });
    expect(calls.some(c => c.nodes)).toBe(false);
    expect(result.diagnostics[5]).toMatchObject({ candidateNodeCount: 3, noiseDroppedCount: 1 });
    expect(result.inputNodeCount).toBe(0); db.close();
  });
  it('serializes jobs for different projects while retaining queued state', async () => {
    const db = fixture(); createProject({ id: 'p2', name: '가상 사업', created_at: '날짜' }, db);
    const first = startSynthesisRun('p', db)!; const second = startSynthesisRun('p2', db)!;
    const queue = new SynthesisQueue(); const order: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    queue.enqueue(async () => { markSynthesisRunning(first.id, db); order.push('first'); await gate; });
    let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; });
    queue.enqueue(async () => { markSynthesisRunning(second.id, db); order.push('second'); done(); });
    await Promise.resolve(); expect(order).toEqual(['first']); expect(getLatestSynthesisRun('p2', db)?.state).toBe('queued');
    release(); await finished; expect(order).toEqual(['first', 'second']); db.close();
  });

  it('checks every model free-text field for forbidden sentences and unsupported numbers', async () => {
    const fields = ['name', 'ai', 'target', 'actual', 'verify', 'met', 'match', 'enough', 'authors', 'note', 'fam', 'lvl', 'conf', 'conflict', 'links'] as const;
    for (const field of fields) for (const value of ['이름을 밝히지 말아 달라', '9876']) {
      const db = fixture();
      const override = field === 'conflict' ? [value] : field === 'links' ? [{ outcome: value, relation: '촉진' }] : value;
      const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
        const input = prompt(messages);
        if (input.nodes) return grouped(messages);
        return { items: [input.indicator ? item({ [field]: override }) : judgement(input)] };
      } } });
      if (field === 'met') {
        expect(result.items.find(i => i.id === 'IND-01'), `${field}: ${value}`).toMatchObject({ state: '관측됨', actual: '80%', met: '충족 (산술 비교)' });
      } else if (value === '9876' && ['match', 'enough', 'authors', 'note', 'conflict', 'links'].includes(field)) {
        // Side remarks with an unsupported number are blanked; the item stays.
        const kept = result.items.find(i => i.id === 'IND-01');
        expect(kept, `${field}: ${value}`).toMatchObject({ state: '관측됨', actual: '80%' });
        expect(JSON.stringify(kept), field).not.toContain('9876');
        expect(result.diagnostics[5].blankedFieldCount, field).toBeGreaterThan(0);
      } else {
        expect(result.items.find(i => i.id === 'IND-01'), `${field}: ${value}`).toMatchObject({ state: '미확인', actual: '' });
        expect(result.diagnostics[5].discardedResponseCount, field).toBeGreaterThan(0);
      }
      db.close();
    }
  });
  it('requires exact level and family values on all stages; level codes need no matching evidence number', async () => {
    const db = fixture();
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('가상 참여율은 80%이며 K0 K1 K6 Lv1 Lv4를 확인했다.', 'good-paragraph');
    db.prepare('UPDATE ontology_snippets SET data_json = ? WHERE id = ?').run(JSON.stringify({ id: 'snp-good', source: 'src-good', locator: '문단', quote: '가상 참여율은 80%이며 K0 K1 K6 Lv1 Lv4를 확인했다.' }), 'snp-good');
    for (const [lvl, fam, accepted] of [
      ['K0', '협력국 정책 반영', true], ['지식활용 K6', '지식 네트워킹', true], ['협력확장 Lv4', '', true],
      ['K1 뒤 문장', '', false], ['Lv4뒤', '', false], ['K7', '', false], ['협력확장 Lv5', '', true], ['Lv6', '', false], ['K1', '허용 밖', false], ['Lv2', '', true], ['K4', '협력국 정책 반영', true],
    ] as const) {
      const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
        const input = prompt(messages);
        if (input.nodes) return grouped(messages);
        return { items: [input.indicator ? item({ lvl, fam }) : judgement(input)] };
      } } });
      expect(result.items.find(i => i.id === 'IND-01')?.state, `${lvl} ${fam}`).toBe(accepted ? '관측됨' : '미확인');
    }
    db.close();
  });
  it('omits indicators with ineligible document or baseline sources, with or without a graph', async () => {
    for (const graphExists of [true, false]) {
      const db = fixture();
      for (const [id, source] of [['past-i', 'past'], ['unknown-i', 'unknown'], ['baseline-i', 'good'], ['excluded-i', 'excluded'], ['provider-i', 'provider']] as const) {
        if (id === 'excluded-i' || id === 'provider-i') createDocument({ id: source, project_id: 'p', file_name: `${source}.txt`, file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: id === 'excluded-i' ? 0 : 1, excluded_reason: null, masked: true, approved_ai: id === 'provider-i' ? 'other' : 'solar', is_past_final_report: false, created_at: '날짜' }, db);
        createIndicator({ id, project_id: 'p', level: '단기성과', name: `제외 ${id}`, ovi: '', mov: '', target_value: '', source_doc_id: source, is_baseline: 1, created_at: '날짜' }, db);
      }
      db.prepare('INSERT INTO indicator_baselines (id, project_id, indicator_id, document_id, document_name, target_value, selected_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('baseline', 'p', 'baseline-i', 'past', '과거', '50%', '날짜');
      if (!graphExists) db.prepare('DELETE FROM ontology_imports WHERE project_id = ?').run('p');
      const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
        const input = prompt(messages);
        if (input.nodes) return grouped(messages);
        return { items: [input.indicator ? { invalid: true } : judgement(input)] };
      } } });
      expect(result.items.filter(i => i.k === 'ind')).toHaveLength(1);
      expect(result.items.find(i => i.k === 'ind')?.name).toBe('가상 참여율');
      expect(result.diagnostics[5]).toMatchObject({ ineligibleSourceIndicatorCount: 5, ineligibleSourceIndicatorReason: '자격 없는 출처 지표 5' });
      expect(JSON.stringify(result.items)).not.toContain('제외 past-i');
      db.close();
    }
  });
  it('sends one normalized title to initial grouping and retains both nodes evidence', async () => {
    const db = fixture();
    insertParagraphs([{ id: 'second-paragraph', document_id: 'good', sequence_no: 2, location: '두번째 문단', content: '가상 사업의 다른 근거입니다.' }], db);
    const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
    graph.sources.good = { id: 'good', document_id: 'good' };
    graph.snippets.one = { id: 'one', source: 'good', locator: '문단', quote: '가상 참여율은 80%이다.' };
    graph.snippets.two = { id: 'two', source: 'good', locator: '두번째 문단', quote: '가상 사업의 다른 근거입니다.' };
    graph.nodes.one = { id: 'one', type: 'outcome-short', title: '가상 참여율', evidence: ['one'] };
    graph.nodes.two = { id: 'two', type: 'outcome-short', title: '가상  참여율', evidence: ['two'] };
    replaceProjectOntology('p', graph, 'tester', db);
    const calls: Prompt[] = [];
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages); calls.push(input);
      if (input.nodes) return grouped(messages);
      return { items: [input.indicator ? item() : judgement(input)] };
    } } });
    expect(calls.find(input => input.nodes)?.nodes).toHaveLength(1);
    expect(calls.find(input => input.group && !input.indicator)?.group?.nodes.flatMap(n => n.evidence).map(e => e.id).sort()).toEqual(['good-paragraph', 'second-paragraph']);
    expect(result.diagnostics[5].candidateNodeCount).toBe(2);
    expect(result.diagnostics[5].groupingInputNodeCount).toBe(1);
    db.close();
  });
  it('stops regrouping when singleton groups do not shrink and judges the remaining groups', async () => {
    const db = largeFixture();
    db.prepare('DELETE FROM ontology_nodes WHERE node_type != ?').run('output');
    const calls: Prompt[] = [];
    const result = await synthesizeProject('large', { groupRowsPerCall: 250, db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages); calls.push(input);
      const rows = input.nodes ?? input.groups;
      return rows ? { groups: rows.map(row => ({ name: '단독 묶음', ids: [row.id] })) } : { items: judgements(input) };
    } } });
    expect(calls.filter(input => input.groups)).toHaveLength(2);
    expect(result.diagnostics[4]).toMatchObject({ regroupFailure: '재묶기 축소 실패', groupingCalls: 4, judgmentCalls: 9, skippedJudgmentCount: 255, skippedJudgmentReason: '판정 생략(묶기 실패) 255' });
    expect(calls.filter(input => input.tasks).every(input => input.tasks!.length <= 5)).toBe(true);
    db.close();
  });

  it('does not accept a goal value as evidence for an unsupported actual value', async () => {
    const db = fixture();
    db.prepare('UPDATE indicators SET target_value = ? WHERE id = ?').run('50%', 'i');
    db.prepare('UPDATE paragraphs SET content = ? WHERE id = ?').run('가상 참여율은 10%이다.', 'good-paragraph');
    db.prepare('UPDATE ontology_snippets SET data_json = ? WHERE id = ?').run(JSON.stringify({ id: 'snp-good', source: 'src-good', locator: '문단', quote: '가상 참여율은 10%이다.' }), 'snp-good');
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      return { items: [input.indicator ? item({ target: '50%', actual: '50%' }) : judgement(input)] };
    } } });
    expect(result.items.find(i => i.id === 'IND-01')).toMatchObject({ state: '미확인', target: '50%', actual: '' });
    expect(result.diagnostics[5].discardedResponseCount).toBeGreaterThan(0);
    db.close();
  });
  it('rejects unknown families on output and factor stages', async () => {
    for (const [step, type] of [[4, 'output'], [7, 'enabler']] as const) {
      const db = fixture();
      db.prepare('UPDATE ontology_nodes SET node_type = ? WHERE id = ?').run(type, 'node-good');
      const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
        const input = prompt(messages);
        if (input.nodes) return grouped(messages);
        return { items: [input.indicator ? item() : { ...judgement(input), fam: '허용 밖' }] };
      } } });
      expect(result.items.filter(i => i.step === step)).toHaveLength(0);
      expect(result.diagnostics[step].discardedResponseCount).toBeGreaterThan(0);
      db.close();
    }
  });

  it('aborts before a retry when a banned sentence is added during a model call', async () => {
    const db = fixture();
    const seen: Prompt[] = [];
    const snapshots: Array<{ items: Array<{ cites: string[] }> }> = [];
    const { OntologyCallError } = await import('@/server/ai/client');
    await expect(synthesizeProject('p', { db, onStageComplete: value => snapshots.push(JSON.parse(JSON.stringify(value))), aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages); seen.push(input);
      db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 1)').run('ban', 'good', 'good-paragraph', 1, '문단', '가상 참여율은 80%이다.');
      throw new OntologyCallError('invalid-response');
    } } })).rejects.toThrow('중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요');
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen.slice(1))).not.toContain('가상 참여율은 80%이다.');
    expect(snapshots.flatMap(snapshot => snapshot.items).every(value => !value.cites.includes('good-paragraph'))).toBe(true);
    db.close();
  });
  it('records interrupted state and clears an already saved stage when eligibility changes during a later call', async () => {
    const db = fixture();
    db.prepare('UPDATE ontology_nodes SET node_type = ? WHERE id = ?').run('output', 'node-good');
    const run = startSynthesisRun('p', db)!;
    let sawSavedStage = false;
    await execute('p', run.id, { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      if (input.step === 5 && input.indicator) {
        sawSavedStage = (getLatestSynthesisRun('p', db)?.item_count ?? 0) > 0;
        db.prepare('UPDATE documents SET is_included = 0 WHERE id = ?').run('good');
        return { items: [item()] };
      }
      return { items: judgements(input) };
    } } });
    expect(sawSavedStage).toBe(true);
    const saved = getLatestSynthesisRun('p', db)!;
    expect(saved).toMatchObject({ state: 'failed', error_message: '중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요', item_count: 0, result_json: null });
    const response = prepareSynthesisResponse('p', saved, db, 'solar');
    expect(response).toMatchObject({ state: 'stale', result: [] });
    expect(JSON.stringify(response)).not.toContain('가상 참여율');
    db.close();
  });
  it('refuses a stage save after a document changes and records an interrupted run with no items', async () => {
    const db = fixture();
    const run = startSynthesisRun('p', db)!;
    markSynthesisRunning(run.id, db);
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      return input.nodes ? grouped(messages) : { items: [input.indicator ? item() : judgement(input)] };
    } } });
    saveSynthesisStage(run.id, result, db);
    expect(getLatestSynthesisRun('p', db)!.item_count).toBeGreaterThan(0);
    db.prepare('UPDATE documents SET is_past_final_report = 1 WHERE id = ?').run('good');
    expect(() => saveSynthesisStage(run.id, result, db)).toThrow('중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요');
    expect(() => finishSynthesisRun(run.id, result, db)).toThrow('중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요');
    abortSynthesisRun(run.id, db);
    const saved = getLatestSynthesisRun('p', db)!;
    expect(saved).toMatchObject({ state: 'failed', error_message: '중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요', item_count: 0, result_json: null });
    const response = prepareSynthesisResponse('p', saved, db);
    expect(response).toMatchObject({ state: 'stale', result: [] });
    expect(JSON.stringify(response)).not.toContain('가상 참여율');
    db.close();
  });
  it('discards a model indicator met and keeps a grounded arithmetic verdict', async () => {
    const db = fixture();
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      return { items: [input.indicator ? item({ met: '목표 70%를 넘어 충족' }) : judgement(input)] };
    } } });
    expect(result.items.find(value => value.id === 'IND-01')).toMatchObject({ state: '관측됨', actual: '80%', met: '충족 (산술 비교)' });
    db.close();
  });
  it('limits a busy stage to 100 attempts and continues later stages', async () => {
    const db = fixture();
    for (let i = 0; i < 105; i++) createIndicator({ id: `extra-${i}`, project_id: 'p', level: '단기성과', name: '가상 참여율', ovi: '', mov: '', target_value: '', source_doc_id: 'good', is_baseline: 1, created_at: '날짜' }, db);
    createIndicator({ id: 'later', project_id: 'p', level: '중기성과', name: '다음 지표', ovi: '', mov: '', target_value: '', source_doc_id: 'good', is_baseline: 1, created_at: '날짜' }, db);
    const calls: Prompt[] = [];
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages); calls.push(input);
      if (input.nodes) return grouped(messages);
      if (input.indicator) return { items: [item({ id: input.indicator.id, step: input.step, cites: [], actual: '' })] };
      return { items: judgements(input) };
    } } });
    expect(result.diagnostics[5].groupingCalls + result.diagnostics[5].judgmentCalls).toBe(100);
    expect(result.diagnostics[5].partialReason).toContain('100회');
    expect(calls.some(input => input.step === 6 && input.indicator)).toBe(true);
    expect(result.items.some(value => value.step === 6 && value.k === 'ind')).toBe(true);
    db.close();
  });

  it('aborts the entire run when an outcome document is excluded during grouping', async () => {
    const db = fixture();
    createDocument({ id: 'factor-doc', project_id: 'p', file_name: 'factor.txt', file_type: 'txt', status: '추출 완료', doc_type: '성과관리표', is_included: 1, excluded_reason: null, masked: true, approved_ai: 'solar', is_past_final_report: false, created_at: '날짜' }, db);
    insertParagraphs([{ id: 'factor-paragraph', document_id: 'factor-doc', sequence_no: 1, location: '문단', content: '가상 요인의 근거 문장입니다.' }], db);
    const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
    graph.sources.good = { id: 'good', document_id: 'good' };
    graph.sources.factor = { id: 'factor', document_id: 'factor-doc' };
    graph.snippets.outcome = { id: 'outcome', source: 'good', locator: '문단', quote: '가상 참여율은 80%이다.' };
    graph.snippets.factor = { id: 'factor', source: 'factor', locator: '문단', quote: '가상 요인의 근거 문장입니다.' };
    graph.nodes.outcome = { id: 'outcome', type: 'outcome-short', title: '가상 참여율', evidence: ['outcome'] };
    graph.nodes.factor = { id: 'factor', type: 'enabler', title: '가상 요인', evidence: ['factor'] };
    graph.edges = [{ source: 'factor', target: 'outcome', relation: 'promotes' }];
    replaceProjectOntology('p', graph, 'tester', db);
    const calls: Prompt[] = [];
    await expect(synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages); calls.push(input);
      if (input.step === 5 && input.nodes) { db.prepare('UPDATE documents SET is_included = 0 WHERE id = ?').run('good'); return grouped(messages); }
      if (input.nodes) return grouped(messages);
      return { items: judgements(input) };
    } } })).rejects.toThrow('중단 — 실행 중 자료 자격이 바뀌었습니다. 다시 실행해 주세요');
    expect(JSON.stringify(calls.filter(input => input.step === 7))).not.toContain('가상 참여율');
    db.close();
  });

});

describe('round 6 review fixes', () => {
  it('never turns a hedged or bounded actual into a verdict', async () => {
    const { judgeIndicator } = await import('@/server/ontology/synthesis');
    for (const [target, actual] of [['80%', '80% 미만'], ['70% 이하', '70% 초과'], ['5', '약 5'], ['3', '3 이상'], ['10', '10 추정'], ['80%', '80% 미달'], ['70% 이하', '70% 보다 높음'], ['5', '5개 이상 운영'], ['10', '10 (추정)'], ['80%', '80% (미달)'], ['70% 이하', '70% (초과)'], ['80%', '80% (달성 실패)'], ['10', '10 (미확정)']] as const) {
      expect(judgeIndicator(target, actual), `${target} / ${actual}`).toMatch(/^판정 불가 /);
    }
    expect(judgeIndicator('1 (2025)', '3')).toBe('충족 (산술 비교)');
    expect(judgeIndicator('70% (이하)', '80%')).toMatch(/^판정 불가 /);
    expect(judgeIndicator('70% 이하', '60%')).toBe('충족 (산술 비교)');
  });
});

describe('round 7 review fixes', () => {
  it('keeps valid groups when another group in the same reply is malformed', async () => {
    const db = fixture();
    let groupingReplies = 0;
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) {
        groupingReplies++;
        const ok = grouped(messages) as { groups: unknown[] };
        return { groups: [...ok.groups, { name: '', ids: ['x'] }, { ids: 'not-an-array' }] };
      }
      return { items: [input.indicator ? item() : judgement(input)] };
    } } });
    expect(groupingReplies).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
    for (const step of [4, 5, 6, 7] as const) expect(result.diagnostics[step].ungroupedNodeCount, String(step)).toBe(0);
    db.close();
  });
});

describe('round 8 review fixes', () => {
  it('reports the run as partial when grouping replies stay malformed', async () => {
    const db = fixture();
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return { groups: [{ ids: 'broken' }] };
      return { items: [input.indicator ? item() : judgement(input)] };
    } } });
    const ungrouped = Object.values(result.diagnostics).reduce((sum, d) => sum + d.ungroupedNodeCount, 0);
    expect(ungrouped).toBeGreaterThan(0);
    expect(result.partialReason).toMatch(/묶기 응답 오류로 점 \d+개를 묶지 못했습니다/);
    db.close();
  });
});

describe('reply normalization (first live run)', () => {
  it('fills harmless gaps without inventing content', async () => {
    const { normalizeCandidate } = await import('@/server/ontology/synthesis');
    const n = normalizeCandidate({ name: '가상 항목', step: '6', cites: 'p1', conf: 3, extra: 'x' }, 6, { id: 'G1-1', indicator: false });
    expect(n).toMatchObject({ id: 'G1-1', step: 6, k: 'out', grp: '성과지표 외 AI 제안', state: '미확인', cites: ['p1'], conf: '3', ai: '', actual: '' });
    expect(n).not.toHaveProperty('extra');
    expect(normalizeCandidate({ name: 'x' }, 7)).toMatchObject({ k: 'fac', grp: '' });
  });
});

describe('model labels do not decide item identity (second live run)', () => {
  it('maps items with a renamed id to their group and sets type and group from the task', async () => {
    const db = fixture();
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      if (input.indicator) return { items: [item()] };
      return { items: judgements(input).map(j => ({ ...j, id: `renamed-${j.id}`, k: 'ind', grp: '기여요인' })) };
    } } });
    const nonIndicator = result.items.filter(i => i.k !== 'ind');
    expect(nonIndicator.length).toBeGreaterThan(0);
    for (const i of nonIndicator) {
      expect(i.k).toBe(i.step === 4 ? 'opt' : i.step === 7 ? 'fac' : 'out');
      if (i.step !== 7) expect(i.grp).toBe('성과지표 외 AI 제안');
    }
    const reasons = Object.values(result.diagnostics).map(d => d.discardReasons ?? {});
    expect(reasons.some(r => r['항목 id 불일치'] || r['종류 불일치'])).toBe(false);
    db.close();
  });
});

describe('network failures during synthesis (dev server 300 s cut)', () => {
  it('counts a fetch failure as one lost request and keeps going', async () => {
    const db = fixture();
    let failed = false;
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes && !failed) { failed = true; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }); }
      return input.nodes ? grouped(messages) : { items: [input.indicator ? item() : judgement(input)] };
    } } });
    const reasons = Object.values(result.diagnostics).flatMap(d => Object.keys(d.discardReasons ?? {}));
    expect(reasons).toContain('AI 응답 오류:network');
    expect(result.items.length).toBeGreaterThan(0);
    db.close();
  });
});

describe('synthesis limits and discarded grouping replies', () => {
  it('reads the whole-run limit from the environment, including its fallback and maximum', async () => {
    const cases = [['90000', 90_000, '90초'], ['120000', 120_000, '2분'], ['14400000', 14_400_000, '240분'], ['14400001', 2_700_000, '45분'], ['bad', 2_700_000, '45분']] as const;
    try {
      for (const [value, limit, label] of cases) {
        vi.stubEnv('AIEAS_SYNTHESIS_MAX_MS', value);
        const db = fixture(); let clock = 0;
        const result = await synthesizeProject('p', { db, now: () => clock, aiClient: { provider: 'solar', generateSynthesis: async () => { clock = limit; return { groups: [] }; } } });
        expect(result.partialReason).toBe(`전체 시간 ${label} 상한`);
        db.close();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('counts each malformed grouping response, group, banned name and invalid id by reason', async () => {
    const db = fixture(); let replies = 0;
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 1)').run('ban-group', 'good', 'good-paragraph', 1, '문단', '금지된 묶음 이름');
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (!input.nodes) return { items: [input.indicator ? item() : judgement(input)] };
      if (++replies === 1) return { groups: 'broken' };
      const id = input.nodes[0].id;
      return { groups: [ { ids: 'broken' }, { name: '금지된 묶음 이름', ids: [id] }, { name: '유효 묶음', ids: [id, id, id, '없는-id', '없는-id'] } ] };
    } } });
    expect(result.diagnostics[5].discardReasons).toEqual({ '묶기 응답 형식': 1, '묶기 스키마': 1, '묶기 이름 금지 문장': 1, '묶기 중복 id': 2, '묶기 없는 id': 2 });
    expect(result.diagnostics[5].discardedResponseCount).toBe(7);
    db.close();
  });

  it('uses the selected task group before validating even invalid or mismatched model grp values', async () => {
    const db = fixture();
    const graph: OntologyGraph = { code: 'PTEST', projectName: '가상 사업', project: { id: 'p' }, reports: {}, report_status: {}, issues: [], sources: {}, snippets: {}, nodes: {}, edges: [] };
    graph.sources.good = { id: 'good', document_id: 'good' };
    graph.snippets.good = { id: 'good', source: 'good', locator: '문단', quote: '가상 참여율은 80%이다.' };
    graph.nodes.outcome = { id: 'outcome', type: 'outcome-short', title: '가상 참여율', evidence: ['good'] };
    graph.nodes.constraint = { id: 'constraint', type: 'constraint', title: '가상 제약', evidence: ['good'] };
    replaceProjectOntology('p', graph, 'tester', db);
    const result = await synthesizeProject('p', { db, aiClient: { provider: 'solar', generateSynthesis: async messages => {
      const input = prompt(messages);
      if (input.nodes) return grouped(messages);
      if (input.indicator) return { items: [item({ grp: '잘못된 그룹' })] };
      return { items: judgements(input).map(j => ({ ...j, id: input.step === 7 ? `renamed-${j.id}` : j.id, grp: '잘못된 그룹' })) };
    } } });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'IND-01', grp: '성과지표 기준 충족 여부', actual: '80%' }),
      expect.objectContaining({ step: 5, k: 'out', grp: '성과지표 외 AI 제안' }),
      expect.objectContaining({ step: 7, k: 'fac', grp: '제약요인' }),
    ]));
    expect(Object.values(result.diagnostics).some(d => Object.keys(d.discardReasons ?? {}).some(reason => reason.includes('스키마:grp')))).toBe(false);
    db.close();
  });
});
