# Lessons replay A/B: operator runbook

What this is: a sanity check of the lesson pipelines (owner decisions 38, 49, 68), not proof. It replays 40-60 past tasks from repositories with many member corrections, 3 runs each, under several arms, and reports numbers. **It gives no verdict. The owner decides.**

| Arm | Meaning |
|---|---|
| `off` | no lessons (A) |
| `on:current` | lessons from the current pipeline: reflector and curator (B), built offline over the same past tasks, delivered to the copy as a prompt block |
| `on:consolidated` | lessons from the reflector plus the nightly consolidation pass (C; lane 8; **stub: the run refuses by name until lane 8's builder is ported**) |
| `file:<label>` | the pipeline's lessons offered to the agent as the repository file `.rovara/lessons.md` (lane R2's format and renderer) plus the one pointer line in `AGENTS.md` (decision 50.5), placed in the copy's checkout only |
| `mcp:<label>` | the same lessons offered through the MCP tool. **Stub**: the run refuses before anything starts until the tool exists. |

## What is real and what is not (read this first)

| Piece | State |
|---|---|
| Contracts, report, STOP lines, blind sheet, fixed grader rule, eval-run refusal in every learning path | built, tested |
| Candidates exporter `scripts/export-replay-candidates.ts` and `select` | built, tested |
| Harness: plan, run, resume, grader blind to the arm | built, tested with fakes |
| **`--max-usd` is a hard stop** | built, tested. **Every copy is reserved at its worst case before it starts**: the project's planning allowance (a copy plans under the planning limit, then approving its plan restarts the run-limit window, so it can cost planning plus the run limit) **plus the run limit plus the grading hold**. A run that would not fit is never started. A copy that started under more planning allowance than you declared, or under none (no model proxy), stops the whole replay. A run is charged what it cost (every stage, checks included, and the model proxy's own figure, whichever is larger) or the reservation when it failed or cannot be priced; grading and the building of the arms' lessons count in the same limit; a copy still running is cancelled when it reaches its worst case. One invocation per results file (a lock file refuses a second) |
| **The install side** `POST/GET /v1/admin/tasks/{taskId}/lessons-replay` (+ `/approve`, `/close`, `GET /evidence`), `agentx admin task lessons-replay start|approve|close|evidence|show` | built, tested through the real handler. A copy is a **workflow task** (the same shape as the candidates) started from the past task's request, **billed to the company or project as a test run** (never the past task's member, never a member's personal plan), **marked `evalRun` at creation**, never shared, readable and closable only by the operator who started it, refused every pull request and update, never announced (no Slack, DM, card, Team record row or tracker comment), never learned from, one audit line `lesson.replay_started` written first |
| **Who may start a copy** | a **company owner or admin** only (decision 68). Not a project admin without a company role, not a member, not Rovara staff on Cloud. Tested for each role |
| **Plan approval** | automatic **only** for an `evalRun` copy, through `POST .../lessons-replay/approve` by its own operator. A normal task cannot reach that path. A copy is reported `completed` only when it really ended |
| The loader's snapshot mode | built, tested. A copy's memory is `off` or one frozen snapshot (lesson ids and versions, or imported lesson texts): the dispatch and delivery load those lessons and never the live set; the project's own learning mode decides, the install's lessons switch (`ll`) does not (decision 68 covers delivery while `ll` is off); the loads are eval loads and never touch the live counters |
| Imported snapshots | `POST /v1/admin/projects/{p}/lessons-replay/snapshots`: lesson texts for a frozen snapshot that is **not in the live lesson store**. Stored separately (14 days, at most 80 lessons and 300 KB), never merged with live lessons |
| **Offline pipeline B** (`replay-offline.ts`, `replay-export.ts`) | built, tested. Runs the real reflector and the real curator (similarity, the judge, tiers, the trial rules, the citation check) over the SAME historical tasks' outcomes, in time order, in an in-memory store, **under the project's real learning settings** (read through `.../lessons-replay/settings`: mode, preset, approvals, company floor and lock, whether auto-apply is on, whether an embedder is set up). The citation check reads your clones at the cited commit. After each day **only what the live curator would make ACTIVE without a person is exported** (the one rule `exportWithoutAPerson`, the loader's own `approvedForUse`); what would have needed a person is counted and printed per arm, not delivered. The loader and delivery keep the normal approval check for snapshot lessons (no bypass). Its model calls count in the run budget and go through `.../lessons-replay/model`; failed calls are counted, not hidden |
| Pipeline C (lane 8) and the `mcp:` arm | stubs; a run refuses. **C, when ported, must export through `exportWithoutAPerson`**: the harness refuses a builder whose result does not carry that rule, so B and C cannot be compared on different rules |
| **The `file:` arm on the install** | built, tested. The broker renders the file from the copy's frozen snapshot at delivery and sends it as `evalFiles` (worker feature `task.evalFiles.v1`; a worker without it is refused the step, so the arm never runs silently without its file). The worker writes `.rovara/lessons.md` and the pointer into the copy's checkout and hides both from the candidate (diff, review, commits). **Not exercised against a real EC2 worker yet**: the rehearsal below proves it |
| The grader (`rubricGrader` over `cliGraderModel` and `cliEvidenceReader`) | built, tested. It sees the task's **request**, the attempt's diff and the merged reference diff, each as data, never the arm. Model: the company's own connected model through the install's `.../lessons-replay/model` route. **Gate: decision 47 forbids lesson-learning calls with `ll` at 0; grading is not learning, so this route is not behind the lessons switch, but it is operator-only, quote-checked and counted in the budget** |

The script `scripts/lessons-replay-measure.ts` makes no AWS call and no model call itself. Everything that touches staging is an operator module (`scripts/lessons-replay-staging-module.ts` for a real run) that talks to the install **through the `agentx` CLI as the signed-in company owner or admin**. Run the script with the pinned Node (22.23.2), for example `npx tsx scripts/lessons-replay-measure.ts <command> ...`.

### Approximations to know before you read a result

- **Pipeline B is rebuilt offline, not replayed live.** It runs under the project's real settings and exports only what is delivered without a person, so it is as faithful as the pieces it has: **without `LESSONS_REPLAY_REPO_DIRS` citations cannot be checked** (so nothing can go live on trial; the module refuses unless you accept that), and **without the install's embedder there is no similarity merge** (the module refuses when the install HAS an embedder, unless you accept the difference; it is then reported). The install's lessons switch is assumed ON offline (that is the question the replay asks). Lessons cut at the 80-lesson snapshot cap and model calls that failed are counted and printed per arm. Lessons that would have needed a person are counted and printed, not delivered: that is a property of the project's settings (a project that approves everything by hand yields an empty arm and a STOP line, which is the honest result).
- **A task whose plan is rated high risk stalls.** Plan approval is automated, but the decide-grade gate for HIGH-risk plans is left intact, so such a copy stops at the plan and is recorded as ungraded. This is deliberate: nothing weakens a normal gate.
- **`learningCalls` per copy is not measured** by the install (shown as "not recorded"). Every learning path refuses a copy, and a test proves it for each model-calling path, so the count would be zero.
- **The file arm's recorded load keys** are the snapshot's lessons that passed the loader's checks; a lesson R2's renderer would not put in a file (no text, a scope naming only other repositories) is dropped from the file but not from that list. The report's loaded-lesson difference can therefore overstate the file arm slightly.

## Rules the harness enforces

- **Replays never feed learning.** Every copy carries `evalRun` on its task record; the task source, the task-end and human-edit reflections, the reflector, the nightly job and the outcome counters all refuse it. The executor must confirm the marker on every run or the whole replay stops (`EvalMarkError`).
- **An arm that ran nothing fails loudly.** An arm with no completed run, or one that loaded nothing on more than half of its completed runs, prints its own STOP line. It is never a pass.
- **Decision 47 and 68.** Replays deliver the frozen snapshot with the install's `ll` switch at 0. The arms' lessons are built offline and counted in the budget; they never touch the live lessons.
- **Lessons learn only from historical outcomes**, in time order: the lessons for a simulated day are built from tasks that finished before that day, never from a replay.
- **One fixed grader.** Its model and version are in the plan and in every graded row. The grader is shown no arm. Runs graded differently, or one task graded by tests in one arm and by a rubric in another, are refused (`GraderMismatchError`).
- **Audit.** Reading a past task for the offline pipeline, reading the project's learning settings and every model call of the replay each leave one audit line (`lesson.replay_read`: the operator, a fixed word, the hold in cents, a task id; never content), written before the read or call. The replay's model calls are booked to the company's learning month: check it has room, and note it before turning lessons on for real.
- **The grader does not change.** Every grading must be answered by the model you declared (`LESSONS_REPLAY_GRADER_MODEL`); a grading answered by another one (the company changed its lessons model mid-run) or by an unnamed one fails that grading and is counted as ungraded.
- **Plan approval accepts the copy's own limit.** Approving a copy's plan accepts its run limit (already capped at `--per-run-usd`) without an acknowledged amount; a normal task still needs the amount acknowledged. A copy needs the agent runtime and a model proxy on the install; without a proxy nothing limits it, and the replay stops.
- **Same mistake** = the grader flags a mistake that a historical correction given before that task already named. The flag must name such a correction.

## Before you start (once)

1. Sign in as a **company owner or admin**: `agentx --env <env> login --admin`. A project admin, a member or Rovara staff cannot start a copy.
2. In **Spending**, raise the per-test cap above the copies' per-run limit (default $2) and, for the full run, the testing allowance (default $10). A copy is billed to the company or project as a test run, so these two limits apply to it. The rehearsal below fits inside the defaults.
3. The project's **learning mode** must be On (the project's own mode decides snapshot loads; the install switch does not). The offline pipeline refuses to build for a project whose mode makes no lessons (Off or Collect). It is also what makes the replay a test of THIS project's rules: Standard preset with On lets a verified member correction go live on trial; a stricter setting leaves lessons waiting for a person, and the arm will be thin.
4. Pick a staging project whose repositories the install can clone. The copies use the project's own checkout settings.
5. The `items.json` you export in step 1 holds real task text (titles, requests, summaries). **Keep it in a private temp folder, not in the repository, and delete it when the replay is done.** The same goes for `replay-out/`, `results.jsonl` and `corrections.json`.
6. Environment for the staging module (no secret among them):

