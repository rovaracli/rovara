# SRL-5a: removing the record's copy of deleted GitHub content within a bound

(Round 3, after the Opus reviews in `reviews/0511-team-record-gaps/srl5-review.md`. Replaces rounds 1 and 2; the changes of round 3 are marked R1 to R6.)

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
   failure and the removal stays tracked and is asked again next hour. 404 is a delete lost for good (see Visibility).
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
called out for the owner (flip: skip `remove` for repositories whose installation is `selected`). The owner's decision is
still pending; current behaviour is kept. Limits to know (R5): a PUBLIC repository deselected from the App may still be
readable with the installation token (200), so it is probably not removed (the safe direction; [verify on staging]); an
UNINSTALLED App keeps every repository's record copy (the mint fails: unknown), while deselecting one repository removes it.

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

## Visibility (M7, R2, R3, R6)
- **Company Health shows only what is that company's own.** The repository check counts "an installation looked
  narrowed (too many of this company's repositories gone at once), nothing removed" under the company's own partition
  (`OPSFAIL#repo_check#<hour>`, shown as `repoCheck`; present only when not zero). A repository removal no durable
  path took is counted once, through the existing per-company `tombstone` counter. NOTHING App-wide is on any company's
  Health: an App-wide count (and its hour) would show one company's events, and Rovara's own faults, to the others.
- **App-wide problems are for the operator**: one fixed line `record.github_sweep_problem` (counts only: a failed run, a
  removal given up on, a delete GitHub forgot before it was taken (404 on redeliver: lost for good, also
  `record.github_redelivery_gone`), a gap lost, an untracked failure, an App secret that cannot be read). The job summary
  carries the same counts. There is no operator console in this repo, so the CloudWatch alarm on these lines
  (DEFERRED-CHECKS, blocks switch-on) is the surface.
- `githubAppReady` is false only for "not set up" (no secret version, no App id): quiet. Any other failure reading the App
  secret THROWS; the job logs `record.github_sweep_problem` {appUnreadable} and skips the sweeps for the hour (the same
  fault also breaks webhook verification).

## The repository check runs last and has a deadline (R1)
- It runs AFTER every company's delete, erase and sweep work, from what is left of the hourly run's budget, and never past
  it. With under two seconds left it does not start (`record.github_repo_check_no_time`, `githubReposNoTime`): the privacy
  paths always come first; a run so busy that this repeats shows in the alarm.
- Each company gets at most 4 s. One `AbortSignal` carries that deadline into the Dynamo reads (between projects) and
  every GitHub call (token mint, list, lookups; the provider adds its own 5-8 s timeouts), and the check also stops
  waiting for a port that ignores the signal. What is not finished is "unknown": nothing of it is removed.
- It walks the companies from a saved cursor (`GHREPOCHECK#cursor`): if time runs out after company A, the next run
  starts after A, so the same companies are not starved every hour.
- ONE installation token per installation per run serves the list and every lookup (`installationRepositoryView`).

## Recovering a repository the check removed (R4)
Removing sets the source row to `failing` and closes the place. To bring a repository back: re-add it to the GitHub App,
then remove the failing source row and add it again in the project's Sources tab (a new row opens the place and reads
`unknown`), or save the row through `putSourceConfig`, which now also resets `failing` to `unknown`.

## Still not covered (accept or decide)
- A comment deleted at GitHub that GitHub never delivered, or whose failure is older than 3 days: a comment existence
  sweep was rejected (404 means deleted or not visible; the cost grows with the record).
- A hosted repository that lost its installation entirely (App uninstalled): the token mint fails, so the check is
  "unknown"; the company's close/erase paths remove the data.
