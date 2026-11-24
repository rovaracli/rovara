// Rovara Code's REAL answers, for the Cloud routes that read them (audit-cloud-20261118, the Cloud<->Code shape mismatches). Each one below was produced by Code's own
// handler code on the batch-17 tree (PrepLabsAI/Rovara pr/batch-20261118-mega17 at 4cc51b895; the same shapes are on code/next 250282ac2, 0.5.27), not written by hand:
// a test here that reads one of them fails when Cloud drifts from what Code really sends. When Code changes a shape, regenerate the constant from Code's code, never edit it
// to make a Cloud test pass.
//
// Over HTTP, Code's deployed broker adds its own trace id to every `/v1/dev/*` object answer (`packages/broker/src/aws/broker.ts` json(): `{ ...value, requestId }`);
// `devAnswer` adds it the same way. `/v1/app/*` answers from the core host carry none.

/** Code's broker wrapping of a `/v1/dev/*` answer (aws/broker.ts json()), exactly. */
export function devAnswer<T extends object>(value: T, requestId = "0f6c2a7e-6d1b-4f7b-9a43-2b8f6c1d9e10"): T & { requestId: string } {
  return { ...value, requestId };
}

/**
 * `GET|PUT /v1/dev/company/engine-model`: Code's CompanyEngineModelView. Copied from Code's tests/contract/company-engine-model-routes.test.ts (the read and the save
 * answers, which that test reads after taking the broker's `requestId` off: `viewOf`).
 */
export const ENGINE_MODEL_READ = { model: "claude-sonnet-5-5", source: "install", offered: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], preselect: "claude-sonnet-5-5" } as const;
export const ENGINE_MODEL_SAVED = { model: "zai.glm-5", source: "company", offered: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], preselect: "zai.glm-5" } as const;

/**
 * `GET|PUT /v1/dev/company/learning-model` (Code #1075, DEC 254zzz63): Code's CompanyLearningModelView and its refusals. REAL answers: produced by Code's own route handler
 * (packages/broker/src/aws/company-learning-model-routes.ts) through Code's real developer dispatcher, membership reader and SDK double (tests/support/company-route-harness.ts),
 * in a fresh clone of PrepLabsAI/Rovara at 5b79579a3 (the head of #1075), by running that file's own `world()` scenarios and writing each raw answer down; not written by hand.
 * The harness answers its own trace id ("company-test"), which is taken off here; `devAnswer` adds one the way the deployed broker does. Two companies: A's gateway lists
 * Sonnet 5.5 and Haiku 5.5 (plus models that are not Claude, which Code leaves out), B's lists Haiku 4.5 and Sonnet 5.5. The install default is Claude Haiku 5.5.
 * Regenerate from Code's code when the route changes, never edit to make a Cloud test pass.
 */
export const LEARNING_MODEL_READ_INSTALL = {"model": "claude-haiku-5-5", "source": "install", "offered": ["claude-sonnet-5-5", "claude-haiku-5-5"], "preselect": "claude-haiku-5-5"} as const;
export const LEARNING_MODEL_SAVED = {"model": "claude-sonnet-5-5", "source": "company", "offered": ["claude-sonnet-5-5", "claude-haiku-5-5"], "preselect": "claude-sonnet-5-5"} as const;
export const LEARNING_MODEL_CLEARED = {"model": "claude-haiku-5-5", "source": "install", "offered": ["claude-sonnet-5-5", "claude-haiku-5-5"], "preselect": "claude-haiku-5-5"} as const;
/** The default is not offered to the company (only Sonnet is): the first offered model is preselected. */
export const LEARNING_MODEL_DEFAULT_NOT_OFFERED = {"model": "claude-haiku-5-5", "source": "install", "offered": ["claude-sonnet-5-5"], "preselect": "claude-sonnet-5-5"} as const;
/** No Claude model is offered at all: `offered` is empty and `preselect` is null. */
export const LEARNING_MODEL_NONE_OFFERED = {"model": "claude-haiku-5-5", "source": "install", "offered": [], "preselect": null} as const;
/** The install's own setting is broken: `model` is null. */
export const LEARNING_MODEL_INSTALL_BROKEN = {"model": null, "source": "install", "offered": ["claude-sonnet-5-5"], "preselect": "claude-sonnet-5-5"} as const;
/** Company B (its own gateway list) reading, and then saving Haiku 4.5, while company A had saved Sonnet 5.5. */
export const LEARNING_MODEL_OTHER_COMPANY_READ = {"model": "claude-haiku-5-5", "source": "install", "offered": ["claude-haiku-4-5", "claude-sonnet-5-5"], "preselect": "claude-haiku-4-5"} as const;
export const LEARNING_MODEL_OTHER_COMPANY_SAVED = {"model": "claude-haiku-4-5", "source": "company", "offered": ["claude-haiku-4-5", "claude-sonnet-5-5"], "preselect": "claude-haiku-4-5"} as const;
/** Code's refusals, as `{ status, body }` (the body is Code's `{ error: { code, message } }`). */
export const LEARNING_MODEL_REFUSALS = {
  notOffered: { status: 400, body: {"error": {"code": "CONFIG_INVALID", "message": "That model isn't a Claude model offered to this company now. Pick one from the list."}} },
  bodyInvalid: { status: 400, body: {"error": {"code": "CONFIG_INVALID", "message": "Send the Claude model lessons should learn with, as { \"model\": \"<model id>\" }, or { \"model\": null } to use this Rovara's default."}} },
  member: { status: 403, body: {"error": {"code": "FORBIDDEN", "message": "Only a company owner or admin can change the model lessons learn with."}} },
  listUnavailable: { status: 503, body: {"error": {"code": "RUNTIME_UNAVAILABLE", "message": "The AI models this company can use could not be read just now; nothing was changed. Try again in a moment."}} },
  settingUnavailable: { status: 503, body: {"error": {"code": "RUNTIME_UNAVAILABLE", "message": "The company's learning model setting could not be read or saved just now; try again."}} },
  notWired: { status: 404, body: {"error": {"code": "NOT_FOUND", "message": "route not found"}} },
  signedOut: { status: 401, body: {"error": {"code": "AUTH_REQUIRED", "message": "your AgentX sign-in has ended; run agentx login <url> again"}} },
} as const;

