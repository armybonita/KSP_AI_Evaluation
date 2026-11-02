import { test, expect } from './isolated-test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { importVault } from '../../src/server/ontology';
import { stableNodeId, nodeHash } from '../../src/server/ontology/node-id';
import { getProjectOntologyGraph, replaceProjectOntology } from '../../src/server/store/ontology';
import { saveNoteReview, confirmNoteLink } from '../../src/server/store/note-review';

test('④~⑦ 목록, 검토와 관계 확정을 가상 자료로 다룬다', async ({ page }) => {
  const base = '/projects/proj-dev-seed';
  await page.goto(`${base}/ontology`);
  const select = page.getByLabel('가상 사업');
  await expect(select).toBeEnabled();
  await select.selectOption('VA01');
  await page.getByRole('button', { name: '가져오기', exact: true }).click();
  await expect(page.getByRole('button', { name: '가져오기', exact: true })).toBeEnabled();
  await expect(page.getByText('아직 가져온 온톨로지가 없습니다. 가상 사업을 선택해 가져오기를 실행하세요.')).toHaveCount(0);

  // 동일한 가상 그래프를 실제 저장 경로로 두 번 가져온다.
  const dbPath = process.env.AIEAS_DB_PATH || path.resolve(process.cwd(), '.e2e-seed.db');
  const db = new Database(dbPath, { fileMustExist: true });
  const project = 'proj-dev-seed';
  const fixture = importVault(path.resolve(process.cwd(), 'fixtures/ontology')).find((item) => item.code === 'VA01')!;
  for (const [id, node] of Object.entries(fixture.nodes)) if (!node.title) node.title = id;
  const ids = new Map(Object.entries(fixture.nodes).map(([id, node]) => [id, stableNodeId(`P${nodeHash(project, 6)}`, String(node.type), String(node.title))]));
  const remap = (value: unknown): unknown => typeof value === 'string' ? ids.get(value) ?? value : Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [ids.get(key) ?? key, remap(v)])) : value;
  const graph = remap(fixture) as typeof fixture;
  for (const [id, node] of Object.entries(fixture.nodes)) graph.nodes[ids.get(id)!].title = node.title;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shortId = stableNodeId(`P${nodeHash(project, 6)}`, 'outcome-short', `가상 단기 노트 ${suffix}`);
  const midId = stableNodeId(`P${nodeHash(project, 6)}`, 'outcome-mid', `가상 중기 노트 ${suffix}`);
  const rejectedId = stableNodeId(`P${nodeHash(project, 6)}`, 'outcome-short', `가상 오분류 노트 ${suffix}`);
  const splitTitle = `가상 분할 노트 ${suffix}`;
  const splitBase = stableNodeId(`P${nodeHash(project, 6)}`, 'outcome-mid', splitTitle);
  const splitA = `${splitBase}-${nodeHash('가상 문서 A', 10)}`;
  const splitB = `${splitBase}-${nodeHash('가상 문서 B', 10)}`;
  const projectNodeId = Object.entries(graph.nodes).find(([, node]) => node.type === 'project')![0];
  for (const [id, type, title] of [
    [shortId, 'outcome-short', '가상 단기 노트'],
    [rejectedId, 'outcome-short', '가상 오분류 노트'],
    [midId, 'outcome-mid', '가상 중기 노트'],
    [splitA, 'outcome-mid', splitTitle],
    [splitB, 'outcome-mid', splitTitle],
    [stableNodeId(`P${nodeHash(project, 6)}`, 'enabler', `가상 기여 노트 ${suffix}`), 'enabler', '가상 기여 노트'],
    [stableNodeId(`P${nodeHash(project, 6)}`, 'constraint', `가상 제약 노트 ${suffix}`), 'constraint', '가상 제약 노트'],
  ]) graph.nodes[id] = { id, type, title, description: title };
  graph.nodes[midId].merged_same_document = true;
  graph.sources['가상 문서 A'] = {title:'가상 문서 A'}; graph.sources['가상 문서 B'] = {title:'가상 문서 B'};
  graph.snippets['가상 근거 A'] = {source:'가상 문서 A', locator:'가상 위치', quote:'가상 분할 근거 A', proves:[splitA]};
  graph.snippets['가상 근거 B'] = {source:'가상 문서 B', locator:'가상 위치', quote:'가상 분할 근거 B', proves:[splitB]};
  graph.snippets['가상 근거 C'] = {source:'가상 문서 A', locator:'가상 위치', quote:'가상 합침 근거 C', proves:[midId]};
  graph.snippets['가상 근거 D'] = {source:'가상 문서 A', locator:'가상 위치', quote:'가상 합침 근거 D', proves:[midId]};
  graph.snippets['가상 근거 E'] = {source:'가상 문서 A', locator:'가상 위치', quote:'가상 단기 근거 E', proves:[shortId]};
  graph.snippets['가상 근거 F'] = {source:'가상 문서 A', locator:'가상 위치', quote:'가상 오분류 근거 F', proves:[rejectedId]};
  graph.candidates = [
    { source: shortId, target: splitA, relation: 'extends_to' },
    { source: shortId, target: midId, relation: 'extends_to' },
    { source: projectNodeId, target: midId, relation: 'targets' },
    { source: rejectedId, target: midId, relation: 'extends_to' },
  ];
  // 기존 확정 노트와 연결을 저장한 뒤 분할된 생성을 가져온다.
  const oldGraph = structuredClone(graph);
  oldGraph.nodes[splitBase] = { ...oldGraph.nodes[splitA], id: splitBase };
  delete oldGraph.nodes[splitA]; delete oldGraph.nodes[splitB];
  oldGraph.snippets['가상 근거 A'].proves = [splitBase];
  oldGraph.snippets['가상 근거 B'].proves = [splitBase];
  oldGraph.candidates = oldGraph.candidates!.map(c => c.target === splitA ? { ...c, target: splitBase } : c);
  const old = replaceProjectOntology(project, oldGraph, 'e2e', db);
  saveNoteReview(project, old.id, splitBase, { status: '확정', text: splitTitle, outcomeState: '미확인', reason: '', errorType: '' }, '가상 검토자', db);
  confirmNoteLink(project, old.id, shortId, splitBase, '가상 검토자', db, 'extends_to');
  const imported = replaceProjectOntology(project, graph, 'e2e', db);
  db.close();

  await page.goto(`${base}/review`);
  const section = page.getByRole('region', { name: '온톨로지 노트 검토' });
  const tabs = [
    ['④ 산출물', '0/1'], ['⑤ 단기성과', '0/2'], ['⑥ 중·장기성과', '0/5'], ['⑦ 기여·제약요인', '0/2'],
  ];
  for (const [label, count] of tabs) {
    await expect(section.getByRole('button', { name: new RegExp(label) })).toContainText(count);
  }
  await expect(section.getByRole('button', { name: /가상산출물A/ })).toBeVisible();
  await expect(section.getByRole('button', { name: /가상산출물A/ })).not.toContainText('근거 자료 미확보');
  await section.getByRole('button', { name: /⑤ 단기성과/ }).click();
  await expect(section.getByRole('button', { name: /가상 단기 노트/ })).not.toContainText('근거 자료 미확보');
  await section.getByRole('button', { name: /⑦ 기여·제약요인/ }).click();
  await expect(section.getByRole('region', { name: '기여요인 목록' })).toContainText('가상 기여 노트');
  await expect(section.getByRole('region', { name: '제약요인 목록' })).toContainText('가상 제약 노트');
  await expect(section.getByText('운영상 특이사항')).toBeVisible();
  await expect(section.getByRole('heading', { name: '내부 평가근거' })).toBeVisible();
  await expect(section.getByRole('heading', { name: '외부 보조자료' })).toBeVisible();
  await expect(section.getByText(/허용 출처.*게시일.*검색일.*검색 범위.*사업기간 관련성/)).toBeVisible();

  for (const action of ['보완 필요', '채택 제외']) {
    await section.getByRole('button', { name: action, exact: true }).click();
    await expect(section.getByRole('status')).toContainText('사유');
    await section.getByLabel('사유').fill('가상 검토 사유');
    await section.getByRole('button', { name: action, exact: true }).click();
    await expect(section.getByRole('status')).toContainText('오류 유형');
    await section.getByLabel('사유').fill('');
  }

  await section.getByRole('button', { name: /⑥ 중·장기성과/ }).click();
  await section.getByRole('button', { name: /가상 분할 노트/ }).first().click();
  await expect(section.getByText(/한 문서의 같은 이름 근거/)).toHaveCount(0);
  const splitBanner = section.locator('p').filter({ hasText: '이전 확정 있음 — 둘 이상으로 나뉨, 다시 확인 필요' });
  await expect(splitBanner).toBeVisible();
  await expect(section.getByText(/단기성과 연결: 가상 단기 노트/)).toContainText('이전 확정 연결 있음 — 나뉨, 다시 확인 필요');
  await section.getByText(/단기성과 연결: 가상 단기 노트/).getByRole('button', { name: '연결 확정' }).click();
  await section.getByRole('button', { name: '확정', exact: true }).click();
  await expect(splitBanner).toHaveCount(0);
  await expect(section.getByText('이전 이력 보기', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: '새 이력으로 수정' })).toBeVisible();
  await section.getByRole('button', { name: /가상 중기 노트/ }).click();
  await expect(section.getByText('한 문서의 같은 이름 근거 2건을 합침 — 서로 다른 성과면 기각 뒤 나눠 확인')).toBeVisible();
  await expect(section.getByText(/단기성과 연결: 가상 단기 노트/)).toContainText('AI 후보');
  await section.getByText(/단기성과 연결: 가상 단기 노트/).getByRole('button', { name: '연결 확정' }).click();
  await expect(section.getByText(/단기성과 연결: 가상 단기 노트/)).toContainText('확정');
  const rejected = section.getByText(/단기성과 연결: 가상 오분류 노트/);
  await rejected.getByRole('button', { name: '기각', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('사유와 오류 유형');
  await section.getByLabel('사유').fill('가상 오분류');
  await section.getByLabel('오류 유형').selectOption('기타');
  await rejected.getByRole('button', { name: '기각', exact: true }).click();
  await expect(rejected).toHaveCount(0);
  await section.getByText('연결 검토 이력').click();
  await expect(section.getByText(/가상 오분류/)).toBeVisible();
  await section.getByLabel('사유').fill('');
  await section.getByLabel('오류 유형').selectOption('');
  const targets = section.getByText(/사업 연결:/);
  await expect(targets).toContainText('AI 후보');
  await targets.getByRole('button', { name: '연결 확정' }).click();
  await expect(targets).toContainText('확정');
  const draft = section.getByLabel('판단 문안');
  const original = await draft.inputValue();
  await draft.fill('가상의 수정 판단 문안');
  await section.getByRole('button', { name: '수정 완료' }).click();
  await expect(section.getByRole('status')).toContainText('사유');
  await section.getByLabel('사유').fill('근거 문장에 맞춤');
  await section.getByRole('button', { name: '수정 완료' }).click();
  await expect(section.getByRole('status')).toContainText('오류 유형');
  await section.getByLabel('오류 유형').selectOption('근거 부족');
  await section.getByRole('button', { name: '수정 완료' }).click();
  await expect(section.getByRole('button', { name: '새 이력으로 수정' })).toBeVisible();
  await expect(draft).toBeDisabled();
  await expect(section.locator('s')).toHaveText(original);
  await section.getByRole('button', { name: '새 이력으로 수정' }).click();
  await expect(draft).toBeEnabled();
  await section.getByText('검토 이력', { exact: true }).click();
  await expect(section.getByText(/이력 2건/)).toBeVisible();
  await expect(section.getByText(/근거 문장에 맞춤/).first()).toBeVisible();
  await page.reload();
  await section.getByRole('button', { name: /⑥ 중·장기성과/ }).click();
  await section.getByRole('button', { name: /가상 중기 노트/ }).click();
  await expect(section.getByLabel('판단 문안')).toHaveValue('가상의 수정 판단 문안');

  // SQL 복사 없이 같은 입력을 실제 가져오기 함수로 다시 저장한다.
  const nextDb = new Database(dbPath, { fileMustExist: true });
  const next = replaceProjectOntology(project, graph, 'e2e', nextDb);
  expect(next.id).not.toBe(imported.id);
  const stored = getProjectOntologyGraph(project, nextDb);
  expect(stored.importId).toBe(next.id);
  expect(stored.edges).toContainEqual({ source: shortId, target: midId, relation: 'extends_to' });
  expect(stored.edges).toContainEqual({ source: shortId, target: splitA, relation: 'extends_to' });
  expect(stored.edges).not.toContainEqual({ source: rejectedId, target: midId, relation: 'extends_to' });
  nextDb.close();
  await page.goto(`${base}/review`);
  await section.getByRole('button', { name: /⑥ 중·장기성과/ }).click();
  await section.getByRole('button', { name: /가상 중기 노트/ }).click();
  await expect(section.getByText(/단기성과 연결: 가상 단기 노트/)).toContainText('확정');
  await expect(section.getByText(/사업 연결:/)).toContainText('확정');
  await expect(section.getByText(/단기성과 연결: 가상 오분류 노트/)).toHaveCount(0);
  await section.getByText('연결 검토 이력').click();
  await expect(section.getByText(/가상 오분류/)).toBeVisible();
  await page.goto(`${base}/ontology`);
  await page.getByRole('button', { name: '상세 그래프', exact: true }).click();
  const graphView = page.getByRole('img', { name: '저장된 사업 온톨로지 상세 그래프' });
  const graphNode = graphView.getByRole('button', { name: 'outcome-mid: 가상 중기 노트' });
  await expect(graphView.locator(`line[data-source="${shortId}"][data-target="${midId}"][data-relation="extends_to"]`)).toHaveCount(1);
  await expect(graphView.locator(`line[data-source="${shortId}"][data-target="${splitA}"][data-relation="extends_to"]`)).toHaveCount(1);
  await expect(graphView.locator(`line[data-source="${rejectedId}"][data-target="${midId}"]`)).toHaveCount(0);
  // 초기 ToC 상세 그래프의 검토 가능한 점은 해당 노트 검토로 이동한다.
  await graphNode.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/review`));
  await expect(section.getByRole('heading', { name: '판단 문안 · 가상 중기 노트' })).toBeVisible();

});
