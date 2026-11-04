# M3 READY — stop for controller review

2026-11-04. Branch `feat/admin-v11-finish`, private remote PrepLabsAI/Rovara-cloud. Controller: Claude session **abhishekgarg-37**. Task 1 M2 fixes: `c218dc6a6`; authorized integration merge: `8956d344e`. Task 2–3 review range: `8956d344e..HEAD` after the checkpoint commit. Read HANDOFF.md and DESIGN.md for the required-change map and policy semantics.

## Result

All nine required REVIEW-M2 items are addressed. The review projects real Continue: admitted-proof exemption only, new R38 windows, shared numeric identity including disabled-era requested limits, and real Continue tests. Emergency disable tolerates malformed money fields under a full-row fence; ready registrations seed inheritance; 100 tasks are counted with a priority-ordered 25-row list; readiness names checked resources; UI gives fixed actionable errors; sessions-ended request and commit races are covered. Disable requires a fresh sign-in and no second owner.

Merged exactly **fae38ff6f272596cb5a4099ee3fe48980d8461b2** from private integ/054 into this feature branch. The only conflict was the append in contracts/src/web.ts; both export blocks were retained. Post-merge `typecheck:all` passed once, with zero errors against the zero-error baseline.

Task 2: `POST /v1/app/projects/{project}/start-preview` reads current project work access, the project's actual process and planning path, and canonical stop sources. It uses `continueAdmissionIdentity` and `captureTaskStopAdmission`/`calculateTaskStop`, with no parallel arithmetic. The existing request-building read permits displaying zero; actual work admission still refuses zero. It writes no task, admission receipt, audit or key. Disabled/ready and uncertain funding show no amount. StartWorkBox's bounded, abortable request never blocks Start, and errors/unknown/malformed/late responses show nothing.

Task 3: Health and How we work links use the existing company-admin/web/admin-feature guards. Existing screens stay lazy and navigation fetches neither page's data.

Optional Task 4 is **inapplicable at the merged head**: there is no Send back control in the current React web session UI or server-rendered task page. The remaining button is Slack's shared workflow message. No change was made to the server gate, pageAccess/projectWorkAllowed or Ask/Fix panels. HANDOFF.md records the search scope and this skipped optional item.

## Gates — all passed

All heavy jobs used heavy.sh/vt sequentially. Vitest and Chromium used pinned Node 22.23.2; vitest maxWorkers=4; Chromium workers=1. No full-suite run.

| Gate | Scope | Result |
| --- | --- | --- |
| M2 fixes | Original 21 files, required typecheck/strict/lint/build/browser/map gates | 1262 tests; six Chromium journeys; all green before integration |
| M2 new mutations | admitted proof, requested identity, lenient disable, ready registration | 4/4 killed by assertions; restored run 4 files / 609 tests green |
| Post-integration full strict check | `heavy.sh npm run typecheck:all` (once) | 0 errors, baseline 0 |
| Required root typecheck | `heavy.sh npm run typecheck` | exit 0 |
| Owning strict typechecks | pkg-broker, pkg-contracts, tests-contract-t-z | all exit 0 |
| Changed-file lint | All changed/new TS/TSX, six owning groups | all exit 0 |
| Owning lint shards | `--list`, then `--only pkg-broker,pkg-contracts,tests-contract-t-z,web-ui,web-tests,web-e2e-tests` | 6/6 passed |
| Final affected tests | 15 named task-stop files plus audit-contracts, task-owner-reads, agent-lifecycle, contracts-web-entry, duplicate exports, web-bundle-budget, admin-budgets, start-work and admin-foundation | **24 files / 1346 tests passed** |
| Preview guard mutations | project work access and unknown funding | 2/2 killed by assertions; sources restored before final gates |
| Chromium | admin-spending.e2e.ts and project.e2e.ts | **10/10 passed**; light/dark axe and screenshots |
| Web build / budget | `build:web`; pinned Node `scripts/web-bundle-budget.ts` | exit 0; **185004 gzip bytes** |
| Inventories / hygiene | task-owner-reads, agent-lifecycle, web-safe-files, duplicate exports, codemap, diff check | all passed; only web-safe list needed a new contract entry |

Exact argv, exits and timings: local ignored `m3-final-gates.json`, `m3-mutations.json`, `m2-fixes-gates.json`, `m2-fix-mutations.json` and their logs. The Chromium fixture now supports a real native TransactGet snapshot so the preview journey exercises the broker calculator, not a fabricated amount. Intermediate test-fixture/type issues were corrected; no failing final gate remains.

## Bundle evidence

| Stage | Initial JavaScript, gzip bytes |
| --- | ---: |
| Original v0.5.3 base | 183820 |
| Historical M2 | 184564 |
| M2 required fixes | 184561 |
| After integ/054 merge | 185009 |
| After Task 2 | 185009 |
| Final, after Task 3 | **185004** |

Budget remains **256000**, headroom **70996**. Navigation adds no initial-bundle growth. No environment variable, IAM/default-boundary change, dependency or new switch was added.

Screenshots were visually inspected: the preview is beside the Start box, and both admin links fit the existing wrapping navigation. Local artifacts:

- [Preview light](/Users/abhishekgarg/web/Rovara-admin-v11-finish-20261104/.test-build/web-e2e/results/project.e2e.ts-an-enrolled-f4cc6-review-before-starting-work-chromium/start-preview-light.png)
- [Preview dark](/Users/abhishekgarg/web/Rovara-admin-v11-finish-20261104/.test-build/web-e2e/results/project.e2e.ts-an-enrolled-f4cc6-review-before-starting-work-chromium/start-preview-dark.png)
- [Admin navigation and enforcement review](/Users/abhishekgarg/web/Rovara-admin-v11-finish-20261104/.test-build/web-e2e/results/admin-spending.e2e.ts-owne-fdde8-backed-audited-transactions-chromium/enforcement-review-light.png)

## Stop

**STOP at M3. Await REVIEW-M3.md.** No product branch was merged, no public push, CI, AWS command, deployment, Docker/colima, stash or git config was run. CI/Linux verification remains with the controller's merge workflow.
