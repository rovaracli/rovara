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
- **The workflow model** (steps, states, send-back rules) is in `packages/contracts/src/task-workflow-node.ts`.
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
  The rules are `packages/contracts/src/task-workflow-node.ts#sendBackProblems`.
- **Stop and redirect** (switch `rd`). `packages/broker/src/agent-sessions/stop.ts#stopSession`,
  `packages/broker/src/agent-sessions/redirect.ts#redirectSession`, the broker side in
  `packages/broker/src/aws/broker/redirect-runtime.ts`, and restarts in `packages/broker/src/aws/developer-tasks/redirect-restart.ts`.
  Cancel is `packages/broker/src/aws/developer-tasks/cancel.ts#cancelTask`.
- **Publish a pull request.** `packages/broker/src/aws/developer-tasks/publication.ts`. The PR body is built in
  `packages/broker/src/aws/developer-tasks/pull-request-body.ts#workflowPullRequestBody`.
- **Merge.** A person presses merge: `packages/broker/src/rovara-code/merge.ts#pressMerge` (readiness in
  `packages/broker/src/rovara-code/merge.ts#mergeReadiness`). After that, `packages/broker/src/rovara-code/merge-tracking.ts#trackTask`
  follows the PR. The web button is `packages/ui/src/screens/session/MergeSection.tsx#MergeSection`.
- **The task page** the app shows: `packages/broker/src/aws/developer-tasks/task-page.ts#getTaskPageState` and
  `packages/broker/src/aws/developer-tasks/task-view.ts#taskView`.

## Time limits

- Chains: the default and minimum step time are `packages/contracts/src/chains.ts#STEP_DEFAULT_TIMEOUT_MINUTES` and
  `packages/contracts/src/chains.ts#STEP_MIN_TIMEOUT_MINUTES`; the step schema in the same file enforces the minimum.
  Running chains are timed out by `packages/broker/src/chains/lifecycle.ts#sweepChainRuns`.
- Agent runs: `packages/broker/src/agents/run-engine.ts#DEFAULT_STEP_MINUTES`. A recipe step can set its own
  `timeoutMinutes` (`packages/contracts/src/agent-recipe.ts`).
- On the worker, the model-call limits and the planning deadline are set up in `packages/worker/src/run-task.ts`
  (search for `planningDeadlineMs`).
- The nightly run's limit is `packages/broker/src/test-env/nightly.ts#NIGHTLY_RUN_MAX_MS`.

## Switches and settings

- Every feature switch is in `packages/contracts/src/broker-names.ts#BROKER_SETTINGS`, as a two-letter code plus the
  variable the broker reads. Search for `code: "xx"`. Fixed resource names are in
  `packages/contracts/src/broker-names.ts#BROKER_NAMES`.
- The broker unpacks them at start-up in `packages/broker/src/aws/broker-environment.ts#hydrateBrokerEnvironment`.
  Each feature reads its own switch in a small `switch.ts`, for example `packages/broker/src/test-env/switch.ts`.
- The CDK side, which turns stack parameters into the packed settings, is `infra/lib/broker-names.ts`.

## Features by folder (`packages/broker/src/`)

