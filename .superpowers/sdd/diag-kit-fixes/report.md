# diag-kit-fixes report (lane: DG-1, DG-2, SK-1 leftovers, SK-3, SK-4)

Branch `fix/diag-kit-fixes` from private/cloud/next 5a519496e, worktree ~/web/Rovara-diag-kit-fixes-20261102. Two local commits, nothing pushed, no AWS call, `fd` stays OFF, no signing key created.

## Commits
| Commit | What |
|---|---|
| 86d96641a | Part A: diagnosis (DG-1 S1-S5, DG-2) |
| 9b064a7d0 | Part B: synthesis kit (SK-4 MUST, SK-3 minors 1-5) |

## Part A: failure diagnosis (switch fd)

### S1 org-wide cap, and the proxy-budget check
Finding first: **an org-only key DID land on the customer's budget.** `ModelProxyClient.mintKey` always sends `team_id = orgId`, and the org's LiteLLM team carries the customer's monthly `max_budget` (`upsertOrg`). The Rovara-paid light key ($0.25, no developer) was therefore counted in the customer's team spend (`orgSpend`/`team_info`), which is what the budget screens and `admitWork` read. (The existing test "mintKey without a developer mints an org-only key: a team, no user" shows the `team_id`.) Fixed, not just recorded:
- `MintKeyInput.rovaraPaid` (protocol.ts too). The key is minted under a fixed Rovara team `rovara-support` (`ROVARA_SUPPORT_TEAM_ID`), no user, models limited to the Rovara AI catalog (anything else refused), `orgId` kept only as key metadata (+ `rovaraPaid: true`) for Rovara's own accounting. The client creates the team on first use, limited to exactly the catalog (never empty = every model), and brings a stale one back to the catalog. `verifyMinted` now checks the key's team against the team it asked for; `auditKeys` treats a support-team key as valid when it holds to the catalog (the org label is not compared with the team).
- `mintChatTurnKey` passes `rovaraPaid: true` on the Rovara-pays branch only.
- Org-wide cap: `DIAGNOSIS_ROVARA_PAID_ORG_LIMITS = { turnsPerDay: 100, centsPerDay: 1500 }` (contracts). One more counter `DIAGNOSISRATE light_org#all` in the same admission transaction (Public only; Enterprise pays itself): `count` and `cents` (each turn counted at the key cap, 25 cents, because the chat service reports no cost). Either full refuses with new fixed words (`orgRateLimited`); the person and project limits are still answered in their own words first. The counter is Rovara's own record of the spend (`costCents` stays 0 in the customer-facing record); a `diagnosis.rovara_paid` log line carries the day total for an alarm. Override: `DiagnosisDependencies.rovaraPaidLimits`; no env variable (the env inventory test would need it registered).
- Tests (all fail without the code, see Mutations): `diagnosis-light.test.ts` "DG-1 S1" (5 tests), `model-proxy-client.test.ts` "DG-1 S1" (4), `model-key-checks.test.ts` audit (1), `diagnosis-rovara-pays.test.ts`.
- NOT verified against a real LiteLLM (only the fakes): team creation with `models` and no `max_budget`, `/key/generate` under that team. Check on the staging rehearsal. Deploy needs both the broker and the model-access function (the client runs there).

### S2 dev container path
- Allow-list row `setup_item devcontainer.configPath` now uses the setup proposal's pattern (`DIAGNOSIS_DEVCONTAINER_PATH_PATTERN`, a browser-safe copy; a test keeps it equal to `DEVCONTAINER_PATH_PATTERN`). A model-written `scripts/ci/devcontainer.json` or `package.json` is dropped at read and refused again at the press.
- The press checks the file exists in the container's repository at the head of its default branch, read now: new port `readDefaultBranchFile` (`diagnosis/default-branch-file.ts`: getRepositoryIdentity -> getDefaultBranchHead -> getFileAtCommit). Missing, unreadable, no reader, repository not the project's: refused with fixed words, nothing applied.

