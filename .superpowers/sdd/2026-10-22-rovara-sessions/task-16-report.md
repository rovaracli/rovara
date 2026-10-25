# Task 16 report: the project page's data (with Step 0 and the Task 15 review minors)

Worktree Rovara-plan5-20261022, branch feat/sessions-plan5, from 1db47852. Local only, nothing pushed. No new broker environment variable (4 KB budget unchanged). No AWS commands.

## Commits
Step 0 (a Home dismissal must not hide a NEW failure):
- f1fcf994 RED (5 failing); 78be7123 fix. A dismissal row stores `occurrence`; a card is hidden only while its current occurrence equals the stored one. Failure cards: ended = `ended:<endedAt>`, open = `rev:<summaryRevision>`; other sources default to the card's `at`. A row with no occurrence hides nothing. The dismiss button's href now carries `?occurrence=<value>` (the occurrence the person saw), so a failure that happens between looking and clicking stays on Home. A repeat for the same occurrence writes nothing; a new occurrence replaces the row.

Task 15 review minors:
- 576b337c RED (4 failing); 6d8c3a64 fix: (1) approvals: the longest-waiting 100 are kept (was the newest); (2) githubUrl returns origin + path only (search and hash stripped); (3) `home.dismissals_truncated` logged at the 300-row cap; (4) summary.ts sets `workflowBlocked` in the budget-pause branch when the workflow is BLOCKED (matches sessionActionsFor, read.ts and the access test, which already offer retry on paused + blocked).

Task 16:
- a2ef42e4 RED (24 of 26 failing); eb95882c feat; 23def840 tests for mutation survivors.

## Contract (packages/contracts/src/session-views.ts, exported from @agentx/contracts)
Route: `GET /v1/app/projects/{name}/overview` (session routes; `isAgentSessionRoute` covers it). Other methods: NOT_FOUND.
Schemas: `ProjectOverviewSchema` / `ProjectOverviewReaderSchema` (type `ProjectOverview`), plus `ProjectOverviewProjectSchema`, `ProjectOverviewYouSchema`, `ProjectOverviewAgentSchema`, `ProjectOverviewBudgetSchema`, and caps `PROJECT_OVERVIEW_REPOSITORIES_MAX` (50), `PROJECT_OVERVIEW_CHANNELS_MAX` (20), `PROJECT_OVERVIEW_AGENTS_MAX` (100).
```
{ project: { name, description?, status active|archived, latestRevision?, repositories[{fullName, defaultBranch}], setup{status, checkedRevision?, checkedAt?, failedStep?}, channels[Slack channel ids] },
  you: { role, canStartWork, canEditSettings, canViewSpend },
  agents: [{ agentId, name, description, running }],
  budget?: { month, spentUsd, limitUsd?, mergedPullRequests, costPerMergedPullRequestUsd? },
  running: LiveTile[] (<= 100) }
```
Changes from the plan: `budget` is optional and present only when the reader has `view_spend` (maintainer or org owner/admin); the plan's `SessionTile[]` for `running` is `LiveTile[]` (it is Task 14's team filter, and the tile carries needsYou, actions, approvalUrl for this reader); `you` and the project description/status/latestRevision were added for the web app's Q24 (capability flags, metadata).

## Rules as built
- Role read live: org member item, then `projectMembers.roleOf` (as the spend and roster routes). No role, left the org, invalid name, undecodable name, missing project, card of another name: the same `PROJECT_NOT_FOUND` "project not found".
- Flags: `canStartWork` = start_tasks and not archived; `canEditSettings` = edit_settings and not archived; `canViewSpend` = view_spend.
- Budget: project-scope spend counter of the current UTC month (spent only, never the held amount), limit from Plan 3's `effectiveLimits` (left out if the settings cannot be read), merged count from `projectMonthStatsKey`; cost = spent / merged rounded to cents, absent when none merged. Counters naming another org, negative or fractional figures read as nothing.
- Agents: Plan 3's `listRoster` for the reader (built-ins and roster agents they may see, active only, cap 100); `running` counts only tiles the reader can see. An unreadable roster leaves `agents: []`.
- Running: `liveSessions(filter "team", project, one page)`, so every session passed the reader's own access check; an unshared or own local session never appears.
- Reads: org member item, role, page reader, one live page, roster, 2 single-item gets, limits.
- Project card: injected `projectPage` reader (wired in developer-routes.ts `sessionReadDependencies` from the existing project record, meta, setup state and Slack bindings), called only after the role check. Without it the route answers NOT_FOUND.
- Merge count: github-webhooks.ts `mergedPullRequestStats` adds `ADD mergedPullRequests :n` (n = pull requests this save moves to MERGED) on `projectMonthStatsKey(orgId, task.project, month of input.now)` in the same revision-conditional transaction as the move, in both the merge poll and the full feedback save (also the landed-push save). A redelivery changes nothing, so adds nothing; a save that does not commit counts nothing; an unknown org or a failing lookup counts nothing and never stops the save. Transaction size grows by one item (the landed-push worst case is 65 of 100); the existing item-count test was updated to +1.

## Tests
- agent-session-project-overview.test.ts: 38 tests. agent-session-home.test.ts 69, projector 43.
- Related set (agent-session-*, github-webhook*, audit-hooks-plan1, workflow-merge-observation, admin-health-infrastructure, realtime-notices): 37 files, 1241 passed, 0 failed.
- `npx tsc -b` clean; `npm run typecheck:all` 0 errors; eslint clean on the changed files.
- TDD: each RED commit failed before its fix (Step 0: 5; minors: 4; Task 16: 24 of 26).

## Mutation (visibility, authorization, money only)
36 mutants over project-overview.ts, the stats code in github-webhooks.ts and the route: 34 killed (20 first run + 14 after new tests), 2 equivalent (invalid-name check is also refused by roleOf; the asker's org role is re-read by liveSessions and not used by roleOf). Script: scratchpad/task16-mut/mutate.py.

## Rulings needed
1. `running` is `LiveTile[]`, not `SessionTile[]` (above). Accept?
2. `budget` omitted for non-maintainers (the plan's field was required). Accept?
3. Channels are Slack channel ids (the binding stores no names), shown to any role-holder. Accept, or limit to contributors and up?
4. A second place moves a PR to MERGED without the webhook code: broker.ts ~11877 (merged at a pushed fix before the push result is recorded). It does not add to the count, so the count can be low by those rare merges. Add it (small, in a shared file) or leave?
5. The built-in agents are part of `agents` (listRoster returns them); the web app may want to hide the ones with `running: 0`.
6. Pre-existing: contracts hold two keys `homeDismissKey` (Task 1, unused) and `homeDismissedKey` (Task 15); the first is dead and could be removed.
