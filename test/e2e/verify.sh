#!/usr/bin/env bash
# Live E2E fixture for the lmstudio-warm opencode plugin. See ./README.md.
#
# Set MAIN and SMALL to two real LM Studio model keys before running (the
# defaults are placeholders and the script refuses to run with them). It `cd`s
# to its own directory and renders opencode.json (gitignored) from
# opencode.template.json with those keys, so the WHOLE fixture config —
# model, small_model, provider.models — uses real keys and the plugin's eager
# warm never chases a placeholder; .opencode/plugin/ makes the plugin auto-load.
# Requires: jq, lms, opencode, and a running LM Studio with both models present.
#
# If LM Studio API auth is enabled, export LM_API_TOKEN first for full
# end-to-end generation; without it the runs end in a 401 AFTER the warm gate,
# which still proves every pre-warm property (the checks below only assert on
# plugin log ordering and `lms ps` state, which are auth-independent).
set -uo pipefail

LMS="${LMS:-$HOME/.lmstudio/bin/lms}"
MAIN="${MAIN:-your-main-model-key}"
SMALL="${SMALL:-your-small-model-key}"
LOG="$HOME/.cache/opencode/lmstudio-warm.log"
cd "$(dirname "$0")" || exit 1

case "$MAIN$SMALL" in
  *your-*-model-key*) echo "Set MAIN and SMALL to two real LM Studio model keys (see ./README.md)" >&2; exit 2 ;;
esac

# Render the fixture config from the template (rendered file is gitignored).
jq --arg m "$MAIN" --arg s "$SMALL" '
  .model = "lmstudio/" + $m
  | .small_model = "lmstudio/" + $s
  | .provider.lmstudio.models = { ($m): { name: "E2E main model" }, ($s): { name: "E2E small model" } }
' opencode.template.json > opencode.json || exit 1

pass=0; fail=0
say()    { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()     { printf '\033[32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()    { printf '\033[31mFAIL\033[0m %s\n' "$*"; fail=$((fail+1)); }
inst()   { "$LMS" ps --json 2>/dev/null | jq --arg k "$1" '[.[]|select(.modelKey==$k)]|length'; }
addr()   { "$LMS" ps --json 2>/dev/null | jq --arg k "$1" '[.[]|select(.identifier==$k)]|length'; }
loads()  { grep -c "loading $1 " "$LOG" 2>/dev/null || true; }

say "(a) cold spawn: model loads BEFORE the first request"
"$LMS" unload "$MAIN" >/dev/null 2>&1
: > "$LOG"
timeout 600 opencode run -m "lmstudio/$MAIN" "Reply with exactly: WARM-OK" >/dev/null 2>&1
[ "$(loads "$MAIN")" -eq 1 ] && ok "plugin performed exactly one load" || bad "expected 1 load, got $(loads "$MAIN")"
grep -q "loaded $MAIN in" "$LOG" && ok "load completed (blocking barrier held)" || bad "no 'loaded' line in $LOG"
[ "$(inst "$MAIN")" -eq 1 ] && [ "$(addr "$MAIN")" -eq 1 ] && ok "exactly 1 instance, identifier unsuffixed" || bad "instances=$(inst "$MAIN") addressable=$(addr "$MAIN")"

say "(b) mid-session eviction: continued session re-warms before next request"
"$LMS" unload "$MAIN" >/dev/null 2>&1
: > "$LOG"
timeout 600 opencode run -c "Second message after eviction: reply OK" >/dev/null 2>&1
[ "$(loads "$MAIN")" -eq 1 ] && ok "evicted model reloaded on resume" || bad "expected 1 reload, got $(loads "$MAIN")"
[ "$(inst "$MAIN")" -eq 1 ] && [ "$(addr "$MAIN")" -eq 1 ] && ok "still 1 unsuffixed instance" || bad "instances=$(inst "$MAIN") addressable=$(addr "$MAIN")"

say "(c) thundering herd: 3 parallel cold spawns must not duplicate-load"
"$LMS" unload "$SMALL" >/dev/null 2>&1
: > "$LOG"
for i in 1 2 3; do
  timeout 600 opencode run -m "lmstudio/$SMALL" "Parallel worker $i: reply OK" >/dev/null 2>&1 &
done
wait
[ "$(loads "$SMALL")" -eq 1 ] && ok "exactly one load across 3 concurrent workers" || bad "expected 1 load, got $(loads "$SMALL")"
[ "$(inst "$SMALL")" -eq 1 ] && [ "$(addr "$SMALL")" -eq 1 ] && ok "1 instance, no :2 duplicates" || bad "instances=$(inst "$SMALL") ids=$("$LMS" ps --json | jq -c --arg k "$SMALL" '[.[]|select(.modelKey==$k).identifier]')"

say "(d) orphaned duplicate: only a :2 instance resident — plugin reconciles"
"$LMS" load "$SMALL" -y >/dev/null 2>&1        # deliberately create the :2 duplicate
"$LMS" unload "$SMALL" >/dev/null 2>&1          # remove the addressable one; only :2 remains
if [ "$("$LMS" ps --json | jq --arg k "$SMALL" '[.[]|select(.identifier==($k+":2"))]|length')" -eq 1 ]; then
  : > "$LOG"
  timeout 600 opencode run -m "lmstudio/$SMALL" "After reconciliation: reply OK" >/dev/null 2>&1
  grep -q "reconciling: unloading duplicate instance ${SMALL}:2" "$LOG" && ok "duplicate :2 was unloaded" || bad "no reconciliation in $LOG"
  [ "$(loads "$SMALL")" -eq 1 ] && [ "$(inst "$SMALL")" -eq 1 ] && [ "$(addr "$SMALL")" -eq 1 ] \
    && ok "fresh addressable instance, no residue" || bad "instances=$(inst "$SMALL") addressable=$(addr "$SMALL")"
else
  bad "could not stage the :2-only precondition (skipping d)"
fi

say "residual state"
"$LMS" ps --json | jq -r '.[] | "\(.modelKey)  id=\(.identifier)  ttlMs=\(.ttlMs)  parallel=\(.parallel)  status=\(.status)"'

say "result: $pass passed, $fail failed"
exit "$fail"