/**
 * `GET .../archive-preview`, `POST .../archive`, `GET .../restore-preview`, `POST .../restore` on `/v1/dev/client/projects/{p}`: copied from Code's
 * tests/contract/project-lifecycle-routes.test.ts (its `toEqual` answers; the company and the time are that test's, the company id is a parameter here).
 */
const CHECKED_AT = "2026-11-17T12:00:00.000Z";
export const archivePreview = (orgId: string, project: string) => ({
  orgId, project, status: "active", expectedRevision: 0, expectedProjectRevision: 1, checkedAt: CHECKED_AT, access: { actions: ["archive"] },
  impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 0, slackChannelsStayLinked: true, deletesNothing: true },
});
export const archiveOutcome = (orgId: string, project: string) => ({
  receipt: { project, status: "archived", revision: 1, projectRevision: 1, archivedAt: CHECKED_AT, egressReconciliation: "pending" },
  replayed: false,
  current: { orgId, project, status: "archived", expectedRevision: 1, expectedProjectRevision: 1, checkedAt: CHECKED_AT, access: { actions: [] }, impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 0, slackChannelsStayLinked: true, deletesNothing: true } },
  effects: { egress: "not_attempted", archiveHook: "not_configured" },
});
export const restorePreview = (orgId: string, project: string) => ({
  orgId, project, status: "archived", expectedRevision: 1, expectedProjectRevision: 1, checkedAt: CHECKED_AT, prerequisites: "not_required", access: { actions: ["restore"] },
  impact: { allowsNewWork: true, linkedSlackChannels: 0 },
});
export const restoreOutcome = (orgId: string, project: string) => ({
  receipt: { project, status: "active", revision: 2, projectRevision: 1, restoredAt: CHECKED_AT, egressReconciliation: "pending" },
  replayed: false,
  current: { orgId, project, status: "active", expectedRevision: 2, expectedProjectRevision: 1, checkedAt: CHECKED_AT, prerequisites: "not_required", access: { actions: [] }, impact: { allowsNewWork: true, linkedSlackChannels: 0 } },
  effects: { egress: "not_attempted" },
});

/**
 * `GET /v1/dev/tasks/{t}/plan` (PLANFULLDOC): `{ plan: TaskPlanDocumentView }`. Generated by Code's own `readTaskPlanDocument` (aws/task-plan-document.ts) over Code's
 * test plan `planDocument()` (tests/support/plan-documents.ts) with one proposed check, stored as a structured plan artifact. Its taskId is a parameter.
 */
