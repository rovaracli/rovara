# Mutant evidence: GATEWAY-PHASE-2, Cloud half (pr/gateway-phase-2-cloud-20261125)

Each mutant was applied singly, in place, to one product line, the tests named below were run (`vitest run`, one worker), and the file was restored with `git checkout --` (the tree was clean after each). Run at 0e83ef219. Tests: `tests/contract/pipeline-gateway-from-code.test.ts` for every row, plus `pipeline-stage-refs.test.ts` for M15.

| # | Mutant | Result | Killed by (first failing test) |
|---|--------|--------|---|
| M1 | the image step takes the Cloud sha, not the Code sha, as the gateway's commit | KILLED | "beta checks out the Code commit the run releases ..." |
| M2 | the gateway step passes `rovaraCloudSha` instead of `rovaraCodeSha` | KILLED | "synthesizes in the Code checkout with -c rovaraCodeSha ..." |
| M3 | the Code build runs with the AWS credentials in its environment | KILLED | same test (the build commands must run with the variables removed) |
| M4 | the gateway step does not refuse a manifest with no Code commit | KILLED | "refuses a manifest with no Code commit for the gateway before any build or synth" |
| M5 | a rollback takes the Code that will be live, not the Code recorded with the digest | KILLED | "a rollback to a recorded digest takes the Code commit recorded with it" |
| M6 | an image recorded with no Code commit is accepted for a rollback | KILLED | "refuses a recorded image that has no Code commit ..." |
| M7 | the switch gate lets any output go (not only DeployedCloudSha) | KILLED | "fails when an output other than DeployedCloudSha goes ..." |
| M8 | the switch gate does not compare the Resources section | KILLED | "fails on a changed, added or removed resource, and names it" |
| M9 | the switch gate's skip is inverted (it judges a Code-made stack, skips a Cloud-made one) | KILLED | "the gate passes the first Code-made change set when only the outputs differ" |
| M10 | DeployedCodeSha is not compared with the Code commit | KILLED | "fails when DeployedCodeSha is missing, malformed, or names another commit ..." |
| M11 | the rollback-floor gate does not judge the gateway's Code commit | KILLED | "the rollback-floor gate judges the gateway's Code commit with the gateway change set" |
| M12 | the Cloud-ref floors also include the gatewayCode group | KILLED | "every gateway floor has a gatewayCode counterpart ..." |
| M13 | the gatewayCode check passes when there is no Code clone | KILLED | "fails closed: no clone while a floor exists ..." |
| M14 | image and gateway are dropped from the steps that need the Code clone input | KILLED | "image and gateway join preflight and gateway-check ..." |
| M15 | `readLiveCloudSha` reads the gateway stack again | KILLED | "a gateway stamped with a Cloud sha ... says nothing about which Cloud is live" |

Result: 15 of 15 killed. Runner: the scratch script that applied each row; the exact search and replace strings are the rows above.

## Pre-review fixes + rebase (added after the Sonnet pre-review; run at ed4a3e66d on cb4941c29)

Same method (single in-place edit, `vitest run --maxWorkers=1` over `pipeline-gateway-keep-live`, `pipeline-gateway-floor-containment`, `pipeline-gateway-from-code`, `pipeline-gateway-from-code-review` and `pipeline-rollback-plan`, `ROVARA_CODE_REPO` set to the Code worktree so the real-git test runs, file restored; tree clean after the run).

