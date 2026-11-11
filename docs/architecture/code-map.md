# Rovara code map

Where things live, so you can open the right file instead of searching. Start with [AGENTS.md](../../AGENTS.md) for names,
commands and shell traps.

**How to read it.** A reference is a repo path in backticks, sometimes with `#name` for the function, class, type or
const to look for in that file. There are no line numbers: they move on every merge. Open the file and search for the name.

**How it stays true.** `node scripts/codemap.ts` checks that every path and name below still exists, and
`tests/unit/codemap.test.ts` runs that check in CI. If you rename or delete something this map names, the test fails:
update the map in the same change. The "What each file owns" tables are generated from each file's header comment.
A new file that is not listed yet only gives a warning. Run `node scripts/codemap.ts --write` when you delete or
rename a file in those folders (the check tells you); otherwise leave the tables to whoever merges, so lanes don't
conflict on them. A description can lag behind its file. A file with no header comment shows its first exports
instead: give it a one-line header comment when you next edit it.

## The request path

- The broker Lambda's entry point is `packages/broker/src/aws/broker.ts#handler`. It builds the router
  `packages/broker/src/aws/broker/handler.ts#createAwsBrokerHandler`, one function that handles HTTP requests and also
  Slack events, scheduled sweeps and `agentx.*` recovery events.
- Route keys such as `/v1/app/{proxy+}` are constants in `packages/broker/src/aws/broker/definitions.ts#APP_ROUTE_KEY`.
- `/v1/app/`, `/v1/dev/` and `/v1/web/` all go to `packages/broker/src/aws/developer-routes.ts#routeDeveloperRequest`.
  Each feature's routes are in `packages/broker/src/aws/developer-routes/` (tables below).
- `/v1/service/` is for the Slack service's IAM role only. The router rewrites it to `/v1/...`. The Ask and diagnosis
  service routes are `packages/broker/src/aws/broker/ask-service.ts#handleAskServiceRoute` and
  `packages/broker/src/aws/broker/diagnosis-service.ts#handleDiagnosisServiceRoute`.
- Session controls (`/v1/app/sessions/{id}/stop|retry|redirect|merge|...`) are in `packages/broker/src/agent-sessions/routes.ts`.
- GitHub webhooks: `packages/broker/src/aws/github-webhooks.ts#handleGithubWebhook`.
- Slack is not routed through the broker handler. Slack calls `POST /v1/slack/interactions` (defined in
  `infra/lib/control-plane.ts`), which reaches `packages/broker/src/aws/slack-interactivity.ts#createSlackInteractivityHandler`.
  Slack events arrive through `packages/broker/src/aws/slack-ingress.ts#createSlackIngressHandler`. Button presses reach
  the broker as typed events, handled in `packages/broker/src/aws/broker/slack-workflow-events.ts`.
- `packages/broker/src/handler.ts#createBrokerHandler` is an older handler that no Lambda uses any more. `/v1/admin/*`
  and everything else is served by `createAwsBrokerHandler` above.

## A task's life

- **Start.** `packages/broker/src/aws/developer-tasks/start.ts#startTask`. Money is checked before any work starts in
  `packages/broker/src/spend/admission.ts#admitWork`. Who pays is decided in `packages/broker/src/spend/payer.ts#resolvePayer`.
- **The workflow model** (steps, states, send-back rules) is in `packages/cloud-contracts/src/task-workflow-node.ts`.
- **Choosing the next step.** No single function does this. The step starters are in
  `packages/broker/src/aws/developer-tasks/workflow-starts.ts`, coding in `packages/broker/src/aws/developer-tasks/workflow-coding.ts#queueWorkflowCoding`,
  review in `packages/broker/src/aws/developer-tasks/workflow-review.ts#startTaskWorkflowReview`, and an owner's decision
  in `packages/broker/src/aws/developer-tasks/decide.ts#decideTaskWorkflow`.
- **Dispatch to a worker.** A step is written as a dispatch row (`packages/broker/src/aws/broker-shared.ts#workflowDispatchItem`)
  and sent by `packages/broker/src/aws/broker/dispatch.ts#runWorkflowDispatch`. What the worker receives is assembled
  in `packages/broker/src/aws/broker/task-operations.ts#taskOperationParts`. Stuck rows are retried by
  `packages/broker/src/aws/broker/workflow-items.ts#retryDueWorkflowDispatches`. The dispatcher Lambda,
  `packages/broker/src/aws/dispatcher.ts#createDispatcherHandler`, consumes the dispatch queue that
  `packages/broker/src/aws/outbox-publisher.ts` fills. It also asks each worker which features it has
  (`packages/broker/src/aws/dispatcher.ts#workerPingFeatures`).
- **Worker callbacks and results.** `packages/broker/src/aws/broker/callbacks.ts#handleCallback`, then
  `packages/broker/src/aws/broker/terminal-result.ts#recordTerminalResult`.
- **Retry.** `packages/broker/src/aws/developer-tasks/workflow-retry.ts#retryTaskWorkflow`. A session's Retry button
  goes through `packages/broker/src/agent-sessions/retry.ts#retrySession`.
- **Send back to coding.** `packages/broker/src/aws/developer-tasks/workflow-coding.ts#sendTaskWorkflowBackToCoding`.
  The rules are `packages/cloud-contracts/src/task-workflow-node.ts#sendBackProblems`.
- **Stop and redirect** (switch `rd`). `packages/broker/src/agent-sessions/stop.ts#stopSession`,
  `packages/broker/src/agent-sessions/redirect.ts#redirectSession`, the broker side in
  `packages/broker/src/aws/broker/redirect-runtime.ts`, and restarts in `packages/broker/src/aws/developer-tasks/redirect-restart.ts`.
  Cancel is `packages/broker/src/aws/developer-tasks/cancel.ts#cancelTask`.
- **Publish a pull request.** `packages/broker/src/aws/developer-tasks/publication.ts`. The PR body is built in
  `packages/broker/src/aws/developer-tasks/pull-request-body.ts#workflowPullRequestBody`.
- **Merge.** A person presses merge: `packages/broker/src/rovara-code/merge.ts#pressMerge` (readiness in
  `packages/broker/src/rovara-code/merge.ts#mergeReadiness`). After that, `packages/broker/src/rovara-code/merge-tracking.ts#trackTask`
  follows the PR. The web button is `packages/ui/src/screens/session/MergeSection.tsx#MergeSection`.
  The merge transaction also writes the merge-commit index row (`packages/broker/src/rovara-code/merge-commit-index.ts#mergeCommitIndexItem`, called from
  `packages/broker/src/rovara-code/merged-state.ts#mergedStateItems`); the Team record finds a Rovara PR by merge commit, to record a revert, with
  `packages/broker/src/rovara-code/rovara-pull-request-index.ts#createRovaraPullRequestIndex`.
- **The task page** the app shows: `packages/broker/src/aws/developer-tasks/task-page.ts#getTaskPageState` and
  `packages/broker/src/aws/developer-tasks/task-view.ts#taskView`.

## Time limits

- Chains: the default and minimum step time are `vendor/rovara-code/packages/contracts/src/chains.ts#STEP_DEFAULT_TIMEOUT_MINUTES` and
  `vendor/rovara-code/packages/contracts/src/chains.ts#STEP_MIN_TIMEOUT_MINUTES`; the step schema in the same file enforces the minimum.
  Running chains are timed out by `packages/broker/src/chains/lifecycle.ts#sweepChainRuns`.
- Agent runs: `packages/broker/src/agents/run-engine.ts#DEFAULT_STEP_MINUTES`. A recipe step can set its own
  `timeoutMinutes` (`vendor/rovara-code/packages/contracts/src/agent-recipe.ts`).
- On the worker, the model-call limits and the planning deadline are set up in `packages/worker/src/run-task.ts`
  (search for `planningDeadlineMs`).
- The nightly run's limit is `packages/broker/src/test-env/nightly.ts#NIGHTLY_RUN_MAX_MS`.

## Switches and settings

- Every feature switch is in `packages/cloud-contracts/src/broker-names.ts#BROKER_SETTINGS`, as a two-letter code plus the
  variable the broker reads. Search for `code: "xx"`. Fixed resource names are in
  `packages/cloud-contracts/src/broker-names.ts#BROKER_NAMES`.
- The broker unpacks them at start-up in `packages/broker/src/aws/broker-environment.ts#hydrateBrokerEnvironment`.
  Each feature reads its own switch in a small `switch.ts`, for example `packages/broker/src/test-env/switch.ts`.
- The CDK side, which turns stack parameters into the packed settings, is `infra/lib/broker-names.ts`.

## Features by folder (`packages/broker/src/`)

