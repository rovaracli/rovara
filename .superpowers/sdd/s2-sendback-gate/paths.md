# S2 sweep: every path that starts a worker run, dispatch or model call on a task's behalf

Rule (owner, 2026-11-04): a removed or no-longer-allowed person must not trigger more work through any path the send-back access gate covers.

Gates used:
- **SB** = `requireProjectSendBackRole` (developer/task-access.ts): owner/admin or a role that may start tasks, and the project is not archived. Same code and words as a send-back.
- **OWN** = `stopIfOwnerRefused` (aws/developer-tasks/owner-stop.ts): the same rule asked live about the task's owner for a step Rovara starts on its own; refusal blocks the task with a plain reason and audits `task.work_refused`.
- **CG** = `creatorGuard` / `requireCreatorStillMember` (ruling R60): a removed owner ends the task `creator_removed`.
- **WR** = the weaker work-role check (`authorizeTaskAction` with a WORK action, `requireProjectWorkRole`): refuses a project viewer, lets a person with no grant through (share design).
- **ARCH** = `requireNewWorkAllowed` (archived project refused).
- **SYS** = `systemTaskAccess` (Task People proof for a system start).

Status: **GATED** (SB or OWN), **PARTLY** (CG plus WR/ARCH only), **NEW-WORK** (a start, gated by the start's own role and archive check), **OPEN** (not gated by SB/OWN: reason given; owner question where it matters).

## A. Human presses that restart or continue a task's work

| Path (function, file) | Gate | Status / why |
|---|---|---|
| Send back to coding (`sendTaskWorkflowBackToCoding`, workflow-coding.ts) | SB, ARCH, CG(queue) | GATED (f93233d52, 6068a38f2) |
| Fix on findings (`resolveTaskWorkflowFindings` FIX) | SB, ARCH | GATED (6068a38f2) |
| Accept all findings, next step is coding (`resolveTaskWorkflowFindings`, due IMPLEMENT) | SB, ARCH, CG | GATED here (F27-5) |
| Accept all findings, next step is review or publication | ARCH (review) | OPEN by design: not coding; forward progress with no new coding run |
| Approve fix of PR review comments (`submitWorkflowFeedbackDecision` APPROVE) | SB, ARCH, CG | GATED here (SB-2) |
| CI-fix / branch-sync Retry (`retryCiFix`) | SB, ARCH | GATED here (SB-2) |
| Retry of a blocked coding step (`retryWorkflowImplementation`) | SB, ARCH | GATED here (also called by redirect restart) |
| Any person's Retry of any step (`retryTaskWorkflow`, one entry: plan, understand, plan check, verify, review, publication, CI fix, coding, design resolve, canvas page retry, session Retry via `retryTaskWorkflowFor`) | SB, ARCH, CG | GATED here at the entry (skipped only for Rovara's own AUTOFIX retry, row E) |
| Retry review of a failed PR-feedback review (`retryTaskWorkflowFeedbackReview`) | SB, ARCH | GATED here |
| Stop & redirect: `sendBackForRedirect` (redirect-restart.ts:118) and `restartCodingForRedirect` (via `retryWorkflowImplementation`) | SB, ARCH | GATED (SB-1 for the phase-1 check at redirect-runtime.ts:109; coding restart gated here) |
| Stop & redirect: `restartPlanningForRedirect`, `revisePlanForRedirect` | WR (`authorizeTaskAction`), pause check | OPEN: planning, not coding (same as live-steer revise below). Owner question |
| Canvas closeout retry (`retryTaskCanvasCloseout`) | WR on `close` | starts no agent work: re-drives the archive of a terminal task |
| Revise plan from live steer (`startRevisedPlan`, live-steer-revise.ts) | WR, ARCH, requireMayGoOn | OPEN: planning, not coding; person with no grant passes by the share design. Owner question |
| Plan decision: approve / request changes (`decideTaskWorkflow`) | WR, ARCH (request changes) | OPEN: approving the plan is the owner's decision on an existing task; coding that follows is started by the dispatch row (row C: IMPLEMENT, gated by OWN). Owner question |
| Continue a stopped task (`continueTask`) | CG, WR, requireMayGoOn | OPEN: a plain follow-up instruction; WR refuses viewers. Owner question whether Continue should meet SB |
| Resume after a spend approval (`resumeTaskAfterSpendApproval`) | CG, SYS | OPEN: runs as the task owner after an approver said yes; CG covers removal, no project-access check. Owner question |
| Start the code review / checks by hand (`startTaskWorkflowReview`, publication retry `retryTaskWorkflowPublication`) | WR, ARCH (review) | OPEN: reviews and pushes are not coding; Retry paths of these steps ARE gated via `retryTaskWorkflow` |
| Spec change replan (`replanForSpecChange`) | WR, ARCH, requireMayGoOn | OPEN: planning; same as live-steer revise |