| # | Mutant | Result | Killed by (first failing test) |
|---|--------|--------|---|
| M16 | `keepsLiveGateway` does not compare the digest with the live ImageDigest | KILLED | "refuses a manifest with no Code commit ..." (gateway step) and the keep-live "does not keep a different digest ..." |
| M17 | a malformed DeployedCodeSha counts as "deployed from Cloud" | KILLED | "a DeployedCodeSha that is present but not a 40-hex commit is NOT read as 'deployed from Cloud'" |
| M18 | a valid DeployedCodeSha still allows the keep | KILLED | "does not keep a different digest, a missing stack, ... or a stack already deployed from Code" |
| M19 | the gateway step skips on a missing Code commit without asking the live stack | KILLED | "a different digest (the live gateway runs another image) is still refused, by the image step and by the gateway step" |
| M20 | a kept digest is not judged against the below-floor digest list | KILLED | "keeping a digest the floors file lists below the floor is refused ..." |
| M21 | the entry with no Code commit wins when last-good and previous name the same image | KILLED | "returns the recorded Code commit without looking at the live stack, and prefers the entry that has one ..." |
| M22 | a release run's unnamed GATEWAY_DIGEST is ROLLBACK_REFUSED again | KILLED | "refuses a digest the last-good record does not name, and one recorded with no Code commit" (review file) |
| M23 | production follows beta's kept digest without asking its own live gateway | KILLED | "production copies beta's digest and keeps beta's Code commit; with none recorded it refuses" |
| M24 | the keep check says yes for any live stack with an ImageDigest | KILLED | the same gateway-step test, and the keep-live production tests |
| M25 | the rollback plan treats a kept gateway (no Code commit) as a Code commit to judge | KILLED | "KEEPS the gateway that runs now: a pre-change record whose digest is what the live gateway stack ... runs is planned" |
| M26 | the containment rule ignores an added line the Code file lacks | KILLED | "reports an added line the Code file lacks" |
| M27 | the containment rule ignores a removed line the Code file still has | KILLED | "reports a removed line the Code file still has" |
| M28 | the first gatewayCode row says "blob-equal" again | KILLED | "no 'blob-equal' or 'byte-identical' claim covers a pair that is not ..." |
| M29 | the install doc says "blob-equal" again | KILLED | the same test |

Result: 14 of 14 killed (running total for the lane: 29 of 29). Runner: the scratch script that applied each row; the exact search and replace strings are the rows above.

## Opus round 1 fixes

Same method (single in-place edit, one worker, `ROVARA_CODE_REPO` set; tests: `pipeline-gateway-phase2-opus-review`, `pipeline-drift-gates`, `pipeline-gateway-keep-live`, `pipeline-gateway-floor-containment`, `pipeline-gateway-from-code`, `pipeline-gateway-from-code-review`, `pipeline-rollback-plan`; file restored after each; tree otherwise unchanged).

| # | Mutant | Result | Killed by (first failing test) |
|---|--------|--------|---|
| M30 | a malformed DeployedCodeSha on the live stack is used as the Code commit | KILLED | rollback-plan "... refuses a target whose gateway has none recorded ..." (and the keep-live malformed cases) |
| M31 | a pre-change record is refused again when the live stack carries a valid DeployedCodeSha (MUST-1 undone) | KILLED | the same plan test; keep-live "a stack already deployed from Code ... the Code commit it attests is used" |
| M32 | the live ImageDigest is not compared with the digest | KILLED | the same plan test; keep-live "... a stack running another image, is still refused" |
| M33 | the switch gate no longer fails a row when the image is unchanged | KILLED | "with the SAME image ... the change set must have no row at all" |
| M34 | that row rule applies whatever the image | KILLED | "the gate passes the first Code-made change set when only the outputs differ" |
| M35 | the switch refusal does not name the hand-deploy cause | KILLED | "when the live stack has no ServiceArn ... the refusal NAMES the cause and the way out" |
| M36 | NO_AWS_ENV unsets AWS_CONFIG_FILE instead of /dev/null | KILLED | "synthesizes in the Code checkout ..." (build env) and the drift-gates env tests |
| M37 | NO_AWS_ENV leaves the instance-metadata lookup on | KILLED | the same tests |
| M38 | an existing Code tree is reused without checking its HEAD | KILLED | "reuses an existing Code tree only when it is at the Code commit asked for" |

Result: 9 of 9 killed (running total for the lane: 38 of 38 in Cloud).
