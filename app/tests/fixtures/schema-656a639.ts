export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  status TEXT NOT NULL,
  doc_type TEXT,
  is_included INTEGER NOT NULL DEFAULT 1,
  excluded_reason TEXT,
  masked INTEGER,
  approved_ai TEXT NOT NULL DEFAULT 'solar',
  is_past_final_report INTEGER,
  inclusion_source TEXT NOT NULL DEFAULT 'auto',
  doctype_source TEXT NOT NULL DEFAULT 'auto',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  table_index INTEGER,
  table_cols INTEGER,
  table_row INTEGER,
  table_col INTEGER
);

CREATE TABLE IF NOT EXISTS indicators (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  ovi TEXT NOT NULL,
  mov TEXT,
  target_value TEXT,
  parent_id TEXT REFERENCES indicators(id) ON DELETE SET NULL,
  source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_location TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  is_unknown_level INTEGER NOT NULL DEFAULT 0,
  is_orphaned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  doc_a_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_a_name TEXT NOT NULL,
  doc_a_value TEXT NOT NULL,
  doc_a_location TEXT,
  doc_b_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  doc_b_name TEXT NOT NULL,
  doc_b_value TEXT NOT NULL,
  doc_b_location TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  target_value TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  conflict_id TEXT,
  other_doc_id TEXT
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  verdict_status TEXT NOT NULL CHECK(verdict_status IN ('실현', '추진 중', '기대', '미확인', '근거 충돌')),
  error_reason TEXT,
  proposal_text TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidences (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  quote TEXT NOT NULL CHECK(length(trim(quote, ' '||char(9)||char(10)||char(13))) > 0),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE CHECK(length(trim(document_id, ' '||char(9)||char(10)||char(13))) > 0),
  location TEXT NOT NULL CHECK(length(trim(location, ' '||char(9)||char(10)||char(13))) > 0),
  speaker TEXT NOT NULL CHECK(length(trim(speaker, ' '||char(9)||char(10)||char(13))) > 0),
  is_citation_banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  location TEXT NOT NULL,
  content TEXT NOT NULL,
  is_citation_banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indicator_attributions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  indicator_id TEXT NOT NULL UNIQUE REFERENCES indicators(id) ON DELETE CASCADE,
  attribution_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  suggestion_id TEXT REFERENCES suggestions(id),
  confirmation_type TEXT NOT NULL CHECK(confirmation_type IN ('확정', '수정 후 확정', '보완 필요', '채택 제외')),
  initial_proposal TEXT,
  edited_text TEXT,
  edited_verdict_status TEXT CHECK(edited_verdict_status IS NULL OR edited_verdict_status IN ('실현', '추진 중', '기대', '미확인', '근거 충돌')),
  reason TEXT,
  confirmer_name TEXT NOT NULL CHECK(length(trim(confirmer_name, ' '||char(9)||char(10)||char(13))) > 0),
  created_at TEXT NOT NULL,
  CHECK (
    confirmation_type != '수정 후 확정' OR (
      edited_text IS NOT NULL AND length(trim(edited_text, ' '||char(9)||char(10)||char(13))) > 0 AND
      reason IS NOT NULL AND length(trim(reason, ' '||char(9)||char(10)||char(13))) > 0
    )
  )
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- W-17 ontology snapshots are scoped to the owning app project. Import rows are
-- retained as history; the graph tables below describe each immutable run.
CREATE TABLE IF NOT EXISTS ontology_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vault_code TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  snippet_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  executor TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'vault',
  model_name TEXT,
  document_success_count INTEGER NOT NULL DEFAULT 0,
  document_failure_count INTEGER NOT NULL DEFAULT 0,
  discarded_quote_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ontology_generation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed')),
  completed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_generation_one_active ON ontology_generation_runs(project_id) WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS ontology_nodes (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_edges (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_field TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_sources (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_snippets (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE TABLE IF NOT EXISTS ontology_relation_candidates (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, source_id, target_id, relation)
);

-- Retain the node type when old graph snapshots are removed.
CREATE TABLE IF NOT EXISTS ontology_review_node_keys (
  project_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id)
);

CREATE TABLE IF NOT EXISTS ontology_review_node_aliases (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, old_node_id TEXT NOT NULL, new_node_id TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, old_node_id)
);
CREATE TABLE IF NOT EXISTS ontology_review_node_titles (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, node_id TEXT NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id)
);
CREATE TABLE IF NOT EXISTS ontology_link_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ontology_link_review_details (
  review_id TEXT PRIMARY KEY REFERENCES ontology_link_reviews(id),
  relation TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ontology_review_evidence_keys (
  project_id TEXT NOT NULL, import_id TEXT NOT NULL, node_id TEXT NOT NULL,
  source_id TEXT NOT NULL, locator TEXT NOT NULL, quote TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, node_id, source_id, locator, quote)
);
CREATE TRIGGER IF NOT EXISTS trg_ontology_relation_candidates_no_update BEFORE UPDATE ON ontology_relation_candidates BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_relation_candidates_no_delete BEFORE DELETE ON ontology_relation_candidates BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_keys_no_update BEFORE UPDATE ON ontology_review_node_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_keys_no_delete BEFORE DELETE ON ontology_review_node_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_keys_no_update BEFORE UPDATE ON ontology_review_evidence_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_evidence_keys_no_delete BEFORE DELETE ON ontology_review_evidence_keys BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_aliases_no_update BEFORE UPDATE ON ontology_review_node_aliases BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_aliases_no_delete BEFORE DELETE ON ontology_review_node_aliases BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_titles_no_update BEFORE UPDATE ON ontology_review_node_titles BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_ontology_review_node_titles_no_delete BEFORE DELETE ON ontology_review_node_titles BEGIN SELECT RAISE(ABORT, '검토 자료는 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_link_details_no_update BEFORE UPDATE ON ontology_link_review_details BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_link_details_no_delete BEFORE DELETE ON ontology_link_review_details BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;

CREATE TABLE IF NOT EXISTS ontology_note_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id),
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  original_text TEXT NOT NULL,
  outcome_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ontology_note_reviews ON ontology_note_reviews(project_id, import_id, node_id, created_at);

CREATE TABLE IF NOT EXISTS ontology_check_issues (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES ontology_imports(id) ON DELETE CASCADE,
  rule_number TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('error', 'warning')),
  file TEXT NOT NULL,
  field TEXT NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (project_id, import_id, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_paragraphs_document_id ON paragraphs(document_id);
CREATE INDEX IF NOT EXISTS idx_sentences_document_id ON sentences(document_id);
CREATE INDEX IF NOT EXISTS idx_sentences_paragraph_id ON sentences(paragraph_id);
CREATE INDEX IF NOT EXISTS idx_sentences_banned ON sentences(is_citation_banned);
CREATE INDEX IF NOT EXISTS idx_indicators_project_id ON indicators(project_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_project_id ON indicator_conflicts(project_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_indicator_id ON indicator_conflicts(indicator_id);
CREATE INDEX IF NOT EXISTS idx_baselines_project_id ON indicator_baselines(project_id);
CREATE INDEX IF NOT EXISTS idx_baselines_indicator_id ON indicator_baselines(indicator_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_indicator_id ON suggestions(indicator_id);
CREATE INDEX IF NOT EXISTS idx_evidences_suggestion_id ON evidences(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_indicator_attributions_project ON indicator_attributions(project_id);
CREATE INDEX IF NOT EXISTS idx_indicator_attributions_indicator ON indicator_attributions(indicator_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_indicator_id ON confirmations(indicator_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_created_at ON confirmations(created_at);
CREATE INDEX IF NOT EXISTS idx_reports_project_id ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_ontology_imports_project ON ontology_imports(project_id, imported_at DESC);
CREATE INDEX IF NOT EXISTS idx_ontology_nodes_latest ON ontology_nodes(project_id, import_id, node_type);
CREATE INDEX IF NOT EXISTS idx_ontology_edges_latest ON ontology_edges(project_id, import_id, relation_field);
CREATE INDEX IF NOT EXISTS idx_ontology_issues_latest ON ontology_check_issues(project_id, import_id, severity);

CREATE TRIGGER IF NOT EXISTS trg_prevent_note_reviews_update
BEFORE UPDATE ON ontology_note_reviews BEGIN SELECT RAISE(ABORT, '검토 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_note_reviews_delete
BEFORE DELETE ON ontology_note_reviews BEGIN SELECT RAISE(ABORT, '검토 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_link_reviews_update
BEFORE UPDATE ON ontology_link_reviews BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;
CREATE TRIGGER IF NOT EXISTS trg_prevent_link_reviews_delete
BEFORE DELETE ON ontology_link_reviews BEGIN SELECT RAISE(ABORT, '연결 이력은 추가만 허용합니다.'); END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_confirmations_update
BEFORE UPDATE ON confirmations
BEGIN
  SELECT RAISE(ABORT, '확정 이력은 수정할 수 없습니다 (추가만 허용).');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_confirmations_delete
BEFORE DELETE ON confirmations
BEGIN
  SELECT RAISE(ABORT, '확정 이력은 삭제할 수 없습니다 (추가만 허용).');
END;
`;