| Feature | Where |
|---|---|
| Money: budgets, reservations, settlement | `packages/broker/src/spend/` (routes: `packages/broker/src/spend/routes.ts#routeSpendRequest`) |
| Team record (switch `tn`) | `packages/broker/src/team-record/` (routes: `packages/broker/src/team-record/routes.ts#handleRecordRoute`; wiring: `packages/broker/src/aws/broker/team-record-wiring.ts`; source rows added, changed and removed from the app (every editor's change applies at once, audited, no second person; a removal queues the place's deletion for the delete worker): `packages/broker/src/team-record/source-write.ts`, `packages/broker/src/team-record/source-store.ts` and `packages/broker/src/team-record/source-places.ts` (what a Slack, Linear or Jira place is: the live Slack channel class, the connected app's places); the pickers' read, `GET .../record/sources/options` (the Slack channels of the company's bound workspace through the identity function's `channel-list`; "your private channels", `kind=slack-private`, through its `member-channels` with the editor's own linked Slack id, never one from the request; the connected Linear teams and Jira projects; editors only): `packages/broker/src/team-record/source-options.ts`, its screen `packages/ui/src/screens/project/lessons/PlacePicker.tsx` (reads in `packages/ui/src/api/record-source-options.ts`); from inside Slack, `@Rovara learn from this channel` (or inviting Rovara to a private channel) answers the person privately with an "Add to project" prompt and its Add button saves through the same source route as the web: `packages/broker/src/team-record/slack-add.ts` (the ingress asks the broker by a direct invoke, `packages/broker/src/aws/broker/team-record-wiring.ts#answerSlackAdd`; the button is `learnAddHandler` in `packages/broker/src/aws/slack-interactivity.ts`); Rovara's own events (remembered note, plan outcome, review outcome, task end) announced to the record: `packages/broker/src/lessons/record-events.ts`; the editing screen of the project's Sources tab (a lazy chunk, loaded only when the route returned the editors' view): `packages/ui/src/screens/project/lessons/SourcesAdmin.tsx`, its calls in `packages/ui/src/api/record-sources.ts`; who may read a task's rows, its Plan 5 visibility: `packages/broker/src/lessons/task-visibility.ts`; the same visibility read again at READ time for every row about a Rovara task, so narrowing a task hides its older rows (a task that can't be read shows nothing): `packages/broker/src/team-record/live-audience.ts` (the rule; applied in `acl.ts#filterVisible`) and `packages/broker/src/team-record/live-audience-port.ts` (the State-table reader); whether a ticket a comment names is recorded under the place (Linear comments), read from the record's rows: `packages/broker/src/team-record/sources/parent-lookup.ts`; GitHub delete webhooks we failed to process, asked for again every hour through the App's webhook deliveries (the hourly job; App-wide; never writes a row): `packages/broker/src/team-record/github-redelivery.ts` (list and redeliver calls: `GitHubAppCredentialProvider.listWebhookDeliveries` / `redeliverWebhookDelivery` in `packages/broker/src/github-app.ts`); a recorded repository the installation no longer shows (deleted, transferred, not shared) removed by the hourly job even when no webhook came: `packages/broker/src/team-record/github-repo-existence.ts` (reads `installationRepositoryView`; runs last in the hourly job, from the leftover budget, with a deadline on every GitHub call and a saved company cursor; a narrowed installation is counted on that company's own Health as `repoCheck` in `ops-failures.ts`; App-wide problems of both sweeps are one fixed log line `record.github_sweep_problem` for the alarm, never on a company's Health; the alarms on these lines and on `record.erase_sweep_failed` / `record.tombstone_failed`, one metric filter on the broker's log group and one operator alarm each, only with the record switch on: `infra/lib/team-record-wiring.ts#TEAM_RECORD_SWEEP_ALARMS`); erase second passes that failed and source deletes no durable path accepted, counted per company for the admin Health data (`teamRecordCheck`) and the web admin service status page (`teamRecord`): `packages/broker/src/team-record/ops-failures.ts`) |
| Self-hosted embedder (Team record + lessons; no Bedrock embedding) | the function: `environments/embedder/` (`app/embedder_core.py` request checks and inference, `app/handler.py`, `models.lock.json` the pinned models, `Dockerfile`, `requirements-*.in` and the hashed `requirements-*.lock`, `tools/` export, parity and image-build tools; every file the Dockerfile copies is tracked, `tests/contract/embedder-image-sources.test.ts`); its stack: `infra/lib/embedder-function.ts#attachEmbedder` (part of the Team record switch; image by stack parameter `EmbedderImageUri`, which the release names and the CLI passes: `packages/cli/src/deploy/parameters.ts#embedderImageUri`; the function runs in a network with no way out); the Team record's re-embed job `packages/broker/src/team-record/reembed.ts` (a stored cursor per workspace, least recently served first, one deadline for the whole run) and the retire step for the old index (`s3-vectors-index.ts#retireOldIndex`, called from `runtime.ts#indexFor`); the broker's port: `packages/broker/src/embedder/client.ts` (limits, retries, answer checks), `packages/broker/src/embedder/wiring.ts` (`recordEmbedderClientFrom`, `lessonEmbedderFrom` for the lessons lane), the Lambda call `packages/broker/src/team-record/aws-adapters.ts#lambdaEmbedderInvoke`, the Team record's `Embedder` `packages/broker/src/team-record/embed.ts`; the model identity and the spec that names the vector index: `packages/cloud-contracts/src/team-record-storage.ts` (`TEAM_RECORD_EMBEDDER`, `LESSON_EMBEDDER`); the account limits the templates assume (Lambda memory 3,008 MB, held by `tests/contract/account-limits.test.ts`): `infra/lib/account-limits.ts`; the check for a table left over by a rolled-back first build, run by `config set teamRecord.enabled 1` and `upgrade`: `packages/cli/src/deploy/team-record-preflight.ts` (the read-only DynamoDB probe is `team-record-probe.ts`); the runbook for sizes and names against account limits: `docs/runbooks/new-resource-size-vs-account-limit.md` |
| Standing instructions (switch `si`): company rules and "How we work" as one system-prompt block | `packages/broker/src/instructions/` (`standing-block.ts#buildStandingInstructions` builds the text, `company-source.ts#CompanyInstructionsSource` is the port the rules are read from, `dispatch-input.ts#standingInputFor` is what a step is asked for; wired in `packages/broker/src/agents/dispatch.ts#applyAgentStep` and `packages/broker/src/aws/broker/task-operations.ts`). Contracts: `vendor/rovara-code/packages/contracts/src/standing-instructions.ts` (limits, wording, payload). The Cloud store of the company rules (G-04, decisions 57 and 85: immutable versions, one waiting proposal, second-admin approval with a fresh sign-in, audited in the same transaction): `packages/broker/src/company-rules/` (`store.ts` rows under `ORG#`, `service.ts` who may propose, approve, reject and cancel, `source.ts#cloudCompanyInstructionsSource` the adapter of the port above, `rules.ts` the checks, the diff and the file's format (the one Rovara Code reads), `sync.ts` the two-way link with one file in the company's meta repository: a repository edit comes back as a pending proposal, an approved version goes out as a pull request, `view.ts` what the page shows, `seed.ts` and `scripts/seed-company-rules.ts` the operator's first approved version, which needs an approval reference; a repository proposal is adopted by one admin and approved by a different one: `service.ts#adoptProposal`; `connected-path.ts#connectedCompanyRulesPath` is what the merge guard reads, and a task may not change the file: `packages/worker/src/lessons-file-guard.ts#isCompanyRulesFilePath`, `packages/broker/src/rovara-code/lessons-file-guard.ts#touchesCompanyRulesFile`); routes `packages/broker/src/aws/developer-routes/company-rules.ts` (API: `briefs/company-rules-api.md`; browser contracts `packages/cloud-contracts/src/app-company-rules.ts`); wiring `packages/broker/src/aws/broker/company-rules-wiring.ts` (the adapter is installed, and the hourly look added to the Team record's job, only while `si` is on). The worker places it in `packages/worker/src/pi-session.ts#createWorkerResources` and `packages/worker/src/agent-run/run-agent-step.ts#agentStepSystemPrompt`. |
| Track record (per-step stats in the playbook) | `packages/broker/src/playbook/track-record.ts`. Not the same thing as the Team record. |
| Lessons (learning v2, switch `ll`) | `packages/broker/src/lessons/` (for local coding tools (an MCP tool and a command asking for the lessons of one repository, project-wide and stable or approved only, never cached: `packages/broker/src/lessons/local-tools.ts#lessonsForLocalTool`, the shared ranking `packages/broker/src/lessons/load.ts#selectLessons`; client side `packages/mcp/src/tools.ts` (`rovara_lessons`) and `packages/cli/src/developer/lessons-local.ts`); why learning cannot run, "lessons paused", one current fixed code per project or company, shown on the Lessons tab and Home to people who decide, with when it started; three failed learning calls in a row pause a project as `model_failed`: `packages/broker/src/lessons/pause.ts`; the company's optional lessons model: `packages/broker/src/lessons/model-setting.ts`; the cheapest suitable model is chosen by `packages/broker/src/model-sources/diagnosis-provider.ts#chooseLearningRoute`, which never picks a free, router or zero-priced model and ranks default-reasoning models last; every lesson read ends in `packages/broker/src/lessons/read-visible.ts#readVisible`, which also checks the LIVE visibility of every task a lesson was learned from, so narrowing a task hides its lessons: `packages/broker/src/lessons/live-visibility.ts#liveVisible`, fail closed; the reader of what an agent is given is everyone who can open the running task's session, and a lesson loads only if all of them can see every task it was learned from (owner decision 31): audiences are sets in `packages/broker/src/lessons/task-audience.ts#audienceWithin`, read through `tableLessonAudiencePort`, one person at a time, never the whole roster; a person reads a lesson when they can open every source task, and the pull request's list names it only when every source task is open to the whole project with no People denial, owner decision 32; all kept apart from the Team record's `task-visibility.ts`). Loaded into a run by `packages/broker/src/aws/broker/lessons-dispatch.ts#learnedContextForOperation` (with the plan summary and planned files from `packages/broker/src/lessons/plan-facts.ts`; default 5 lessons and 2 KB per stage). Learning capture is in `packages/broker/src/learning/`. Lesson similarity (owner decision 23): `packages/broker/src/lessons/similarity.ts` (code-aware tokens, BM25, cited-path overlap and the optional embedder's cosine, fused by reciprocal rank; the verbatim, near-exact, flipped and narrowing copy tests and `sameByStructure` (the only test that lets a judge's "same" merge; any other "same" keeps the draft apart as a possible duplicate, `possibleDuplicateOf`, for a person, never on trial or auto-applied); a judge's "same" about a REJECTED lesson drops the draft only by the same test, otherwise it is a pending "matches a rejected lesson" card; a person's "Merge into the existing lesson" is `POST .../lessons/{id}/merge` -> `approve.ts#mergeDuplicate` -> `curate.ts#foldDuplicate` (the same `mergeInto` fold with every cap, one commit that also retires the duplicate, audited `lesson.merged` with `judged: person`), which compare the bodies word by word and in order through `packages/broker/src/lessons/copy-match.ts` and keep negations, direction words, qualifiers and numbers; `rankLessons`, which never throws, waits for the embedder only a bounded time and falls back to keywords and paths), the lesson vectors kept beside each lesson head in the record table `packages/broker/src/lessons/dynamo-vectors.ts` (`LESSON#<id>#VEC`: spec, text hash, float32; removed with the lesson), the one seam `lessonSimilarityFor` (`aws/broker/lessons-wiring.ts`, takes `dependencies.lessonEmbedder` or else the record runtime's `lessonEmbedder`, built from the embedder function the environment names; none: keywords and paths), the curator's shortlist and ONE listwise judge call per draft `packages/broker/src/lessons/curate.ts`, the loader's ranking `load.ts`, and the same-mistake matcher `metric-source.ts#fusedMatcher`. Approve by exception (owner decision 24): `packages/broker/src/lessons/trial.ts` (when a lesson goes live on trial, trial to stable, `isPublishable`), the Standard / Regulated preset in `packages/broker/src/lessons/preset-setting.ts` (read in `policy.ts#resolveLearning`, stored by `dynamo-settings.ts#DynamoPresetStore`), the thumbs-down in `counters.ts#recordFeedback`, and the pull request's "Lessons used" list in `packages/broker/src/lessons/used-in-pr.ts` (shown by `rovara-code/pull-request-body.ts`). | What people already correct reaches the reflector as spans: reviewers' pull request comments and "remember this" notes (`packages/broker/src/lessons/captured-rows.ts`, read by `packages/broker/src/aws/broker/lesson-subject-source.ts`) and human fix-up commits (`packages/broker/src/lessons/human-edit.ts`, handed over by the code-host tap `packages/broker/src/team-record/sources/codehost.ts#runHumanEdit`; hosts: `packages/broker/src/team-record/sources/capture-adapters.ts`; indexes: `packages/broker/src/team-record/capture-indexes.ts`); at a merge the tap queues ONE ids-only `human_edit` message on the LessonsReflect queue (`packages/broker/src/lessons/reflect-queue.ts#HumanEditMessageSchema`, sent by `packages/broker/src/aws/broker/lessons-wiring.ts#humanEditEnqueue`) and the LessonsWorker runs it under the reflection's own lease, deadline and call rules (`packages/broker/src/lessons/human-edit.ts#learnFromHumanEdit`, lease `human_edit-<head commit>`. A finished task's reflection runs from a queue: `lessons/task-end.ts#learningTaskEndHandler` sends ids, `lessons/reflect-worker.ts` (a lease in `lessons/reflect-claims.ts`, retry only when nothing was spent, deadline with an abort signal, `lessons/deadline-guard.ts`) runs `learnFromEndedTaskTyped` in the LessonsWorker Lambda (its own slim entry `aws/lessons-worker-entry.ts`, handler in `aws/broker/lessons-worker.ts`; CDK `infra/lib/team-record-wiring.ts#attachLessonsWorker`); `lessons/jobs.ts` holds the hourly deletion resume and the nightly run: re-reflection of reverted tasks, then per project the helpful settle (`settleHelpful`) and the expiry sweep, then the trial-to-stable pass (both rotate their starting project from a saved position, `lessons/nightly-state.ts`; the task's end counts its outcome for the lessons it loaded, `lessons/task-end.ts#countOutcome`, which runs in two places around the reflection: before it only what needs no judge (a revert taking its queued mark back), after it, in the judge's own attempt (no lease, own time budget, once per task), the corrections that need a rating. The corrections are the subject's own spans: send-backs, and members' pull request comments (with the file they were made on, `EvidenceSpan.paths`) and "remember this" notes, minus the initiator's own, quoted text and comments that do not read as corrections (`lessons/correction-filter.ts`); a revert counts only with a verified member reverter. They are rated by `lessons/judge-model.ts#modelCorrectionJudge` on the company's own learning model path (quote, Public's per-task cap as the task's total, the month's look, pause codes, judge failures counted once per task, random-id markers around the texts). A harmful mark is one person's, once per lesson ever (the same key as the buttons' marks), and erasure takes it back (`LessonStore.noteHarm` / `takeBackHarm`); no usable model or learning Off records nothing and queues no helpful mark. The helpful marks it queues are settled by the nightly job because that job already holds the expiry sweep they must run before, 14 days after the merge) (`lessonsNightlyJob`; only where the project's preset allows trial lessons). Approve by exception (owner decision 24): `packages/broker/src/lessons/trial.ts` (when a lesson goes live on trial, trial to stable, `isPublishable`), the Standard / Regulated preset in `packages/broker/src/lessons/preset-setting.ts` (read in `policy.ts#resolveLearning`, stored by `dynamo-settings.ts#DynamoPresetStore`), the thumbs-down in `counters.ts#recordFeedback`, and the pull request's "Lessons used" list in `packages/broker/src/lessons/used-in-pr.ts` (shown by `rovara-code/pull-request-body.ts`). A lesson restricted only to the readers of the project's own repositories counts as project-wide (owner decision 34, `packages/broker/src/lessons/project-repo-audience.ts`: the repositories are read live from the project definition, a repository whose place the Team record closed is left out at once, and a scope cut at its length limit ends with `CUT_SCOPE_PLACE` and is never believed); such a lesson loads into any project task, but is named in a pull request's list and published only in its own repository (decision 36: `mayNameInRepository`, `used-in-pr.ts`, `trial.ts#isPublishable`) and is never promoted to a project rule (`promote.ts`). Lessons in the repo (owner decisions 50, 50a, 50b; lane R1): which lessons may ever go into one repository's `.rovara/lessons.md` is decided in `packages/broker/src/lessons/repo-eligibility.ts` (pure, no model: `repoVisibilityOf` sets `provenance.repoOnly` at reflection from EVERY input the reflector was given, with fixed `repoBlockCodes` codes when it cannot; `mergedRepoVisibility` ANDs it in `curate.ts#mergeInto`, which a person's merge `foldDuplicate` uses too; `isRepoFileEligible` / `repoFileBlockers` is the rule: repository-only for that repository, stable or person-approved, active, no restricted audience, names nobody, sound), and counted before any file pass is built by `packages/broker/src/lessons/repo-eligibility-report.ts` (counts only) fed by the read-only operator script `scripts/lessons-repo-eligibility-report.ts` (`npx tsx ...` through `staging-aws.sh`; the lessons are in the Team record table). The repo-only reflection (owner decision 50c; lane R1b): when a Rovara task's pull request merges, `packages/broker/src/lessons/repo-reflect.ts#reflectRepoOnly` runs ONE more reflection per merged change request that has a member's review comment or a human edit, over the repository's own words only (its review comments, the human edits, the merge fact and nothing Rovara wrote (no title, no description); `repoOnlySubjectOf`, random-id span markers via `ReflectSubject.promptStyle`), with `repoInputs` set so R1 marks its drafts repo-only. The repository is proved before anything is paid (`repoVisibilityOf` over the prompt's spans; the proof is the project's registered repository address matched to the code host's own identity by the adapter, `lesson-subject-source.ts#repoChangeOf`). Two reflections, no hand-over: `task-end.ts#learnFromEndedTaskTyped` ALWAYS runs the comments reflection (kind `comments`, after the first reflection and the outcome judge; same switch and task tally; once-key `repo-reflect:comments:<task>:<place>:<head>` taken atomically right before the call), and `human-edit.ts#createHumanEditExtractor`, when it has real human edits, runs a separate edits reflection (kind `edits`: the edits with the same comments for context; own once-key `repo-reflect:edits:...`). A repo-only draft never merges into a lesson that is not repo-only for the same repository (`repo-eligibility.ts#mergeKeepsRepoOnly`; a refinement across that line is a card too, a contradiction does not retire): the pair stays apart linked both ways (`possibleDuplicateOf`, `Lesson.repoTwins`; the card cannot be merged, `mergeBlocked`) and `load.ts#chooseWithTwins` gives a task only one of them (only `repoTwins` pairs, the other twin if the preferred one does not fit the bytes). Public's cap is one total per task across both, in any order: a ladder of once-keys (`repo-reflect.ts#readTaskHeld`, `reserveTaskHeld`, `noteTaskHeld`); the nightly trial repair (`jobs.ts`) never retires a trial lesson on a card across the repo-only line. Its input is a code-host-neutral `RepoChangeRequest` that the adapter side produces (`capture-adapters.ts#PullRequestFeedbackView`). Lessons held back because their source task is a legacy task with no session item are counted apart (`live-visibility.ts#legacyWithheld`, `legacyHeld` on the Lessons tab for people who decide). Lessons replay A/B (lane 7, owner decisions 38, 47, 49, 50.5): a sanity check of the lesson pipelines on 40-60 past tasks, not proof, with no automatic verdict. The arms are named (`off`, `on:<pipeline>`, `file:<label>`, `mcp:<label>`) in `vendor/rovara-code/packages/contracts/src/eval-memory.ts` (`parseArm`, `compareArms`, `readArmRows` reads old two-arm results); the result rows, the fixed grader (`assertOneGrader`), the loaded-lesson difference and its STOP line (`loadedLessonDifference`), the report in plain words and JSON (`buildMeasureReport`, `renderMeasureReport`) and the blind reviewer sheet (`blindSheet`, `importMarks`) are in `vendor/rovara-code/packages/contracts/src/eval-replay-measure.ts`. An eval or replay task carries the `evalRun` mark on its task record and every learning path refuses it (`packages/broker/src/lessons/eval-run.ts#isEvalRunMark`; the list of places that call a learning model is kept by `tests/unit/lessons/eval-run-refusal.test.ts`). The harness (`packages/broker/src/lessons/replay-harness.ts`: plan, frozen snapshots from historical outcomes, run, grade; ports for the executor, grader and pipelines), the task choice (`packages/broker/src/lessons/replay-select.ts`), the final lesson set count (`packages/broker/src/lessons/replay-lessonset.ts`) and the repeat-mistake metric on the replay (`packages/broker/src/lessons/replay-mistakes.ts`, over `metric.ts#sameMistakeTwice`) are driven by the operator script `scripts/lessons-replay-measure.ts` (no AWS call of its own; candidates come from `scripts/export-replay-candidates.ts` over `packages/broker/src/lessons/replay-candidates.ts`; the executor that cannot start an unmarked task is `packages/broker/src/lessons/replay-executor.ts#stagingExecutor`, its install side is the operator route `packages/broker/src/aws/broker/admin-and-helpers.ts#adminTaskLessonsReplay` (`POST/GET /v1/admin/tasks/{taskId}/lessons-replay`; the logic in `packages/broker/src/aws/developer-tasks/lessons-replay.ts`, the snapshots in `packages/broker/src/lessons/replay-snapshot-store.ts`, the refusals to publish or announce a copy in `packages/broker/src/developer/eval-copy.ts`, the CLI in `packages/cli/src/admin/task-lessons-replay.ts` and `scripts/lessons-replay-port.ts`), the rubric grader `packages/broker/src/lessons/replay-grader.ts#rubricGrader`, the file arm (R2's lessons file placed in the copy's checkout only: rendered at delivery by `packages/broker/src/lessons/deliver.ts#evalFilesFromRefs` and `replay-delivery.ts#replayLessonsFiles`, sent as `evalFiles` (`vendor/rovara-code/packages/contracts/src/eval-files.ts`, worker feature `task.evalFiles.v1`), placed and hidden from the candidate by `packages/worker/src/eval-files.ts`), the offline pipeline B (the real curator under the project's real settings) and the lane 8 stub `packages/broker/src/lessons/replay-offline.ts`, the one export rule every arm must use (`packages/broker/src/lessons/replay-export.ts#exportWithoutAPerson`: only what is delivered without a person; the rest counted), the operator's clone-backed citation check `scripts/lessons-replay-git.ts`, the project's settings route `.../lessons-replay/settings`, the grader's and the offline pipeline's company-model route `packages/broker/src/lessons/eval-model.ts` (`POST /v1/admin/projects/{p}/lessons-replay/model`; also `.../lessons-replay/snapshots` (import) and `.../subjects/{taskId}`), the copy's approve, close and evidence routes under `/v1/admin/tasks/{taskId}/lessons-replay/` (company owner or admin only; copies are workflow test runs billed to the company or project); the runbook is `docs/runbooks/lessons-replay-measure.md`). The Rovara-owned lessons file and its weekly pull request (owner decisions 50, 50a, 50b, 56; lane R2): `packages/broker/src/lessons/repo-file-format.ts` (the text of `.rovara/lessons.md`: header, sections by path scope, blocks by id, cleaned and wrapped text, a SURGICAL `applyFileChanges` that leaves the team's own bytes alone; the canonical render is the same for any order of the same set), `repo-file-plan.ts#planRepoFile` (pure: removals with reasons, then edits, then adds; only `isRepoFileEligible` lessons; hand-edit hold by fingerprint; caps 300 lessons / 64 KB), `repo-file-pass.ts#runRepoFilePass` (the weekly pass for one repository: lease, a new random branch `rovara/lessons-<12 hex>` from the default head, `force: false`, nothing adopted, one open pull request, previous one closed and its branch deleted, audit before each host write, ignored-PR rule after 3 unmerged; NO model call; runs only while lessons are on), `repo-file-state.ts` and `dynamo-repo-file.ts` (the per-repository state under `LESSONSET#REPOFILE#`, conditional on a revision), `repo-file-pointer.ts` (the one pointer line, first pull request only), `repo-file-pr.ts` (pull request words and the status lines), `repo-file-job.ts` (the weekly pass inside the nightly job, no new schedule), `repo-file-routes.ts` and `GET|POST /v1/app/projects/{p}/lessons/repo` in `routes.ts` (status and the maintainer's switches; the CLI is `agentx project lessons-repo`, `packages/cli/src/developer/lessons-repo.ts`; Cloud's rows are `packages/ui/src/screens/project/lessons/RepoFileControl.tsx`), `repo-file-hook.ts` (an erased lesson that is only in the open pull request closes it at once), read-back of the team's edits (lane R3, owner decisions 50, 50a: file to Rovara, one way, no model call, no extra read: `repo-file-readback.ts#readBackFile`, run by the weekly pass on the default-branch file it already read, before the plan; a changed block under a known id becomes the lesson's text as a person edit, a known id the team removed is retired with the cause `removed_in_repository` (a bulk disappearance is held one pass), a rewrite clears harm marks only when substantial (`isSubstantialRewrite`), a bullet with no id becomes a new person-approved repo-only lesson (refused with a fixed reason when it names a person or asks for a capability change); ids gone for good are never touched and a mark on the text of an erased lesson that is still in the file (`LessonStore.textFingerprints` / `markGoneFingerprint`: an HMAC of the text and the repository under the project's own secret, taken from the file itself, with the fingerprint of every marked block recorded on each successful pass in `RepoFileState.seen`; cleared when a successful read or sweep finds no copy left (a departed repository keeps its marks until its sweep does), wiped with the project) keeps a stripped-id copy from coming back as a new lesson and lets the erasure sweep take it out; where an approver group is required these lessons wait pending; a file that is not valid text, has merge-conflict lines or lost every marker is unreadable and changes nothing; `repo-file-plan.ts` then puts the id line before the team's bullet (a `tag` edit of `repo-file-format.ts#applyFileChanges`, `looseItems`) and never declines an id whose text is still there), and wiring in `packages/broker/src/aws/broker/lessons-repo-file-wiring.ts`. The code host's `commitFiles` and `deleteBranch` (a plug-in interface addition, both owners approve: `vendor/rovara-code/packages/contracts/src/plugins/code-host.ts`; GitHub: `packages/broker/src/github-commit-files.ts`) and decision 50.4: a Rovara TASK pull request may not touch `.rovara/lessons.md` (`packages/worker/src/lessons-file-guard.ts` refuses the first push (`publish.ts`) and every fix, update and base-merge push (`maintain-pull-request.ts#push`, judged by what the commit itself introduces); `packages/broker/src/rovara-code/lessons-file-guard.ts` refuses the merge). Erasure is its own sweep, independent of the publish state, visiting the WATCH ROWS (`packages/broker/src/lessons/repo-file-sweep.ts#sweepProject`; before any host action `repo-file-host.ts#guardTarget` (every entry point wraps its target; a test enumerates them) compares the host's repository id with the place's, and `readOwnPr` confirms a pull request is Rovara's before a close: a repository removed from the project, re-hosted or re-id'd is rebuilt from its watch row by `RepoFileRuntime.reach` and still swept; unreachable ones are recorded once and shown on the status), WRITE AHEAD (a watch row at switch-on and before any host write, a branch-keyed row before the branch, commit and pull request; no row, no host write; `CodeHost.changeRequestForBranch` finds the pull request of a numberless row) and with its own slice of the nightly budget (`packages/broker/src/lessons/repo-file-erase.ts#sweepErasures`, run first in the nightly job and in the deletion hook): it reads only the default branch's lessons file, the lesson store's per-lesson tombstone (`LessonStore.goneOf`, written first by the deletion itself and retried with its intent), the pull request rows (`RepoFileStore.putPr`, one per Rovara-made PR, `LESSONSET#REPOFILEPR#`) and the code host; it closes a Rovara PR that adds a gone lesson (whatever the head, branch deleted only while still Rovara's) and opens a removal-only PR for a gone block; closing a project closes Rovara's PRs from the same rows (`closeProjectRovaraPrs`); a state that does not fit its caps or schema FAILS LOUDLY (`StateFull`, row problem `state_unreadable`) and an unparseable item throws, it is never read as absent. A Rovara pull request a person pushed to is handed over (`RepoFileState.theirs`): never touched again, removals go out in a new one; nothing is deleted unless its branch head is read again and is still the one Rovara left. | What people already correct reaches the reflector as spans: reviewers' pull request comments and "remember this" notes (`packages/broker/src/lessons/captured-rows.ts`, read by `packages/broker/src/aws/broker/lesson-subject-source.ts`) and human fix-up commits (`packages/broker/src/lessons/human-edit.ts`, handed over by the code-host tap `packages/broker/src/team-record/sources/codehost.ts#runHumanEdit`; hosts: `packages/broker/src/team-record/sources/capture-adapters.ts`; indexes: `packages/broker/src/team-record/capture-indexes.ts`); at a merge the tap queues ONE ids-only `human_edit` message on the LessonsReflect queue (`packages/broker/src/lessons/reflect-queue.ts#HumanEditMessageSchema`, sent by `packages/broker/src/aws/broker/lessons-wiring.ts#humanEditEnqueue`) and the LessonsWorker runs it under the reflection's own lease, deadline and call rules (`packages/broker/src/lessons/human-edit.ts#learnFromHumanEdit`, lease `human_edit-<head commit>`. A finished task's reflection runs from a queue: `lessons/task-end.ts#learningTaskEndHandler` sends ids, `lessons/reflect-worker.ts` (a lease in `lessons/reflect-claims.ts`, retry only when nothing was spent, deadline with an abort signal, `lessons/deadline-guard.ts`) runs `learnFromEndedTaskTyped` in the LessonsWorker Lambda (its own slim entry `aws/lessons-worker-entry.ts`, handler in `aws/broker/lessons-worker.ts`; CDK `infra/lib/team-record-wiring.ts#attachLessonsWorker`); `lessons/jobs.ts` holds the hourly deletion resume and the nightly re-reflection of reverted tasks. Approve by exception (owner decision 24): `packages/broker/src/lessons/trial.ts` (when a lesson goes live on trial, trial to stable, `isPublishable`), the Standard / Regulated preset in `packages/broker/src/lessons/preset-setting.ts` (read in `policy.ts#resolveLearning`, stored by `dynamo-settings.ts#DynamoPresetStore`), the thumbs-down in `counters.ts#recordFeedback`, and the pull request's "Lessons used" list in `packages/broker/src/lessons/used-in-pr.ts` (shown by `rovara-code/pull-request-body.ts`). |
| Company-approved extra test images (`tx` + `pj`) | `packages/broker/src/test-env/company-images.ts` (the one served-or-refused decision), `company-image-resolver.ts` (digest lookup), `org/company-test-images.ts` (who may), `org/company-test-image-store.ts` (rows under `ORG#`). Routes: `developer-routes/company-test-images.ts`. Screen: `packages/ui/src/screens/admin/how-we-work/CompanyImagesScreen.tsx`. |
| Test environment, nightly run, saved images (`ev`, `nh`, `sv`) | `packages/broker/src/test-env/`. Routes: `packages/broker/src/aws/developer-routes/test-environment.ts`. Contracts: `vendor/rovara-code/packages/contracts/src/test-environment.ts`. |
| Why a task ran (user, test run, nightly) | `vendor/rovara-code/packages/contracts/src/agent-run-node.ts#WORK_ORIGINS` |
| Proof and evidence (`pe`) | `packages/broker/src/proof/`, wired in `packages/broker/src/aws/broker/evidence-wiring.ts` |
| Decision cards (`dk`) | `packages/broker/src/decisions/` |
| Chains and triggers (hidden since 2026-11-07: out of the CLI help; the web app shows "This isn't available" for `/app/chains/*`, `/app/triggers/*` and chain-run session links unless the `chains` web feature is on, which no install sets; code and data stay) | `packages/broker/src/chains/`, `packages/broker/src/triggers/`; the web notice is `packages/ui/src/shell/Unavailable.tsx#Unavailable` |
| Intake: tickets that start tasks (Jira, Linear, GitHub issues) | `packages/broker/src/intake/` (engine `packages/broker/src/intake/engine.ts#ingestIntake`; who a Jira or Linear account is, only through the company's tracker links: `packages/broker/src/intake/identity.ts#trackerAccountResolvers`; routes, including "Not this one" and the ticket updates settings: `packages/broker/src/intake/routes.ts#routeIntakeRequest`; Home cards for waiting tickets and failing watched sources: `packages/broker/src/intake/home-source.ts`; watched Jira and Linear sources read through the company's connection: `packages/broker/src/triggers/intake-searches.ts#intakeSearchesOf`; the project screen's section: `packages/ui/src/screens/project/TicketsSection.tsx`, calls in `packages/ui/src/api/intake.ts`) |
| Ticket updates: write-back to the ticket that started a task (owner decision 6) | `packages/broker/src/ticket-updates/` (the milestone handler `packages/broker/src/ticket-updates/handler.ts#sendTicketUpdate`; the Linear, Jira and GitHub writers `packages/broker/src/ticket-updates/trackers.ts#ticketTrackersOf`; the started, plan-ready and closed moments `packages/broker/src/ticket-updates/moments.ts`; settings and write access `packages/broker/src/ticket-updates/settings.ts`; wiring `packages/broker/src/aws/broker/ticket-updates-wiring.ts#installTicketUpdates`; contracts `vendor/rovara-code/packages/contracts/src/ticket-updates.ts`) |
| Agent sessions (live, stop, redirect, ask) | `packages/broker/src/agent-sessions/`. Sessions on a Mac (devices, local sessions, the Mac move) are unfinished and kept: `packages/broker/src/devices/`, `packages/broker/src/agent-sessions/handoff.ts`. Nothing offers them: no client pairs a Mac, and `packages/broker/src/agent-sessions/access.ts#OFFER_HANDOFF` (off) keeps "handoff" out of a session's actions. Existing local sessions still read. |
| The one status model (state, words, next step) | Contract `vendor/rovara-code/packages/contracts/src/task-status.ts`; worked out from a task in `packages/broker/src/agent-sessions/task-status.ts#taskStatusOf` (session summary `display`, task view `statusView`). |
| Task notifications (Slack DM / email, batched) | `packages/broker/src/notifications/` (queue on summary change, delivery in the session sweep via `packages/broker/src/aws/broker/attention-wiring.ts`); the person's setting is `/v1/app/me/notifications` (`notifications/prefs-routes.ts`). |
| Plug-ins: code hosts and check runners | `packages/broker/src/plugins/`, registered in `packages/broker/src/aws/broker/plugin-wiring.ts#createBrokerPlugins` |
| Audit | `packages/broker/src/audit/` |
| Slack explicit membership (switch `sm`): a Slack person with no explicit, current company membership is not the implicit member | the rule: `packages/broker/src/aws/broker/dependency-wiring.ts#slackRequesterStanding` (last step); the switch and the "warn" notice: `packages/broker/src/org/slack-explicit-members.ts`; the stop path (a legacy teammate stop needs the membership too, outcome `NOT_A_MEMBER`): `packages/broker/src/aws/broker/slack-workflow-events.ts#stopSlackThreadTask`; the plain reply: `packages/slack-service/src/processor.ts` (`SLACK_NOT_A_MEMBER_NOTICE`, `packages/cloud-contracts/src/errors.ts`) |
| Script tokens (switch `pt`): tokens people make for their scripts and CI | `packages/broker/src/script-tokens/` (the token check and its closed route list: `packages/broker/src/script-tokens/authenticate.ts#authenticateScriptToken`, called from `packages/broker/src/aws/developer-routes.ts#routeDeveloperRequest`; settings routes: `packages/broker/src/script-tokens/routes.ts#routeScriptTokens`; screen: `packages/ui/src/screens/settings/ScriptTokensScreen.tsx`; user docs: `docs/script-tokens.md`) |

## Worker

- A task run: `packages/worker/src/run-task.ts#runTaskInvocation`, started from `packages/worker/src/main.ts`. Its
  HTTP server is `packages/worker/src/server.ts`.
- The features this worker supports: `packages/worker/src/implemented-features.ts#WORKER_IMPLEMENTED_FEATURES`. The
  protocol version and the features an invocation can require are in `vendor/rovara-code/packages/contracts/src/protocol.ts#AGENTX_PROTOCOL_VERSION`
  and `packages/cloud-contracts/src/protocol.ts#WORKER_INVOCATION_FEATURES`.
- Lessons on the worker: `packages/worker/src/learned-context.ts#validateLearnedContext`.
- There is no `executor/run.ts` in the worker. The one in `packages/verifier/src/executor/run.ts` is the E2E executor.

## Web app

- `packages/web` is a thin shell: `packages/web/src/bootstrap.tsx` mounts the app, and `packages/web/src/server/handler.ts`
  serves it.
- The pages are in `packages/ui/src/screens/`, the route list is `packages/ui/src/routes.tsx#appRoutes`, and the API
  client is `packages/ui/src/api/client.ts#createApiClient` (one module per area in `packages/ui/src/api/`).
- Company settings (`/app/admin/*`): one list of sections, `packages/ui/src/screens/admin/admin-sections.ts#ADMIN_SECTIONS`, drives both the
  navigation (`packages/ui/src/screens/admin/AdminNav.tsx#AdminNav`, a menu behind one button on a phone) and the overview. What a change affects and who
  can change it, per page, is `packages/ui/src/screens/admin/settings-text.ts#SETTINGS_AREAS`, shown by `packages/ui/src/screens/admin/SettingsNote.tsx#SettingsNote`.
  The one Connections page is `packages/ui/src/screens/admin/connections/ConnectionsScreen.tsx#ConnectionsView`: a row per connection
  (`ConnectionCard.tsx`), its state words in `connection-state.ts`, saved connections and the Linear and Jira add form in `RegistryItems.tsx`,
  GitHub in `packages/ui/src/screens/onboarding/steps/GithubConnectPanel.tsx`, AI providers in `packages/ui/src/screens/admin/models/ProviderSetup.tsx`.
  "Used by" is exact from `GET /v1/app/connection-usage` (`packages/broker/src/aws/developer-routes/connection-usage.ts#getConnectionUsage`: connectors, watched intake sources and each project's effective AI source order, only projects the viewer may see). The add form for cloud and monitoring tools is `AddMonitoring.tsx`; it posts to the same `POST /v1/app/connections` as the CLI.

## Contracts

- Contracts are two packages (convergence W0-3). Names Rovara Code's contracts own come from `@rovara-code/contracts` (the vendored copy, read only:
  change it in Code first, then refresh the pin). Cloud's own are `@agentx/cloud-contracts`. A name has one owner: where Cloud still defines a name Code also
  exports, the file and the exact names are listed in `packages/cloud-contracts/owed-upstream.json` with a reason and one kind: `owedUntil` (Cloud is ahead; a Code
  lane lands it; the entry fails after the date), `cloudOnly: true` (Cloud's own on purpose, never expires) or `migration: true` (a saved-data shape; never expires,
  listed in DEFERRED-CHECKS). `tests/contract/cloud-contracts-no-duplicate-names.test.ts` fails for any other duplicate.
- The Cloud barrel is `packages/cloud-contracts/src/index.ts`. Code that runs in the browser imports `@agentx/cloud-contracts/web`
  (`packages/cloud-contracts/src/web.ts`), which also re-exports the browser-safe names of Code's contracts (the build tree-shakes Code's Node-only modules
  out). Its own file list `packages/cloud-contracts/web-safe-files.json` is checked by `tests/contract/contracts-web-entry.test.ts`.
