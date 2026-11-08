# SRL-5a: redeliver GitHub delete webhooks that we failed to process

## Problem
The GitHub tap answers 503 when a comment delete or a repository delete/transfer could not be taken
(`removalFailed`, or still running at the 1.5 s budget). GitHub never redelivers on its own, so the stored copy of
deleted GitHub content could stay for good.

## What was checked in the code
- One GitHub App per deployment (Rovara's on Cloud, the customer's own on a private install). Its JWT is built by
  `GitHubAppCredentialProvider.appHeaders()` (`packages/broker/src/github-app.ts`), already used for
  `GET /app/installations`. `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{id}/attempts` take the App
  JWT only (no installation token, no extra App permission). The list is App-wide: all companies' deliveries are in it.
- A redelivery keeps the same `X-GitHub-Delivery` guid and a freshly signed identical body. In
  `handleGithubWebhook` the record tap runs on EVERY attempt before the delivery is reserved, so a redelivery offers
  the delete again; tombstones are idempotent. Everything after the tap is keyed by the guid
  (`GITHUB_DELIVERY#<guid>`: `reserved`/`retry`/`duplicate`; trigger events and the code-host intake drop a repeated
  event id), so a redelivery of a delivery that was already processed changes nothing else.
- Only two deliveries remove record data: `issue_comment` / `pull_request_review_comment` with `action: deleted`, and
  `repository` with `deleted` / `transferred` (`createCodeHostTap`). Redelivering a created/edited event of a comment
  that was deleted later could write the old text again, so the sweep redelivers ONLY these removal events and
  nothing else.
- The hourly team-record job (EventBridge, `agentx.team-record` / `job: hourly`, `runtime.jobs.run("hourly")`) already
  exists in the CDK app, runs only where the record is on, and also runs while the record is paused (deletes keep
  going). No CDK change is needed.

## Choice: (a) redeliver failed deliveries; not (b) existence sweep
(b) would GET every recorded comment each cycle. GitHub answers 404 for a deleted comment AND for one the installation
can no longer see, so a revoked or narrowed installation looks like mass deletion (the MCP sweep needs a canary and
a 20 percent brake for exactly that); a pass over all comments has no volume-independent bound and spends the
installation's rate limit; and it can never be exact for a repository that moved. (a) asks GitHub for exactly the
deliveries that failed, uses the delivery's own removal path (so every safeguard of the tap stays), cannot tombstone
anything by itself, and its work is proportional to failures, not to the size of the record.

## Algorithm (`team-record/github-redelivery.ts`, run from the hourly job with its own 5 s budget)
1. Read the state (`watermark`, up to 8 `gaps`). A state that cannot be read: do nothing, count a failure.
2. List deliveries newest first (100 a page, at most 25 pages a run) down to `watermark - 30 min` (no watermark: to
   the end of what GitHub keeps), plus each saved gap. Group by guid.
3. A guid is redelivered when ALL hold: its event/action is a record removal; no attempt of it ever got a 2xx; its
   newest attempt failed in a retryable way (status code 0 = timeout or refused connection, 408, 429, or 5xx; any
   other 4xx is our deliberate refusal and is not retried); its newest attempt is more than 30 min old (so two
   runs in a row ask once); it has had fewer than 100 attempts. At most 50 a run, oldest first.
4. `POST /attempts` answering 202 (or 404/422 = GitHub no longer has it) is done. Any other answer or error is a
   failure; the run then does not advance the watermark past that delivery, so the next hour asks again.
5. A redelivery that fails again at our side is itself a new failed entry in the list, found by the next run: the
   retry chain continues every hour until a 2xx or until GitHub drops the delivery.
6. The new watermark is the run's start time, held back to the oldest delivery still unresolved. If the page cap or
   time budget stopped a scan before it reached its lower limit, the unscanned part is saved as a gap (cursor +
   lower limit) and scanned first the next hour. Gaps that GitHub has already forgotten (older than 3 days) are dropped
   and counted.
7. Nothing in the sweep tombstones, writes a row or reads a record row. Errors never delete anything; every failure
   is a fixed log line plus a count in the job summary.

## Bound
A delete webhook that GitHub delivered and we answered with a timeout, refused connection, 429 or 5xx is retried every
hour, so the stored copy is removed within about **1 hour plus the time until the cause is fixed** (retry interval 60
minutes, minimum 30), and no later than the first successful run after the cause is fixed AS LONG AS that is inside
GitHub's 3 day (72 h) delivery history. Stated assumptions:
- fewer than about 2,500 App deliveries an hour per scan (more is carried over as gaps, still bounded by 3 days but
  slower);
- the hourly job runs (a missed run only delays by one more hour);
- the App credentials work (if they do not, the sweep fails visibly each hour and the watermark does not move).
NOT covered (stays as before): a delete GitHub never attempted, or one older than 3 days when the cause was fixed.
The company's per-company Health counter `tombstone` (OPSFAIL#, written by the webhook when a delete could not be
taken) still shows the first failure; the sweep itself is App-wide with no company, so its failures are job-summary
counts and fixed log lines (`record.github_redelivery_*`), not per company counters.

## Deferred (staging)
Field names of the deliveries list, the cursor in the `Link` header, `status_code` 0 for timeouts, and the 202 of
`/attempts` are written from GitHub's documented API and must be seen once on staging (DEFERRED-CHECKS SRL-5).
