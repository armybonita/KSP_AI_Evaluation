import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openExistingDatabaseForWrite } from '../src/server/store/db';
import { migrateAdditiveSchema } from '../src/server/store/additive-migration';

// Require an explicit existing database so a typo cannot silently migrate a new file.
const dbPath = process.env.AIEAS_DB_PATH;
if (!dbPath || !isAbsolute(dbPath) || !statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('AIEAS_DB_PATH must be the absolute path of an existing database file');
}

const db = openExistingDatabaseForWrite(dbPath);
try {
  db.pragma('journal_mode = WAL');
  migrateAdditiveSchema(db);
  console.log('Database migration finished');
} finally {
  db.close();
}
