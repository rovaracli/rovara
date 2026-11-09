# Lessons replay A/B: operator runbook

What this is: a sanity check of the lesson pipelines (owner decisions 38, 49), not proof. It replays 40-60 past tasks from repositories with many member corrections, 3 runs each, under three arms, and reports numbers. **It gives no verdict. The owner decides.**

| Arm | Meaning |
|---|---|
| `off` | no lessons (A) |
| `on:current` | lessons from the current pipeline: reflector, curator, similarity, judge (B) |
| `on:consolidated` | lessons from the reflector plus the nightly consolidation pass (C; built by lane 8, not on this branch yet) |
| `file:<label>`, `mcp:<label>` | the same lessons offered to a LOCAL agent through `.rovara/lessons.md` or the MCP tool (decision 50.5). Stubs: the run refuses until lane R2 and the MCP tool exist. |

The script `scripts/lessons-replay-measure.ts` makes no AWS call and no model call. Everything that touches staging is an operator module you pass with `--module` (below). Run the script with the pinned Node (22.23.2), for example `npx tsx scripts/lessons-replay-measure.ts <command> ...`.

## Rules the harness enforces

- **Replays never feed learning.** Every replayed task carries `evalRun` on its task record; the task source, the task-end and human-edit reflections, the reflector, the nightly job and the outcome counters all refuse it. The executor must confirm the marker on every run or the whole replay stops (`EvalMarkError`).
- **Decision 47.** Replays run with the install's lessons switch (`ll`) at 0 and make no learning calls; a run that reports one stops the replay. The lesson snapshots are built offline by the harness, with learning calls named in the plan (`snapshotBuilds: explicit`), never through the install's switch. The report prints this.
- **Lessons learn only from historical outcomes**, in time order: the snapshot for a simulated day is built from tasks that finished before that day, never from a replay.
- **One fixed grader.** Its model and version are in the plan and in every graded row. The grader is shown no arm. Runs graded differently, or one task graded by tests in one arm and by a rubric in another, are refused (`GraderMismatchError`).
- **Same mistake** = the grader flags a mistake that a historical correction given before that task already named. The flag must name such a correction. The repeat-mistake metric (`sameMistakeTwice`) then checks it and splits it: lesson loaded / lesson not loaded / no lesson.

## 0. Rehearse small first (cheap, catches wiring faults)

Use `--small` in step 3 (4 or more tasks, 1 repeat) and a `--cost-cap`. Do not read a rehearsal as a result.

## 1. Choose the tasks

Input: a candidates file, a JSON list of `{ taskId, project, repository, at (ms), memberCorrections, outcome }` for finished past tasks. `memberCorrections` counts human send-backs, change-requesting review comments, human edits and a revert by members, the same corrections the lessons metric counts.
TODO: no exporter for this file exists yet. Build it from the staging State and Team record tables with the same pattern as `scripts/export-replay-tasks.ts` (read-only queries through the guard):

```sh
~/.local/share/rovara-tools/staging-aws.sh aws dynamodb query --table-name <state table> --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"DEVTASK#<taskId>"}}' --output json
```

Then select (deterministic: the same file and seed give the same tasks):

```sh
npx tsx scripts/lessons-replay-measure.ts select --candidates candidates.json --seed <text> --target 50 --out selection.json
```

It takes the repositories with the most member corrections first, at most 15 tasks per repository (lifted only if the pool is too concentrated), highest-correction tasks first, and returns them in time order.

## 2. Build the frozen snapshots (the lesson pipelines)

The operator module (`--module`) is an ES module whose default export returns `{ builders, executor, grader, deliveries? }` (types in `packages/broker/src/lessons/replay-harness.ts`). `builders` maps each pipeline label to a `SnapshotBuilder`. Pipeline B wraps the existing reflector, curator, similarity and judge over the historical subjects; pipeline C is lane 8. TODO: neither builder is written; the harness and its tests use fakes.

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts snapshots --selection selection.json --arms off,on:current,on:consolidated --module ./replay-module.mjs --out-dir replay-out
```

Writes `snapshots.json`, `learning.json` (cost and calls per arm), `lesson-sets.json` (size, duplicates, contradictions) and `final-lessons.json`.

## 3. Plan

```sh
npx tsx scripts/lessons-replay-measure.ts plan --selection selection.json --arms off,on:current,on:consolidated --seed <text> --grader-model <model> --grader-version <version> --snapshots replay-out/snapshots.json --out plan.json
```

450 runs for 50 tasks (50 x 3 arms x 3 repeats). The plan refuses fewer than 40 or more than 60 tasks, other repeat counts, and a missing snapshot.

## 4. Run and grade

Needs the staging executor (starts a task on staging marked `evalRun`, with the arm's `memory` input or delivery, and returns its load records, cost and an evidence reference) and the grader. TODO: both are operator code; the executor must run only through `staging-aws.sh` (account 944937319445, us-west-2). Also needs a corrections file: a JSON list of `{ id, taskId, at, kind, member, text? }` (the v1.2 `CORRECTION#` items through `metric-source.ts#v12CorrectionSource`).

```sh
~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/lessons-replay-measure.ts run --plan plan.json --module ./replay-module.mjs --corrections corrections.json --results results.jsonl --cost-cap <usd>
```

Resumable: a rerun skips recorded runs. A run that fails is an ungraded row and the replay goes on.

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

For 50 tasks: 450 runs. The runs dominate. At an assumed $1-3 per replayed task (check staging's recent cost per task) that is about $450-1,350. Grading: free for hidden tests, about $0.05 per run for a rubric grader, about $20. Pipeline B's learning is about $0.03 per historical task (reflection plus judge), about $2. Pipeline C adds one consolidation call per simulated day, about $1-2. Budget the full replay at roughly $500-1,500, and set `--cost-cap` for the run step.