- Every read of a task's owner fields must be on the list in `tests/contract/task-owner-reads.test.ts`. It is checked by
  a scan (`tests/support/task-owner-scan.ts`).

## Infra

- The CDK app is `infra/bin/agentx.ts`. It calls `infra/lib/app.ts#buildAgentXApp`, which creates every stack. The main
  one is `infra/lib/control-plane.ts#ControlPlaneStack`.

## How to add common things

Each recipe lists the files to touch in order and the tests that fail if you forget one. When in doubt, read the
example commit with `git show <sha> --stat`.

### A feature switch (example: d01147df4, the `fd` switch)

1. Add the entry to `packages/cloud-contracts/src/broker-names.ts#BROKER_SETTINGS`. The two-letter code must be unused.
2. Add the stack parameter (default `"0"`, allowed `"0"`/`"1"`) in `infra/lib/developer-signin.ts#developerSignInParameters`,
   and pack it into the broker's settings in `infra/lib/control-plane.ts` (search for `brokerSettings.add`). Switches
   travel in the packed `AGENTX_SETTINGS` variable, not as separate Lambda variables and not in SSM.
3. Make it settable from the CLI: a row in `packages/cli/src/config/keys.ts#CONFIG_KEYS`, the parameter in
   `packages/cli/src/deploy/parameters.ts#OPERATOR_PARAMETERS` and in
   `packages/cli/src/deploy/parameter-update.ts#NAMED_ENVIRONMENT_ONLY_PARAMETERS`.
