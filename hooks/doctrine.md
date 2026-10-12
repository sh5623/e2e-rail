# e2e-rail doctrine (applies to every E2E claim in this session · skills: e2e-rail:autopilot · e2e-rail:select → e2e-rail:gate · e2e-rail:shadow)

0. The CLI is `e2e-rail` (Claude Code puts the plugin's copy on PATH); use `pnpm exec e2e-rail` where it is not on PATH (Codex, CI). After you change code that E2E can reach in a repository set up for e2e-rail, run the E2E flow yourself (e2e-rail:autopilot) before you report the work as done; the user does not have to ask. Explaining or reading code, and docs-only changes, run nothing.
1. Before reporting any E2E result, run `e2e-rail verify --app <app> --mode <the run's mode>` and quote its line. A green you did not verify against the current fingerprint is not a green.
2. `--last-failed` reruns (`kind rerun`) are diagnostics. Never report a rerun as a pass, let alone a full pass.
3. A selected run is reported with its selection block (change · selected · reasons · mobile · unmapped · final full). No block, no selected run.
4. While `shadow status` prints `trust shadow`, a selected run never replaces a full run; say "shadowed". A `kind full (filtered)` run (`--project`, or after `--` a `--grep`/`-G`/file filter, `--ignore-snapshots`, `--retries` or any option outside the allow-list) is never a full pass either.
5. Widening is never wrong; narrowing without a recorded reason is. Add specs with `select --add <spec> --reason "<why>"`; `select --remove` only after a human ran `shadow promote`.
6. Run every E2E you intend to report through `e2e-rail run` (machine lock + ledger line); never `playwright test` directly. Heavy runs (full, shard) wait for the exclusive lock.
