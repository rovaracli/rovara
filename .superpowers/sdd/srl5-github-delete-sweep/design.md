# SRL-5a: removing the record's copy of deleted GitHub content within a bound

(Round 2, after the Opus review `reviews/0511-team-record-gaps/srl5-review.md`. This replaces the round 1 note.)

## Problem
The GitHub tap answers 503 when a comment delete or a repository delete/transfer could not be taken, but GitHub never
redelivers on its own, so deleted GitHub content could stay in the team record for good. Two more ways to lose a
delete turned up in review: the App was not subscribed to `repository` events at all, and a delete lost while the
repository was being looked up was answered 2xx.

## What was checked in the code
- One GitHub App per deployment (Rovara's shared public App on Cloud, the customer's own on a private install). Its
  JWT comes from `GitHubAppCredentialProvider.appHeaders()`; the deliveries API takes the JWT only. The list is App-wide.
- A redelivery keeps the same guid and a freshly signed identical body. In `handleGithubWebhook` the record tap
  runs on EVERY attempt, before the delivery is reserved, so a redelivery offers the delete again; tombstones are
  idempotent; everything after the tap is keyed by the guid.
- Only two deliveries remove record data (`createCodeHostTap`): a deleted comment (`issue_comment` on a PR,
  `pull_request_review_comment`) and `repository` deleted/transferred. One list, `RECORD_REMOVAL_DELIVERIES`
  (`sources/github.ts`), is the source of truth for the tap, the sweep and the test that the App is subscribed.
- Installation lifecycle events (`installation_repositories` removed) do not touch the record today.
- The hourly team-record job (`agentx.team-record` / `hourly`) already exists in the CDK app. No CDK change.

## Part 1: make sure GitHub sends and we answer honestly (H1 subscription, H2, M4)
- `repository` is added to `GITHUB_WEBHOOK_EVENTS` (needs only `metadata: read`, which the App has). New Apps get it
  from the manifest. EXISTING Apps (staging, Cloud) must tick "Repository" in the App's event subscriptions by hand
  (no reinstall, no re-accepting of permissions); `agentx doctor` already names a missing event. A test fails if any
  removal event is not in the App's event list.
- The tap decides "is this a removal" from the event and action alone, BEFORE the repository lookup, and tells the
  webhook first (`removalStarted`). A lookup that throws is reported lost (`removalFailed`), a lookup that hangs is
  caught by the webhook's budget: both answer 503, which GitHub's history shows as a failure. A repository the
  record does not hold is still a plain 2xx.
- `handleGithubWebhook` turns a lost removal into a retryable 503 whatever else went wrong (a refusal, a conflict).
- The sweep retries a removal that failed with ANY non-2xx (a rotated webhook secret answers 403, a broken route 404):
  the fault was ours, and the delete was not taken.

## Part 2: the redelivery sweep (`team-record/github-redelivery.ts`)
Run from the hourly job, App-wide, with its own 5 s budget and a signal that ends every call at the deadline.
1. State (one item, `GHREDELIVERY#state` in the org directory partition): watermark, up to 8 gaps, and up to 400
   TRACKED removals `{guid, newest attempt id, first failure, last ask, asks}`. Saved with an optimistic version, so
   two overlapping runs cannot overwrite each other (the loser drops its state and logs it).
2. List deliveries newest first (100 a page, at most 25 pages) down to `watermark - 30 min`, then each saved gap,
   oldest gap first (GitHub forgets those first). Group by guid.
3. A failed removal seen is tracked from its FIRST failure. A tracked removal is forgotten when any attempt of the
   guid is seen with a 2xx. It is given up on 72 hours after its first failure (GitHub has forgotten it), or after
   100 asks; that is counted and shown on Health.
4. Due removals (newest attempt and last ask both older than 30 min) are asked in this order: fewest asks first,
   then oldest first, at most 50 a run. A delete that always fails therefore cannot starve a new one.
   `POST /attempts`: 202 requested; 404 gone (counted separately); anything else, 422 ("spammed") included, is a
   failure and the removal stays tracked and is asked again next hour.
5. Because tracking lives in the state, the watermark no longer has to be pinned for a failed or unconfirmed ask.
   It is held back only for a failed removal that could not be tracked (the list is full).