4. Read it in the feature's own `switch.ts`. On/off switches are on only when the value is exactly `"1"`
   (`vendor/rovara-code/packages/contracts/src/live-interaction.ts#liveInteractionFlagOn`).
5. Document it in `docs/day-two.md`.
   A live-interaction switch also needs its deploy gate in `vendor/rovara-code/packages/contracts/src/live-interaction.ts#LIVE_INTERACTION_DEPLOY_GATES`
   (`tests/contract/live-interaction-deploy-gate.test.ts`).
6. The new parameter moves the infrastructure digests: strip it in
   `tests/contract/task-person-proof-infrastructure.test.ts#parentRemainderDigest`, then retake the digests (below).

Tests: `tests/contract/broker-settings.test.ts`, `tests/contract/config-keys.test.ts`,
`tests/contract/config-commands.test.ts` (row count), `tests/contract/lambda-environment-size.test.ts`, the digest and
snapshot tests below, and a per-switch test copied from a sibling such as `tests/contract/live-fix-switch.test.ts`.

### A worker feature, so older workers are refused (example: ff8cd431f, `task.ownerRedirect.v1`)

1. Define the feature string in a contracts file (that example used `vendor/rovara-code/packages/contracts/src/live-interaction.ts`).
2. Add it to `packages/cloud-contracts/src/protocol.ts#WORKER_INVOCATION_FEATURES`, and add the optional field to the
   invocation schema in the same file.
