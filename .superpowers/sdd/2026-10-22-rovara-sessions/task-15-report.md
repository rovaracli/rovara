# Task 15 report: Home (with Step 0 and the Task 14 review minors)

Worktree Rovara-plan5-20261022, branch feat/sessions-plan5, from c1ec4aa6. Local only, nothing pushed. No new broker environment variable (the 4 KB budget is unchanged). No AWS commands.

## Commits
Step 0 (a blocked workflow offers retry):
- 5624e866 RED; 15428d2e fix. Summary flag `workflowBlocked: true` (SessionSummarySchema, set in summary.ts while the workflow is BLOCKED and the session is open; old summaries lack it and read as false). `sessionActionsFor(access, { status, workflowBlocked })` offers `retry` for failed, cancelled, or flagged needs_person/paused. The session view reads the flag live when it is not the computed summary.

Task 14 review minors (the numbering of the review message, minor 3 was not sent):
- ccac279e RED; 38b89027 fix: (1) presence index: log `agent_session.live_presence_truncated` at the 1000-row cap, drop rows whose own `indexExpiresAt` has passed; (2) log `agent_session.live_shares_truncated` (kind of partition only); (4) a retry is recorded after a Plan 3 failure only when this request id's idempotency item exists and the revision moved on (a run that re-blocked is recorded, another person's retry is not recorded as the caller's); (5) fallback name "a member".
- 8ac32977 allow-list for live.ts (TTL attribute), 207f2410 missing `projectMemberKey` import in a Task 13 test (typecheck:all was red).
- Read growth to note (no redesign): the Live wall's share reads are one query per project partition (grants plus tile projects) and each is capped at 1000 rows; reads grow with the number of projects among the visible tiles, not with tiles.

Task 15:
- 3c778e87 RED; 1557b204 feat; two test-only follow-ups (spend visibility, GitHub address, forged dismissal rows; mutation survivors).

