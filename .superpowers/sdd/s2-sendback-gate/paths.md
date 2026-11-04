# S2 sweep: every path that starts a worker run, dispatch or model call on a task's behalf

Rule (owner, 2026-11-04): a removed or no-longer-allowed person must not trigger more work through ANY path.

Gates:
- **SB** = `requireProjectSendBackRole` (developer/task-access.ts): company owner/admin, or a role that may start tasks; and the project is not archived. Same code and words as a send-back. Human presses throw its error (PROJECT_ACCESS_DENIED / PROJECT_ARCHIVED); they are not audited.
- **OWN** = `stopIfOwnerRefused` (aws/developer-tasks/owner-stop.ts): the same rule asked live about the task's owner for a step Rovara starts on its own. Refusal: nothing runs, the task is blocked where it stands with a plain reason ("Rovara didn't start this step: ..."), the dispatch row goes (no retry), and `task.work_refused` is audited (facts: `path`, `cause`).
- **CG** = `creatorGuard` / `requireCreatorStillMember` (R60): a removed owner ends the task `creator_removed`. MR-3: also checked before every queued dispatch; the row is removed and the stop audited.
- **WR** = the weaker work-role check (`authorizeTaskAction`): refuses a project viewer only. Every path below that used to stop at WR now also meets SB.
- **ARCH** = `requireNewWorkAllowed` (archived project).

