import { performance } from 'node:perf_hooks';
import { selectParagraphsForText } from '../src/server/suggest/paragraph-selection';

const paragraphs = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), document_id: `d${Math.floor(i / 100)}`, sequence_no: i, location: `¶${i}`, content: (`교육 사업 운영 ${i}명 ` + '가상 자료 검토 성과 '.repeat(30)).slice(0, 250).padEnd(250, '가') }));
global.gc?.();
const before = process.memoryUsage();
const start = performance.now();
const result = selectParagraphsForText('교육 참여 성과 100명', paragraphs);
const elapsed = performance.now() - start;
const after = process.memoryUsage();
console.log(JSON.stringify({ paragraphs: paragraphs.length, characters: paragraphs.reduce((sum, p) => sum + p.content.length, 0), elapsed_ms: Math.round(elapsed), heap_delta_bytes: after.heapUsed - before.heapUsed, rss_delta_bytes: after.rss - before.rss, sent: result.sentParagraphCount }));