```sh
export LESSONS_REPLAY_ENV=<cli environment name> LESSONS_REPLAY_ORG=<company id> LESSONS_REPLAY_PROJECT=<project>
export LESSONS_REPLAY_PER_RUN_USD=1 LESSONS_REPLAY_PLANNING_LIMIT_USD=<the project's planning limit for the path (Spending > the project; QUICK 2, FULL 6 by default)>
export LESSONS_REPLAY_GRADER_MODEL=<the model name the company's route answers with: the first grading prints the name it saw if this is wrong> LESSONS_REPLAY_GRADER_VERSION=<version>
export LESSONS_REPLAY_REPO_DIRS=<name>=<path to a clone of that repository>[,<name>=<path>]   # citations are checked at the cited commit; clones must have the history
export LESSONS_REPLAY_GRADE_HOLD_USD=0.25 LESSONS_REPLAY_LEARN_HOLD_USD=0.25 LESSONS_REPLAY_REPOSITORIES=<repo name>[,<repo name>]
```

## 0. Rehearse small and paid first, then run the full replay

**What a copy reserves.** Before it starts a copy the replay reserves the copy's worst case: the project's planning limit + `--per-run-usd` + the grading hold. With QUICK planning at $2, `--per-run-usd 1` and a $0.25 grading hold that is **$3.25 per copy**, so a `--max-usd` of $10 starts at most **three** copies (less the cost of building the lessons). That is deliberate: the limit can never be passed, even if every copy costs its worst case. What you actually pay is the sum of what the copies cost, far less.

