import { test, expect } from './isolated-test';
import os from 'node:os';
import path from 'node:path';

// 가상 시드만 사용하는 화면 증거. 두 링크와 실제 줄바꿈을 함께 확인한다.
test('사업 카드와 초기 ToC 화면을 두 너비에서 확인한다', async ({ page }) => {
  const shotsDir = process.env.AIEAS_SCREEN_SHOTS_DIR ?? path.join(os.tmpdir(), 'aieas-screen-shots');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/projects');
  const card = page.getByTestId('project-card-proj-dev-seed');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('open-pdm-proj-dev-seed')).toBeInViewport();
  await expect(card.getByTestId('open-pcp-proj-dev-seed')).toBeInViewport();
  await page.screenshot({ path: path.join(shotsDir, 'project-list.png') });
  await card.screenshot({ path: path.join(shotsDir, 'project-card.png') });
  await page.setViewportSize({ width: 1024, height: 900 });
  await card.scrollIntoViewIfNeeded();
  for (const kind of ['pdm', 'pcp']) {
    const link = card.getByTestId(`open-${kind}-proj-dev-seed`);
    await expect(link).toBeInViewport({ ratio: 1 });
    const metrics = await link.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = element.getBoundingClientRect();
      return { lines: range.getClientRects().length, left: rect.left, right: rect.right };
    });
    expect(metrics.lines).toBe(1);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(1024);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(shotsDir, 'project-list-1024.png') });

  await page.goto('/projects/proj-dev-seed/toc');
  const section = page.getByTestId('outcome-final-results-section');
  const scroll = page.getByTestId('outcome-table-scroll');
  await expect(section).toBeVisible();
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await section.scrollIntoViewIfNeeded();
    await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const links = section.locator('a[data-testid^="review-link-"], a[data-testid^="report-link-"]');
    expect(await links.count()).toBeGreaterThan(0);
    for (const link of await links.all()) {
      const metrics = await link.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return { lines: range.getClientRects().length, whitespace: getComputedStyle(element).whiteSpace };
      });
      expect(metrics.lines).toBe(1);
      expect(metrics.whitespace).toBe('nowrap');
    }
    for (const kind of ['unit', 'baseline', 'status', 'evidence']) {
      const cells = section.locator(`[data-outcome-cell="${kind}"]`);
      expect(await cells.count()).toBeGreaterThan(0);
      for (const cell of await cells.all()) {
        const metrics = await cell.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const lines: number[] = [];
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) lines.push(rect.top);
          }
          return { lines: new Set(lines).size, whitespace: getComputedStyle(element).whiteSpace };
        });
        expect(metrics.whitespace).toBe('nowrap');
        expect(metrics.lines).toBe(1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(shotsDir, `initial-toc-${width}.png`) });
  }
});
