import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void>, updates: [] as Array<{ index: number; value: unknown }>, states: [] as unknown[], setters: [] as Array<(value: unknown) => void>, index: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.index++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      const setState = (update: unknown) => {
        const previous = hooks.states[index];
        const next = typeof update === 'function' ? (update as (value: unknown) => unknown)(previous) : update;
        if (Object.is(previous, next)) return;
        hooks.states[index] = next;
        hooks.updates.push({ index, value: next });
      };
      hooks.setters[index] = setState;
      return [hooks.states[index], setState];
    },
    useEffect: (effect: () => void) => hooks.effects.push(effect),
    useTransition: () => [false, (callback: () => void) => callback()],
  };
});

import { seedDev, SEED_PROJECT_ID } from '../scripts/seed-dev';
import { closeDatabase, openDatabase } from '../src/server/store';
import ReviewPage from '../src/app/projects/[projectId]/review/page';
import { ReviewClientView } from '../src/app/projects/[projectId]/review/review-client-view';

function findTestId(node: any, testId: string): any {
  if (node == null || typeof node !== 'object') return null;
  if (node.props?.['data-testid'] === testId) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findTestId(child, testId);
    if (found) return found;
  }
  return null;
}

describe('검토 원문 자동 열기의 사업 금지문', () => {
  let dbPath: string;
  let originalDbPath: string | undefined;
  const projectBan = '가상 참여자는 별도 보호 조치가 필요합니다.';
  const otherBan = '다른 가상 사업의 금지 문장입니다.';

  beforeEach(() => {
    originalDbPath = process.env.AIEAS_DB_PATH;
    dbPath = path.join(os.tmpdir(), `review-ban-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    hooks.effects.length = 0;
    hooks.updates.length = 0;
    hooks.index = 0;
    hooks.states.length = 0;
    hooks.setters.length = 0;
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (originalDbPath === undefined) delete process.env.AIEAS_DB_PATH;
    else process.env.AIEAS_DB_PATH = originalDbPath;
    vi.unstubAllGlobals();
  });

  async function pageWithBans() {
    await seedDev({ fakeAi: true, dbPath, projectId: SEED_PROJECT_ID });
    process.env.AIEAS_DB_PATH = dbPath;
    const db = openDatabase(dbPath);
    const existing = db.prepare('SELECT id, document_id FROM paragraphs LIMIT 1').get() as { id: string; document_id: string };
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run('ban-current', existing.document_id, existing.id, 999, '가상 위치', projectBan);
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('other-project', '다른 사업', '2026-10-30');
    db.prepare('INSERT INTO documents (id, project_id, file_name, file_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('other-doc', 'other-project', 'other.pdf', 'pdf', '완료', '2026-10-30');
    db.prepare('INSERT INTO paragraphs (id, document_id, sequence_no, location, content) VALUES (?, ?, ?, ?, ?)')
      .run('other-paragraph', 'other-doc', 1, '가상 위치', otherBan);
    db.prepare('INSERT INTO sentences (id, document_id, paragraph_id, sequence_no, location, content, is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run('ban-other', 'other-doc', 'other-paragraph', 1, '가상 위치', otherBan);
    const evidence = db.prepare(`SELECT e.id, e.suggestion_id FROM evidences e JOIN suggestions s ON e.suggestion_id=s.id WHERE s.indicator_id=? LIMIT 1`).get('ind-activity') as { id: string; suggestion_id: string };
    db.prepare('UPDATE evidences SET quote = ?, is_citation_banned = 0 WHERE id = ?').run(projectBan, evidence.id);
    db.prepare('INSERT INTO evidences (id, suggestion_id, quote, document_id, location, speaker, is_citation_banned) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run('ev-other-project-ban', evidence.suggestion_id, otherBan, existing.document_id, '가상 위치', '협력국');
    return { evidenceId: evidence.id, db };
  }

  it('프로젝트 금지문은 브라우저 props에 실리지 않는다', async () => {
    const { evidenceId } = await pageWithBans();
    const page = await ReviewPage({
      params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      searchParams: Promise.resolve({ indicatorId: 'ind-activity', snippet: evidenceId, open: 'source' }),
    });
    expect(JSON.stringify(page.props)).not.toContain(projectBan);
    expect(page.props.initialAutoOpenSnippetId).toBeNull();
    const item = page.props.initialData.indicators.find((entry: any) => entry.indicator.id === 'ind-activity');
    expect(item.suggestion.evidences.find((entry: any) => entry.id === evidenceId)).toMatchObject({
      quote: '인용 금지 문장 있음',
      is_citation_banned: 1,
    });
    const unrelatedBan = page.props.initialData.indicators.find((entry: any) => entry.indicator.id === 'ind-activity')
      .suggestion.evidences.find((entry: any) => entry.id === 'ev-other-project-ban');
    expect(unrelatedBan).toMatchObject({ quote: otherBan, is_citation_banned: 0 });
    const otherProjectBanPage = await ReviewPage({
      params: Promise.resolve({ projectId: SEED_PROJECT_ID }),
      searchParams: Promise.resolve({ indicatorId: 'ind-activity', snippet: 'ev-other-project-ban', open: 'source' }),
    });
    expect(otherProjectBanPage.props.initialAutoOpenSnippetId).toBe('ev-other-project-ban');
  });

  it('금지 근거는 닫고 무관한 근거는 서버 판정 후 열며 갱신 때 다시 확인한다', async () => {
    const { evidenceId, db } = await pageWithBans();
    const searchParams = Promise.resolve({ indicatorId: 'ind-activity', snippet: evidenceId, open: 'source' });
    const bannedPage = await ReviewPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }), searchParams });
    expect(bannedPage.props.initialAutoOpenSnippetId).toBeNull();

    db.prepare('UPDATE evidences SET quote = ?, is_citation_banned = 0 WHERE id = ?').run('관계없는 가상 근거 문장입니다.', evidenceId);
    const safePage = await ReviewPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }), searchParams });
    expect(safePage.props.initialAutoOpenSnippetId).toBe(evidenceId);

    const props = safePage.props;
    ReviewClientView(props);
    hooks.effects.forEach((effect) => effect());
    // Identify the panel state by the opened evidence, independent of hook order.
    const opened = hooks.updates.filter((update) => (update.value as Record<string, boolean> | null)?.[evidenceId] === true);
    expect(opened).toHaveLength(1);
    const panelState = opened[0].index;

    const changed = structuredClone(props.initialData);
    const selected = changed.indicators.find((entry: any) => entry.indicator.id === 'ind-activity');
    selected.suggestion.evidences.find((entry: any) => entry.id === evidenceId).is_citation_banned = 1;
    // Locate the data state by the page data object, as used by action responses.
    const dataState = hooks.states.findIndex((state) => state === props.initialData);
    expect(dataState).toBeGreaterThanOrEqual(0);
    hooks.setters[dataState](changed);
    const changedProps = props;
    hooks.effects.length = 0;
    hooks.updates.length = 0;
    hooks.index = 0;
    ReviewClientView(changedProps);
    hooks.effects.forEach((effect) => effect());
    expect(hooks.updates).toContainEqual({ index: panelState, value: {} });
  });

  it('hides an evidence card when citation status is unknown', async () => {
    await pageWithBans();
    const page = await ReviewPage({ params: Promise.resolve({ projectId: SEED_PROJECT_ID }), searchParams: Promise.resolve({ indicatorId: 'ind-activity' }) });
    const data = structuredClone(page.props.initialData);
    const indicator = data.indicators.find((item: any) => item.indicator.id === 'ind-activity');
    const evidence = indicator.suggestion.evidences[0];
    evidence.quote = projectBan;
    delete evidence.is_citation_banned;
    const tree = ReviewClientView({ ...page.props, initialData: data });
    expect(findTestId(tree, 'citation-banned-notice-0')).not.toBeNull();
    expect(findTestId(tree, 'evidence-quote-0')).toBeNull();
  });
});
