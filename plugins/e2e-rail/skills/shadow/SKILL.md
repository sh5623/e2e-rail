---
name: shadow
description: Use when a round ends, after the integration step's full E2E run, or when asked whether selected runs can be trusted to replace full runs. Pairs the full run with the selection computed for the same code, records hit or miss with the e2e-rail CLI, reports the streak and puts promotion (or demotion) to a human. Do NOT load for: deciding a change's scope (select), running and reporting tests (gate), first-time setup (init), speed, workers or sharding (measure).
---

# e2e-rail:shadow — does the selection catch what the full run catches?

From the repository root. The CLI: `e2e-rail` (Claude Code puts the plugin's copy on PATH; it runs the copy the repository pins in
`node_modules` when there is one). Not on PATH (Codex, CI): `pnpm exec e2e-rail`, or `npx e2e-rail` in npm and yarn
repositories.
Shadow mode costs nothing: the full run happens anyway, and the selection is only computed. Until a human promotes, selected runs never replace full runs.

## 1. Pair: select on the code the full run tests
A full run is paired with the selection computed for the same code (commit + uncommitted diff + untracked files).
Compute it right before the integration full run, on that exact code:
```sh
e2e-rail select --app <app> --base <base>
e2e-rail run --app <app> --full --mode <mode>
```
The base is chosen as in `e2e-rail:select`. Exit 10 from `select` (a full selection) is fine.

## 2. Record
```sh
e2e-rail shadow record --app <app> --run <full run-id>
```
Prints `shadow: <run-id> <outcome> · streak <s>/<n>`, plus `missed: <spec>` lines. Outcomes:
- `hit` — every failed spec was inside the selection (a passing run is a hit): streak + 1.
- `miss` — a failed spec was outside it (`missed: <spec>`; `(removed)` when a `--remove` dropped it): streak 0.
- `trivial (the selection ran this app in full, which proves nothing)` — streak unchanged.
- `unpaired (no selection was computed for this code)` — the code moved between `select` and the run; streak
  unchanged. Select on the run's code next time.

Refused with exit 1 and nothing recorded: a run that is not an unfiltered `kind full` (selected, rerun, shard,
`kind full (filtered)`), a failed run that recorded no failure (Playwright crashed or a setup step failed), or a run
an older e2e-rail recorded (`… was recorded under an older e2e-rail verification policy …`: run it again).
Recording the same run again changes nothing.

## 3. Status
```sh
e2e-rail shadow status
```
`trust <shadow|selected> · streak <s>/<n> · promotable <yes|no>`, then `recent:` records. One state serves every app.
`streak reset: earlier records were made under an older verification policy` — an older e2e-rail built that streak:
it now reads as 0 (trust is kept), and the streak grows again from the next `shadow record`. Report it.

## 4. Decide — a human decides
- `promotable yes` → ask the human: "Shadow streak <s>/<n> with no miss. Promote, so that selected runs stop being
  marked shadowed and selections may drop specs?" Run `e2e-rail shadow promote` only after a yes in this
  session. Never promote on your own, and never because the streak looks long enough.
- A miss → for each missed spec run `e2e-rail map --app <app> --explain <spec>` and read the changed
  files. Name the coupling the selector missed (string navigation, modal opener, shared fixture, alias, runtime
  route) and propose a fix: a `tiers.full` glob, a literal route in the spec, or a new impact-analyst checklist item.
- A miss after promotion means the selection is no longer trusted: propose `e2e-rail shadow demote` (trust
  back to shadow, streak 0) to the human.

## 5. Report
```
shadow:   <the record line, verbatim>
missed:   <spec — coupling — proposed fix> (one per line) | none
status:   <the status line, verbatim>
decision: promotion proposed to a human | not promotable (streak <s>/<n>) | trust already selected | demotion proposed
```

## 6. Seeded-failure drill (during the shadow period)
A streak counts what the selection caught; a drill shows it catches a real break. Run one now and then, and before
proposing promotion. Always in a scratch worktree with a scratch ledger, never in the tree or the ledger you work with:
switching branches carries uncommitted edits both ways (the break stays in your files, and your own uncommitted work
is overwritten), and a drill's `select` and `run` would overwrite the real selection and add failures to the real
ledger. A copied config does not separate the ledger by itself: an absolute `ledger.dir` is the same for every copy.

1. Note the original state, then make the scratch worktree from HEAD and copy your uncommitted work into it as a patch
   (your tree, index and stashes are only read):
   ```sh
   { git rev-parse HEAD; git diff HEAD --binary; git diff --cached --binary; git ls-files --others --exclude-standard; } | shasum > "${TMPDIR:-/tmp}/e2e-rail-drill.before"
   DRILL="${TMPDIR:-/tmp}/e2e-rail-drill"
   git worktree add --detach "$DRILL" HEAD
   git diff HEAD --binary > "$DRILL.patch" && git -C "$DRILL" apply --allow-empty "$DRILL.patch"
   git ls-files --others --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$DRILL"
   ```
   The last line copies untracked files, an untracked `e2e-rail.config.mjs` included. Install the scratch tree's
   dependencies the way the repo does (for example `pnpm install --frozen-lockfile --offline`). Start when
   `e2e-rail lock status` shows no run: the drill serves the app on its configured port.
2. Every drill command runs in `$DRILL` with the scratch ledger. Shell variables do not outlive one command call, so
   start every block with the first three lines below, and check the ledger before anything is selected:
   ```sh
   DRILL="${TMPDIR:-/tmp}/e2e-rail-drill"
   export E2E_RAIL_LEDGER_DIR="$DRILL.ledger"
   cd "$DRILL"
   e2e-rail status | head -1
   ```
   The line must end with `ledger $DRILL.ledger` (spelled out as the path). Anything else: stop.
3. Pick a recent change and break the code it touches so that a spec that should be selected fails (an assertion it
   checks, a label it reads). Then, with the three lines first:
   ```sh
   e2e-rail select --app <app> --base <base>
   e2e-rail run --app <app> --selection --mode <mode>
   ```
   The spec must be in the selection (a reason naming the broken file) and `run --selection` must fail. A selection
   without it, or a passing run, is a selector miss: name the coupling and propose a fix as in section 4. That is the
   positive control; a planted assertion alone shows nothing about the impact analysis. Plant a failure in an
   UNRELATED spec as well and run `run --app <app> --full --mode <mode>`: the full run fails and, paired with the
   selection, would show as a miss. That is the negative control, and expected. A miss resets the streak only when
   the failure is genuine, so never `shadow record` a drill's run.
4. Clean up, also after a failure or an interrupted run, from the original tree:
   ```sh
   DRILL="${TMPDIR:-/tmp}/e2e-rail-drill"
   git worktree remove --force "$DRILL" && git worktree prune && rm -rf "$DRILL.patch" "$DRILL.ledger"
   { git rev-parse HEAD; git diff HEAD --binary; git diff --cached --binary; git ls-files --others --exclude-standard; } | shasum | diff - "${TMPDIR:-/tmp}/e2e-rail-drill.before"
   ```
   No output from `diff`: the original is as it was before. Any output: stop and report it. A session that ended
   mid-drill leaves the scratch tree behind: `git worktree list` shows `…/e2e-rail-drill`; remove it the same way
   before the next drill. Then select again on the real code, without `E2E_RAIL_LEDGER_DIR`.

Report: `drill: <spec> selected (<reason>) · run --selection failed as expected · original unchanged` or
`drill: missed <spec> — <coupling>`.
