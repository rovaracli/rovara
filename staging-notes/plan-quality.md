# Plan and implementation quality for Rovara Code v2 (branch fix/plan-quality)

Base: private/merge/plan6-into-integration (a390a6ea, what staging runs). No AWS, IAM, CDK or Lambda-variable changes.
Why: three graded rehearsals (0.4.11, 0.4.12, 0.4.13) all scored Plan 3-4 and Implementation 4 for the same four gaps: (1) input validation accepting loose values such as `Number(" 2 ")`; (2) no test of the new option combined with the existing ones (filters plus limit) or above the item count; (3) the plan's Checks section listing lint but not the `npm test` the repo's CI requires; (4) the PR body not naming the tested head commit.

## What changed

1. Guidance (general, not tied to the scenario), pinned word for word by `tests/contract/rovara-code-plan-quality.test.ts`:
   - the planner and the builder get it as the v2 recipe's own step instructions (`packages/contracts/src/agent-templates.ts`, `ROVARA_CODE_PLAN_GUIDANCE`, `ROVARA_CODE_BUILD_GUIDANCE`). The recipe's `plan` step and `build` step carry them; `plan_critic`, `check`, `review`, `pull_request` and the recipe-level instructions are unchanged. They reach the worker as the existing "Instructions from your company's agent" prompt section (proved end to end in `rovara-code-plan-estimate.test.ts`, "the plan-quality guidance reaches the prompts"; a v1 task's prompts contain none of it).
   - the plan critic gets the matching checklist item in its own prompt (`packages/broker/src/rovara-code/critic.ts`, `PLAN_CRITIC_QUALITY_CHECKLIST`), not in a step setting, so a company overlay on the step cannot drop it.
2. Checks section, deterministically (not only by prompt):
   - `packages/broker/src/rovara-code/ci-checks.ts` reads the repo's `.github/workflows/*.yml|yaml` (default branch, through the org's existing read-only reader; at most 3 repositories, 20 files, 64 KiB each, 10 s overall; any failure leaves the plan as it was). Only workflows that run on push or pull_request count. Only plain single-program verification commands are kept (test, lint, type-check, build, `npm test`, `npm run <test|lint|check|typecheck|build...>`, pytest, go test, cargo test, make test, and so on); no shell syntax at all (pipes, quotes, variables, `||`, `;`, `$(...)`), installs and deploys are dropped, `working-directory` and `cd` must stay inside the repository. Capped at 8, label `CI: <step name or command>`.
   - `withCiChecks` (contracts, `workflow-plan-document.ts`) merges them into the planner's `checks` member after the planner's own (no duplicate command, nothing the proposed-check rules would refuse, never more than 8). They are proposals like any other: shown in the plan, run only after the person approves it.
   - A project check that the plan can't propose again (the project already requires it, e.g. `npm test`) used to be dropped silently. For v2 plans the plan now stores `checks.alsoRun` (the project's required checks) and the Checks section lists them as a line like "npm test: `npm test` in `repo/demo` (a project check; it always runs)". v1 plans store and show exactly what they did.
   - The "plan must name a test" rule still reads the planner's answer as written; a CI check never stands in for a test claim.
3. PR body: the Tests section (and the regenerated status block) says `- Tested on head commit 11111111` (8-character short SHA of the candidate commit the checks ran on; `(pushed as 22222222)` when the pull request head is a different commit with the same code; one `head commits: repo sha, ...` line for several repositories). Only when a check ran on this code. v1 bodies are unchanged.
4. Digests: the v2 recipe digest changed `1b47c1f5...` -> `c9381c97a2967f260ab3d16e48b2c3fddddc394fb15562fb61d62d74bf693812` in `tests/fixtures/builtin-agent-digests.json`. `rovara-code-golden.test.ts` has a new block that lists the two changed paths by value (`steps[0].settings.instructions`, `steps[2].settings.instructions`, change 7), proves that undoing exactly those two paths gives the old digest, and pins the v1 digest `1f3d988f...` (unchanged) and the fixture. The recorded golden fixtures and SHA256SUMS are byte-identical (they record v1).

