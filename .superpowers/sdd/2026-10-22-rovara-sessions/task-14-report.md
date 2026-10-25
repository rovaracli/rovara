# Task 14 report: Live (with the Task 13 review fixes)

Worktree `Rovara-plan5-20261022`, branch `feat/sessions-plan5`, from e6aca903. Local only, nothing pushed. Broker env: no new variable.

## The contract the web app wires (exact names)

Route (one, GET only, any other method is `NOT_FOUND`; it sits under the existing `ANY /v1/app/{proxy+}` gateway route, so no infra change):

`GET /v1/app/live?filter=all|mine|team|needs_me|failed&project=<name>&cursor=<opaque>&limit=1..100`

- `filter` defaults to `all`; an unknown filter, a bad project name or limit, or a cursor that is not this person's for this filter and project is `CONFIG_INVALID`.
- Answers `{ tiles: LiveTile[] (at most 100), next?: string }`. Read it with `LiveResponseReaderSchema`.
- A session the caller cannot view is never in the answer (not even by count). A caller who left the org gets `{ tiles: [] }`. A cursor is sealed (AES-GCM) and bound to org, person, filter and project.

`@agentx/contracts` (all exported from the barrel, `session-views.ts` and `agent-sessions.ts`):

| Name | What |
| --- | --- |
| `LiveTileSchema` / `LiveTile` / `LiveTileReaderSchema` | the tile, strict server schema and forward reader |
| `LiveResponseSchema` / `LiveResponse` / `LiveResponseReaderSchema` | `{ tiles, next? }` |
| `LiveFilterSchema` / `LiveFilter` / `LIVE_FILTERS` | the five filters |
| `LIVE_VIEWING_MAX` (5), `LIVE_PAGE_MAX` (100), `LIVE_ENDED_KEEP_HOURS` (24) | limits |
| `SESSION_STATUS_WORDS` | words for every status (`statusWords` on a tile is `SESSION_STATUS_WORDS[status]`; `stopped` is "Stopped") |
| `SessionWhereViewSchema` | where a session runs as a person is told (cloud, or a Mac by label and offline); `SessionViewSchema.where` uses it too |
| `livePresenceKey` | org-wide presence index key (broker use) |

`LiveTile` fields: `contractVersion, sessionId, kind, title, agent?, project?, owner {developerId,name}, where, status, statusWords, step?, peek?, lastRunFailed?, costUsd, viewingNow [<=5 {developerId,name}], viewingNowCount, needsYou, following, actions: SessionAction[], approvalUrl?, updatedAt`.

