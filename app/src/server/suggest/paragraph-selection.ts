import type { IndicatorBaselineRecord, IndicatorRecord, ParagraphRecord } from '../store';

export const DEFAULT_SUGGEST_MAX_INPUT_CHARS = 30000;
export const DEFAULT_SUGGEST_MAX_PARAGRAPHS = 150;
const MAX_PARAGRAPH_CHARS = 4000;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
export function getSuggestMaxInputChars(value = process.env.AIEAS_SUGGEST_MAX_INPUT_CHARS): number {
  return positiveInteger(value, DEFAULT_SUGGEST_MAX_INPUT_CHARS);
}
export function getSuggestMaxParagraphs(value = process.env.AIEAS_SUGGEST_MAX_PARAGRAPHS): number {
  return positiveInteger(value, DEFAULT_SUGGEST_MAX_PARAGRAPHS);
}

// Dates are consumed before numbers so their components cannot match quantities.
function terms(text: string): Set<string> {
  const result = new Set<string>();
  const tokens = text.toLowerCase().match(/\d{4}(?:[-.]\d{1,2}(?:[-.]\d{1,2})?|년\s*\d{1,2}월(?:\s*\d{1,2}일)?)|\d+(?:[.,]\d+)?\s*(?:%|[가-힣a-z]{1,2})?|[가-힣]+|[a-z]+/g) ?? [];
  for (const token of tokens) {
    if (/^\d/.test(token)) {
      const compact = token.replace(/\s+/g, '');
      if (/^\d{4}(?:[-.]\d{1,2}|년)/.test(compact)) result.add(`d:${compact}`);
      else {
        const number = compact.match(/^\d+(?:[.,]\d+)?/)![0];
        result.add(`n:${number}`);
        if (compact !== number) {
          const unit = compact.slice(number.length);
          result.add(`q:${number}${unit}`);
          if (unit.length === 2) result.add(`q:${number}${unit[0]}`);
        }
      }
    } else if (/^[가-힣]+$/.test(token)) {
      if (token.length === 1) result.add(`k:${token}`);
      else for (let i = 0; i + 1 < token.length; i++) result.add(`k:${token.slice(i, i + 2)}`);
    } else result.add(`w:${token}`);
  }
  return result;
}

function safeSlice(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
function jsonItem(p: ParagraphRecord, content: string): string {
  return JSON.stringify({ document_id: p.document_id, location: p.location, content });
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const locations = new Intl.Collator('ko', { numeric: true });

export function selectParagraphsForText(query: string, paragraphs: ParagraphRecord[], maxChars = getSuggestMaxInputChars(), maxParagraphs = getSuggestMaxParagraphs()) {
  const budget = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_SUGGEST_MAX_INPUT_CHARS;
  const limit = Number.isSafeInteger(maxParagraphs) && maxParagraphs > 0 ? maxParagraphs : DEFAULT_SUGGEST_MAX_PARAGRAPHS;
  const wanted = terms(query);
  const frequencies = new Map<string, number>();
  const entries = [...paragraphs].sort((a, b) => compare(a.document_id, b.document_id) || locations.compare(a.location, b.location) || compare(a.location, b.location) || a.sequence_no - b.sequence_no || compare(a.id, b.id)).map((paragraph, index) => {
    const content = safeSlice(paragraph.content, MAX_PARAGRAPH_CHARS);
    const matches = [...terms(content)].filter((term) => wanted.has(term));
    for (const term of matches) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { paragraph, content, index, matches, score: 0 };
  });
  for (const entry of entries) {
    for (const term of entry.matches) {
      const weight = term.startsWith('q:') ? 5 : term.startsWith('n:') || term.startsWith('d:') ? 3 : 1;
      entry.score += weight * Math.log(1 + (entries.length - (frequencies.get(term) ?? 0) + 0.5) / ((frequencies.get(term) ?? 0) + 0.5));
    }
    entry.score /= Math.sqrt(Math.max(1, entry.content.length));
  }
  const ranked = entries.filter((e) => e.content && e.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Map<number, { paragraph: ParagraphRecord; content: string }>();
  let used = 2; // array brackets and commas are included
  let sentCharacterCount = 0;
  function add(entry: typeof entries[number]) {
    if (!entry.content || selected.has(entry.index) || selected.size >= limit) return;
    const available = budget - used - (selected.size ? 1 : 0);
    if (available <= jsonItem(entry.paragraph, '').length) return;
    let low = 0, high = entry.content.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (jsonItem(entry.paragraph, safeSlice(entry.content, mid)).length <= available) low = mid;
      else high = mid - 1;
    }
    const content = safeSlice(entry.content, low);
    if (!content) return;
    used += jsonItem(entry.paragraph, content).length + (selected.size ? 1 : 0);
    sentCharacterCount += content.length;
    selected.set(entry.index, { paragraph: entry.paragraph, content });
  }
  if (ranked.length) {
    for (const entry of ranked) add(entry);
    for (const entry of ranked) {
      if (!selected.has(entry.index)) continue;
      for (const i of [entry.index - 1, entry.index + 1]) {
        const neighbor = entries[i];
        if (neighbor && neighbor.paragraph.document_id === entry.paragraph.document_id && neighbor.score === 0) add(neighbor);
      }
    }
  } else for (const entry of entries) add(entry);
  const result = [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, { paragraph, content }]) => ({ ...paragraph, content }));
  return { paragraphs: result, sentParagraphCount: result.length, totalParagraphCount: paragraphs.length, sentCharacterCount };
}

export function selectParagraphsForIndicator(indicator: IndicatorRecord, paragraphs: ParagraphRecord[], baseline?: IndicatorBaselineRecord | null, maxChars?: number) {
  return selectParagraphsForText([indicator.name, indicator.ovi, indicator.mov, indicator.target_value, baseline?.target_value].filter(Boolean).join(' '), paragraphs, maxChars);
}