3. Refuse delivery to a worker that lacks it: `packages/broker/src/aws/ec2-delivery.ts#forWorkerFeatures`.
4. Add it to `packages/worker/src/implemented-features.ts#WORKER_IMPLEMENTED_FEATURES` only once the worker really
   uses the field.

Tests: `tests/contract/ec2-dispatch.test.ts`, and `tests/contract/worker-server.test.ts`, which holds a literal copy of
the `/ping` feature list that must be updated too.

### An app route under `/v1/app` (examples: 638f557f2, d01147df4)

1. Add a module that exports a path constant, an `isXPath` test, and a `routeX(...)` that returns `undefined` for
   other paths. Put it in `packages/broker/src/aws/developer-routes/`, or in the feature's own folder when the feature
   has one (`packages/broker/src/diagnosis/routes.ts`, `packages/broker/src/spend/routes.ts`).
   `packages/broker/src/aws/developer-routes/setup-recipes.ts#routeSetupRecipes` is a good model.
2. Call it from the dispatch chain in `packages/broker/src/aws/developer-routes.ts#routeDeveloperRequest`. Browser-only
   routes also need the browser-session guard near the top of that function.
3. Build its dependencies in `packages/broker/src/aws/developer-routes/dependencies.ts`.
4. Behind a switch, the route answers not found while the switch is off.
5. The web app's client module goes in `packages/ui/src/api/`.

