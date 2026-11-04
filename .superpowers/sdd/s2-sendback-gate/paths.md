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
| Accept all findings, next step is coding (`resolveTaskWorkflowFindings`) | SB + CG (F27-5) |
| Approve fix of PR review comments (`submitWorkflowFeedbackDecision` APPROVE, feedback-review.ts) | SB + CG (SB-2) |
| Retry review of a failed PR-feedback review (`retryTaskWorkflowFeedbackReview`, feedback-capture.ts) | SB |
| Any person's Retry of any step (`retryTaskWorkflow`, workflow-retry.ts: plan, understand, plan check, verify, review, publication, CI fix and branch sync, coding, design resolve; also the page's application-round retry and the session Retry) | SB + CG at the one entry (skipped only for Rovara's own AUTOFIX retry, row C) |
| CI-fix / branch-sync Retry (`retryCiFix`); Retry of coding (`retryWorkflowImplementation`, also reached by redirect restart) | SB (direct, as well as via the entry) |
| Plan decision: approve, or request changes (`decideTaskWorkflow`, decide.ts) | SB at the point a run would start; a decision that only ends the task (reject, answered) starts nothing and is not gated |
| Continue a task (`continueTask`, continue.ts) | SB |
| Open a pull request for a plain task (`openPullRequest`, close.ts) | SB |
| Start the code review by hand (`startTaskWorkflowReview`) | SB |
| Publication retry (`retryTaskWorkflowPublication`) | SB, ahead of the step's own state checks |
| Revise the plan from a live message (`reviseTaskPlan`, live-steer-revise.ts) | SB |
| Spec change replan (`replanForSpecChange`, spec-replan.ts) | SB |
| Stop & redirect: planning restart, plan revision, coding restart, send-back (redirect-restart.ts, `currentTask`) | SB for all four, plus the phase-1 check at redirect-runtime.ts:109 (SB-1) |
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
| Starts that follow a human's yes and run as the owner: `resumeTaskAfterSpendApproval`, `resumeAfterRunLimitApproval`, `startAcceptedStep` after a gated decision | CG + the approver's own authority. The step they resume is one the gated paths above already admitted; a lost-access owner is stopped at the next queued dispatch (row 1) and at the model-key mint. Kept out of this change on purpose: they sit in the spend and budget-authority flows other lanes (S1, admin-v11) are editing |
| Model key mint (`model-access.ts`: `requireOrgOpenFor`, `requireCreatorStillMember`, the task's work authority) | Per model call: a removed owner or a closed company is refused (defence in depth under every row) |
| Sweeps that only read, end or release (operation_end, release, milestones, reconcile) | N/A: start nothing |

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
