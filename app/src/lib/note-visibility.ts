export type NoteStatusItem = { id: string; type: string; title: string; status?: string; splitPending?: boolean; history?: Array<{ status: string }> };

export function noteStatus(item: NoteStatusItem): string {
  return item.splitPending ? '미검토' : item.status ?? item.history?.at(-1)?.status ?? '미검토';
}