| Feature | Where |
|---|---|
| Money: budgets, reservations, settlement | `packages/broker/src/spend/` (routes: `packages/broker/src/spend/routes.ts#routeSpendRequest`) |
| Team record (switch `tn`) | `packages/broker/src/team-record/` (routes: `packages/broker/src/team-record/routes.ts#handleRecordRoute`; wiring: `packages/broker/src/aws/broker/team-record-wiring.ts`; source rows written and removed from the app (a removal queues the place's deletion for the delete worker): `packages/broker/src/team-record/source-write.ts` and `packages/broker/src/team-record/source-store.ts`; Rovara's own events (remembered note, plan outcome, review outcome, task end) announced to the record: `packages/broker/src/lessons/record-events.ts`) |
| Track record (per-step stats in the playbook) | `packages/broker/src/playbook/track-record.ts`. Not the same thing as the Team record. |
| Lessons (learning v2, switch `ll`) | `packages/broker/src/lessons/`. Loaded into a run by `packages/broker/src/aws/broker/lessons-dispatch.ts#learnedContextForOperation`. Learning capture is in `packages/broker/src/learning/`. |
| Test environment, nightly run, saved images (`ev`, `nh`, `sv`) | `packages/broker/src/test-env/`. Routes: `packages/broker/src/aws/developer-routes/test-environment.ts`. Contracts: `packages/contracts/src/test-environment.ts`. |
| Why a task ran (user, test run, nightly) | `packages/contracts/src/agent-run-node.ts#WORK_ORIGINS` |
| Proof and evidence (`pe`) | `packages/broker/src/proof/`, wired in `packages/broker/src/aws/broker/evidence-wiring.ts` |
| Decision cards (`dk`) | `packages/broker/src/decisions/` |
| Chains and triggers | `packages/broker/src/chains/`, `packages/broker/src/triggers/` |
| Agent sessions (live, stop, redirect, ask) | `packages/broker/src/agent-sessions/` |
| Plug-ins: code hosts and check runners | `packages/broker/src/plugins/`, registered in `packages/broker/src/aws/broker/plugin-wiring.ts#createBrokerPlugins` |
| Audit | `packages/broker/src/audit/` |

## Worker

- A task run: `packages/worker/src/run-task.ts#runTaskInvocation`, started from `packages/worker/src/main.ts`. Its
  HTTP server is `packages/worker/src/server.ts`.
- The features this worker supports: `packages/worker/src/implemented-features.ts#WORKER_IMPLEMENTED_FEATURES`. The
  protocol version and the features an invocation can require are in `packages/contracts/src/protocol.ts#AGENTX_PROTOCOL_VERSION`
  and `packages/contracts/src/protocol.ts#WORKER_INVOCATION_FEATURES`.
- Lessons on the worker: `packages/worker/src/learned-context.ts#validateLearnedContext`.
- There is no `executor/run.ts` in the worker. The one in `packages/verifier/src/executor/run.ts` is the E2E executor.

## Web app

- `packages/web` is a thin shell: `packages/web/src/bootstrap.tsx` mounts the app, and `packages/web/src/server/handler.ts`
  serves it.
- The pages are in `packages/ui/src/screens/`, the route list is `packages/ui/src/routes.tsx#appRoutes`, and the API
  client is `packages/ui/src/api/client.ts#createApiClient` (one module per area in `packages/ui/src/api/`).

## Contracts

- The barrel is `packages/contracts/src/index.ts`. Code that runs in the browser imports `@agentx/contracts/web`
  (`packages/contracts/src/web.ts`). Its file list `packages/contracts/web-safe-files.json` is checked by
  `tests/contract/contracts-web-entry.test.ts`.
- Every read of a task's owner fields must be on the list in `tests/contract/task-owner-reads.test.ts`. It is checked by
  a scan (`tests/support/task-owner-scan.ts`).

## Infra

- The CDK app is `infra/bin/agentx.ts`. It calls `infra/lib/app.ts#buildAgentXApp`, which creates every stack. The main
  one is `infra/lib/control-plane.ts#ControlPlaneStack`.

## How to add common things

Each recipe lists the files to touch in order and the tests that fail if you forget one. When in doubt, read the
example commit with `git show <sha> --stat`.

### A feature switch (example: d01147df4, the `fd` switch)

1. Add the entry to `packages/contracts/src/broker-names.ts#BROKER_SETTINGS`. The two-letter code must be unused.
2. Add the stack parameter (default `"0"`, allowed `"0"`/`"1"`) in `infra/lib/developer-signin.ts#developerSignInParameters`,
   and pack it into the broker's settings in `infra/lib/control-plane.ts` (search for `brokerSettings.add`). Switches
   travel in the packed `AGENTX_SETTINGS` variable, not as separate Lambda variables and not in SSM.
3. Make it settable from the CLI: a row in `packages/cli/src/config/keys.ts#CONFIG_KEYS`, the parameter in
   `packages/cli/src/deploy/parameters.ts#OPERATOR_PARAMETERS` and in
   `packages/cli/src/deploy/parameter-update.ts#NAMED_ENVIRONMENT_ONLY_PARAMETERS`.
4. Read it in the feature's own `switch.ts`. On/off switches are on only when the value is exactly `"1"`
   (`packages/contracts/src/live-interaction.ts#liveInteractionFlagOn`).
5. Document it in `docs/day-two.md`.
   A live-interaction switch also needs its deploy gate in `packages/contracts/src/live-interaction.ts#LIVE_INTERACTION_DEPLOY_GATES`
   (`tests/contract/live-interaction-deploy-gate.test.ts`).
6. The new parameter moves the infrastructure digests: strip it in
   `tests/contract/task-person-proof-infrastructure.test.ts#parentRemainderDigest`, then retake the digests (below).

Tests: `tests/contract/broker-settings.test.ts`, `tests/contract/config-keys.test.ts`,
`tests/contract/config-commands.test.ts` (row count), `tests/contract/lambda-environment-size.test.ts`, the digest and
snapshot tests below, and a per-switch test copied from a sibling such as `tests/contract/live-fix-switch.test.ts`.

### A worker feature, so older workers are refused (example: ff8cd431f, `task.ownerRedirect.v1`)

1. Define the feature string in a contracts file (that example used `packages/contracts/src/live-interaction.ts`).
2. Add it to `packages/contracts/src/protocol.ts#WORKER_INVOCATION_FEATURES`, and add the optional field to the
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

1. Add the action to `packages/contracts/src/audit.ts#AUDIT_ACTIONS` and its allowed fact keys to
   `packages/contracts/src/audit.ts#AUDIT_FACT_KEYS`. Facts are ids, counts and fixed words only.
2. Add the action and a sample to `tests/contract/audit-contracts.test.ts`. That's the guard.
3. Write the event in the same DynamoDB transaction as the change, using
   `packages/broker/src/audit/outbox.ts#auditPending` and `packages/broker/src/audit/flush.ts#flushAuditEvents`.
   `packages/broker/src/aws/developer-routes/second-review.ts` is a worked example.
4. If the event carries personal details, read `docs/audit-ledger/personal-data.md`.

### A contracts file (examples: 3193de208 browser-safe, d01147df4 Node-only)

1. Add `packages/contracts/src/<name>.ts`.
2. Node-side code imports the barrel: export it from `packages/contracts/src/index.ts`.
3. If the browser needs it, export it from `packages/contracts/src/web.ts` and add it to
   `packages/contracts/web-safe-files.json` (sorted). It must not import `node:*`. A file only the browser uses may skip
   `index.ts` (`packages/contracts/src/app-second-review.ts` does); most files are in both.

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

1. Add the key helper to `packages/contracts/src/org-scoped-keys.ts`, and the read to the feature's store module.
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
| `attribution-erasure.ts` | Enterprise foundations I3 (wiring): the broker's side of erasing a person from the attribution change requests carry. |
| `callbacks.ts` | worker callbacks, workflow candidate export, build source and baseline source. |
| `code-host-events.ts` | P6: the broker end of the neutral code host events, for any registered host. |
| `code-host-poll.ts` | P6: the broker end of the poller. |
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
| `handler.ts` | createAwsBrokerHandler: the request router. |
| `learning-wiring.ts` | the learning lane's hook on the end of a task. |
| `lessons-dispatch.ts` | the lesson loader's one call at a coding stage's dispatch (learning v2, L4). |
| `lessons-report.ts` | what a worker's progress events tell the lessons library (learning v2, L4/L5) and the "What the agent loaded" record. |
| `lessons-wiring.ts` | builds the lessons library's ports from the broker's own dependencies (learning v2, LS-3) and puts them on `dependencies.lessons`. |
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
| `cancel.ts` | (No header comment.) Exports `TaskActor`, `cancelTaskFor`, `retryTaskWorkflowFor`. |
| `close.ts` | (No header comment.) Exports `openPullRequest`, `finishTaskClose`, `workflowTaskFinished`. |
| `common.ts` | (No header comment.) Exports `creatorGuard`, `TASK_ID`, `iso`. |
| `continue.ts` | (No header comment.) Exports `continueTask`, `heldPreparationOptions`, `heldSavedEnvPin`. |
| `decide.ts` | (No header comment.) Exports `recordPublishedCandidateOutcomes`, `decideTaskWorkflow`. |
| `design-decision.ts` | Design review stage, DR7 slice C (money W2): the COMMIT PORT of `designApproveHandler`. |
| `design-proof.ts` | Design review stage, DR7 slice C (DR12 wiring): the two ports `loadProofDesignContext` reads, built from what the broker holds. |
| `design-resolve-retry.ts` | Design review stage, DR7 slice B2: the owner's Retry of a planner run that BLOCKED while it was answering a design review's findings (a rule file that could not be verified, a leftover program, a run that failed). |
| `design-spec.ts` | Design review stage, DR7 slice C (DR12 wiring): the spec step's view of the design. |
| `error-ref.ts` | Live interaction F1: the ErrorRef a task view carries, so the app can offer "Fix with agent" for an error it shows. |
| `evidence-port.ts` | Proof and evidence (wire-proof): what the task routes need to show a task's evidence: the pack kept for the task's current code (rovara-code/evidence-keep.ts), as the pull request shows it (counts, a link) and as the... |
| `evidence-risk-input.ts` | Proof and evidence P4: the evidence's part of a pull request's risk, read where the risk is judged (publication, a pushed fix, a description rewrite). |
| `feedback-capture.ts` | (No header comment.) Exports `startTaskWorkflowFeedbackReviewFromWebhook`, `FEEDBACK_REVIEW_RETRY_BUSY`, `FEEDBACK_REVIEW_RETRY_CHANGED`. |
| `feedback-review.ts` | (No header comment.) Exports `getWorkflowFeedbackReview`, `FEEDBACK_CHANGED_SINCE_CARD`, `submitWorkflowFeedbackDecision`. |
| `health-notice.ts` | Setup and test health SH28 (owner decision 7): "Setup needs repair" does not pause a task start. |
| `learning-events.ts` | Learning v2 wiring (WA-2): what the task actions tell the learning lane. |
| `publication-context.ts` | (No header comment.) Exports `e2ePublicationContext`. |
| `publication.ts` | (No header comment.) Exports `currentWorkflowPublicationAuthorityForTask`, `currentWorkflowPublicationModeForTask`, `startTaskWorkflowPublicationFromSystem`. |
| `pull-request-body.ts` | (No header comment.) Exports `workflowPullRequestBody`, `workflowPullRequestStatusLines`, `proofContextOfTask`. |
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
| `task-page.ts` | (No header comment.) Exports `taskPageStage`, `publicationAttempts`, `taskPageStep`. |
| `task-people.ts` | (No header comment.) Exports `taskPeopleEffectsDependencies`, `getTaskPeople`, `getTaskPeopleCapabilities`. |
| `task-reads.ts` | (No header comment.) Exports `readTask`, `getTaskPlan`, `listTasks`. |
| `task-view.ts` | (No header comment.) Exports `candidateChangedFiles`, `unpublishedOf`, `WorkspaceReads`. |
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
| `common.ts` | (No header comment.) Exports `PROJECT_NOT_FOUND_IN_APP`, `signInStoreOf`, `bodyError`. |
| `company-domains.ts` | Company domain verification (owner decision 2026-11-02): the owner-only "Company domains" routes. |
| `decisions.ts` | Decision cards (wire-proof, setup wizard E4): what the card routes (`decisions/routes.ts`) need for one caller, built from the developer route dependencies. |
| `dependencies.ts` | (No header comment.) Exports `setupDraftDepsOf`, `diagnosisRouteDepsOf`, `agentRunStarterOf`. |
| `design-review.ts` | Design review stage, DR7 slice C: the routes and the decision cards of a design under review, and the ports the design review's handlers need. |
| `identity-lambda.ts` | (No header comment.) Exports `errorName`, `SLACK_UNAVAILABLE`, `channelMembersThroughLambda`. |
| `install.ts` | Enterprise foundations E2: GET /v1/app/install. |
| `intake.ts` | Meta repo lane F (F1): the broker's wiring of the intake routes (`rovara-code`-style: one module, so the router needs two lines). |
| `jira-org-admin.ts` | The Jira organization admin key (DV-1, owner decision 2026-11-02): `/v1/app/org/jira-org-admin`, the one place a company owner or admin sets or clears the READ-ONLY Atlassian organization admin API key and the Atlassi... |
| `known-failing-marks.ts` | Setup and test health KF-1: `/v1/app/projects/{name}/known-failing`, the tests a maintainer marked as already failing, and Undo. |
| `known-failing-policy.ts` | Setup and test health SH17 (owner decision F4): `/v1/app/org/known-failing-policy`, the company setting "always two people" for marking tests as already failing. |
| `lessons.ts` | Learning v2 L3b wiring: the lessons routes and the loaded-knowledge routes on the developer routes. |
| `organization.ts` | (No header comment.) Exports `createProject`, `getAppNavigation`, `getAppMe`. |
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
| `test-environment-candidate.ts` | TE-2: a test-environment proposal's candidate check, as the routes use it. |
| `test-environment-wizard.ts` | Setup wizard (E4), the parts of the test-environment routes that go beyond propose / prove / approve: edit a maintainer's EDITED proposal body: validated like any environment, then stored as a proposal (never approved... |
| `test-environment.ts` | Test environment (wire-testenv, setup wizard E4): the setup routes. |
| `test-health.ts` | Setup and test health SH28: `/v1/app/projects/{name}/test-health`, behind the `nh` switch (and the test environment): with either off the path is not found, as any unknown path. |
| `tracker-people.ts` | Tracker people (lane team-record-links): `/v1/app/org/tracker-people`, the page where a company admin maps the Linear and Jira people the automatic linker could not match to a member of the company. |
| `types.ts` | (No header comment.) Exports `CLOSE_STOP_BUDGET_MS`, `DeveloperApiConfiguration`, `DeveloperRouteDependencies`. |
<!-- /codemap:files -->