- `actions`: what the caller may do on that session, from the same rule as the session view's `you.actions` (without `make_agent`). Arjun on Priya's tile: `["watch","comment"]`. Maintainer: `stop`, `take_over`, `share`, `steer`; `retry` only when the session failed or was cancelled. A project viewer: `["watch"]`. An org admin with no project role: `watch, comment, stop`.
- `approvalUrl`: the bare `/v1/app/approve/<apr_id>` link (no ticket, no query) of the FIRST pending decision the caller may make, decided by Plan 3's own live check (`mayDecideApproval`); absent for anyone else, and when the decisions cannot be read.
- `needsYou`: the caller is in the summary's `needsPeople`. `following`: the owner always, others by their follow item.
- `viewingNow`/`viewingNowCount`: fresh heartbeats (90 s) from a new org-wide presence index.
- A client keeps the tile with the newer `updatedAt` when answers cross (the plan's monotonic rule).
- Realtime: no new notice. The existing Task 8 `session.updated` on the project channel and the person's own channel is what tells the wall to read again (a test drives a real summary refresh through the real sink and checks the project-channel notice, then the new wall).

Not changed: `SessionTileSchema` is still the list tile of `GET /v1/app/sessions` (`level`, `revision`, nested `summary`). The Live wall has its own `LiveTileSchema`; see the rulings.

## Commits

Task 13 review fixes (each RED then fix):
- I-1 retry of IMPLEMENT-blocked or committed-source-recovery workflow: 512b8222 RED / b377388d fix. The session actor is honoured for the `work` action, `queueWorkflowCoding` authorizes BEFORE it commits, and a retry whose Plan 3 call failed after the workflow moved on (revision up, no longer BLOCKED) still writes its event, request item and audit item. Tests: IMPLEMENT-blocked and recovery through the real broker (`agent-session-retry-implement.test.ts`, `workflow-dependencies-broker-integrity.test.ts`), plus the fail-after-commit pair in `agent-session-stop-retry.test.ts`.
- I-2 take-over and `ids` approvals: dee832e0 RED / b9715aa8 fix. `stillMayApprove` now fails closed (a role that cannot be read removes the previous owner). The previous owner already leaves an owner-routed `ids` list unless they hold `approve_writes`; new tests cover `ids` lists (decide check before and after), a kept maintainer, and the fail-closed read.
- Minors: 7fda934a RED / 70ebdd7e fix, 1eb2e4b5 (pins two mutants). RETRIED mark and request item now last `RUN_RECORD_MEMORY_DAYS` (90) like Plan 3's `RUN_REQUEST`; a lost link is repaired idempotently (`repairLink`) for the starter's own repeat and for anyone else (who is told "already retried"); `retry` is offered only for `failed` and `cancelled` sessions (`sessionActionsFor(access, { status })`); the owner-read guard now sees named interfaces such as `TaskLike`, which surfaced 17 more reads (all classified in the table).

Task 14: 31664fe1 RED (`agent-session-live.test.ts`, fake table also takes `BatchGetCommand`) / fea7f594 feat / 84e416e2 and b8a6ddf7 (mutant-killing and late-session tests, plus dropping one dead early exit). Also: `admin-health-infrastructure.test.ts` allow-list lists `take-over.ts`, `stop.ts`, `retry.ts` for the TTL attribute (a Task 12b/13 gap; the test was failing before).

## How it reads (bounded, fixed)

One request: 1 org-member read; 1 query of the org's `LIVE_SESSIONS` (at most `LIVE_INDEX_SCAN_MAX` rows, logged when cut, paged); 1 query of the caller's grants; 1 query per share partition (member, company, and each project they or a tile have); per 100-candidate chunk: 1 batch of session records and 1 batch of their tasks, People lists and the caller's follow items; 1 query of the presence index; 1 list of the caller's pending approvals (`approvalsFor`, matched to the page, only if some tile has a pending approval). Unprocessed batch keys are asked again (5 rounds), then `RUNTIME_UNAVAILABLE`, never a wall with holes. At most 10 chunks, so at most 31 batch calls; the 300-session test makes at most 40 commands for every filter (no per-tile reads). One session beyond the page is judged so `next` appears exactly when another visible session follows.

Safety: each session record is read and judged by Task 4's rules (`sessionAccessFor`, same code as the session view, with the Task People list, grants, shares prefetched), never trusted from the index tile; the tile only narrows what is read (project, open/ended, needs me, failed). Forged or foreign rows (a tile or session of another org, a share or presence row naming another org, a META naming another session) show nothing and are logged without titles. Task People `denied`, revoked grants, removed shares and withdrawn company shares take effect on the next read (nothing cached).

Task 5 m-3 hand-off (lazy sessions of old ended tasks showing "starting"): the 7a sweep closes them; a test shows such a session on the wall until the sweep looks and off it after. Between creation and the next sweep run (5 minutes) it can still show as "starting".

## Tests

- `agent-session-live.test.ts`: 45 tests (plan's seven-session company, every filter, actions per person, approval links from Plan 3's real check, presence, fixed reads at 300 sessions, paging, forged rows, realtime, real-broker route).
- Related set (all `agent-session-*`, owner-read guards, realtime, admin-health, workflow flow and recovery, cancel/write-gate/chain/agent-lifecycle/audit-catalog, run-limit): 38 files, 1522 passed, 0 failed.
- `npx tsc -b` clean; `npm run typecheck:all` 0 errors (baseline 0); eslint clean on every changed file.

## Mutation

- Task 13 fixes: 9 mutants (work action, moved-on test both halves, RETRIED expiry, repair link, retryable statuses, fail-closed role read, interface scan) all killed; the first pass found the moved-on test survived on revision-only and state-only, pinned by a test, then killed. One survivor left, equivalent: removing the new pre-commit `authorizeTaskAction("work")` in `queueWorkflowCoding` changes nothing observable, because the retry's first check, `requireMayGoOn` and the commit's own conditions (`closedAt`, workflow revision) already refuse every case the extra check could (a demoted editor, a closed task); it stays as the reviewer asked, as defense in depth.
- Task 14 live code: 64 mutants first pass, 43 killed, 21 survived (tile-versus-record duplication, read counts, `next`, decisions edge cases, forged org rows, dedupe, index paging). Added tests; second pass on the survivors plus 5 new mutants: all killed except two. Survivors left: (a) the tile-level `!ended` default of the index prefilter set to `true`: the session record still drops the session, so the answer is the same; read counts are pinned by the ended-sessions test. A final run after the last test showed it no longer matters. (b) an early `break` inside the page loop, removed as dead code (no observable effect).
- Equivalent/defense-in-depth kept: the duplicate-key dedupe in `batchGetItems` is now tested directly (duplicates would be a `ValidationException`).

## Rulings needed

1. `SessionTileSchema` (the plan's name) stays the list tile; the Live wall's tile is `LiveTileSchema` with the plan's fields flattened (`status`, `statusWords`, `costUsd` instead of nested `summary`, no `level`/`revision`). Accept, or rename (the web app wires whichever name the controller picks).
2. `retry` is now offered only for failed/cancelled sessions (review minor). A BLOCKED workflow shows as `needs_person`, and the retry route still works for it, but the button is not offered. Rule whether a blocked workflow (plan blocked, coding stopped, verification blocked) should also offer `retry` (needs a flag in the summary).
3. Presence now writes a second item per heartbeat (the org-wide index) so the wall reads viewers in one query; a failed index write is logged and never fails the heartbeat. Items older than the deploy have no index entry, so tiles show no viewers for up to 90 s after the deploy.
4. `team` for a task session means the caller holds a role through a grant or the project's Slack channel (an org admin without a grant is not "on the team"); for a local session, shared with them and not theirs.
5. `needsYou` on a tile of an approval-only wait: Arjun listed as needed but a project viewer sees `needsYou: true` and no `approvalUrl` (the link is only for who may decide).
