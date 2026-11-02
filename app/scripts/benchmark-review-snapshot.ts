import { writeFileSync } from 'node:fs';
import { openDatabase } from '../src/server/store/db';
import { getNoteReviewData } from '../src/server/store/note-review';
const path = process.env.AIEAS_DB_PATH;
if (!path || !process.env.TMPDIR || !path.startsWith(`${process.env.TMPDIR}/`)) throw new Error('synthetic database required');
openDatabase(path);
writeFileSync(`${process.env.TMPDIR}/${process.argv[2]}.json`, JSON.stringify(getNoteReviewData('project-0')));