API Gateway already sends all of `/v1/app/{proxy+}` to the broker, so there's no CDK change. There's no route
inventory test. If the Auditor role must reach the route, add it to
`packages/broker/src/org/auditor.ts#AUDITOR_ALLOWED_ROUTES` (guarded by `tests/contract/auditor-gate.test.ts`).

### An audit event (example: 01ce97233)

1. Add the action to `packages/cloud-contracts/src/audit.ts#AUDIT_ACTIONS` and its allowed fact keys to
   `packages/cloud-contracts/src/audit.ts#AUDIT_FACT_KEYS`. Facts are ids, counts and fixed words only.
2. Add the action and a sample to `tests/contract/audit-contracts.test.ts`. That's the guard.
3. Write the event in the same DynamoDB transaction as the change, using
   `packages/broker/src/audit/outbox.ts#auditPending` and `packages/broker/src/audit/flush.ts#flushAuditEvents`.
   `packages/broker/src/aws/developer-routes/second-review.ts` is a worked example.
4. If the event carries personal details, read `docs/audit-ledger/personal-data.md`.

### A contracts file (examples: 3193de208 browser-safe, d01147df4 Node-only)

0. First ask whether Code's contracts already own the name or should (a shared shape goes to Code first). Only a Cloud-only file goes here.
1. Add `packages/cloud-contracts/src/<name>.ts`.
2. Node-side code imports the barrel: export it from `packages/cloud-contracts/src/index.ts`.
3. If the browser needs it, export it from `packages/cloud-contracts/src/web.ts` and add it to
   `packages/cloud-contracts/web-safe-files.json` (sorted). It must not import `node:*`. A file only the browser uses may skip
   `index.ts` (`vendor/rovara-code/packages/contracts/src/app-second-review.ts` does); most files are in both.

Tests: `tests/contract/contracts-web-entry.test.ts` (the browser file list must match exactly),
`tests/contract/contracts-barrel-duplicate-exports.test.ts`, and `tests/contract/task-owner-reads.test.ts` if anything
reads a task's owner fields. A schema with a person-id field also needs `packages/broker/src/team-record/person-fields.ts#PERSON_FIELDS`
(`tests/unit/team-record-core/person-fields.test.ts`).

### Retake infrastructure digests and template snapshots (example: b638814f5)

Do this only after an intended infrastructure change, such as a new switch or parameter.

1. Run `npx vitest run tests/contract/task-person-proof-infrastructure.test.ts`. The failure prints the new digests.
   Copy those values into the file's `digestCases` and add a dated comment saying what moved. Never type digests by hand.
2. Run `npx vitest run tests/contract/named-templates.test.ts tests/contract/legacy-templates.test.ts -u` to rewrite the
   snapshots. Read the snapshot diff: it should show only your change.

### A new DynamoDB read in the broker (example: d01147df4)

1. Add the key helper to `packages/cloud-contracts/src/org-scoped-keys.ts`, and the read to the feature's store module.
2. The broker's role can already read and write the State table. Another Lambda (notifier, dispatcher) needs its own
   grant, checked by `tests/contract/lambda-dynamodb-key-grants.test.ts`.
3. A read of a task's owner fields needs a row in `tests/contract/task-owner-reads.test.ts`.
4. An item that holds a person id needs an erase step and a `packages/broker/src/team-record/person-fields.ts#PERSON_FIELDS`
   row.

No single test lists every broker read.

## What each file owns

### `packages/broker/src/aws/broker/`