## Contract for the web app
Routes (under the existing `ANY /v1/app/{proxy+}`; no infra change):
- `GET /v1/app/home` answers `HomeResponse = { cards: HomeCard[] (<= 10), total }`. Read with `HomeResponseReaderSchema`.
- `POST /v1/app/home/cards/{cardId}/dismiss` (cardId URL-encoded, e.g. `failure%3Ases_...`; no body needed) answers `{ cardId, dismissed: true }` (`HomeDismissResponseReaderSchema`). Only `failure` and `offer` cards; any other kind is `CONFIG_INVALID` "This card goes away when it's done." (`HOME_NOT_DISMISSIBLE`). Idempotent; a card that is not on the caller's Home (or already dismissed) answers the same and writes nothing. Kept 30 days (`HOME_DISMISS_DAYS`) in the caller's own partition (`homeDismissedKey`, TTL `indexExpiresAt`); an expired row is ignored.
- Exports from `@agentx/contracts` (packages/contracts/src/home.ts): `HomeCardSchema`/`HomeCardReaderSchema`, `HomeResponseSchema`/`HomeResponseReaderSchema`, `HomeButtonSchema`, `HomeDismissResponseSchema`/`HomeDismissResponseReaderSchema`, `HomeCardIdSchema`, `HOME_CARD_KINDS`, `HOME_BUTTON_ACTIONS`, `HOME_DISMISSIBLE_KINDS`, `HOME_REASON_MAX` (200), `HOME_DISMISS_DAYS`, `HOME_NOT_DISMISSIBLE`, plus `homeDismissedKey`.
- `HomeCard = { cardId "<kind>:<id>", kind approval|spend_request|question|plan|pull_request|failure|offer, title, reason (<= 200, why it is shown), sessionId? (only a session the caller may view), at, buttons[] (<= 3) }`. `button = { label, action open|confirm|retry|dismiss|start, href?, method? GET|POST }`. `href` (an absolute http(s) address, no ticket, no query) is present exactly when the caller may take the action; `method` says how to follow it (`retry` and `dismiss` are POSTs; `retry` takes `{ requestId }`). The client shows no button without `href` and never builds a request from the words.
- Buttons per kind: approval `Open` (confirm, bare `/v1/app/approve/<apr>`, only for deciders) and `Open session` (only when viewable); spend_request `Decide` (confirm) and `Open session`; plan `Review plan`; pull_request `Open pull request` (a plain https://github.com address only, else `Open session`); failure `Open session`, `Retry` (only when the caller may retry it: agent run, chain run or blocked workflow, a cloud session, a project role with start_tasks), `Dismiss`.
- The `HomeCardSchema` placeholder (kinds needs_you/failed/finished/running) in session-views.ts is replaced by home.ts.

Plan 7 Q22: reason, total, button href, approval link (the `confirm` button), dismiss response contract: built. Question target: no source in Plan 5's Home task (see rulings).

## Sources and rules
Sources are `registerHomeCardSource({ kind, list(deps, caller, context) })`; Plan 5 registers approval, spend_request, plan, pull_request, failure. A source that throws or takes more than 2 s (`homeSourceTimeoutMs`) is skipped and logged `home.source_failed` with fixed words (source, reason, error name), never its message. A card a source builds wrongly (schema, kind, id prefix) is dropped and logged `home.card_invalid`; duplicates by cardId are kept once; each source is cut at 100 cards (`home.source_truncated`).
Ranking: approvals and budget requests on an open session, question, plan, pull request, other approvals and budget requests, failure, offer; oldest first (by `at`, then id).
Visibility, all read live: an approval or budget request only for a person who passes Plan 3's own decide check now (listed, project role, not expired); the session id, title and Open session link only if the caller can view the session (a decider without view gets the card and the confirm link only, and it still ranks as blocking); plan, pull request and failure cards only for sessions the caller owns now (effective owner) and can view, from their MY_SESSIONS list (a take-over moves the card, a stale row gives nothing). A person not in the org gets `{ cards: [], total: 0 }` and no source is asked.
Bounds: caller's list at most 200 rows, 50 sessions judged (`home.sessions_truncated`), 100 approvals checked, 100 open budget requests, 300 dismissal rows; `total` therefore counts at most 100 per source.
Failure text: step words with the "Failed: " prefix removed, at most 120 characters, control characters spaced out; none means "it did not finish". Approval reasons: write record's `agent.name` (else "An agent"), step approvals use the task's agent name, chain gates "A chain run", pending changes "A change is waiting for you to approve: <title>" (title from `changeTitleOf`, exported from approval-decide-kind.ts).

## Tests
- agent-session-home.test.ts: 59 tests (shapes, ranking and total with the plan's fourteen cards, reasons, hrefs, per-person visibility, take-over, dismiss, sources, bounds, routes).
- Related set (all agent-session-*, admin-health-infrastructure, realtime-notices): 31 files, 1082 passed, 0 failed. `npx tsc -b` clean; `npm run typecheck:all` 0 errors; eslint clean on the changed files.
- TDD: each RED commit failed before its fix (Step 0: 5 failing; review minors: 6 failing; Home: whole file failing on the missing module).

## Mutation (security, permission, link and dismiss logic only, per the cost policy)
37 mutants over home.ts and the routes, plus 4 rerun after new tests: 30 killed. Survivors, all equivalent or defense in depth: spend status/expiry re-check (mayDecideSpendRequest checks both), row-org checks on the caller's own list and on the open spend list (the keys already carry the org and getSpendRequest/sessionsById re-check it), the local-session and session-action retry guards (the `retryable` rule already excludes those cases), the spend list `Limit` (the slice bounds it), and one control mutant.
Script: scratchpad/task15-mut/mutate.py.

## Rulings needed
1. `question` cards: Plan 5's Home task registers no question source, so there is no question target contract. Whoever owns questions registers a source (`kind: "question"`) and says what its `href` is; the web app already handles any card by its buttons.
2. Dismissal is by card id for 30 days: a session that fails again within 30 days of a dismissal stays hidden (a new run is a new session, so it is not affected). Accept, or key dismissals to the failure instant.
3. `total` is capped at 100 per source (reads are bounded). Accept.
4. Plain CLI task failures get no Retry (the retry route would only refuse and tell the owner to continue where they started).
5. Spend cards name a session only when the decider may view it; otherwise "A run" / "The monthly budget" / "An agent owner's budget".
6. Task 15 mutation policy change was applied: visibility, authorization, link, dismiss ownership and bounds only; ranking and wording were not mutated.