## B. New tasks and runs started by a live person (the start is the gate)

| Path | Gate | Status |
|---|---|---|
| `startTask` (developer API, MCP, Slack, app) | ARCH + role that may start tasks (`requireNewWorkAllowed`), live | NEW-WORK |
| `startCodeIntent` / intake `startHeld` / `startWaitingIntake` / change-anyway | go through `startTask` with the member's role | NEW-WORK |
| Agent runs (`startAgentRun`, runs.ts:285), roster runs, chains (`startOnce`, runner.ts:389) | ARCH + role, live; each step re-checks the creator (`requireCreatorStillMember` in the run engine) | NEW-WORK |
| Setup agent, setup draft, setup command, setup check | `requireNewWork` (ARCH + role) | NEW-WORK |
| Diagnosis (`startLightDiagnosis`, `startDeepDiagnosis`) | person's own session and level on the task (diagnosis/authority.ts); runs on the customer's provider | OPEN: not a task restart; model call by the person pressing |
| Ask (task.asked) / steer notes | person's session level; no worker run | OPEN: not work on the task |

## C. Rovara's own dispatches (run as the task's owner, no one pressing)

| Path | Gate | Status / why |
|---|---|---|
| IMPLEMENT dispatch: CI, conflict and review-comment fix rounds, and a custom sequence's next coding step (`startTaskWorkflowImplementationFromSystem`) | CG, OWN, SYS, lowered-autonomy | GATED here (paths `ci_fix_round`, `conflict_round`, `feedback_round`, `program_step`) |
| PR-feedback critic run from a GitHub event (`startTaskWorkflowFeedbackReviewFromWebhook`) | CG, SYS, OWN | GATED here (path `feedback_review`) |
| Every queued dispatch kind, and the AUTOFIX look (`runWorkflowDispatch`, `runAutofixDispatch`, dispatch.ts) | CG at the top (MR-3): removed owner ends the task, row removed, audited | GATED here (path `queued_dispatch`) |
| PLAN, UNDERSTAND, PLAN_CRITIQUE, CRITIC_REPLAN starts (`startTaskWorkflowPlanFromSystem`, `...UnderstandFromSystem`, `...PlanCritiqueFromSystem`, `...CriticRevisionFromSystem`, `...PlanRevisionFromSystem`, `resumeAfterRunLimitApproval`) | CG, SYS | PARTLY: removed owner stops (CG + MR-3); no project-access/archive check. These rows are queued by a human's earlier press; owner question whether to add OWN |
| CHECKS / E2E checks, baseline, grounding, replay (`startTaskWorkflowE2E*FromSystem`) | CG, SYS; E2E also re-reads the creator's project authority (`requireWorkflowE2ECreatorAuthority`, refuses a lost grant, viewer) | PARTLY: E2E rounds already check live project access; plain CHECKS do not |
| REVIEW (`startTaskWorkflowReviewFromSystem`, `queueWorkflowReview`) | CG, SYS, lowered-autonomy | PARTLY: as above |
| PUBLISH / UPDATE / branch sync (`startTaskWorkflowPublicationFromSystem`, `startTaskWorkflowBranchSyncFromSystem`) | CG, SYS, lowered-autonomy | PARTLY: a push by Rovara of already-reviewed code; owner question |
| Design review rounds and resolve runs (`startDesignReviewRound`, `startDesignResolveRun`) | CG, SYS | PARTLY: as the plan steps |
| Spec writing / republish (`spec-wiring.ts`, `queueRepublish`) | CG, SYS | PARTLY |
| Rovara's own send-back and retry (AUTOFIX: `autoSendBackToCodingFromSystem`, `retryTaskWorkflow` with `automatic`) | CG; autofix policy and spend cap; mint refusal below | OPEN by design: judged by the autofix policy (6068a38f2 test: Rovara's own send-back for an owner who lost access is unchanged). Owner question |
| Model key mint (`model-access.ts`, `requireOrgOpenFor`, `requireCreatorStillMember`, task work authority) | removed owner or closed company refused per call | Defence in depth for every row above |
| Sweeps that only read or end (operation_end, release, milestones) | none needed | start nothing |

## D. Open owner questions (nothing here changes without a ruling)

1. Should Continue, Plan decision, live-steer revise, spec replan, manual review start and publication retry meet SB (today: work-role only, by the share design)?
2. Should Rovara's own planning, check, review and publish dispatches ask OWN (project access of the owner now), not only CG? One option: a single OWN call in `runWorkflowDispatch` with a block for every stage.
3. Should Rovara's AUTOFIX send-back / retry stop for an owner who lost project access?

Human-path refusals throw the gate's own error (PROJECT_ACCESS_DENIED / PROJECT_ARCHIVED) and are not audited; only refusals of work Rovara would have started on its own are audited (`task.work_refused`).
