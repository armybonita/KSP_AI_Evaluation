const { chromium } = require('playwright');
const { hasProposalContent, safeDiagnosticSummary } = require('./resuggest-smoke-assertions.cjs');

const timeoutMs = Number(process.env.AIEAS_SMOKE_TIMEOUT_MS || 240000);

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      // public-safety-allow: loopback-only URL validation
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error('invalid base URL');
    }
    return url.origin;
  } catch {
    // public-safety-allow: literal identifies the required local-only address
    throw new Error('expected plain HTTP on 127.0.0.1');
  }
}

async function main() {
  let phase = 'browser_start';
  let attempt = 0;
  let browser;
  let completed = false;

  try {
    phase = 'validate_base_url';
    const baseUrl = normalizeBaseUrl(
      // public-safety-allow: local smoke default must stay on loopback
      process.env.AIEAS_SMOKE_BASE_URL || 'http://127.0.0.1:33331'
    );
    const pageUrl = `${baseUrl}/app/projects/proj-dev-seed/review`;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', () => process.stderr.write('browser page error (details suppressed)\n'));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        process.stderr.write('browser console error (details suppressed)\n');
      }
    });
    await page.setExtraHTTPHeaders({ 'X-Auth-Request-User': 'resuggest-acceptance-check' });

    phase = 'open_review_page';
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('heading', { name: 'AI 제안 검토' }).waitFor({
      state: 'visible',
      timeout: 15000,
    });

    phase = 'select_seed_indicator';
    await page.locator('[data-testid="indicator-item-ind-activity"]').click();
    const button = page.locator('[data-testid="resuggest-button"]');
    await button.waitFor({ state: 'visible', timeout: 10000 });

    const timestamp = page.locator('[data-testid="suggestion-created-at"]');
    const proposal = page.locator('[data-testid="proposal-text"]');
    const errorBox = page.locator('[data-testid="error-reason-box"]');
    let previous = (await timestamp.innerText()).trim();

    for (attempt = 1; attempt <= 2; attempt += 1) {
      phase = 'submit_resuggest';
      process.stdout.write(`resuggest attempt ${attempt}/2: submitted\n`);
      await button.click();

      phase = 'wait_for_action_result';
      await page.waitForFunction(
        ({ oldTimestamp }) => {
          const currentTimestamp = document.querySelector('[data-testid="suggestion-created-at"]');
          const actionError = document.querySelector('[data-testid="error-banner"]');
          return (
            (currentTimestamp && currentTimestamp.textContent.trim() !== oldTimestamp) ||
            Boolean(actionError)
          );
        },
        { oldTimestamp: previous },
        { timeout: timeoutMs },
      );

      const latest = (await timestamp.innerText()).trim();
      const actionError = page.locator('[data-testid="error-banner"]');
      if ((await actionError.count()) > 0) {
        throw new Error(
          `attempt ${attempt}: action failed (${safeDiagnosticSummary(await actionError.innerText())})`
        );
      }
      if (latest === previous) {
        throw new Error(`attempt ${attempt}: action failed (no updated suggestion timestamp)`);
      }

      const hasError = (await errorBox.count()) > 0;
      if (hasError) {
        const details = page.locator('[data-testid="error-reason-details"]');
        if (await details.count()) {
          await details.locator('summary').click();
        }
        const detailText = page.locator('[data-testid="error-reason-text"]');
        const detail = (await detailText.count())
          ? safeDiagnosticSummary(await detailText.innerText())
          : safeDiagnosticSummary(await errorBox.innerText());
        throw new Error(`attempt ${attempt}: AI returned a generation error (${detail || 'details empty'})`);
      }

      const proposalText = (await proposal.count()) ? await proposal.innerText() : '';
      if (!hasProposalContent(proposalText)) {
        throw new Error(`attempt ${attempt}: updated suggestion has an empty proposal`);
      }

      process.stdout.write(`resuggest attempt ${attempt}/2: new timestamp and nonempty proposal\n`);
      previous = latest;
    }

    completed = true;
  } catch (error) {
    const message =
      phase === 'validate_base_url'
        // public-safety-allow: safe diagnostic names the local-only address
        ? 'AIEAS_SMOKE_BASE_URL must use plain HTTP on 127.0.0.1'
        : safeDiagnosticSummary(error instanceof Error ? error.message : error);
    process.stderr.write(`FAIL: phase=${phase} attempt=${attempt || 'setup'} ${message}\n`);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        process.stderr.write('FAIL: phase=browser_close attempt=2 browser close failed (details suppressed)\n');
        process.exitCode = 1;
      }
    }
  }

  if (completed && process.exitCode !== 1) {
    process.stdout.write('PASS: two consecutive successful resuggest actions\n');
  }
}

if (require.main === module) {
  main();
}

module.exports = { normalizeBaseUrl };
