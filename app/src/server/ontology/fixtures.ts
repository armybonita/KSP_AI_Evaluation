import path from 'node:path';
import { importVault } from './importer';
import type { OntologyGraph } from './types';

/** Deployment archives include the complete app/ tree, including fixtures/ontology. */
export function loadSyntheticOntologyGraphs(): OntologyGraph[] {
  return importVault(path.join(process.cwd(), 'fixtures', 'ontology'));
}