## Exact prompt diff (all additions; nothing existing was reworded)

Planner (v2 `plan` step instructions):

```diff
+Plan the input rules, the tests and the checks as well as the code.
+- Input: say exactly which values are accepted and which are rejected (empty, padded with spaces, signed, decimal, exponent, hex, below the minimum, above the maximum), and parse strictly. A loose conversion such as Number() or parseInt() accepts values the rule does not.
+- Tests: for each new option, plan a test alone, one combined with each existing option it can meet (such as filters), and one at each boundary: the minimum, the maximum, one past each, and a value above the number of available items.
+- Checks: list every check the repository's CI requires. Read its workflow files, and do not stop at lint.
```

Builder (v2 `build` step instructions):

```diff
+Validate input strictly: accept only the documented form and reject everything else with a clear error before doing any work.
+Do not rely on a loose conversion such as Number() or parseInt(), which accepts padding, exponents, hex and decimals.
+Write tests for each new option alone, combined with the existing options, and at its boundaries (the minimum, the maximum, one past each, and above the number of available items).
+Run the plan's checks and the repository's own test command before you finish.
```

Plan critic (`planCritiquePrompt`, inserted after the paragraph that defines blocking and note points, before "You advise; you do not decide."):

```diff
+Also hold the plan to this checklist, and report a gap as a blocking point when it would let bad input through or leave the change untested: it validates input strictly, with explicit rejection cases; it tests each new option alone, combined with the existing options and at the boundaries; and its checks include every check the repository's CI requires.
```

## Gates (exact Node v22.23.2, through heavy.sh)

- `npx tsc -b`: clean. eslint on every changed file: clean.
- `npm run typecheck:all`: the stricter check reports ONE error, in `tests/contract/rovara-code-review-wake.test.ts:181` (`string | undefined` passed where `string` is wanted). It is already there at the base commit a390a6ea (checked by stashing this branch's changes and running the same program), from the Bug I merge; this branch adds none. Not fixed here (outside this change).
- Tests: all `tests/contract/rovara-code-*` (including golden, golden-v2, v2, v2-switch, pr-body, critic, plan-estimate, the new plan-quality), `agent-templates`, `agent-dispatch`, `agent-recipe`, `agent-store`, `agent-roster`, `developer-task-workflow-flow`, `task-web`, `workflow-plan-document` and `plan-document-instructions`: 69 files, 2,523 tests passed. Plus 31 new tests in `rovara-code-plan-quality.test.ts`, 5+2 new in `rovara-code-plan-estimate.test.ts`, 5 new in `rovara-code-pr-body.test.ts`, 3 new in `rovara-code-golden.test.ts`.

## Does a worker image need rebuilding? No.

Every behaviour change runs in the broker Lambda: the recipe text and prompt section, the plan critic prompt, the CI read and merge (`storePlanAnswer`), and the PR body. The worker image bundles `@agentx/contracts`, but only gains unused exports (`withCiChecks`, `alsoRun`, `listRequired`); it parses plans without the checks input as before, so its plan reading is unchanged. A rebuild would be harmless but changes nothing. Deploying needs the broker (and anything that bundles contracts) rebuilt by the normal release; no new Lambda variable, so the ENV-ROOM check does not apply.

## Behaviour to know

- The CI read uses the repository's DEFAULT branch head, not the task's base commit (the org's existing read-only agent reader reads only the default branch). On a repo whose sandbox base differs in workflows this can differ; it only adds proposals a person reviews.
- Cloud installs only (the reader is org-scoped); a private install skips the read and behaves as before.
- Orgs already pinned to v2 get the new v2 text on their next task (a recipe digest change, not a new version number). Orgs on v1 (the default pin) are untouched.
- Not done: the plan critic still advises only (it cannot reject a plan); the HELP-text gap the graders also noted is a product-specific detail, so no general rule was added for it.