const PLAN_VIEW = {"taskId": "8b579b4b-eaa7-4bf2-87bc-0123456789ab", "document": "plan", "version": 1, "sha256": "835be5961ba49a236ad31be7b7d2c5b2c5a016e26c45eefa9376452cdea41aff", "approved": false, "current": true, "versions": [1], "content": {"schemaVersion": 1, "title": "Retry failed payments", "why": [{"text": "Failed payments are dropped without a retry.", "author": "Priya"}], "claims": [{"id": "1", "text": "Payments that fail with a timeout are retried.", "evidence": [{"kind": "code", "path": "payments/src/charge.ts", "startLine": 10, "endLine": 24, "note": "Today a timeout throws."}], "children": [{"id": "1.1", "text": "The retry waits longer each time."}]}, {"id": "2", "text": "A payment is never charged twice."}], "notChanging": ["The refund flow stays as it is."], "risks": ["A slow gateway could keep a retry open for a long time."], "decisions": [{"id": "d1", "claimId": "1", "question": "How many times should a payment be retried?", "options": [{"id": "three", "label": "Three times", "consequence": "Most timeouts clear by the third try."}, {"id": "five", "label": "Five times", "consequence": "Customers wait longer before seeing a failure."}], "recommended": "three"}], "checks": {"proposed": [{"id": "proposed-2", "label": "Unit tests", "command": {"cwd": "repo/app", "executable": "npx", "args": ["vitest", "run"], "timeoutSeconds": 120}}], "proves": {"proposed-2": ["2"]}, "expectOnBase": {"proposed-2": "fail"}}}, "summary": {"scenarios": [], "checks": [{"checkId": "proposed-2", "label": "Unit tests", "does": "runs npx vitest run", "builtin": false, "proves": ["claim 2"], "expectedOnBase": "fail", "direction": "should fail now and pass after the change", "line": "Check \"Unit tests\" runs npx vitest run; proves claim 2; should fail now and pass after the change"}], "decisions": [{"id": "d1", "question": "How many times should a payment be retried?", "answer": "Three times"}], "lines": ["Check \"Unit tests\" runs npx vitest run; proves claim 2; should fail now and pass after the change"], "findingSentences": [], "selfCheckLines": ["Not checked by AgentX's plan check."]}} as const;
export const taskPlanAnswer = (taskId: string = PLAN_VIEW.taskId) => ({ plan: { ...PLAN_VIEW, taskId } });

/** `GET /v1/dev/tasks` (developer-tasks.ts listTasks): one row of Code's list is DeveloperTaskListItemSchema's fields, nothing more; a full page carries `nextCursor`. */
export const taskListRow = (taskId: string, over: Partial<{ title: string; project: string; status: string; shared: boolean; createdAt: string; updatedAt: string }> = {}) => ({
  taskId, title: "Retry failed payments", project: "payments", status: "SUCCEEDED", shared: false, createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T11:00:00.000Z", ...over,
});

/**
 * `POST /v1/dev/tasks/{t}/people/take-ownership` answering PENDING: `{ change: TaskPeopleChangeResult }` (contracts task-people.ts TaskPeopleChangeResultSchema, its PENDING
 * branch, strict), as developer-tasks.ts returns `{ change: await proposeTaskOwnership(...) }`.
 */
export const takeOwnershipPending = (taskId: string, requestId: string) => ({
  change: { status: "PENDING", requestId, confirmationUrl: `https://code.example.test/review/${taskId}/task/people/confirm/${requestId}`, expiresAt: "2026-11-17T12:10:00.000Z" },
});

/**
 * `GET /v1/dev/client/projects/{p}/setup-status` and `PUT .../setup-status/eval-none`: generated by Code's own route (developer-routes.ts routeClientSetupStatus) in Code's
 * tests/contract/project-setup-status-routes.test.ts harness: a failed run whose output has TAB-indented lines, and a project an admin marked "no evals".
 */
export const SETUP_STATUS_FAILED_WITH_TABS = {"project":"alpha","viewer":{"companyRole":"admin","projectAdmin":false,"canSkip":true},"progress":{"done":2,"total":8,"percent":25,"nextRequired":"setupRun"},"repos":{"state":"done","count":1,"items":[{"name":"api","defaultBranch":"main","fullName":"acme/api"}]},"setupRun":{"state":"failed","status":"failed","approval":"none","startedAt":"2026-11-17T11:58:00.000Z","elapsedMs":91000,"costCents":37,"commandsRun":4,"partial":true,"stop":"attempts_used","testOutcome":"unknown","failure":"Rovara used up its tries before the setup worked. The commands it ran are kept.","failedCommand":{"n":1,"command":"npm test","exitCode":1,"timedOut":false,"lastLines":["FAIL src/a.test.ts","\texpected 1 to be 2","\tat src/a.test.ts:4:7"]}},"evalConfirm":{"state":"needs_you","report":"none","blockedBy":"setupRun"},"aiAndSpend":{"state":"done","source":"default","companyModelSaved":false,"modelBudgetUsd":null},"slackChannel":{"state":"optional","channels":[]},"linear":{"state":"optional","team":null},"invites":{"state":"optional"},"firstTask":{"state":"needs_you","hasTask":false,"canStart":false}} as const;
export const SETUP_STATUS_NO_EVALS = {"project":"alpha","viewer":{"companyRole":"admin","projectAdmin":false,"canSkip":true},"progress":{"done":4,"total":8,"percent":50,"nextRequired":"firstTask"},"repos":{"state":"done","count":1,"items":[{"name":"api","defaultBranch":"main","fullName":"acme/api"}]},"setupRun":{"state":"done","status":"ready","approval":"approved","check":{"status":"ready"},"approvedAt":"2026-11-17T11:59:00.000Z","startedAt":"2026-11-17T11:58:00.000Z","elapsedMs":91000,"costCents":37,"commandsRun":4,"partial":false,"stop":"proposed","commandsFound":{"setup":1,"tests":1},"testOutcome":"unknown"},"evalConfirm":{"state":"done","report":"no_evals","noEvals":{"confirmedAt":"2026-11-17T12:00:00.000Z"}},"aiAndSpend":{"state":"done","source":"default","companyModelSaved":false,"modelBudgetUsd":null},"slackChannel":{"state":"optional","channels":[]},"linear":{"state":"optional","team":null},"invites":{"state":"optional"},"firstTask":{"state":"needs_you","hasTask":false,"canStart":true}} as const;
export const SETUP_EVAL_NONE_ANSWER = {"project":"alpha","noEvals":true,"taskId":"11111111-1111-4111-8111-111111111111"} as const;

