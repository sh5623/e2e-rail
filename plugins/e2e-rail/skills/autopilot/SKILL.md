---
name: autopilot
description: Use when you changed source or test code in a repository set up for e2e-rail (an e2e-rail.config.mjs at the root, or a personal one `e2e-rail status` finds) and are about to report the work as done, commit or hand it off, without the user naming E2E or this skill; and when the e2e-rail Stop hook says this turn changed code E2E can reach with no passing run. Runs the whole flow: status → select with the impact check and its review record → run → bounded diagnosis and fix on failure → verify → report. Do NOT load for: explaining or reading code, docs-only changes, first-time setup (init), speed, workers or sharding (measure), shadow pairing at the end of a round (shadow).
---

# e2e-rail:autopilot — the E2E flow after a code change, without being asked

From the repository root. The CLI: `e2e-rail` (Claude Code puts the plugin's copy on PATH; it runs the copy the
repository pins in `node_modules` when there is one). Not on PATH (Codex, CI): `pnpm exec e2e-rail`, or `npx e2e-rail`
in npm and yarn repositories. `--app <app>` when the config has several apps; `<mode>` as e2e-rail:gate picks it.

## 0. Does this change need E2E?
```sh
e2e-rail status
```
- `e2e-rail.config.mjs not found … Run e2e-rail init first.` — the repository is not set up for e2e-rail. Never install
  the CLI or write a config on your own: end with `E2E: not verified — e2e-rail is not set up (e2e-rail:init)`.
- `<app>: <mode> verified (full@<run-id>)` in the mode the repository gates in — this exact code already passed in full:
  report that (e2e-rail:gate step 0) and stop.
- `reach none since <sha>` for every app, and nothing you changed is listed — no change E2E can reach (docs, unit
  tests, ignored paths): nothing to run; say `E2E: no change E2E can reach`.
- Otherwise go on. `reach no base (…)` means there is nothing to narrow from: the selection will be full.

## 1. Select and check (e2e-rail:select)
Follow e2e-rail:select steps 1–4: the base (`last-green` unless a verify line names one), the selection, the impact
check of every partial app (Claude Code: the `e2e-impact-analyst` agent; Codex: `references/impact-analyst.md`), one
`--add` per finding, then record the check:
```sh
e2e-rail select --app <app> --base last-green
e2e-rail select --review-done --reason "impact-analyst: <no additions | n additions>"
```
An app that runs in full needs no check (`review: not needed`). Write the selection block, `review:` line included.

## 2. Run (e2e-rail:gate)
```sh
e2e-rail run --app <app> --selection --mode <mode>
```
- `review: none — …` or `review: stale (…) — …` before the run: the check was not made for this code and list. Go
  back to step 1 before you report the run.
- `waiting for the heavy lock (…)` — another run holds the machine lock: wait; never kill it. When an identical run
  finishes first, this one prints `reused: run <id> …` and takes its result (nothing runs again): report that run-id.
- While `trust shadow`, a selected run is `shadowed` and never replaces a full run. The full run stays where the
  project puts it (an integration step, CI); start one yourself only when the selection is full or the project asks.

## 3. On failure: diagnose, fix, go again (at most 2 rounds)
1. Keep the evidence first: Playwright empties `test-results/` on the next run. Copy `<app root>/test-results` out of
   the work tree (for example to `${TMPDIR:-/tmp}/e2e-<run-id>/`) and keep the run-id; the `failed:` lines stay in the
   ledger.
2. Write what you observed apart from what you think: the failing assertion, the request or mock it depends on, the
   trace (`pnpm exec playwright show-trace <app root>/test-results/<test dir>/trace.zip`). Then one hypothesis (your
   change, a shared mock or fixture, the test's own expectation, the environment) and the check that tells it apart.
3. `e2e-rail run --app <app> --last-failed --mode <mode>` is a diagnostic (`kind rerun`) for that check. Its pass is
   never the result, and a lone pass does not prove the failure was flaky or load-related.
4. Fix the cause, then step 1 again: the code changed, so the selection is computed again and needs its own check.

Never relax an expectation, add `skip` or `fixme`, raise retries or timeouts, or rerun until green to make a run pass.
After 2 rounds without a pass, stop: report the failure (`FAILED`, its run-ids and `failed:` lines) and your best
hypothesis.

## 4. Verify and report (e2e-rail:gate steps 2–3)
```sh
e2e-rail verify --app <app> --mode <mode> --require selected
```
Report in the gate's fixed format, with the selection block and its `final:` line (where the pending full run
happens). A full run is verified with `verify --app <app> --mode <mode> --require full`.

## 5. When you do not run it
End the reply with one line: `E2E: not verified — <why>` (the user said not to, the work is unfinished and you are
asking a question, the repository is not set up, a run you must not wait for holds the lock). In Claude Code the
e2e-rail Stop hook asks once per turn when this turn changed code E2E can reach and no run passed for it; this line is
the answer when the flow does not fit. Never write a pass you did not verify.

## Limits
Never install the CLI or edit `package.json`, the lockfile or `.gitignore` (e2e-rail:init, with a human's yes);
never `shadow promote`, `demote` or `select --remove` (human decisions); never `playwright test` directly for a result.
Codex runs no e2e-rail hook: this flow starts from this description and the doctrine.