6. A scan cut short by the page or time limit, or by an unreadable page, is saved as a gap. At most 8 gaps are kept; when
   there are more the NEWEST are dropped, with a log line carrying the time range, and the run counts as failed.
7. The sweep never writes or removes a record row and never reads one. An error is never a deletion.

### Bound
A delete webhook GitHub delivered and we answered with anything but 2xx is asked for again every hour (minimum 30 min
between asks). It is removed within about **1 hour after the cause is fixed**, provided that is inside GitHub's
72 hour history (the first failure starts the clock). Assumptions: the hourly job runs; the App credentials work;
about 1,000 to 1,500 App deliveries an hour or fewer per run (25 pages; the real rate is 300 to 500 ms a page in
5 s; more is carried over as gaps, still within 3 days but slower, and a gap lost to the limit of 8 is reported).
Not covered by Part 2: a delete GitHub never attempted, or one older than 3 days when the cause was fixed.

## Part 3: the repository check (`team-record/github-repo-existence.ts`)
GitHub may never send `repository deleted` (App not yet subscribed, webhook off, GitHub incident), and a redelivery
cannot bring back a delivery that was never made. For repositories (few, unlike comments) an existence check is cheap.
Each hourly org run lists the repositories its projects record GitHub rows from (source rows `github:repo/<id>`, the
installation each project pins them to; a source row already `failing` is skipped) and, per installation:
- reads the installation's repository list (`GET /installation/repositories`, complete or not believed);
- for a recorded repository missing from the list, asks for it directly with the installation token
  (`GET /repositories/{id}`); only a clear 404 counts;
- removes it the way the tap does (`tombstone` with cause `source_deleted`, then the source row reads `failing`).

**404 cannot tell "deleted" from "no longer reachable by the installation"** (transferred out, or no longer shared
with the App): GitHub answers 404 for both, and no call a third party can make tells them apart. The check therefore
decides "Rovara can no longer read this repository", and removes in both cases. Reasoning: the tap already removes on a
transfer out (also a loss of access); a company that withdraws the repository from the App has withdrawn Rovara's
right to hold a copy; and the live-check ACL makes the rows unreadable to others anyway. The cost of a wrong removal
(history lost until re-learned) is smaller than the cost of keeping deleted data. This is a policy choice and is
called out for the owner (flip: skip `remove` for repositories whose installation is `selected`).

Safeguards, taken from `sources/existence-sweep.ts`:
- an error, refusal, timeout, redirect or unclear answer is never "not held" (a port throw = unknown, nothing of
  that installation is removed);
- canary: the installation's list must be complete and NOT empty (an empty list is what a revoked, suspended or
  narrowed installation looks like). Side effect: a company whose installation reaches nothing else cannot lose its
  last repository this way (the webhook is the only path then);
- brake: more than 20 percent of an installation's recorded repositories "not held" removes none; fewer than 5 recorded
  repositories may lose at most 1 per check (so 2 of 3 never go). Applied to what the list shows, before any
  per-repository lookup;
- one installation's brake does not stop another;
- a removal no durable path took is counted per company (`tombstone`) and App-wide.

Bound for a deleted repository: **within about 1 hour of the check running**, whether or not a webhook was ever sent.

## Visibility (M7)
A new App-wide failure counter (`OPSFAIL#app#github_sweep#<hour>` in the org directory partition) is read into every
company's Health data (`githubSweep`, only when above zero; `opsFailuresCheck` warns). It counts: a redelivery run that
failed, a removal given up on, a gap lost, a failure that could not be tracked, an installation whose repositories
looked narrowed, a repository removal no durable path took. Job-summary details carry the other counts. NOT built here: a CloudWatch
alarm (CDK) that pages on the `record.github_redelivery_*` / `record.github_repo_check_*` log lines; until it exists the
only signal is the Health page (DEFERRED-CHECKS, marked as blocking the team record switch-on).

## Quiet when there is no App (L10)
`githubAppReady` (the broker's App secret has a version and names an App) gates both GitHub sweeps; an install with no App
skips them without a failure or a log line.

## Still not covered (accept or decide)
- A comment deleted at GitHub that GitHub never delivered, or whose failure is older than 3 days: a comment existence
  sweep was rejected (404 means deleted or not visible; the cost grows with the record).
- A hosted repository that lost its installation entirely (App uninstalled): the token mint fails, so the check is
  "unknown"; the company's close/erase paths remove the data.
