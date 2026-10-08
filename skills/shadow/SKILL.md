---
name: shadow
description: Use when a round ends, after the integration step's full E2E run, or when asked whether selected runs can be trusted to replace full runs. Pairs the full run with the selection computed for the same code, records hit or miss with the e2e-rail CLI, reports the streak and puts promotion (or demotion) to a human. Do NOT load for: deciding a change's scope (select), running and reporting tests (gate), first-time setup (init), speed, workers or sharding (measure).
---

# e2e-rail:shadow — does the selection catch what the full run catches?

From the repository root. npm or yarn repos: `npx e2e-rail`. Shadow mode costs nothing: the full run happens
anyway, and the selection is only computed. Until a human promotes, selected runs never replace full runs.

## 1. Pair: select on the code the full run tests
A full run is paired with the selection computed for the same code (commit + uncommitted diff + untracked files).
Compute it right before the integration full run, on that exact code:
```sh
pnpm exec e2e-rail select --app <app> --base <base>
pnpm exec e2e-rail run --app <app> --full --mode <mode>
```
The base is chosen as in `e2e-rail:select`. Exit 10 from `select` (a full selection) is fine.

## 2. Record
```sh
pnpm exec e2e-rail shadow record --app <app> --run <full run-id>
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
pnpm exec e2e-rail shadow status
```
`trust <shadow|selected> · streak <s>/<n> · promotable <yes|no>`, then `recent:` records. One state serves every app.
`streak reset: earlier records were made under an older verification policy` — an older e2e-rail built that streak:
it now reads as 0 (trust is kept), and the streak grows again from the next `shadow record`. Report it.

## 4. Decide — a human decides
- `promotable yes` → ask the human: "Shadow streak <s>/<n> with no miss. Promote, so that selected runs stop being
  marked shadowed and selections may drop specs?" Run `pnpm exec e2e-rail shadow promote` only after a yes in this
  session. Never promote on your own, and never because the streak looks long enough.
- A miss → for each missed spec run `pnpm exec e2e-rail map --app <app> --explain <spec>` and read the changed
  files. Name the coupling the selector missed (string navigation, modal opener, shared fixture, alias, runtime
  route) and propose a fix: a `tiers.full` glob, a literal route in the spec, or a new impact-analyst checklist item.
- A miss after promotion means the selection is no longer trusted: propose `pnpm exec e2e-rail shadow demote` (trust
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
proposing promotion — always on a scratch branch, never on the branch you ship:
```sh
git switch -c e2e-drill
```
1. Pick a recent change and break the code it touches so that a spec that should be selected fails (an assertion it
   checks, a label it reads).
2. Select and run on that broken code:
   ```sh
   pnpm exec e2e-rail select --app <app> --base <base>
   pnpm exec e2e-rail run --app <app> --selection --mode <mode>
   ```
   The spec must be in the selection (a reason naming the broken file) and `run --selection` must fail. A selection
   without it, or a passing run, is a selector miss: name the coupling and propose a fix as in step 4.
3. Plant a failure in an UNRELATED spec as well and run `run --app <app> --full --mode <mode>`: the full run fails and,
   paired with the selection, would show as a miss. That is expected. A miss resets the streak only when the failure
   is genuine, so never `shadow record` a drill's full run.
4. Then revert: `git switch -` and `git branch -D e2e-drill`, and select again on the real code.

Report: `drill: <spec> selected (<reason>) · run --selection failed as expected` or `drill: missed <spec> — <coupling>`.
