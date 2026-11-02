import React from 'react';
import type { OmittedItem } from '@/lib/visibility-reasons';

/** A document notice item is named "n개 문서"; count its documents, and every other item as one. */
export function omittedCount(items: OmittedItem[]): number {
  return items.reduce((sum, item) => {
    const documents = item.reason.includes('문서는 분석과 근거에서 빠집니다') ? Number(item.name.match(/^(\d+)개 문서$/)?.[1]) : NaN;
    return sum + (Number.isFinite(documents) ? documents : 1);
  }, 0);
}

export function OmittedItems({ items }: { items: OmittedItem[] }) {
  // Nothing to list: render nothing, so this box never contradicts the document exclusion notice shown beside it.
  if (!items.length) return null;
  return <details className="rounded border border-amber-200 bg-amber-50 p-3 text-sm"><summary>{`빠진 항목 ${omittedCount(items)}건`}</summary>
    <ul className="mt-2 list-disc pl-5">{items.map((item, index) => <li key={`${index}:${item.name}`}>{item.name}: {item.reason}</li>)}</ul>
  </details>;
}
