# Ontology vault reader

`importVault(path)` reads Markdown notes and returns one isolated graph per `project` note. Shared nodes are copied into each graph. `checkVault(path)` reports error and warning metadata (`file`, `field`, `rule`) without note text. `toVaultExchange(graph)` maps a graph to the `window.VAULT` field names.

The vault reader remains read-only: it does not write to a vault or export review results. The W-17 step 2 persistence entry point, `store.ts`, writes isolated snapshots into the app project's SQLite database through the `server/store` boundary. `/api/projects/[projectId]/ontology` exposes only synthetic fixture selection and project-scoped result lookup. Fixture paths resolve from the app working directory (`fixtures/ontology`), which the development deployment archive includes with the rest of `app/`.

The `ontology_snippets.data_json` field retains only each synthetic snippet's ID, source reference, locator, and quoted sentence so W-17 step 3 can compare that quote with its source text. It deliberately does not retain the snippet's facts, AI interpretation, uncertainty notes, or unrelated metadata. Node and source rows keep an empty `data_json` object for compatibility with the step 2 schema; their full payloads are not persisted because no current query uses them.