Status: GATED (SB or OWN), NEW-WORK (a start by a live person; the start's own role and archive check is the gate), N/A (starts no agent work).

## A. A person presses something that starts or restarts work on an existing task: all GATED (SB)

| Path (function, file) | Gate |
|---|---|
| Send back to coding (`sendTaskWorkflowBackToCoding`, workflow-coding.ts) | SB (f93233d52, 6068a38f2) |
| Fix on findings (`resolveTaskWorkflowFindings` FIX) | SB |
| Accept all findings, whatever the next step is: coding, a review, the pull request push (`resolveTaskWorkflowFindings`, `startAcceptedStep`) | SB + CG at the press (F27-5, review H2); the start itself asks OWN for the owner (`direct_start`) |
| Approve fix of PR review comments (`submitWorkflowFeedbackDecision` APPROVE, feedback-review.ts) | SB + CG (SB-2) |
| Retry review of a failed PR-feedback review (`retryTaskWorkflowFeedbackReview`, feedback-capture.ts) | SB |
| Any person's Retry of any step (`retryTaskWorkflow`, workflow-retry.ts: plan, understand, plan check, verify, review, publication, CI fix and branch sync, coding, design resolve; also the page's application-round retry and the session Retry) | SB + CG at the one entry (skipped only for Rovara's own AUTOFIX retry, row C) |
| CI-fix / branch-sync Retry (`retryCiFix`); Retry of coding (`retryWorkflowImplementation`, also reached by redirect restart) | SB (direct, as well as via the entry) |
| Plan decision: approve, or request changes (`decideTaskWorkflow`, decide.ts) | SB at the point a run would start; a decision that only ends the task (reject, answered) starts nothing and is not gated |
| Continue a task (`continueTask`), go on as a normal task (`continueAsTask`, review M2) (continue.ts) | SB |
| Open a pull request for a plain task (`openPullRequest`, close.ts) | SB |
| Start the code review by hand (`startTaskWorkflowReview`) | SB |
| Publication retry (`retryTaskWorkflowPublication`) | SB, ahead of the step's own state checks |
| Resuming a parked dispatch from any person's press (`resumeParkedTaskDispatch`, access-resume.ts; manual review start, Retry, publication retry) | SB first, inside the function (review H3), so no caller can resume a parked row ahead of the gate |
| Revise the plan from a live message (`reviseTaskPlan`, live-steer-revise.ts) | SB |
| Spec change replan (`replanForSpecChange`, spec-replan.ts) | SB |
| Stop & redirect: planning restart, plan revision, coding restart, send-back (redirect-restart.ts, `currentTask`) | SB for all four, plus the phase-1 check at redirect-runtime.ts:109 (SB-1) |
| Recovery after a refusal: Retry at the merge wait (`retryCiFix` accepts a "Rovara didn't start" block, review H4) | SB, then back to WAITING and tracking woken (a PR-feedback critic that was still collecting starts again) |
| Retry canvas closeout (`retryTaskCanvasCloseout`) | N/A: re-drives the archive of a finished task; no agent work |

## B. A person starts a new task or run: NEW-WORK (the start is the gate)

| Path | Gate |
|---|---|
| `startTask` (developer API, MCP, Slack, app); `startCodeIntent`, intake (`startHeld`, `startWaitingIntake`), change-anyway (all go through `startTask`) | ARCH + a role that may start tasks, live (`requireNewWorkAllowed`) |
| Agent runs (`startAgentRun`, runs.ts:285), roster runs, chains (`startOnce`, runner.ts:389) | ARCH + role, live; every step re-checks the creator in the run engine (R60) |
| Slack thread workspaces (`thread-workspaces.ts:498`) | ARCH + the requester's role, live |
| The workspace-level task API (`POST /v1/workspaces/{id}/tasks`, workspace-routes.ts:231, handled by `acceptTask` in acceptance.ts) | CG (`requireWorkspaceCreatorStillMember`, acceptance.ts:217, :426) and the workspace's own ownership; this is the project-less workspace operation, not a developer task. Not a task restart; left as is |
| Setup agent, setup draft, setup command, setup check | `requireNewWork` (ARCH + role) |
| Diagnosis (`startLightDiagnosis`, `startDeepDiagnosis`), Ask, steer notes | N/A for task restarts: a model call by the person pressing, on the customer's provider, under their session level (diagnosis/authority.ts); starts no task work |

## C. Rovara's own dispatches (run as the task's owner, no one pressing): all GATED

| Path | Gate |
|---|---|
| Every queued dispatch kind except IMPLEMENT: UNDERSTAND, PLAN, PLAN_CRITIQUE, CRITIC_REPLAN, REPLAN, GROUNDING, CHECKS (and E2E checks, baseline, replay), REVIEW, SYNC, PUBLISH, UPDATE; design-review rounds and resolve runs; spec writing (`runWorkflowDispatch`, dispatch.ts) | CG (MR-3) then OWN once, before the kind is started (path `queued_dispatch`) |
| IMPLEMENT dispatch: CI, conflict and review-comment fix rounds, and a custom sequence's next coding step (`startTaskWorkflowImplementationFromSystem`) | CG, OWN (paths `ci_fix_round`, `conflict_round`, `feedback_round`, `program_step`) |
| PR-feedback critic run from a GitHub event (`startTaskWorkflowFeedbackReviewFromWebhook`) | CG, OWN (path `feedback_review`) |
| Rovara's own look, send-back and retry on a blocked step (AUTOFIX: `runAutofixDispatch`) | CG, OWN (path `autofix`): the blocked step stands for a person with the ask "only a person can fix this"; the row goes; audited. This replaces the 0.4.27 rule that Rovara's own send-back still ran for an owner who lost access |
| Understand started straight from a person's answer to its questions (`startTaskWorkflowUnderstandFromSystem`, via `startUnderstanding`), the plan check after a plan decision, the reviews and the push after a gated press (`startAcceptedStep`) | OWN inside each start (path `direct_start`), judged by the OWNER's access (`ownerCheckAccess`), not the presser's (review H1, H2, M3) |
| Resume after a spend approval (`resumeTaskAfterSpendApproval`, continue.ts; held first dispatch, run-limit start, budget retry, agent advance, plain continue) | CG + one OWN check at the top (path `spend_resume`, review M1): the approval stands and nothing runs for an owner without access. A workflow task keeps its blocked step and says why in its block reason (plain "Rovara didn't start" text in place of the pause's); a task with no workflow has the audit event and the notice to the others only. Flagged hunk in the spend flow |
| Each step of an agent run (roster, chain, process runs; `agentRunHostOf.requireCreator`, model-access.ts) | CG + OWN per step (path `agent_step`, review M5): the engine ends the run FAILED with the plain reason; the person's session Retry is the way on |
| Plan grounding (`runGroundingStep`) | OWN before the check starts only (review M4); a check already running is not cut off; a refusal ends the hold as a plan that could not be checked |
| Model key mint (`model-access.ts`: `requireOrgOpenFor`, `requireCreatorStillMember`, the task's work authority) | Per model call: a removed owner or a closed company is refused (defence in depth under every row) |
| Sweeps that only read, end or release (operation_end, release, milestones, reconcile) | N/A: start nothing |

Slack dependency (review M6): an owner whose access comes from a Slack channel needs Slack for the check. If Slack cannot be reached, a queued dispatch is deferred without using its tries and the task page says "Waiting for Slack" (a note on the workflow at its own revision). After 30 minutes from the first miss (`slackWaitSince` on the row) the step stops with a plain, retryable "Rovara didn't start ... could not reach Slack ... press Retry" reason, the row goes, and the stop is audited (cause `slack_unavailable`). A direct start or a person's press gets the retryable SLACK_UNAVAILABLE; AUTOFIX looks again each minute (its own bounded count).

Notice to others (owner decision 2026-11-04, narrowed by re-check 2): when Rovara stops a step because the effective owner lost access (cause `owner_removed`, `no_project_access`, `viewer`), each co-owner (People role `owner`, not the effective owner, with a Slack user) who can really Take over gets one direct message: "Rovara stopped <task> because its owner no longer has access. You can take it over to continue." with the task page link. A commenter is not told (Take over needs the session level `edit`; a commenter has `use`). "Can really take over" is read from stored rows (`canTakeOverNow`): a writer company role and either a company owner/admin or a direct project grant whose role may start tasks; a person whose access is only through a Slack channel cannot be confirmed without Slack and is left out (under-notify, never a false promise). One pending row per stop and person (`OWNER_STOP_NOTIFY#<path>#<occurrence>#<person>`, with `ownerAtStop`), so a retried refusal adds nothing. At send time the notifier re-checks everything (still a co-owner, `canTakeOverNow` again, task not closed, effective owner still the one who lost access) and cancels the row if any fails, so no title goes to someone who has since lost access. It names nobody. An archived project, a Slack outage or a lost company notify nobody. Not checked at send time: the live People proof (a co-owner who left the Slack channel is still read as a co-owner from the stored list).

When Slack answers again the wait ends: the clock on the row and the note on the task are cleared (`clearSlackWait`) as soon as the access check passes, so the page stops saying "Waiting for Slack" and a later short outage starts its own 30 minutes.

## D. Behaviour changes this replaces (tests updated; each says "this replaces")

- Continue, Open a pull request, plan decisions, review start, publication retry, live-steer revise, spec replan: a person with no project grant, or a viewer-turned-nothing, used to pass the work-role check (share design, R11); now refused like a send-back.
- Continue (and every other start) in an archived project used to keep working for a running task; now PROJECT_ARCHIVED. Cancel and Close still work.
- A required-E2E round or any queued step in an archived project used to keep going (I4); now it is not started and the task says why.
- A queued dispatch for a removed owner used to be parked (`taskAccessPausedAt`); now the row is removed (MR-3).
- Rovara's own send-back for an owner who lost access used to still run (0.4.27); now it stops (AUTOFIX row).
- A co-owner or taker without a project grant can no longer start the next step for themselves.

## E. Left alone on purpose

- Reject and answered-task decisions, Cancel, Close, stop, comments, notes: they start no agent work.
- The audit refusal for a human press is the thrown error only; `task.work_refused` is for work Rovara itself would have started.