/**
 * `GET /v1/app/projects/{p}/setup-agent` with a waiting candidate that adds a prompt location (L4-EVP): generated by Code's core host (core-host/setup-run-routes.ts) in Code's
 * tests/unit/core-host-setup-approval.test.ts harness ("L4-EVP: prompt locations in a setup candidate").
 */
export const SETUP_AGENT_WITH_PROMPT_LOCATIONS = {"status": "none", "basedOnRevision": 1, "limits": {"commands": 40, "sameStepTries": 3, "wallClockMin": 45, "budgetCents": 400, "hostAsks": 5}, "canManage": true, "apply": {"candidateRevision": 2, "baseRevision": 1, "setup": ["npm ci"], "readiness": ["npm test"], "promptLocations": ["demo/deskbot/agent.py: function DeskAgent.build_contents"], "check": {"status": "ready"}, "risk": "medium", "changes": [{"area": "prompt_locations", "risk": "medium"}], "approver": "maintainer", "canApprove": true, "canReject": true, "approval": {"requestId": "setup-3bcd3535887874bfb2e0e0c816654b419cccc674-2", "revision": 2, "artifactDigest": "3bcd3535887874bfb2e0e0c816654b419cccc674f8a405043634f03146aba4b3", "kind": "setup", "risk": "medium"}}} as const;

/**
 * `GET /v1/app/projects/{p}/test-environment` on the hosted core (core-host/dev-routes.ts testEnvironmentAnswer): generated in Code's
 * tests/unit/core-host-test-environment-route.test.ts harness (hosted Code, nothing set).
 */
export const TEST_ENVIRONMENT_HOSTED = {"project": "payments", "enabled": true, "testServices": false, "testServicesUnavailable": "Test services not available here: this install's workers cannot start them yet", "serviceCatalog": {"name": "owner-starter-list", "entries": [{"id": "mongodb@7", "family": "mongodb", "version": "7"}, {"id": "mysql@8", "family": "mysql", "version": "8"}, {"id": "postgres@16", "family": "postgres", "version": "16"}, {"id": "postgres@17", "family": "postgres", "version": "17"}, {"id": "redis@7", "family": "redis", "version": "7"}]}} as const;

/** `GET /v1/dev/projects/{p}/lessons/measure` (lessons/measure.ts readLessonMeasure), generated over an empty store: Code says `revertDetection: "wired"`. */
export const LESSON_MEASURE = {"project": "payments", "windowDays": 30, "floor": 0.35, "loads": 0, "lessonsInUse": null, "loadedLessons": 0, "loadedBelowFloor": 0, "loadsWithBelowFloor": 0, "loadedNoMatch": 0, "meanWordsLoaded": null, "meanWordsLeftOut": null, "loadsCapBound": 0, "leftOutAtOrAboveFloor": 0, "meanFitLoaded": null, "meanFitLeftOut": null, "cleanMerge": {"merged": 0, "reverted": 0, "clean": 0, "rate": null}, "revertDetection": "wired", "truncated": false, "unreadable": 0} as const;

/** Code's wiki-build end word and sentence for a nightly refresh stopped at the upkeep limit (contracts wiki-build.ts WIKI_BUILD_END_WORDS and its sentence table). */
export const WIKI_UPKEEP_PAUSED = { stop: "upkeep_paused", message: "Nightly upkeep reached its spending limit, so the wiki refresh paused. It kept the pages it finished." } as const;
