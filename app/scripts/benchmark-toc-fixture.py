"""Copy the synthetic startup fixture and add a 14-row PDM and plan documents."""
import os
import sqlite3
import sys

scratch = os.path.realpath(os.environ['TMPDIR']) + os.sep
source, target = (os.path.realpath(p) for p in sys.argv[1:3])
if not source.startswith(scratch) or not target.startswith(scratch) or os.path.exists(target):
    raise ValueError('Both databases must be under TMPDIR; target must not exist')
with sqlite3.connect(source) as original, sqlite3.connect(target) as db:
    original.backup(db)
    rows = [['단계', '서술', '지표(OVI)', '검증수단', '목표값']]
    rows += [['산출물', f'고유지표 {i}', f'고유지표 {i}', '가상 수단', '10명'] for i in range(14)]
    for row_index, row in enumerate(rows):
        for col_index, content in enumerate(row):
            db.execute('UPDATE paragraphs SET content=?, table_index=0, table_cols=5, table_row=?, table_col=? WHERE id=?',
                       (content, row_index + 1, col_index + 1, f'project-0-doc-0-paragraph-{row_index * 5 + col_index}'))
    for i in range(1, 50, 2):
        db.execute("UPDATE documents SET doc_type='사업계획서' WHERE id=?", (f'project-0-doc-{i}',))
