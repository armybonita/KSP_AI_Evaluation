export type OntologyScalar = string | number | boolean | null;
export type OntologyValue = OntologyScalar | OntologyValue[] | { [key: string]: OntologyValue };

export interface OntologyNote {
  name: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  sections: Record<string, string>;
}

export interface OntologyIssue {
  severity: 'error' | 'warning';
  file: string;
  field: string;
  rule: string;
  detail?: string;
}

export interface OntologyGraph {
  code: string;
  projectName: string;
  project: Record<string, unknown>;
  sources: Record<string, Record<string, unknown>>;
  snippets: Record<string, Record<string, unknown>>;
  nodes: Record<string, Record<string, unknown>>;
  edges: Array<{ source: string; target: string; relation: string }>;
  candidates?: Array<{ source: string; target: string; relation: string }>;
  reports: Record<string, string>;
  report_status: Record<string, string>;
  issues: OntologyIssue[];
}

export interface VaultExchange {
  code: string;
  sources: OntologyGraph['sources'];
  snippets: OntologyGraph['snippets'];
  nodes: OntologyGraph['nodes'];
  reports: OntologyGraph['reports'];
  report_status: OntologyGraph['report_status'];
  project: Record<string, unknown>;
}
