# Review: scripted split of broker.ts (64ef57401 scripts, c6bed67cd applied; base fd7cd3c35)

Reviewer: Opus, read-only (only this file written). Tests through heavy.sh with vitest --maxWorkers=2. No AWS calls.

## Verdict: APPROVE WITH FIXES

The moved code is a pure text move, and the exported surface is identical. The script is deterministic and idempotent.
One real load-order change exists, and it is not the one the report worried about. Fix I1 before landing.

## What I verified independently (my own scripts, not the builder's)

1. **Text identity.** My AST check covered all 677 non-import statements of the fd7cd3c35 broker.ts. Each one appears exactly once in exactly one new file (allowing for an added `export `). The new tree also has 677 non-import statements, so nothing was added.
2. **Exported surface.** I compared broker.ts exports syntactically, following the re-exports into the modules. Before and after there are 80 names, with identical names and kinds (value vs type).
3. **Determinism and idempotence.**
   - I took a scratch copy of fd7cd3c35 and ran the committed script on it (verified the copy by sampling 127 file hashes against git).
   - The output was byte-identical to c6bed67cd for all 28 source files, the helper, 9 auto-patched tests and the manifest. The two hand-fixed tests are the only differences, as expected.
   - The second run printed `already split` and exited 0. `--check` exited 0.
   - `--dry-run` returns before any write (split-broker.ts:670-673).
