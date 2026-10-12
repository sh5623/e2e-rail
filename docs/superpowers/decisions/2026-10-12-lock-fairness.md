# Machine lock fairness — 2026-10-12

The BFM brief reported light waits behind repeated heavy jobs in a separate, similarly structured round lock.
Those timings are motivation, not measurements of e2e-rail. Reproducing with e2e-rail 0.2.2 confirmed the mechanism:
three 650 ms heavy holds, default 500 ms polling, light requested during the first hold.

| Gap between heavy requests | Before | After |
| --- | --- | --- |
| 0 ms | H1 → H2 → H3 → L; light waited 2008 ms | H1 → L → H2 → H3; light waited 1008 ms |
| 1000 ms | H1 → L → H2 → H3; light waited 1004 ms | H1 → L → H2 → H3; light waited 1009 ms |

These are one local reproduction per condition, not an E2E performance benchmark. The assertion is ordering, not
the exact elapsed time. The user authorized implementation, a version bump, and merge/push after review.

## Decision

Use a per-request ticket, ordered by the machine's monotonic clock (random token breaks simultaneous ties).
Only the earliest published ticket may claim a lock. Remove its ticket on admission, not on release: consecutive
light requests can fill the slots together. A heavy still claims heavy.lock and drains running lights before work.
Already running holders are never preempted. Every pending request has a finite set of predecessors; later requests
cannot overtake it. Progress assumes earlier holders finish or exit and waiting processes continue being scheduled.
There is no unconditional seconds-based latency promise; callers can still set timeoutMs.

Keep the existing exclusion protocol and directory names. Tickets reuse mkdir/owner publication, exit cleanup,
PID/boot checks, symlink handling and the 10-second ownerless grace. A paused live requester keeps its place until it
resumes, exits or times out; do not reap live requests based on age. Older CLI processes ignore the queue, so mixed
versions preserve mutual exclusion but do not guarantee fairness. Upgrade all contenders before relying on order.

The one-poll light-preference proposal was rejected: after that poll a competing heavy can still win, and repeating
the yield without ordering risks starving heavy work. Driver sleep alone does not address already waiting heavy
processes. Per-request tickets need no global sequence-counter lock and address both classes with one admission rule.

## Validation and release

Lock tests cover zero-gap heavy chains, an already queued heavy, shared light slots followed by a heavy and late
lights, slow light polling, cross-process ordering, timeout/callback cleanup, graceful exit/SIGKILL, ownerless grace,
and ticket symlinks. Existing cross-process overlap tests continue checking heavy exclusion and light-slot capacity.
A scratch-copy mutation removes the heavy admission check; the zero-gap chain regression must fail.

Release as 0.2.3. Verification policy remains 2 because no pass/fail, fingerprint or selection rule changed.
`measure workers` still owns an exclusive heavy lock throughout each measured run; fairness affects only admission.
No BFM package, round driver, config or project convention is changed by this release.
