# Lessons replay A/B: operator runbook

What this is: a sanity check of the lesson pipelines (owner decisions 38, 49), not proof. It replays 40-60 past tasks from repositories with many member corrections, 3 runs each, under three arms, and reports numbers. **It gives no verdict. The owner decides.**

| Arm | Meaning |
|---|---|
| `off` | no lessons (A) |
| `on:current` | lessons from the current pipeline: reflector, curator, similarity, judge (B) |
| `on:consolidated` | lessons from the reflector plus the nightly consolidation pass (C; built by lane 8, not on this branch yet) |
| `file:<label>` | the pipeline's lessons offered to a LOCAL agent as the repository file `.rovara/lessons.md` (lane R2's format and renderer) plus the one pointer line in AGENTS.md (decision 50.5). Built: `replay-delivery.ts#FILE_DELIVERY`. |
| `mcp:<label>` | the same lessons offered through the MCP tool. Stub: the run refuses until the tool exists. |

## What is real and what is not yet (read this first)

| Piece | State |
|---|---|
| Contracts, report, STOP line, blind sheet, fixed grader rule, eval-run refusal in every learning path (including R1b comments and edits) | built, tested |
| Candidates exporter `scripts/export-replay-candidates.ts` (ranks by member corrections) and `select` | built, tested; the Team record counts (comments, edits, reverts) are an optional extra input |
| Harness: plan, run, resume, `--max-usd` hard stop, grader blind to the arm | built, tested with fakes |
| Executor `stagingExecutor` (`packages/broker/src/lessons/replay-executor.ts`): always starts the task marked `evalRun`, reads the mark back, cancels and stops the replay on an unmarked task | built, tested against a fake port |
| Rubric grader `rubricGrader` (`replay-grader.ts`): hidden tests where a task has them, else a rubric scored by a model | built, tested with a fake model; needs your model adapter and evidence reader |
| Pipeline B `asOfSnapshotBuilder` (`replay-asof.ts`): the lessons live at the start of each day, read from the lesson store's version history, no model | built, tested; its learning cost is NOT measured (shown as "not recorded") |
| `file:<label>` arm (`replay-delivery.ts#FILE_DELIVERY`): renders each day's lessons with R2's own `renderLesson` and `renderLessonsFile`, so a lesson R2 would not put in a file is not offered; the executor port places the file and pointer in the checkout | built, tested; the placement is part of the install-side blocker below |
| Pipeline C (lane 8) and the `mcp:` arm | stubs; a run refuses |
| **The install side of the executor port (BLOCKER for a real run)** | **missing.** The existing e2e replay (`aws/workflow-e2e-replay.ts`, `agentx admin task e2e-replay`, `scripts/e2e-replay-round.ts`) re-verifies the recorded UI round of a task with no model. It starts no task and cannot carry a memory input, so it cannot be the executor. Needed: (1) an admin route that starts a copy of a past task with a `memory` input and the `evalRun` mark set at creation, (2) the lesson loader honouring `memory: { mode: "snapshot" }` with a pinned snapshot. Copy the e2e replay's shape: admin route, CLI client, a polling script. |

The script `scripts/lessons-replay-measure.ts` makes no AWS call and no model call. Everything that touches staging is an operator module you pass with `--module` (below). Run the script with the pinned Node (22.23.2), for example `npx tsx scripts/lessons-replay-measure.ts <command> ...`.

## Rules the harness enforces

- **Replays never feed learning.** Every replayed task carries `evalRun` on its task record; the task source, the task-end and human-edit reflections, the reflector, the nightly job and the outcome counters all refuse it. The executor must confirm the marker on every run or the whole replay stops (`EvalMarkError`).
- **Decision 47.** Replays run with the install's lessons switch (`ll`) at 0 and make no learning calls; a run that reports one stops the replay. The lesson snapshots are built offline by the harness, with learning calls named in the plan (`snapshotBuilds: explicit`), never through the install's switch. The report prints this.
- **Lessons learn only from historical outcomes**, in time order: the snapshot for a simulated day is built from tasks that finished before that day, never from a replay.
- **One fixed grader.** Its model and version are in the plan and in every graded row. The grader is shown no arm. Runs graded differently, or one task graded by tests in one arm and by a rubric in another, are refused (`GraderMismatchError`).
- **Same mistake** = the grader flags a mistake that a historical correction given before that task already named. The flag must name such a correction. The repeat-mistake metric (`sameMistakeTwice`) then checks it and splits it: lesson loaded / lesson not loaded / no lesson.

## 0. Rehearse small first, then run the full replay