<!-- codemap:files packages/broker/src/aws/broker -->
| File | What it owns |
|---|---|
| `acceptance.ts` | accepting tasks and pull requests, and cancelling tasks. |
| `admin-and-helpers.ts` | SWE-bench routes, admin task reads, keys, request parsing helpers and event hooks. |
| `ask-service.ts` | Live interaction A3: the broker's wiring for Ask, and the three service routes the chat service calls (`/v1/service/asks/*`, the orchestrator role only). |
| `attention-wiring.ts` | UX2 slice 2 item 5: the broker's wiring for task notifications (`notifications/attention.ts`), run by the five-minute session sweep. |
| `attribution-erasure.ts` | Enterprise foundations I3 (wiring): the broker's side of erasing a person from the attribution change requests carry. |
| `callbacks.ts` | worker callbacks, workflow candidate export, build source and baseline source. |
| `capture-adapters-wiring.ts` | the GitHub code host through the one capture interface learning reads a host by (team-record/sources/capture-adapters.ts). |
| `code-host-events.ts` | P6: the broker end of the neutral code host events, for any registered host. |
| `code-host-poll.ts` | P6: the broker end of the poller. |
| `company-rules-wiring.ts` | Company rules (G-04, switch `si`): the broker's wiring. |
| `consumer-hosts.ts` | Enterprise foundations P5a-c: the code host and check runner the broker hands to Rovara Code's consumers (merge, merge tracking, CI fix, feedback autonomy). |
| `context-tools.ts` | the internal context-tool routes (`GET /v1/internal/context-tools`, `POST /v1/internal/context-tools/call`). |
| `credential-exchange.ts` | Enterprise foundations N-3 (wiring): the credential the broker hands a worker at `/repository-credentials` comes from the repository's code host (the port's `issueGitCredential`) and is held to `workerGitCredentialUsa... |
| `decision-press.ts` | a decision card's button pressed in Slack (wire-proof). |
| `definitions.ts` | limits, the setup capture policy, the record and dependency types, route keys. |
| `dependency-wiring.ts` | builds the dependency objects handed to the agent, chain, admin, plan and developer-task routes. |
| `design-review-packet-route.ts` | Part of the broker, DR7 slice A: `GET /v1/internal/design-review/packet?slot=<key slot>`, the one route a design-review worker reads a reviewer's packet from. |
| `design-review-slot-access.ts` | Part of the broker, DR7 slice A: what `GET /v1/internal/model-access?slot=` does differently for a design-review operation (model-access.ts calls into this; an operation WITHOUT a stored binding never does). |
| `diagnosis-service.ts` | Live interaction F2: the broker's wiring for Fix with agent's light tier, and the three service routes the chat service calls (`/v1/service/diagnoses/*`, the orchestrator role only). |
| `dispatch.ts` | agent run, workflow and autofix dispatch. |
| `e2e-rounds.ts` | application E2E rounds (baseline, replay, grounding) and their dispatch. |
| `edition-wiring.ts` | Enterprise foundations E2: the edition of this install, read once at cold start from the deploy stamp (ROVARA_EDITION). |
| `evidence-and-setup.ts` | workflow E2E evidence upload and project setup evidence and callbacks. |
| `evidence-wiring.ts` | the proof evidence's hook on the end of a verification run (wire-proof). |
| `feedback-and-codebuild.ts` | callback refusals, feedback approvals, CodeBuild records and pull request updates. |
| `fix-setup-wiring.ts` | Setup and test health (SH17): what the auto-fix runner needs to turn an ask about the test environment into a Fix setup card. |
| `fixture-delivery.ts` | The fixture delivery callback, broker side (test services, slice 3, s3-fakes-run): `POST /v1/internal/workspaces/{w}/operations/{o}/fixture-set`. |
| `handler.ts` | createAwsBrokerHandler: the request router. |
| `learning-model.ts` | Learning v2 production wiring (lessons-in-production lane 1): the model the learning pipeline calls (`PipelineModel`: the reflector, the curator's judge), on the COMPANY's own AI provider. |
| `learning-spend.ts` | Learning v2 production wiring (lessons-in-production lane 1): the company's own limit on what learning may spend (`LearningSpend`, `lessons/ports.ts`). |
| `learning-wiring.ts` | the learning lane's hook on the end of a task. |
| `lesson-slack-author.ts` | Lessons sweep (lane D): who a Slack thread reply's author is, for the lessons' subject source (`lesson-subject-source.ts`, `slackAuthor`). |
| `lesson-subject-source.ts` | Learning v2 production wiring (lessons-in-production lane 1): the reflector's task-side facts, read from what the broker really records about a finished task (`TaskSubjectSource`, `lessons/task-end.ts`). |
| `lesson-thread-note-authors.ts` | Lessons sweep (lane D): who wrote each saved note of a task (`NOTE#` rows), for the lessons' subject source (`threadNotes`). |
| `lessons-dispatch.ts` | the lesson loader's one call at a coding stage's dispatch (learning v2, L4). |
| `lessons-repo-file-wiring.ts` | Lessons in the repo, lane R2: builds the lessons file pass's ports from the broker's own dependencies (`lessons/repo-file-job.ts` RepoFileRuntime). |
| `lessons-report.ts` | what a worker's progress events tell the lessons library (learning v2, L4/L5) and the "What the agent loaded" record. |
| `lessons-wiring.ts` | builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. |
| `lessons-worker.ts` | the LessonsWorker's handler (lessons in production, lane 2, WB-4). |
| `meta-repo-wiring.ts` | Meta repo lane A: the broker's wiring for creating a project from a meta repo and for the meta repo's config file, kept in one module so the handler needs two lines. |
| `model-access.ts` | write gate, model access (web and Slack), turn routing and budgets. |
| `nightly-head.ts` | Setup and test health SH17 (quiet repository): the reader of a project's default-branch head that lets a nightly baseline older than 7 days still count when the branch has not moved since it ran (`test-env/nightly-usa... |
| `nightly-run-wiring.ts` | The nightly run's joints to the broker's own dependencies (NH-1). |
| `plan-answers.ts` | plan critique, plan answers, CI checks and planner replies. |
| `plugin-wiring.ts` | Enterprise foundations P4: the plug-ins the broker registers. |
| `project-registration.ts` | project registration, cloud project creation, the project catalog and setup admission. |
| `pull-request-reconcile.ts` | Linear lines, pull request reconciliation, event append and artifacts. |
| `records.ts` | reading artifacts, workspaces, projects, pull requests and memberships. |
| `redirect-runtime.ts` | Stop & redirect, the broker's side of the world (live-interaction design 3.7, switch `rd`): what the redirect needs that is not the table. |
| `registry-credentials.ts` | N9 (INTG2): the broker's wiring of a project's registry credentials: the route's handler, and the registries a prepare invocation carries. |
| `registry-tokens-wiring.ts` | N9 (INTG2): the broker's own AWS identity as a CodeArtifact token source. |
| `repository-hosts.ts` | Enterprise foundations P5d/P5e: how the broker's task side and route side reach a repository's code host. |
| `runtime-clients.ts` | the AWS client configuration, DynamoDB client, Step Functions client and EC2 session manager. |
| `saved-env-aws.ts` | Saved project images (SV wiring): the AWS adapters of the registry's ports. |
| `saved-env-lease.ts` | Saved project images (SV wiring): the three handlers over the stored records. |
| `saved-env-login.ts` | Saved environments (SH25, review M1): the route's handler. |
| `saved-env-prepare.ts` | Saved environments (SH25): the saved image field of a prepare invocation, and the install of the registry's hooks. |
| `saved-env-real.ts` | Saved project images (SV wiring): the registry's real bindings, built only while the install's `sv` switch is on. |
| `saved-env-rebuild.ts` | Saved project images (SV wiring): starting the rebuild job. |
| `saved-env-sweep.ts` | Saved project images (SV wiring): settling the end of a rebuild. |
| `saved-env-triggers.ts` | Saved project images (SV wiring): what makes the registry look at a project, and what starts the job it queues. |
| `scope-helpers.ts` | environment, organisation and GitHub scope helpers, egress decisions, connection stores. |
| `second-review-evidence-routes.ts` | Second review (lane cr-settings, switch `cr`): the writers of the evidence that lets a model block. |
| `seed-lock-wiring.ts` | SEED-RISK-1: the code host's side of the broker's seed locks (test-env/seed-lock.ts). |
| `setup-pins.ts` | P1 (su): the broker pins the commit a setup run reads. |
| `setup-stopped-result.ts` | F5 (su): a setup run that a person stopped ends at once (the cancel's own transaction), and the worker, which was asked to abort, finishes within a few seconds and reports the partial proposal it had. |
| `slack-workflow-events.ts` | Slack workflow, people and note events. |
| `spec-wiring.ts` | Meta repo lane D (K1): what the broker's operation end needs to settle a spec write or a spec publication. |
| `staff-routes.ts` | Enterprise foundations E3: Rovara staff routes are off in the Enterprise edition. |
| `sweeps-and-readiness.ts` | scheduled event predicates, dispatch failure records, E2E readiness. |
| `task-operations.ts` | agent steps, the task operation parts, application selection, agent skills and tools. |
| `team-record-wiring.ts` | the Team record's call sites. |
| `terminal-and-github-events.ts` | queued first tasks, terminal results, GitHub workflow events, merge recovery. |
| `terminal-result.ts` | recording a task's terminal result and the stop, end and close notices. |
| `thread-workspaces.ts` | closing workspaces, admitting Slack work, thread workspaces and their preparation. |
| `ticket-updates-wiring.ts` | Slice 5 "Outside tools" (owner decision 6): the broker's wiring of ticket updates. |
| `workflow-e2e-verification.ts` | verifying workflow E2E evidence, authority checks and presentations. |
| `workflow-items.ts` | retries, evidence jobs and the items each completed workflow step writes. |
| `workspace-preparation.ts` | workspace preparation, Slack identities, shared threads and Slack bindings. |
| `workspace-routes.ts` | Slack refusal answers, workspace routing, connector and GitHub context. |
<!-- /codemap:files -->

### `packages/broker/src/aws/developer-tasks/`

<!-- codemap:files packages/broker/src/aws/developer-tasks -->
| File | What it owns |
|---|---|
| `access-resume.ts` | (No header comment.) Exports `resumeParkedTaskDispatch`. |
| `access.ts` | (No header comment.) Exports `refuse`, `loadOwnedTask`, `AuthorizedTask`. |
| `cancel.ts` | (No header comment.) Exports `TaskActor`, `cancelTaskFor`, `BLOCKED_NOT_RUNNING`. |
| `close.ts` | (No header comment.) Exports `openPullRequest`, `finishTaskClose`, `workflowTaskFinished`. |
| `common.ts` | (No header comment.) Exports `creatorGuard`, `TASK_ID`, `iso`. |
| `continue.ts` | (No header comment.) Exports `continueTask`, `heldPreparationOptions`, `heldSavedEnvPin`. |
| `decide.ts` | (No header comment.) Exports `recordPublishedCandidateOutcomes`, `DESIGN_CARD_ONLY_MESSAGE`, `decideTaskWorkflow`. |
| `design-decision.ts` | Design review stage, DR7 slice C (money W2): the COMMIT PORT of `designApproveHandler`. |
| `design-proof.ts` | Design review stage, DR7 slice C (DR12 wiring): the two ports `loadProofDesignContext` reads, built from what the broker holds. |
| `design-resolve-retry.ts` | Design review stage, DR7 slice B2: the owner's Retry of a planner run that BLOCKED while it was answering a design review's findings (a rule file that could not be verified, a leftover program, a run that failed). |
| `design-spec.ts` | Design review stage, DR7 slice C (DR12 wiring): the spec step's view of the design. |
| `error-ref.ts` | Live interaction F1: the ErrorRef a task view carries, so the app can offer "Fix with agent" for an error it shows. |
| `evidence-port.ts` | Proof and evidence (wire-proof): what the task routes need to show a task's evidence: the pack kept for the task's current code (rovara-code/evidence-keep.ts), as the pull request shows it (counts, a link) and as the... |
| `evidence-risk-input.ts` | Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). |
| `feedback-capture.ts` | (No header comment.) Exports `startTaskWorkflowFeedbackReviewFromWebhook`, `FEEDBACK_REVIEW_RETRY_BUSY`, `FEEDBACK_REVIEW_RETRY_CHANGED`. |
| `feedback-review.ts` | (No header comment.) Exports `FEEDBACK_REVIEW_RETRY_FROM_TASK_PAGE`, `FEEDBACK_REVIEW_RETRY_FROM_TASK_PAGE_OR_SLACK`, `getWorkflowFeedbackReview`. |
| `health-notice.ts` | Setup and test health SH28 (owner decision 7): "Setup needs repair" does not pause a task start. |
| `learning-events.ts` | Learning v2 wiring (WA-2): what the task actions tell the learning lane. |
| `lessons-replay.ts` | Lane 7 (0.5.12, DECISIONS 38, 49, 68): the replay COPY of a past task, for the lessons replay (`scripts/lessons-replay-measure.ts`). |
| `owner-stop.ts` | S2 (send-back gate completeness): the one place a step Rovara is about to start on its own (a fix round, a custom sequence's next coding step, a PR-feedback critic) is refused because the task's owner may no longer ha... |
| `publication-context.ts` | (No header comment.) Exports `e2ePublicationContext`. |
| `publication.ts` | (No header comment.) Exports `currentWorkflowPublicationAuthorityForTask`, `currentWorkflowPublicationModeForTask`, `startTaskWorkflowPublicationFromSystem`. |
| `pull-request-body.ts` | (No header comment.) Exports `workflowPullRequestBody`, `fitPullRequestBody`, `pullRequestTitle`. |
| `redirect-carry.ts` | Stop & redirect, the Retry that keeps the instruction (LR-2). |
| `redirect-frame.ts` | Stop & redirect: the two small things a restart and a Retry that keeps the instruction both need, apart from the restarts so the retry paths can use them without a cycle (LR-2). |
| `redirect-restart.ts` | Stop & redirect, phase 2: the task module's side of the restart (agent-sessions/redirect-continue.ts decides WHETHER to restart; these start the run). |
| `release.ts` | (No header comment.) Exports `FinishedTaskRelease`, `ReleaseDeps`, `recordFinishedRunCost`. |
| `second-review-ack.ts` | Second review (SR-1, switch `cr`): the task owner acknowledges that an `on` second review did not run, so the merge may go ahead. |
| `share.ts` | (No header comment.) Exports `safeDecode`, `ShareAdmin`, `ShareModeDependencies`. |
| `spec-replan.ts` | Wire lane D (MD-1): "Re-plan" on a changed spec. |
| `spec-wiring.ts` | Meta repo lane D (K1): the task side of the spec. |
| `start.ts` | (No header comment.) Exports `limitError`, `chargeFailure`, `shareFor`. |
| `task-answer-context.ts` | (No header comment.) Exports `workflowTaskAnswerContext`, `taskCommentSection`, `taskOwnsThread`. |
| `task-index.ts` | (No header comment.) Exports `runResultOf`, `ownerIndexRowOf`, `syncIndex`. |
| `task-page.ts` | (No header comment.) Exports `designCardOnlyApplies`, `taskPageStage`, `publicationAttempts`. |
| `task-people.ts` | (No header comment.) Exports `taskPeopleEffectsDependencies`, `getTaskPeople`, `getTaskPeopleCapabilities`. |
| `task-reads.ts` | (No header comment.) Exports `readTask`, `getTaskPlan`, `listTasks`. |
| `task-view.ts` | (No header comment.) Exports `candidateChangedFiles`, `candidateDiffText`, `unpublishedOf`. |
| `task-window.ts` | (No header comment.) Exports `actionableWorkspace`, `busyOrClosing`, `extraItemsCancelled`. |
| `testing-view.ts` | Setup and test health SH18/SH19: the Testing view of a task, read for the pull request's `## Testing` section, its rewrite after a pushed fix, and the task page. |
| `thread-notes.ts` | (No header comment.) Exports `planWhyEntries`, `personLabel`, `recordWorkflowThreadNote`. |
| `types.ts` | (No header comment.) Exports `DeveloperTaskRouteDependencies`. |
| `workflow-coding.ts` | (No header comment.) Exports `queueWorkflowCoding`, `resumeAfterRunLimitApproval`, `planCheckRetryKey`. |
| `workflow-inputs.ts` | (No header comment.) Exports `retiredClaimIdList`, `planUnreadablePrompt`, `previousMarkdownBlock`. |
| `workflow-retry.ts` | (No header comment.) Exports `startTaskWorkflowPlanRevisionFromSystem`, `retryTaskWorkflow`. |
| `workflow-review.ts` | (No header comment.) Exports `startTaskWorkflowReview`, `queueWorkflowReview`, `startTaskWorkflowReviewFromSystem`. |
| `workflow-revise.ts` | Live steer: the owner's "Revise the plan with this change" (agent-sessions/live-steer-revise.ts holds the press); the task helpers it needs are handed in here and nothing else is decided here. |
| `workflow-starts.ts` | (No header comment.) Exports `queueWorkflowUnderstand`, `startTaskWorkflowUnderstandFromSystem`, `startTaskWorkflowPlanFromSystem`. |
<!-- /codemap:files -->

### `packages/broker/src/aws/developer-routes/`

<!-- codemap:files packages/broker/src/aws/developer-routes -->
| File | What it owns |
|---|---|
| `audit-export-fresh.ts` | Enterprise foundations I2/I1 (controller default, pending the owner's answer): starting an audit export needs a sign-in made within the last few minutes (the rule of the other high-risk actions, `isFreshSignIn`). |
| `authentication.ts` | (No header comment.) Exports `DeveloperTokenClaims`, `developerClaims`, `getSignIn`. |
| `card-decide-grade.ts` | Security review follow-up (2026-11-06): the decide-grade sign-in for a HIGH card that has no approval of its own: a high design (the task page's inline approve) and a high requirements or coding plan card. |
| `common.ts` | (No header comment.) Exports `PROJECT_NOT_FOUND_IN_APP`, `signInStoreOf`, `bodyError`. |
| `company-domains.ts` | Company domain verification (owner decision 2026-11-02): the owner-only "Company domains" routes. |
| `company-rules.ts` | Company rules (G-04, owner decisions 57 and 85; switch `si`, StandingInstructionsEnabled): the admin's routes. |
| `company-test-images.ts` | Company-approved extra test-service images (switches `tx` and `pj`): the admin's routes at `/v1/app/org/test-images` (read: any admin; change: browser session, admin, fresh sign-in to approve). |
| `connection-usage.ts` | `GET /v1/app/connection-usage`: which projects use each company connection, for the "used by" line of the Connections page. |
| `decisions.ts` | Decision cards (wire-proof, setup wizard E4): what the card routes (`decisions/routes.ts`) need for one caller, built from the developer route dependencies. |
| `dependencies.ts` | (No header comment.) Exports `setupDraftDepsOf`, `diagnosisRouteDepsOf`, `agentRunStarterOf`. |
| `design-review-company.ts` | Design review (DR-FU4): `/v1/app/org/design-review`, the company's How we work card for design review, for company owners and admins only. |
| `design-review.ts` | Design review stage, DR7 slice C: the routes and the decision cards of a design under review, and the ports the design review's handlers need. |
| `fixtures.ts` | Test services, slice 3 (s3-fakes-store): the routes for a hand-written fake (a FixtureSet v2) and its review. |
| `identity-lambda.ts` | (No header comment.) Exports `errorName`, `SLACK_UNAVAILABLE`, `channelMembersThroughLambda`. |
| `install.ts` | Enterprise foundations E2: GET /v1/app/install. |
| `intake.ts` | Meta repo lane F (F1): the broker's wiring of the intake routes (`rovara-code`-style: one module, so the router needs two lines). |
| `jira-org-admin.ts` | The Jira organization admin key (DV-1, owner decision 2026-11-02): `/v1/app/org/jira-org-admin`, the one place a company owner or admin sets or clears the READ-ONLY Atlassian organization admin API key and the Atlassi... |
| `known-failing-marks.ts` | Setup and test health KF-1: `/v1/app/projects/{name}/known-failing`, the tests a maintainer marked as already failing, and Undo. |
| `known-failing-policy.ts` | Setup and test health SH17 (owner decision F4): `/v1/app/org/known-failing-policy`, the company setting "always two people" for marking tests as already failing. |
| `learning-model.ts` | Lessons in production, lane 1b: the company's "lessons model" setting, `/v1/app/org/learning-model` (the model its lesson learning runs on; unset = the cheapest suitable company-billed model). |
| `lessons-local.ts` | Lessons for local coding tools (decision 46b, lane B1): `POST /v1/dev/projects/{p}/lessons`, the route boundary (project role, `lessons` script-token permission, 60 a minute per person, the day's counter) over `lessons/local-tools.ts#lessonsForLocalTool`. |
| `lessons.ts` | Learning v2 L3b wiring: the lessons routes and the loaded-knowledge routes on the developer routes. |
| `organization.ts` | (No header comment.) Exports `createProject`, `getAppNavigation`, `getAppMe`. |
| `outside-cards.ts` | Decision journey slice 3b: outside approvers decide on the card. |
| `plan-cards.ts` | Decision journey slice 2: the requirements and the coding plan as decision cards, decided on the card (Approve, Request changes) through the ONE workflow decision Slack, MCP and the task page use (`decideTaskWorkflow`... |
| `plan-panel.ts` | OWNER DECISION 18 (PLAN-PANEL-NOW): the task page reads, discusses and decides the plan in one place. |
| `project-access.ts` | (No header comment.) Exports `checkProjectAccess`, `listWorkspaces`. |
| `project-archive-setup.ts` | (No header comment.) Exports `archiveDepsOf`, `egressDepsOf`, `getAppProject`. |
| `project-list.ts` | (No header comment.) Exports `queryAll`, `REVISION_READS_AT_ONCE`, `mapLimit`. |
| `project-members.ts` | (No header comment.) Exports `projectRoleForRoute`, `getProjectMembers`, `putProjectMember`. |
| `project-settings.ts` | (No header comment.) Exports `listGithubRepositories`, `putProjectSettings`, `projectMetaConfigRoute`. |
| `saved-env-image.ts` | Saved project images (SV wiring, switch `sv`): the project's Environment panel as routes. |
| `second-review.ts` | Second review by another AI company (SR-1, switch `cr`): `/v1/app/org/second-review`, the picker's preview and the company's choice. |
| `settings-proof-hook.ts` | TE-4: the broker tells the settings proof when a project's setup check has reported (terminal-result.ts), so a held API change is written or dropped, and a failed save's message is sent, without waiting for someone to... |
| `settings-proof.ts` | TE-4 (owner decision 2026-11-02): the project settings PUT does not write commands with no proof, whoever sends it. |
| `setup-agent.ts` | Setup agent routes (sh-setup-wire, SH14; design setup-test-health 3.4): `/v1/app/projects/{name}/setup-agent`, `.../stop`, `.../command` and `.../journal`. |
| `setup-recipes.ts` | Setup and test health SH29 wiring (switch `sp`): company setup recipes, as routes. |
| `spec-routes.ts` | Meta repo lane D: the task owner's choices on a held spec. |
| `sso.ts` | Enterprise foundations I1: the admin routes for company group sign-in. |
| `task-findings.ts` | UX2 slice 2 item 3: review findings are decided on the task page in Rovara, with the same authority as Slack and the MCP tools. |
| `task-page-actions.ts` | OWNER DECISION 7: what the old review page (`/review/<task>/task`) could still press on a stopped task, now on the task page in Rovara, through the very functions that page and Slack call: POST /v1/app/tasks/{id}/work... |
| `team-record-source-write.ts` | What a Team record source write needs from the broker's own request (`team-record/source-write.ts`): the caller's company role and whether the session is a live browser one, the body (read only when a write asks for i... |
| `test-environment-candidate.ts` | TE-2: a test-environment proposal's candidate check, as the routes use it. |
| `test-environment-wizard.ts` | Setup wizard (E4), the parts of the test-environment routes that go beyond propose / prove / approve: edit a maintainer's EDITED proposal body: validated like any environment, then stored as a proposal (never approved... |
| `test-environment.ts` | Test environment (wire-testenv, setup wizard E4): the setup routes. |
| `test-health.ts` | Setup and test health SH28: `/v1/app/projects/{name}/test-health`, behind the `nh` switch (and the test environment): with either off the path is not found, as any unknown path. |
| `tracker-people.ts` | Tracker people (lane team-record-links): `/v1/app/org/tracker-people`, the page where a company admin maps the Linear and Jira people the automatic linker could not match to a member of the company. |
| `types.ts` | (No header comment.) Exports `CLOSE_STOP_BUDGET_MS`, `DeveloperApiConfiguration`, `DeveloperRouteDependencies`. |
<!-- /codemap:files -->
