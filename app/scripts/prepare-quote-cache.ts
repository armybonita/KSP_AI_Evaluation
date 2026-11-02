import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openExistingDatabaseForWrite } from '../src/server/store/db';
import { prepareVirtualQuoteCache } from '../src/server/store/prepare-quote-cache';

const dbPath = process.env.AIEAS_DB_PATH;
if (!dbPath || !isAbsolute(dbPath) || !statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('AIEAS_DB_PATH must be the absolute path of an existing database file');
}
const db = openExistingDatabaseForWrite(dbPath);
try {
  const result = prepareVirtualQuoteCache(db);
  console.log(`Prepared outcome evidence and virtual quote checks: virtual projects=${result.projects}, snippets=${result.snippets}`);
} finally {
  db.close();
}