4. **No load-time reads cross modules.**
   - No top-level initializer in aws/broker/*.ts reads a binding from a sibling module, functions included. So the 23-module cycle is safe.
   - The only `let`s (chainRunnerDependencies, removeChainRunner) are used only inside dependency-wiring.ts.
   - No module imports `../broker.js` back.
5. **The staying part of broker.ts.** The new broker.ts body is the old tail (from `const s3`) in the same order. Three things were taken out of it:
   - the four runtime-clients consts;
   - serviceStatusRouteDependencies (an override, a function);
   - two blank lines.
   The four runtime-clients consts now evaluate before `s3` and the other clients. This is still after env-init. Building SDK clients in a different order has no observable effect.
6. **Failing tests are pre-existing.**
   - I ran all 7 failing files on the scratch fd7cd3c35 copy and on the head.
   - Both runs gave 351 passed and 43 failed, with an identical list of failing test names (empty diff).
7. **The 10 adapted test files that are not in the failing set pass on the head** (363/363). org-members and task-owner-reads are among the 7 files in item 6: their only failures are also failures on the base.
8. **esbuild bundles the split entry** (format esm, node22) without errors.

## The "18 imports now load after env-init" question

**Environment: benign.**
- I simulated ESM evaluation order for the old and new graphs, following static imports including `@agentx/*` sources, with verbatimModuleSyntax semantics.
- Old: 723 modules evaluated before `hydrateBrokerEnvironment`. New: 203 (env-init's own closure).
- An AST scan of every non-test `packages/*/src` file finds no module-top-level `process.env` read anywhere in the broker's graph. The only hits are other Lambda entry files, which are not in this graph.
- `hydrateBrokerEnvironment` only fills unset variables.
- So no module reads a different environment at import time. `handler` and the singletons keep their order (item 5).

**Registries: a real change.** The new module order changes the order of top-level side-effect registrations. See I1.

## Findings

### Critical
None.

### Important

**I1. Member-mover order changes: `spend-requests` now runs after `triggers` (it ran before).**
- Where: packages/broker/src/aws/broker.ts:5 and scripts/split/split-broker.ts:472-475. The splitter hoists side-effect imports to the top and drops the original import order.
- How it shows up:
  - ESM simulation: old order is spend/requests.ts 406, then triggers/lifecycle.ts 484. New order is triggers 484, then spend/requests 489.
  - Real esbuild bundles agree. Base: spend/requests at line 360402, triggers at 378574. Head: triggers at 376582, spend/requests at 378656.
- Why it matters:
  - `registerMemberMover` stores movers in a Map (agents/lifecycle.ts:74-78).
  - `runMovers` runs them one after another in insertion order (agents/lifecycle.ts:339), under a 2 s in-request deadline (`checkTime`).
  - So a member merge or removal now runs the movers in a different order. That affects which one the deadline cuts off and the order of the logs.
  - Other registries are not affected:
    - Approver rules and subject handlers are keyed by name, so their order doesn't matter.
    - Home-card sources keep their relative order. home.ts still loads before rovara-code/questions.ts.
- Runtime risk is low. But the commit claims to be a pure move, and no test can catch this, because each test loads modules in its own order.
- Fix: make broker.ts keep the old evaluation order exactly, as the sibling devtasks splitter's `preserveImportOrder` does.
  - Emit a bare `import "<spec>";` for every original non-`import type` import, in the original order. That includes env-init at its original position, after the 21 imports above it.
  - Then emit the named imports.
  - runtime-clients.ts is reachable only through broker/ modules, which load after the prelude. It therefore still evaluates after env-init.
  - Moving env-init to the very top is a reasonable improvement. Do it as its own commit, with a note on the mover-order change.
  - Re-verify: the simulated order should be identical to the old one (except for the new broker/ modules).

**I2. Dry-run says "would apply cleanly" when the real run would refuse.**
- Where: scripts/split/split-broker.ts:663-664 and 671-672.
- Missing anchors and override symbols only count as problems when not in dry-run. So the mainline dry run exits 0 with "applies cleanly", while a real run would exit 2 on the 7 missing anchors plus 1 override.
- The report's "Applies cleanly" for mainline is therefore misleading.
- Fix: in dry-run, count the same problems and exit 2 like the real run, so dry-run predicts the real run. Keep the detail lines.

**I3. Public-mainline reuse would publish private names.**
- What: split-broker.config.ts and split-broker.manifest.json name about 677 private-branch symbols. 190 of them are absent on mainline, which means they are Cloud-only.
- c6bed67cd also commits .superpowers/sdd/split-broker evidence (exports-*.json, mainline-dry-run.txt).
- PrepLabsAI/Rovara is public.
- Fix: for mainline, use a separate mainline config and manifest generated there. Never cherry-pick the private config, manifest or evidence to the public repo. Check visibility before pushing.

### Minor

**M1. The eager-use check misses some load-time reads** (split-broker.ts:116-123 and 298).
- Gaps:
  - static class fields and static blocks are treated as deferred;
  - enum member initializers are not treated as eager;
  - an eager call to a sibling *function* is skipped (`target.kind !== "function"`), even though the function's body may read a sibling const that is still in TDZ.
- None of these occur today (verified above). But they matter for re-runs on newer heads.
- Fix: treat static members and enums as eager. For an eager call to a function, follow that function's own `uses` one level, or refuse.

**M2. Top-level non-declaration statements stay in broker.ts with only a note** (split-broker.ts:192 and 220).
- A top-level call or `if` on a newer head would silently move to after all module code.
- None today.
- Fix: refuse instead, unless the statement sits inside the keepFrom range.

**M3. A non-dry run writes the manifest next to the config, not under `--root`** (split-broker.ts:650 and 684).
- `--root <other checkout>` therefore overwrites the reference manifest in the script's own checkout.
- Fix: write it under `--root`, or require `--manifest`.

**M4. `--check` and `--force` edge cases** (split-broker.ts:622 and 632).
- `--check` requires every configured module file to exist. On a checkout where anchors fold together (mainline), it reports `split-incomplete` after a successful split.
- `--force` leaves stale module files behind, and `brokerSourceFiles()` then reads them as "rest".
- Fix: record the written module list (marker or manifest) and check against that. Clear the folder on `--force`.

**M5. developer-task-start's hand fix is looser than the original** (tests/contract/developer-task-start.test.ts:398-405).
- The original required one import statement naming both helpers in broker.ts. The new check:
  - is per name;
  - applies only to files that call the helper (`name(`).
- The intent ("defined once, imported from broker-shared") still holds. Once devtasks lands this hand fix goes away anyway (see the recipe below).

**M6. There are now two split engines and two test helpers.**
- Engines: split-broker.ts and split-lib.ts.
- Helpers: tests/support/broker-source.ts (original order) and tests/support/split-source.ts (file first, then alphabetical).
- Keep readBrokerSource for broker.ts. admin-health-infrastructure asserts an ordered list of lines, which alphabetical order would break.
- Consolidate later; it does not block landing.

**M7. Cosmetic leftovers.** broker.ts has two leftover blank lines where stepFunctions and ec2Sessions were.

## Landing order and recipe (with chore/split-devtasks bb855e299)

The two splits do not touch each other's sources. The devtasks split leaves broker.ts byte-identical, and the developer-* thin files re-export the same names, so broker.ts's imports still resolve.
They overlap only in tests:
- developer-task-start, org-members, requalify-hold and task-owner-reads are edited by both;
- each adds its own helper.

**Order: land devtasks first (after its own fixes), then re-run the broker splitter on the new head. Do not rebase c6bed67cd.**

1. Builder fixes I1 and I2 (and preferably M1-M3) in the script commit. Re-run on fd7cd3c35 and confirm:
   - verify-moved and exports compare pass;
   - ESM order is identical to the base apart from the new broker/ modules.
2. Land chore/split-devtasks on the integration head (call the result D).
3. Make a new branch from D. Cherry-pick only the script commit(s) (64ef57401 plus the fix). Then:
   - Run `node scripts/split/split-broker.ts --dry-run`. Expect no missing anchors and 0 new or absent symbols compared with the manifest.
   - Apply.
   - The splitter patches requalify-hold, org-members, task-owner-reads and the other read-the-file tests on top of the devtasks versions, using the same literal patterns.
   - Re-apply the app-projects hand fix.
   - Leave developer-task-start as devtasks wrote it. Its `readSplitSource(".../broker.ts")` reads broker.ts plus broker/*.ts, so it covers the split without the broker hand fix. Confirm that it passes.
4. Check the result:
   - verify-moved, the exports compare and `tsc -b packages/broker`;
   - affected tests;
   - the failing set compared with D (it should be the same failing set);
   - the ESM-order simulation compared with D.
5. Merge. A release-build or CI bundle check for the Broker entry is still owed (deploy entry: infra/lib/control-plane.ts:200).

If broker lands first instead, the same rule applies the other way: rebuild devtasks from its script on the new head, and do not rebase.

**In-flight branches that edit broker.ts (S = the split commit on integration):**
1. `git rebase S^` first (the head just before the split), resolving as usual.
2. `git switch -c <branch>-resplit S`. Bring over the branch's non-broker changes: `git diff S^ <branch> -- . ':!packages/broker/src/aws/broker.ts' | git apply -3`. Resolve tests the split patched by keeping `readBrokerSource()` / `brokerSourceFiles()`.
3. Re-split:
   - `git show <branch>:packages/broker/src/aws/broker.ts > packages/broker/src/aws/broker.ts` (the unsplit file with the branch's changes);
   - `rm -r packages/broker/src/aws/broker`;
   - `node scripts/split/split-broker.ts`.
   New symbols land by range. Check the "new here / placed differently" lines and add anchors or overrides if needed.
4. `git diff S` should now show only the branch's own changes, inside the modules. Run verify-moved against the branch's unsplit broker.ts, plus tsc and affected tests.
   - Small branches can instead hand-port hunks, using split-broker.manifest.json to find each symbol's module.
5. Tests on the branch that read `aws/broker.ts` as text: the splitter patches the common shapes. Fix any it lists under `review:` by hand.

**Public mainline:** this needs its own config and manifest, with anchors for the 7 modules that are missing there. Only ever push the generic script, never the private config, manifest or evidence (I3).
