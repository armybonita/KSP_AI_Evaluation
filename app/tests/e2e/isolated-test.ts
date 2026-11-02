import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Each test gets a private DB and upload directory. The application process is
// restarted against that DB, so its open SQLite handle can never outlive or
// point at a different test's files. The Next build is shared and immutable.
export const test = base.extend<{ isolatedServer: void }>({
  isolatedServer: [async ({}, use, testInfo) => {
    const runDir = process.env.AIEAS_E2E_RUN_DIR;
    const seedDb = process.env.AIEAS_E2E_SEED_DB;
    if (!runDir || !seedDb) throw new Error('Run E2E through npm run e2e to prepare isolated databases.');
    if (testInfo.config.workers !== 1) throw new Error('E2E servers share one port; use one worker.');
    const dir = fs.mkdtempSync(path.join(runDir, 'case-'));
    const dbPath = path.join(dir, 'test.db');
    const uploadDir = path.join(dir, 'uploads');
    fs.copyFileSync(seedDb, dbPath);
    fs.mkdirSync(uploadDir);
    const oldDb = process.env.AIEAS_DB_PATH;
    const oldUpload = process.env.AIEAS_UPLOAD_DIR;
    process.env.AIEAS_DB_PATH = dbPath;
    process.env.AIEAS_UPLOAD_DIR = uploadDir;
    const port = process.env.PORT || '3041';
    const child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'start', '-p', port], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AIEAS_AUTH_MODE: 'proxy',
        AIEAS_ROLE_MAP: JSON.stringify({ admin: 'Admin', planner: '기획팀', owner: 'PO' }),
        AIEAS_E2E_FAKE_AI: '1',
        AIEAS_AI_PROVIDER: 'solar',
        AIEAS_LLM_BASE_URL: '',
        AIEAS_LLM_API_KEY: '',
        AIEAS_MODEL: 'aieas-default',
        AIEAS_REASONING_EFFORT: 'xhigh',
        NEXT_DIST_DIR: '.next-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
    try {
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`E2E server exited before ready: ${output}`);
        if (output.includes('Ready in')) {
          try {
            const response = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { ready = true; break; }
          } catch { /* wait for this server's health endpoint */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error(`E2E server failed readiness: ${output}`);
      await use();
      if (testInfo.status !== testInfo.expectedStatus) console.error(`[E2E 서버 로그]\n${output}`);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(force);
      }
      if (oldDb === undefined) delete process.env.AIEAS_DB_PATH; else process.env.AIEAS_DB_PATH = oldDb;
      if (oldUpload === undefined) delete process.env.AIEAS_UPLOAD_DIR; else process.env.AIEAS_UPLOAD_DIR = oldUpload;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, { auto: true, timeout: 45000 }],
});
export { expect };
