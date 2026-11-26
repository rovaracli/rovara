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
