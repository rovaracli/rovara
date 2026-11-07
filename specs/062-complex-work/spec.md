# Feature Specification: Complex Work in Large Repos (milestones, CI as the gate, no capacity walls)

Rovara takes a big request in a large repository and delivers it as a series of small, green, reviewable pull
requests (milestones), for a whole team at once, without capacity walls, and we can measure that it works.

**Feature Branch**: `docs/complex-work-spec` (for `cloud/next`)
**Created**: 2026-11-07
**Status**: Draft for owner review, then design review
**Input**: Owner direction 2026-11-05 ("I don't want Rovara to generate massive PRs that are almost impossible
for a human to read"); the read-only code audit of release 0.5.8 (commit 0317c607c) on 2026-11-06; the
milestones plan ("Rovara: Milestones and Stacked Pull Requests", https://claude.ai/artifact/PXB6Vvh4Uv9v2s8UmVJGc6);
the audit plan ("Rovara for complex work: build and turn-on plan", https://claude.ai/artifact/HeG6e5TPFuBDnggotLwSas)
**Depends on**: 056 native task workflow, 058 GitHub coordination, 059 task dependencies, Rovara Code v2 (switch `rv`)
**Replaces**: the milestones plan's ordering and the audit plan's ordering. This spec is the one sequence for both.

## Context

We used "Rovara builds Rovara" as the test case for complex work: a 470k-line TypeScript monorepo with about
740k lines of tests, a suite that takes several CPU-hours, ten people working at once, and a release train on an
integration branch. It is a stand-in for any customer with large repos, slow tests and many people. It is not the
goal itself.

Today a Rovara task ends in one pull request per repository, opened at the end and reviewed as a whole. Every task
must pass all its checks inside a 30-minute round in a 1-vCPU, ~6 GiB sandbox on an `m6g.large`, and a team hits
the workspace limits (3 per person, 20 per company, held until merge) within hours.

The audit found that most of what is needed already exists: built and on, built but switched off, or built and
never called. The real gaps are fewer than they look, and milestones make several of them smaller.

## The key idea: milestones are the spine

Small milestones shrink most of the complex-work problem:

- A smaller change is quicker to check, because it touches less code.
- A 400-line PR gets read; a huge one gets skimmed.
- A merged milestone stays merged, so a failure loses at most one milestone.

What milestones do **not** shrink is checking: a small change in a big repo must still pass that repo's slow
tests. So "CI is the main gate" is part of the core, not an extra.

## Goals

1. A big request becomes an approved, ordered list of milestones; each ships as its own green PR of about 400
   changed lines (generated and lock files excluded), with its own checks, review and human approval.
2. A milestone in a large repo reaches a green PR even when the full suite takes hours: light checks on the
   worker, the customer's CI as the main gate, the full suite on a follow-up run, and pre-existing failures judged
   against a baseline instead of blocking.
3. Work is never refused: it starts now or waits in a visible queue. Waiting on a person costs no slot and no
   machine time. Money (a company budget with warnings and an owner choice at 100%) is the one control.
4. A team of ten can work on one repo all day, with maintainers able to act on each other's tasks.
5. Progress is measured on real work by a replay benchmark, re-run after every phase.

## Non-goals (this spec)

- Automatic merging. "Rovara never merges by itself" (owner decision 1, confirmed 2026-10-27) stands unless
  decision D1 below changes it.
- Batching several PRs into one merge train. Small, independent PRs make it unnecessary for most customers.
- x86 or GPU workers.
- Billing integration. It runs as a separate business track (item D6).

## What already exists (do not rebuild)

Built and on by default in 0.5.8:

| Capability | Where |
|---|---|
| Idle machine stopped after 5 minutes, disk kept, machine time stops counting | `packages/broker/src/aws/session-reaper.ts#IDLE_STOP_MS` |
| Merge rules read from GitHub: required checks (classic and rulesets), CODEOWNERS, "require up to date" | `packages/broker/src/github-app.ts`, `packages/broker/src/rovara-code/merge.ts#mergeReadiness` |
| Shared team board with all / mine / team / needs me / failed filters | `packages/broker/src/agent-sessions/read.ts#listSessions` |
| Session take-over by a teammate with edit access | `packages/broker/src/agent-sessions/take-over.ts` |
| Month budget pause: running tasks pause, a top-up request is raised, approval resumes them | `packages/broker/src/spend/requests.ts#requestForMonth`, `#resumeMonthTasks` |
| Ticket intake keeps up to 200 waiting tickets per project | `packages/broker/src/intake/engine.ts` |
| A check can run on AWS CodeBuild, up to 420 minutes | `packages/contracts/src/project-node.ts#CodeBuildGateDefinitionSchema` |
| Multi-repo projects (up to 32 repos), one PR per repo | `packages/contracts/src/project-node.ts` |
| Plan, plan check, design review and approval; "Design first" in the web start box | 056, 061, design review (`dr`) |

Built but switched off (defaults from `infra/lib/developer-signin.ts`):

| Switch | Unlocks |
|---|---|
| `rv` Rovara Code v2 (`"false"`, only `"true"` turns it on; also `ROVARA_CODE_V2_FOR_NEW_ORGS = false`) | Draft PR marked ready only once CI is green; CI-fix loop (`CI_FIX_ROUNDS_MAX = 3`); "no CI" handling; merge from Rovara; branch sync; merge tracking; parallel parts; multi-repo merge. **Milestones depend on it.** |
| `ev` test environment, `nh` nightly run, `sv` saved images | Approved test setup, nightly baseline and coverage map, warm task starts |
| `su` setup agent, `sp` setup recipes | Working out how to build and test a new repo |
| `tx` test services | Service containers for tests in a sealed round (gated by TS-L1..L8) |
| `tc` task people | Co-owners, ownership take-over |
| `ls` live steer, `rd` stop and redirect | Steering a running agent |
| `cr` second review, `pe` proof and evidence, `vx` four-result verification | Extra review and evidence |
| `wd` ordered work breakdowns | Item-level checkpoints (v1 only; v2 ignores it) |
| `tn` team record, `ll` lessons | Past decisions and lessons in runs |

Built but never called (connect them, do not rewrite):

- `packages/broker/src/rovara-code/full-suite-followup.ts#queueFullSuiteFollowup`: the full suite on its own
  run (up to 4 h, 20 a day) with a merge-card gate. Its header: "starting it ... are wiring in the hot file (H5)".
- `packages/broker/src/test-env/nightly.ts#readCoverageMap`: the nightly stores a coverage map; nothing reads it.
- `packages/worker/src/verification/selection.ts#buildImportGraph`: the import-graph test selector.
- `packages/worker/src/reconcile.ts#reconcileInterruptedOperations`: called only from tests.
- `/v1/internal/record-tools/{list,call}` (past-task search): no worker code calls it.

## Plan

Four phases, each closed by a gate measured with the replay benchmark.

### Phase 0: foundation (about 1 to 2 weeks)

- **FR-0.1** Turn on `rv` on staging and prove the full v2 journey: draft PR, CI, mark ready, merge, branch sync.
- **FR-0.2** Replay benchmark, first slice: 20 past merged changes of a repo, including 4 or 5 big ones that
  should have been milestones, each started from its parent commit through the real task pipeline and scored
  (green PR reached, cost, closeness to the merged change). Reuse the eval-batch queue and cost cap
  (`packages/broker/src/aws/eval-batch*.ts`).
- **FR-0.3** Answer decisions D1 to D4.

**Gate**: today's benchmark score is recorded.

### Phase 1: small green PRs in a big repo

Milestones (from the milestones plan):

- **FR-1.1** The planner proposes milestones, each with a goal, rough size, dependencies and a "safe to merge
  alone?" flag; the person approves the list once, together with the design.
- **FR-1.2** One PR per milestone in the same task, with "Part 2 of 5, depends on #123, next: ..." descriptions.
- **FR-1.3** Independent milestone PRs and step mode: wait for merge (or approval, per D3) before the next one.
- **FR-1.4** A PR size budget (about 400 changed lines) that forces a split or a written reason.

Making each milestone pass in a large repo:

- **FR-1.5** CI is the main gate (A1): publish the draft after light checks; notify people only at `pr_ready`
  (CI green), not when the draft opens (today `developer/workflow-messages.ts` says "Review it and merge it"
  before CI); run CI-fix rounds without a full worker check round; time out CI that stays pending.
- **FR-1.6** Wire the full-suite follow-up run (A2).
- **FR-1.7** Judge against the baseline (A4): a check whose only failures are known failures passes; failures
  found at preparation become the baseline instead of `WORKSPACE_NOT_READY`. Today
  `task-workflow-node.ts#recordWorkflowVerification` needs every check to PASS.
- **FR-1.8** Per-project check-round budget for the coding run (A5); today fixed at 30 minutes
  (`CHECK_ROUND_BUDGET_MS`).
- **FR-1.9** Machine size, install-wide then per project (B1), and disk size from the app (B2). Fix
  `qualification-launch.ts`, which refuses any type but `m6g.large`. Turn on `ev`, `nh`, `sv`.
- **FR-1.10** Waiting on a person takes no slot (D2). Step mode holds a task open for days; without this, people
  run out of slots within a day. Precedent: a paused run already takes no slot (`developer-tasks/start.ts`).
- **FR-1.11** Send work to a chosen branch (C1): wire the saved working branch
  (`org/project-working-branch-save-http.ts`: "CLI and task consumers are not released") into worker checkout,
  PR base, nightly head, setup pins and saved images; add the exact-ref check at task start and a per-task override.

**Gate**: on the benchmark, big changes arrive as green PRs under the size budget; one real feature ships through
Rovara end to end, on Rovara's own repo or a pilot repo.

### Phase 2: stacks and teams

- **FR-2.1** Stacked milestones: milestone N based on milestone N-1, retargeted when N-1 merges (method per D1).
- **FR-2.2** Feedback flows down the stack: a fix on PR 1 rebuilds and re-checks PRs 2 and 3.
- **FR-2.3** Run-ahead mode (build the next milestone while the previous one is in review).
- **FR-2.4** Cross-repo ordering (infra, backend, frontend) and a rule for a merge that stops halfway. Replaces
  today's alphabetical order (`merge.ts#byRepository`).
- **FR-2.5** Queue instead of refusing (D1 in the audit plan): a QUEUED state, a drainer when room frees up,
  triggers that wait instead of being dropped (today a trigger at `WORKSPACE_LIMIT` is marked failed), intake that
  retries by itself.
- **FR-2.6** Fair order, queue position and estimated wait on the board.
- **FR-2.7** Show budget alerts and notify approvers. `BUDGET_ALERT` rows (80% and 100%) are written today but
  nothing shows or sends them.
- **FR-2.8** At 100% of the company budget, queue new work instead of refusing it.
- **FR-2.9** Handle running out of EC2 capacity: wait and retry, other types and zones, quota alarm.
- **FR-2.10** A maintainer can approve a plan (today `task-access.ts`: `decide: ["owner"]`); wire task
  invitations (`tu`/`tv` are never read). Turn on `tc`, `ls`, `rd`.

**Gate**: ten people, a full day, no refusals; a feedback change flows through a 3-PR stack correctly.

### Phase 3: depth

- **FR-3.1** Per-milestone budgets and spend on the task page; replanning after each merged milestone.
- **FR-3.2** Test selection in the normal coding run (A3): apply `selection.ts` there (today only owner retries and
  E2E rounds), read the stored coverage map, a JS/TS per-test coverage producer, the import graph with workspace
  and alias resolution, a "typecheck changed packages" check.
- **FR-3.3** Past-task search for agents (F1) and a repo map or symbol index tool (F2). Today the agent's tools are
  read, write, edit, grep, find and ls.
- **FR-3.4** A configurable tool-call limit that pauses and asks (today `TOOL_CALL_LIMIT = 200`, a hard stop); a
  readable step timeline; transcript export; tracing across broker, worker and model proxy.
- **FR-3.5** Resume within a milestone after a crash (today a lost machine reruns the whole stage).
- **FR-3.6** Shared dependency caches or warm instances; browsers in the sandbox; test services with dev containers.
- **FR-3.7** Spike milestones (a draft PR that is never merged, then plan the rest); independent PRs for
  mechanical changes split by directory or CODEOWNERS.

### Alongside every phase

- Release safety: a break-glass runbook, a canary stage before production, a written control-plane rollback.
- Deploy gates for `su`, `tx` and `sv` enforced in code (today only text); fix stale comments (`tx` "nothing
  reads", the coverage-map note in `test-env/task-plan.ts`, the proof folder in the code map).
- Plans and billing (business track): today no code moves a company off `trial`, so the 400-hour team allowance is
  never used.

## Moved down or dropped

| Item | Change | Why |
|---|---|---|
| Chunked review of large diffs | Safety net only | Small PRs fix it at the source; today diffs over 120 KB are cut and marked partial |
| Resume mid-step | Phase 3 | Merged milestones are natural checkpoints |
| GitHub merge queue | Only if D1 allows | Owner decision "no automatic merge" |
| PR batching / merge trains | Dropped | Not needed with small independent PRs |

## Decisions needed from the owner

- **D1 Restacking.** Allow force-push on branches only Rovara writes to, or restack by merging (noisier history)?
  Today `branch-sync.ts` says "never a rebase, never a force-push". Also: keep "no automatic merge", or allow
  handing an approved PR to GitHub's merge queue?
- **D2 CI as the default gate** for repos that have CI. Milestones multiply CI runs (the milestones plan estimates
  20 to 40% more spend on big tasks), and customers pay for their CI minutes.
- **D3 The gate between milestones.** Wait for merge (safer, slower) or for approval (faster)? Proposed default:
  merge for brownfield work.
- **D4 Slots.** Once FR-1.10 and the queue exist, do the 3-per-person and 20-per-company limits stay? Proposed:
  no; money becomes the control.
- Also open from the milestones plan: a fixed 400-line budget or per company in How we work; out-of-order merges
  and PRs closed mid-stack (rebuild, refuse or ask); milestones replacing today's parts or grouping them.

## Live checks still needed

- Which switches staging and production actually have set (install configuration, not in the repo).
- Real `tsc -b` time and peak memory for a large repo on `m6g.large`, and disk used by a fresh clone plus install.
- Status of the TS-L1..L8 test-service checks and the SH-1 setup-agent checks.
- Whether the eval stack (`-c agentxEval=enabled`) still deploys.
- Whether the context tools' "never Build" rule is deliberate.

## How we run it

- One design-reviewed spec covers Phase 1, because milestones and CI-as-gate change the same hot code
  (publication, merge tracking, the workflow).
- One lane owns the task-to-PRs path, so parallel lanes do not collide in those files. Everything merges into
  `cloud/next` through the single controller, as today.
- Rovara-on-Rovara is the test, not the goal: each phase gate includes one real feature on our own repo plus the
  benchmark score.

## Success measures (weekly)

- Benchmark: share of replayed changes reaching a green PR under the size budget, and their cost.
- Share of merged changes made through Rovara, on Rovara's own repo and on pilot repos.
- Time from request to green PR; how often a merged change needs rework.
- Work refused (target zero after Phase 2) and the average queue wait.
