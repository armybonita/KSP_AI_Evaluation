// DB access stays inside app/src/server/store/ per the app boundary contract.
// This ontology-facing entry point keeps the public API beside the importer.
export {
  getProjectOntology,
  getProjectOntologyGraph,
  getProjectOntologyEvidenceSource,
  listProjectOntologyEvidence,
  replaceProjectOntology,
} from '../store/ontology';
export type {
  OntologyEvidenceList,
  OntologyEvidenceView,
  OntologyImportRecord,
  OntologyIssueRecord,
  OntologyProjectEdge,
  OntologyProjectGraph,
  OntologyProjectNode,
  OntologyNodeStatement,
  OntologySourceView,
  OntologySummary,
} from '../store/ontology';
