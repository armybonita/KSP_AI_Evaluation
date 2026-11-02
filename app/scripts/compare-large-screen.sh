#!/usr/bin/env bash
# Compare baseline commit (default a69c7c2) and this checkout on independent copies of one synthetic DB.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
: "${TMPDIR:?Set TMPDIR to the synthetic scratch directory}"
: "${BASELINE_COMMIT:=a69c7c2}"
source_db="${1:?Pass an absolute path to the prepared synthetic database under TMPDIR}"
case "$source_db" in "$TMPDIR"/*) ;; *) echo 'synthetic database must be under TMPDIR' >&2; exit 1;; esac
scratch="$(mktemp -d "$TMPDIR/lr2-equality.XXXXXXXX")"
mkdir -p "$scratch/baseline"
git -C "$root" archive "$BASELINE_COMMIT" app | tar -x -C "$scratch/baseline"
ln -s "$root/app/node_modules" "$scratch/baseline/app/node_modules"
python3 - "$source_db" "$scratch/old.sqlite" "$scratch/new.sqlite" <<'PY'
import sqlite3, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True) as source:
    for path in sys.argv[2:]:
        with sqlite3.connect(path) as target:
            source.backup(target)
PY
prefix="$(basename "$scratch")"
for mode in note_json review_json report_json toc_json graph_json; do
  for iteration in first second; do
    (cd "$scratch/baseline/app" && AIEAS_DB_PATH="$scratch/old.sqlite" SNAPSHOT_PREFIX="$prefix-old-$iteration" "$root/app/node_modules/.bin/tsx" scripts/benchmark-screen.ts "$mode")
    (cd "$root/app" && AIEAS_DB_PATH="$scratch/new.sqlite" SNAPSHOT_PREFIX="$prefix-new-$iteration" "$root/app/node_modules/.bin/tsx" scripts/benchmark-screen.ts "$mode")
    cmp "$TMPDIR/$prefix-old-$iteration-$mode.json" "$TMPDIR/$prefix-new-$iteration-$mode.json"
    printf '%s %s: equal\n' "$mode" "$iteration"
  done
done
printf 'Databases and baseline: %s\n' "$scratch"