Do the whole sequence twice: first as a **rehearsal** (steps 2 to 4 with `--small` on `plan`, a selection of 4 to 8 tasks, 1 repeat, `--max-usd 25`), then the **full replay** (40-60 tasks, 3 repeats, a `--max-usd` you chose from the rehearsal's cost per run times 450, plus 20%). Do not read a rehearsal as a result. Every step that spends takes a **hard `--max-usd`**: `snapshots` stops when its builders have spent more than the limit, and `run` refuses to start without one, never passes it, and does not start a run that would pass it if it cost as much as the dearest run so far.

## 1. Choose the tasks

Export the finished tasks' `META` items from the State table exactly as `scripts/export-replay-tasks.ts` describes (read-only, through the guard; the operator runs the queries, the scripts make none), for example:

```sh
~/.local/share/rovara-tools/staging-aws.sh aws dynamodb query --table-name <state table> --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"DEVTASK#<taskId>"}}' --output json
```

Put the items in `items.json` (`{ "items": [...] }`, or the CLI's typed JSON with `--marshalled`). A task's member corrections are its human send-backs, counted by the lessons' own rule (Rovara's automatic send-backs never count). Review comments that read as corrections, human edits and reverts live in the Team record: add their counts per task as `"corrections": { "<taskId>": { "prComments": n, "humanEdits": n, "reverts": n } }` next to `items` (optional; without it only send-backs are counted).

```sh
npx tsx scripts/export-replay-candidates.ts --input items.json --out candidates.json --org <org id>
```

It skips (and counts) automatic runs, unfinished tasks, tasks with no repository or time, and **eval or replay runs: a replay is never a past task**. Then select (deterministic: the same file and seed give the same tasks):

```sh
npx tsx scripts/lessons-replay-measure.ts select --candidates candidates.json --seed <text> --target 50 --out selection.json
```

It takes the repositories with the most member corrections first, at most 15 tasks per repository (lifted only if the pool is too concentrated), highest-correction tasks first, and returns them in time order.

## 2. Build the frozen snapshots (the lesson pipelines)

The operator module (`--module`) is an ES module whose default export returns `{ builders, executor, grader, deliveries? }` (types in `packages/broker/src/lessons/replay-harness.ts`). `builders` maps each pipeline label to a `SnapshotBuilder`: for `current` use `asOfSnapshotBuilder({ store, key, pin })` (the lessons the install held at the start of each simulated day, read from the lesson store; no model, so no learning cost is recorded for it); pipeline C is lane 8 and has no builder yet, so run `--arms off,on:current` until it lands (the plan needs two arms; the report's B-versus-C section then says "not comparable").

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts snapshots --selection selection.json --arms off,on:current --module ./replay-module.mjs --out-dir replay-out --max-usd 5
```

Writes `snapshots.json`, `snapshot-lessons.json` (each day's lessons, for the file arm), `learning.json` (cost and calls per arm), `lesson-sets.json` (size, duplicates, contradictions) and `final-lessons.json`.

## 3. Plan

```sh
npx tsx scripts/lessons-replay-measure.ts plan --selection selection.json --arms off,on:current,on:consolidated --seed <text> --grader-model <model> --grader-version <version> --snapshots replay-out/snapshots.json --out plan.json
```

450 runs for 50 tasks (50 x 3 arms x 3 repeats). The plan refuses fewer than 40 or more than 60 tasks, other repeat counts, and a missing snapshot.

## 4. Run and grade

Needs the executor and the grader in the module. `executor: stagingExecutor(port)` always starts the task with `evalRun: true`, reads the mark back, and stops the replay on a task that does not carry it; `port` is the install side listed above as the blocker (it must reach staging only through `staging-aws.sh`, account 944937319445, us-west-2). `grader: rubricGrader({ model, evidence, correctionText, tests? })` needs your model adapter (a fixed model and version, recorded in every row) and an evidence reader. Also needs a corrections file: a JSON list of `{ id, taskId, at, kind, member, text? }` (the v1.2 `CORRECTION#` items through `metric-source.ts#v12CorrectionSource`).

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts run --plan plan.json --module ./replay-module.mjs --corrections corrections.json --results results.jsonl --max-usd <usd> [--snapshot-lessons replay-out/snapshot-lessons.json]
```

`--snapshot-lessons` is required when the plan has a `file:` arm (it holds each pipeline's lessons for each day).

Resumable: a rerun skips recorded runs (the limit counts what this invocation spends). A run that fails is an ungraded row and the replay goes on; an unmarked task or a learning call stops everything.

## 5. Report

```sh
npx tsx scripts/lessons-replay-measure.ts report --results results.jsonl --plan plan.json --compare on:current,on:consolidated --dir replay-out --corrections corrections.json [--marks marks-by-arm.json] [--json]
```

Reads in this order:

1. **Loaded-lesson difference between B and C.** If fewer than 10% of the (task, lesson) loads differ, or neither arm loaded anything, the report prints a STOP line and nothing more (`--continue-anyway` prints the rest after it). Lessons are matched by their words, so a reworded lesson counts as different.
2. Pass rate per arm with a Wilson 95% interval, over runs graded in every arm; the tasks only one arm of a pair solved.
3. Same-mistake count per arm and the metric's split.
4. Learning cost per project-day (a project-day is a project and a UTC day with at least one replayed task) and mean run cost.
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

For 50 tasks: 450 runs. The runs dominate. At an assumed $1-3 per replayed task (check staging's recent cost per task) that is about $450-1,350. Grading: free for hidden tests, about $0.05 per run for a rubric grader, about $20. Pipeline B's learning is about $0.03 per historical task (reflection plus judge), about $2. Pipeline C adds one consolidation call per simulated day, about $1-2. Budget the full replay at roughly $500-1,500, and set `--max-usd` for the run step from the rehearsal's measured cost per run.