### S3 press bound to the change shown
The body now carries `target`, `path`, `from`, `to` (required, strict); the broker compares them with the stored proposal at `index` and refuses any difference (`notShown`). Chosen over a digest because the screen already shows from -> to, so F5 echoes what it shows. Old clients sending only `{requestId, index}` are refused (F5 is unbuilt).

### S4 held deep start
`heldPreparationOptions(task, held)` (continue.ts): setup-draft preparation for `purpose` `setup_draft` OR `diagnosis`. Unit-tested on the function; a full held-start integration test was not built (the held path needs the spend-request world).

### S5 erased person's name in model text
`eraseDiagnosisPerson` now deletes the RECORD and REQUEST of every diagnosis the person asked for (and lets go of the error's open place), then the PERSON row, then the index item. A waiting answer arriving later writes nothing (the settle is conditional on the request). Register note in `person-fields.ts` corrected. Limit: a teammate's name in a diagnosis someone ELSE asked for stays (<= 30 days); the model text is not scanned for names.

### DG-2 (owner-visible, "Replaces: the design's pending change card")
`DIAGNOSIS_APPLY_BUTTON_LABEL = "Apply this change"` (contracts) for F5 (not built); every "Propose this change" in code comments, docs/day-two.md and tests became "Apply this change". The design file `live-interaction.md` (outside this worktree) still says "Propose this change"/"pending change": the controller should edit it.

## Part B: synthesis kit

### SK-4 (MUST before any signing key exists)
- `kit.json` has a required `files` map: SHA-256 of every other kit file (the entry, `code-map.json`, `code/<64 hex>.zip`); the key pattern `KIT_FILE_PATH` allows nothing else (closes Opus minor 1). `buildSynthKit` writes it after the kit is finished.
- `bundle.ts`: refuses a file kit.json does not list, a listed file that is missing, and a file whose bytes as COPIED into the bundle differ from the listed hash (so a change during the copy is caught too). Then runs `kitCheck` on the COPY it is about to sign (`out/synth-kit`), default `verifyKitForSigning`: checkout is the release commit and clean (see below) and `selfCheck` again in the sandbox (refuses without one; the bundle CLI has no unsandboxed flag). A failure removes the output folder. `kitCheck` is an injectable dependency like `signer`/`exportImage`; release:bundle never passes one; tests with fake kits pass `NO_KIT_CHECK`. The real kit test (synth-kit.test.ts) runs the real check.
- Release-workflow test now catches: `|| true` or any `||`, `;`, `&` after the verify/kit/bundle commands; `continue-on-error` on the job or any of its steps; a `shell:` override or `set +e` in the signing steps; the gating commands each appear once and start their line; `npm ci` then `npm run build` precede the kit step; `--allow-unsandboxed-check` in ANY package.json script or workflow file. Mutations of each were seen failing.
- `scripts/release/source-state.ts` (moved out of synth-kit.ts; still re-exported there): `assertSourceIsRelease` (kit) and `releaseCommitOfCleanTree` (build.ts main, was a bare `git rev-parse HEAD`) both now require a clean tree AND (a) no ignored file outside the build-output/tooling allow-list (`isExpectedIgnoredPath`) and (b) every gitignored `dist/` has an output newer than its newest tracked source. This is what "also cover the gitignored dist/" means here. **Residual, stated plainly:** a `dist/` file edited by hand AFTER the build has a newer time and passes; only a fresh `npm ci && npm run build` (which both CI jobs do, and the workflow test now pins) proves dist equals source. Hash-stamping the build output would close it but changes `npm run build`; not done.

### SK-3
- **Dedupe of the twice-carried code packages: NOT built, by design.** It cannot be done without breaking the kit contract. The kit gets the zips from `kitDir/code/` because the sandbox lets it read only its own folder; the approval checks (`collect()`) require the kit to WRITE `packages/<id>.zip` and compare those bytes with the signed ones (review I3: independent evidence that the kit made no code). Removing `code/` needs one of: (a) the kit stops writing `packages/` and `collect()` reads the verified copy (SynthOutputSchema, build-at-approval, entry.ts, prebuilt-code, 6 test files with fake kits change, and the I3 comparison disappears), or (b) the runner gets a second readable folder (macOS profile, bwrap args, Node permission flags in synth-run.ts, and the release self-check needs a bundle-shaped layout). Cost left in place: about 60 MB per bundle. Register as follow-up with "Replaces: the kit writes packages/".
- Opus minors: 1 done (SK-4); 2 done (approval summary line "CDK's own template validation was not run for this build..."); 3 done as a comment (profiles.ts: the live-test environment is not covered); 4 done (stand-in throws on `awsSdkConnectionReuse`, test `synth-kit-prebuilt.test.ts`); 5 done as a comment (profile values not covered: `agentxAuditTsa`, `rovaraEnterpriseInternetEgress`); 6 is docs only (determinism proves one machine and one Node patch version).

### SK-1 leftovers (confirmed against the re-check and the code)
| Item | State |
|---|---|
| B1 kit tied to release commit and release.json hash | Done (kit.json releaseSha256/gitCommit; bundle.ts and approval refuse; HEAD+clean check). Now also build.ts (above) and kit file hashes. |
| B2 self-check in the release workflow | Done in release.yml `bundle` job; the hand-run gap (N1) is closed by SK-4; the `|| true`/continue-on-error gap closed by the workflow test. |
| S2 deployer tolerant of additive fields | Done (`parseReleaseManifestIgnoringUnknownFields`, bundle-deployer tests re-run green). Rule stays: a field that MUST be deployed needs a schemaVersion bump. |
| S3 no unsandboxed networked self-check | Done; flag in package.json now tested. |
| S4 duplicate packages | SK-3 above. |
| S5 selfCheck test through buildSynthKit | Done (synth-kit.test.ts, re-run green). |

## Wiring pending (hot file)
None pending. Small edits made in split modules: `aws/broker/handler.ts` one import and one spread line `...diagnosisDefaultBranchFileRoute(dependencies)` beside `setupCitationReader`; optional `defaultBranchFileReader` on `DeveloperRouteDependencies` (types.ts) and `readDefaultBranchFile` in the diagnosis propose ports (dependencies.ts).

## Blocked on owner
Nothing new. Decisions to see: (1) DG-2 wording and that Apply is immediate; (2) org cap defaults 100 turns / $15 a day per org, raise by code change; (3) the new `rovara-support` team in the proxy (a Rovara-side team that carries all Rovara-paid diagnosis spend; first use creates it); (4) erase now deletes diagnoses the person asked for.

## Risks
- Proxy change is verified with fakes only; real LiteLLM behaviour (team without a budget, key under it, `/key/list` audit) must be seen on staging before `fd` is on.
- `kit.json` now requires `files`; kits made before this change are refused (none has shipped).
- `source-state` allow-list may refuse a developer's local build that has other ignored files; CI is unaffected. The kit step on a dev Mac needs a built, clean, release-commit checkout as before.
- The press body change breaks any client built to the old shape (F5 not built).

## High-risk, needs an Opus review
All of Part B signing path (`bundle.ts`, `synth-kit.ts` verifyKitForSigning, `source-state.ts`, `release.yml` test); Part A money/tenancy (`model-proxy/client.ts` support team, `store.ts` org cap), propose (`propose.ts` S2/S3), erasure (`store.ts` eraseDiagnosisPerson).

## Mutations (each applied, the named tests failed, then restored; `git status` clean after)
Part A, one combined run of 11 mutants (10 tests failed, each mutant killed by its own test): S3 compare removed -> "a press whose target, path, from or to differs..."; S2 missing-file allowed and reader optional -> "the file must be in the container's repository..." (the two mutants share one test); S2 allow-list back to any relative path -> "checks the value of an allowed path" (live-interaction-contracts); S1 dollar ceiling ignored -> "the dollar ceiling holds on its own"; S1 cap not passed by the start -> "an open diagnosis..." and "Public counts its turns by default"; S5 RECORD and REQUEST deletes removed -> "DG-1 S5: removes every diagnosis..."; S1 key under the org team -> "mints under the support team..."; S1 broker not asking for the support team -> diagnosis-rovara-pays "is let through unmetered..."; S4 held diagnosis not prepared as setup draft -> "is prepared as the setup draft's read-only preparation is...". Not mutated: the turns-per-day half of the org cap (its test exists).
Part B (earlier runs): bundle.ts without verifyKitCopy / extra-file check / missing-file check / the kitCheck call / with a no-op default check (5 mutants, 1-3 tests each); source-state without the build check in the kit step, in the release build, stale detection off, ignored-file allow-list off (4 mutants); build.ts back to a bare rev-parse (the "release build command stops on a dirty checkout" test failed); release.yml with `|| true`, with continue-on-error, package.json with the flag (each failed the workflow test); prebuilt-code without the awsSdkConnectionReuse refusal; build summary without the CDK-validation line.

## Gates
- `tsc -b`: clean (run after each Part A/B change).
- ESLint on the 44 changed .ts files: clean after fixing 2 unnecessary assertions in bundle.ts (re-run on the files changed since).
- Strict lint shards: pkg-contracts, pkg-cli, pkg-broker, scripts: all passed (scripts after the fix).
- `tests/egress/outbound-hosts.test.ts` and `tests/contract/broker-environment-provided.test.ts`: 16/16 pass (with a web dist built at the start of the lane; the contracts change does not touch the web build).
- Inventory and switch tests: task-owner-reads, task-owner-reads-bypass, agent-lifecycle, broker-settings, role-sites, live-fix-switch, live-interaction-deploy-gate, contracts-web-entry: pass. (No new broker read of a task, env variable, route or switch was added; the new GitHub reads go through the existing installation scope.)
- Part A: diagnosis-* (10 files), slack-diagnosis, slack-diagnostics-infrastructure, live-interaction-contracts, team-record-core erase/person-fields/erase-race, model-proxy-client, model-key-checks, model-access-invoker/handler, model-proxy-sources: 473 tests pass (after updating two live-interaction-contracts expectations for the dev container pattern).
- Part B: `synth-kit.test.ts` + `release-enterprise-packages.test.ts` (real release, real kit, real signed bundle through `verifyKitForSigning`, real approval): 38/38 pass in 345 s. 22 other release/bundle files: 336/341 in one parallel run; the 5 failures were the kit-entry schema test (fixed: it builds a manifest without `files`) and four release-build/release-verify tests that run real release builds, which passed when re-run alone with `--maxWorkers=1` (release-verify, bundle-approve-build, release-build: 62/62). Treat the four as load/parallelism, not a regression, but CI should confirm.
- NOT run (per the lean process): full suite, typecheck:all, other browsers, Linux (the bubblewrap path of the kit check is unexercised here; the workflow installs it).

## Suggested register updates (for the controller; I did not edit the register outside this worktree)
- DG-1: S1-S5 done in 86d96641a; add "S1 needs a staging check of the `rovara-support` team in the real proxy before fd"; add "S5 limit: other people's diagnoses can still name an erased person (<= 30 days)".
- DG-2: label constant in; F5 must use `DIAGNOSIS_APPLY_BUTTON_LABEL`; design file live-interaction.md still says Propose/pending.
- SK-4: done (9b064a7d0), residual: dist edited by hand after the build is not detected.
- SK-3: S4 stays NOT built, reason above; minors 1-5 closed.
