# kit-signing report (saved by the controller; the builder's write failed on a full disk)
Commit 08de65fc1 on fix/kit-signing (from a18aca07a). No AWS call, no key created, nothing deployed, no CI.
1. infra/lib/bundle-signing.ts (AgentXBundleSigning, wired in app.ts), off unless -c agentxBundleSigning=enabled + agentxBundleSigningRepository + agentxBundleSigningOidcProviderArn. Role assumable only via GitHub OIDC with aud=sts.amazonaws.com, sub=repo:<repo>:ref:refs/tags/v*, job_workflow_ref=<repo>/.github/workflows/release.yml@refs/tags/v*. Key policy: only that role may Sign; Sign denied to every other principal incl. admins. 9 assertion tests incl. no other stack template changes when on.
2. bundle.ts re-reads and hashes every kit file in the output folder immediately before signer.sign; refuses on any difference from kit.json or the manifest. 6 tests (5 fail without the call).
3. Release-workflow test joins `\` continuations and catches `|| true`; release:verify/kit/bundle package.json scripts must be one bare `tsx scripts/release/<name>.ts`, no pre/post hooks; negative controls.
4. Dev container path pattern (and browser copy) refuses `..` and `.` segments.
5. docs/enterprise/bundle-signing.md: owner's one-time steps (not done).
Gates: typecheck:all 0; strict lint pkg-contracts, infra, scripts, tests-contract b-c/p-r/s/d; tests listed in the hand-back pass; no template differences without the context key. synth-kit.test.ts was blocked by ENOSPC (re-run by controller).
Decisions/risks: repository is a required context value (release.yml's bundle job runs only where github.repository == 'PrepLabsAI/Rovara'); job_workflow_ref as an IAM condition key for GitHub OIDC confirmed only by a secondary source (fails closed if unsupported; sub still pins repo+tag); a v* tag carrying an edited release.yml would still get the role (tag ruleset + mainline protection are owner steps).
Needs Opus review: key policy and role trust, the signing step.