**The paid rehearsal.** Choose a selection of 3 tasks (`--target 3`), arms `off,on:current,file:current`, 1 repeat (`plan ... --small`), and lower the project's QUICK planning limit to $1 for the rehearsal so a copy reserves $2.25 (Spending > the project; set `LESSONS_REPLAY_PLANNING_LIMIT_USD=1`). The runs go task by task, all three arms of the first task first.

1. `--max-usd 10`: starts the first four copies (the first task in all three arms and the next task's `off`). That is the plumbing proof and costs a few dollars. To run all nine, use `--max-usd 25` (9 x $2.25 = $20.25 reserved, plus the lessons). Spend is capped either way.
2. Check, in this order: the `snapshots` step reports its spend; `import-snapshots` reports as many snapshots as were planned; one `off` copy ends `completed` with a graded row; open its evidence (`agentx admin task lessons-replay evidence <copy id>`) and check the diff is the task's change and nothing else.
3. One `file:current` copy: the evidence shows `.rovara/lessons.md` and the `AGENTS.md` pointer are **not** in the diff, and the run's report lists loaded lessons.
4. Each arm's `ran` count is non-zero, and the report's "Runs by outcome" shows how many were left ungraded per arm (a stalled HIGH-risk plan is an ungraded run, not a miss). An arm with nothing completed, or fewer than half of the planned pairs completed in both arms, prints a STOP line: stop and find out why before spending more.
5. In `learning.json` (and the report) read, per arm, **lessons proposed / would have needed a person / cut at the cap / model calls that failed**. If almost everything "needed a person" the project's settings are strict and B will look empty: that is the real answer for that project, and a reason to choose a project with Standard settings for the full run.
6. Note the real cost per run, per arm. The full run's `--max-usd` must cover the reservation: runs x (planning limit + per-run limit + grading hold), plus the lessons. Raising it is your decision; it is never exceeded.

Then the **full replay** (40-60 tasks, 3 repeats). Do not read a rehearsal as a result. Every step that spends takes a **hard `--max-usd`**: `snapshots` stops when its builders have spent more than the limit, and `run` refuses to start without `--max-usd`, `--per-run-usd` and `--planning-usd`, reserves each copy's worst case, counts failed and unpriced runs at the reservation, counts grading and the building spend, and never starts a run that would pass the limit.

## 1. Choose the tasks

Export the finished tasks' `META` items from the State table exactly as `scripts/export-replay-tasks.ts` describes (read-only, through the guard; the operator runs the queries, the scripts make none), for example:

```sh
~/.local/share/rovara-tools/staging-aws.sh aws dynamodb query --table-name <state table> --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"DEVTASK#<taskId>"}}' --output json
```

Put the items in `items.json` (`{ "items": [...] }`, or the CLI's typed JSON with `--marshalled`) in a private temp folder. A task's member corrections are its human send-backs, counted by the lessons' own rule (Rovara's automatic send-backs never count). Review comments that read as corrections, human edits and reverts live in the Team record: add their counts per task as `"corrections": { "<taskId>": { "prComments": n, "humanEdits": n, "reverts": n } }` next to `items` (optional).

```sh
npx tsx scripts/export-replay-candidates.ts --input items.json --out candidates.json --org <org id>
```

It skips (and counts) automatic runs, unfinished tasks, tasks with no repository or time, and **eval or replay runs: a replay is never a past task**. Then select (deterministic: the same file and seed give the same tasks):

```sh
npx tsx scripts/lessons-replay-measure.ts select --candidates candidates.json --seed <text> --target 50 --out selection.json
```

A replay is of **one project**: the selection must hold tasks of one project (`snapshots` refuses a mix).

## 2. Build and import the frozen snapshots (the lesson pipelines)

`snapshots` runs each arm's pipeline over the SAME historical tasks, in time order, and writes the lessons of each simulated day as a frozen snapshot. Its model calls go through the install's `.../lessons-replay/model` route and are counted in the budget.

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts snapshots --selection selection.json --arms off,on:current --module scripts/lessons-replay-staging-module.ts --workspace <org id> --out-dir replay-out --max-usd 5
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts import-snapshots --dir replay-out --module scripts/lessons-replay-staging-module.ts
```

`snapshots` writes `snapshots.json`, `snapshot-lessons.json`, `learning.json` (cost and calls per arm), `lesson-sets.json` and `final-lessons.json`. `import-snapshots` sends each day's lessons to the install as a frozen snapshot (not in the live store; never merged with it) and checks that the id the install derived is the id the plan will name. Pipeline C has no builder until lane 8 is ported: run `--arms off,on:current` (plus `file:current` at plan time).

## 3. Plan

```sh
npx tsx scripts/lessons-replay-measure.ts plan --selection selection.json --arms off,on:current,file:current --seed <text> --grader-model <model> --grader-version <version> --snapshots replay-out/snapshots.json --out plan.json [--small]
```

450 runs for 50 tasks and 3 arms (50 x 3 x 3). The plan refuses fewer than 40 or more than 60 tasks and other repeat counts unless `--small` (1 repeat), and a missing snapshot.

## 4. Run and grade

Needs a corrections file: a JSON list of `{ id, taskId, at, kind, member, text? }` (the v1.2 `CORRECTION#` items through `metric-source.ts#v12CorrectionSource`).

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts run --plan plan.json --module scripts/lessons-replay-staging-module.ts --corrections corrections.json --results results.jsonl --max-usd <usd> --per-run-usd 1 --planning-usd <the project's planning limit> --dir replay-out
```

`--per-run-usd` must equal `LESSONS_REPLAY_PER_RUN_USD` and `--planning-usd` must equal `LESSONS_REPLAY_PLANNING_LIMIT_USD`. `--dir` lets the run count the snapshots' building spend (`learning.json`) in the same limit. The executor starts each copy, approves its plan through the guarded route, waits for it to end, reads the mark back, takes its evidence, and closes it.

Resumable: a rerun skips recorded runs (the limit counts what the earlier runs charged). A run that fails is an ungraded row charged at what it cost or its hold, and the replay goes on; an unmarked task or a learning call stops everything, and so does crossing the limit.

## 5. Report

```sh
npx tsx scripts/lessons-replay-measure.ts report --results results.jsonl --plan plan.json --compare on:current,file:current --dir replay-out --corrections corrections.json [--marks marks-by-arm.json] [--json]
```

Reads in this order:

1. **Loaded-lesson difference between the two compared arms.** If fewer than 10% of the (task, lesson) loads differ, or an arm did not run, or an arm loaded nothing on more than half its runs, the report prints a STOP line naming which, and nothing more (`--continue-anyway` prints the rest after it). Only (task, repeat) pairs graded in both arms count. Lessons are matched by their words.
2. Pass rate per arm with a Wilson 95% interval, over runs graded in every arm; the tasks only one arm of a pair solved; each arm's per-task intervals.
3. Same-mistake count per arm and the metric's split.
4. Learning cost per project-day and mean run cost.
5. Final lesson set: size, duplicates, unresolved contradictions.
6. Reviewer "useful" marks, blind to the arm.

## 6. The blind reviewer sheet

```sh
npx tsx scripts/lessons-replay-measure.ts blind-sheet --final-lessons replay-out/final-lessons.json --seed <text> --out-sheet sheet.json --out-key key.json
```

Give the reviewer only `sheet.json`: each distinct lesson once, under an id, in an order that does not depend on the arm. The reviewer returns `{ "marks": [{ "id": "R001", "useful": true }, ...] }` (`null` = no mark). Keep `key.json` away from the reviewer.

```sh
npx tsx scripts/lessons-replay-measure.ts import-marks --key key.json --marks marks.json --out marks-by-arm.json
```

## Estimated cost (estimates, measure the rehearsal first)

For 50 tasks and 3 arms: 450 runs. The runs dominate. At an assumed $1-3 per replayed task (check the rehearsal) that is about $450-1,350. Grading: about $0.05 per run, about $20. The offline pipeline B: about $0.03 per historical task, about $2 (counted in the limit). Budget the full replay at roughly $500-1,500, and set `--max-usd` for the run step from the rehearsal's measured cost per run. The copies are test runs: raise the testing allowance and the per-test cap in Spending first (see "Before you start").

## Cleaning up

Copies are closed by the executor. Imported snapshots expire after 14 days. Delete `items.json`, `candidates.json`, `corrections.json`, `replay-out/` and `results.jsonl` from your temp folder when done: they hold real task text.
