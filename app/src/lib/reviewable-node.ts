/** Node types exposed as note review items in the latest ontology import. */
export function isReviewableNodeType(type: string): boolean {
  return ['indicator', 'output', 'outcome-short', 'outcome-mid', 'enabler', 'constraint'].includes(type);
}
