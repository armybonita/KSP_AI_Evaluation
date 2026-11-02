import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const appDir = path.resolve(scriptDir, '..');

const TARGET_PROJECT_ID = 'proj-dev-seed';
const TARGET_INDICATOR_ID = 'ind-output';

function printUsage() {
  console.error(
    [
      '사용법 (대상은 proj-dev-seed / ind-output 으로 고정):',
      '  node scripts/reset-seed-indicator.mjs <db-파일-경로> [--dry-run]',
      '  node app/scripts/reset-seed-indicator.mjs --db <db-파일-경로> [--dry-run]',
      '  npx --prefix app tsx app/scripts/reset-seed-indicator.mjs <db-파일-경로> [--dry-run]',
    ].join('\n')
  );
}

// 일반 node 로 바로 실행된 경우 tsx 로 재실행하여 TypeScript 모듈(seed-dev.ts, src/server/store)을 직접 가져온다.
const isRunningUnderTsx =
  process.env.AIEAS_RESET_SEED_TSX === '1' ||
  process.execArgv.some((arg) => arg.includes('tsx'));

if (!isRunningUnderTsx) {
  const tsxBin = path.resolve(appDir, 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(tsxBin)) {
    try {
      execFileSync(tsxBin, [scriptFile, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: {
          ...process.env,
          AIEAS_RESET_SEED_TSX: '1',
        },
      });
      process.exit(0);
    } catch (err) {
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : 1;
      process.exit(status);
    }
  }
}

function formatBackupTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function parseCliArgs(argv) {
  let dbPath = null;
  let dryRun = false;
  let help = false;
  let error = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--db') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        error = '--db 인자에 DB 파일 경로가 필요합니다.';
        break;
      }
      if (dbPath) {
        error = `DB 파일 경로가 중복으로 지정되었습니다: ${next}`;
        break;
      }
      dbPath = next;
      i += 1;
    } else if (arg.startsWith('--db=')) {
      const val = arg.slice('--db='.length);
      if (!val) {
        error = '--db 인자에 DB 파일 경로가 필요합니다.';
        break;
      }
      if (dbPath) {
        error = `DB 파일 경로가 중복으로 지정되었습니다: ${val}`;
        break;
      }
      dbPath = val;
    } else if (
      arg === '--project-id' ||
      arg.startsWith('--project-id=') ||
      arg === '--indicator-id' ||
      arg.startsWith('--indicator-id=')
    ) {
      error = `지원하지 않는 인자입니다 (${arg}). 복원 대상은 '${TARGET_PROJECT_ID}' / '${TARGET_INDICATOR_ID}' 으로 고정되어 있습니다.`;
      break;
    } else if (arg.startsWith('-')) {
      error = `알 수 없는 옵션입니다: ${arg}`;
      break;
    } else if (!dbPath) {
      dbPath = arg;
    } else {
      error = `허용되지 않는 추가 인자입니다: ${arg}`;
      break;
    }
  }

  return { dbPath, dryRun, help, error };
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[오류] ${parsed.error}`);
    printUsage();
    process.exit(1);
  }
  if (parsed.help || !parsed.dbPath) {
    printUsage();
    process.exit(parsed.help ? 0 : 1);
  }

  const resolvedDbPath = path.resolve(parsed.dbPath);
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[오류] DB 파일을 찾을 수 없습니다: ${resolvedDbPath}`);
    process.exit(1);
  }

  const {
    backupDatabase,
    closeDatabase,
    getLatestSuggestion,
    listSuggestions,
    openExistingDatabaseForWrite,
    openReadonlyDatabase,
    replaceIndicatorSuggestions,
  } = await import('../src/server/store/index.ts');
  const { buildSeedIndicatorSuggestion } = await import('./seed-dev.ts');

  let readonlyDb = null;
  let writeDb = null;
  try {
    // 1. 쓰기용 openDatabase()(WAL 설정·스키마 변경·인용 금지 근거 이관)를 부르지 않고
    //    읽기 전용 연결(readonly: true)로만 연다.
    readonlyDb = openReadonlyDatabase(resolvedDbPath);

    // 2. 일반 실행이면 어떤 쓰기 연결·초기화도 실행하기 전에 일관된 백업 사본(.backup())을 먼저 만든다.
    let backupPath = null;
    if (!parsed.dryRun) {
      backupPath = `${resolvedDbPath}.bak-${formatBackupTimestamp()}`;
      await backupDatabase(backupPath, readonlyDb);
      console.log(`[백업 완료] ${backupPath}`);
    }

    // 3. 읽기 전용 연결로 현재 값과 시드 기준 바꿀 값을 계산한다.
    const existingSuggestions = listSuggestions(TARGET_INDICATOR_ID, readonlyDb);
    const currentLatest = getLatestSuggestion(TARGET_INDICATOR_ID, readonlyDb);

    const seedTarget = await buildSeedIndicatorSuggestion({
      db: readonlyDb,
      dbPath: resolvedDbPath,
      projectId: TARGET_PROJECT_ID,
      indicatorId: TARGET_INDICATOR_ID,
    });

    const summaryPayload = {
      mode: parsed.dryRun ? 'dry-run' : 'apply',
      dbPath: resolvedDbPath,
      target: {
        project_id: TARGET_PROJECT_ID,
        indicator_id: TARGET_INDICATOR_ID,
        indicator_level: seedTarget.indicator.level,
        indicator_name: seedTarget.indicator.name,
        existing_suggestion_count: existingSuggestions.length,
      },
      before: currentLatest
        ? {
            suggestion_id: currentLatest.id,
            verdict_status: currentLatest.verdict_status,
            proposal_text: currentLatest.proposal_text,
            error_reason: currentLatest.error_reason,
            created_at: currentLatest.created_at,
            evidences: currentLatest.evidences.map((ev) => ({
              id: ev.id,
              document_id: ev.document_id,
              location: ev.location,
              speaker: ev.speaker,
              quote: ev.quote,
              is_citation_banned: ev.is_citation_banned ?? 0,
            })),
          }
        : null,
      after: {
        suggestion_id: seedTarget.suggestion.id,
        verdict_status: seedTarget.suggestion.verdict_status,
        proposal_text: seedTarget.suggestion.proposal_text,
        error_reason: seedTarget.suggestion.error_reason,
        created_at: seedTarget.suggestion.created_at,
        evidences: seedTarget.evidences.map((ev) => ({
          id: ev.id,
          document_id: ev.document_id,
          location: ev.location,
          speaker: ev.speaker,
          quote: ev.quote,
          is_citation_banned: ev.is_citation_banned ?? 0,
        })),
      },
    };

    if (parsed.dryRun) {
      console.log('[DRY-RUN] DB를 바꾸지 않고 대상 행과 현재 값·바꿀 값만 출력합니다.');
      console.log(JSON.stringify(summaryPayload, null, 2));
      return;
    }

    // 4. 백업과 읽기 전용 조회가 끝난 뒤에야 읽기 전용 연결을 닫고 쓰기 연결을 연다.
    readonlyDb.close();
    readonlyDb = null;

    // openDatabase() 는 스키마 변경과 사업 전체 인용 금지 이관을 돌리므로 쓰지 않는다(검수 2회차 지적 1).
    writeDb = openExistingDatabaseForWrite(resolvedDbPath);

    const replaceResult = replaceIndicatorSuggestions(
      TARGET_INDICATOR_ID,
      seedTarget.suggestion,
      seedTarget.evidences,
      writeDb
    );

    const updatedLatest = getLatestSuggestion(TARGET_INDICATOR_ID, writeDb);
    console.log(
      JSON.stringify(
        {
          ...summaryPayload,
          backupPath,
          deletedSuggestionIds: replaceResult.deletedSuggestionIds,
          keptSuggestionIds: replaceResult.keptSuggestionIds,
          verifiedAfter: updatedLatest
            ? {
                suggestion_id: updatedLatest.id,
                verdict_status: updatedLatest.verdict_status,
                proposal_text: updatedLatest.proposal_text,
                evidences: updatedLatest.evidences.map((ev) => ({
                  document_id: ev.document_id,
                  location: ev.location,
                  speaker: ev.speaker,
                  quote: ev.quote,
                  is_citation_banned: ev.is_citation_banned ?? 0,
                })),
              }
            : null,
        },
        null,
        2
      )
    );
  } finally {
    if (readonlyDb) {
      readonlyDb.close();
    }
    if (writeDb) {
      writeDb.close();
    }
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('[실행 오류]', err);
  process.exit(1);
});
