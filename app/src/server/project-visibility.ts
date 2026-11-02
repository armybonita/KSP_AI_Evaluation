import { notFound } from 'next/navigation';
import { getProject } from '@/server/store';
import { currentViewer, type Viewer, viewerFromHeaders } from '@/server/viewer';

export const GUEST_HIDDEN_PROJECT_MARKERS = [
  'KDI',
  'KSP',
  '국제개발협력센터',
  '한국개발연구원',
  '경제발전경험공유',
  'Knowledge Sharing',
  '헝가리',
  'Hungar',
  '우즈베키',
  'Uzbek',
] as const;

export function isGuestHiddenProjectName(name: string): boolean {
  const foldedName = name.toLowerCase();

  return GUEST_HIDDEN_PROJECT_MARKERS.some((marker) => {
    if (marker === 'KDI' || marker === 'KSP') {
      const abbreviation = marker.toLowerCase();
      const pattern = new RegExp(`(^|[^a-z])${abbreviation}(?=$|[^a-z])`, 'i');
      return pattern.test(name);
    }

    return foldedName.includes(marker.toLowerCase());
  });
}

export function filterProjectsForViewer<T extends { name: string }>(
  projects: readonly T[],
  viewer: Viewer
): T[] {
  if (viewer.kind !== 'guest') return [...projects];
  return [];
}

export async function filterProjectsForCurrentViewer<T extends { name: string }>(
  projects: readonly T[]
): Promise<T[]> {
  return filterProjectsForViewer(projects, await currentViewer());
}

type HeaderReader = { get(name: string): string | null };

export async function isProjectHiddenFromViewer(
  projectId: string,
  requestHeaders?: HeaderReader
): Promise<boolean> {
  const project = getProject(projectId);
  if (!project) return false;

  const viewer = requestHeaders
    ? viewerFromHeaders(requestHeaders)
    : await currentViewer();
  return viewer.kind === 'guest';
}

export async function assertProjectVisibleToCurrentViewer(
  projectId: string
): Promise<void> {
  if (await isProjectHiddenFromViewer(projectId)) notFound();
}
