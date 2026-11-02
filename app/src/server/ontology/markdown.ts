import { load } from 'js-yaml';
import type { OntologyNote } from './types';

export function parseMarkdownNote(path: string, raw: string): OntologyNote {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { name: basename(path), path, frontmatter: {}, body: raw, sections: splitSections(raw) };
  }
  const parsed: unknown = load(match[1]) ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a mapping');
  }
  return {
    name: basename(path),
    path,
    frontmatter: parsed as Record<string, unknown>,
    body: match[2],
    sections: splitSections(match[2]),
  };
}

export function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string[]> = { _: [] };
  let current = '_';
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.*)/);
    if (heading) {
      current = heading[1].trim();
      sections[current] ??= [];
    } else {
      sections[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

export function extractLinks(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.flatMap((item) => {
    if (typeof item !== 'string') return [];
    return [...item.matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1].trim());
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1)?.replace(/\.md$/i, '') ?? path;
}
