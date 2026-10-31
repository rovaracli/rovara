// Plan 5 Task 12a (hardened in its review): the inventory of every read of a task's owner, as an allowlist. A TypeScript pass (tests/support/task-owner-scan.ts) over
// `packages/broker/src` and `packages/contracts/src` finds each read of the creator's fields (`developerId`, `developerName`, `slackUserId`, `provider`), of
// `ownerKey` and of `startedBy` on an expression typed as a `DeveloperTaskRecord` (or a `Pick` of it), through `.x`, `?.x`, `["x"]` and destructuring, whatever the
// variable is called; the same reads on an item, a record, `any` or `unknown` that looks like a task (named for one, or in a function that loads a task row); plus every
// `taskOwnerKey(` call, every `taskCreator` option and every raw read of `currentOwner`. Each hit must match a row below by file, function (the enclosing named
// functions, outermost first, and `#2` for a second function of one name) and field, with its class. A new read that is not in the table fails here: classify it
// (and, if it carries authority, make it CALL `effectiveTaskOwner` or a sibling, in its function) before it ships. `task-owner-reads-bypass.test.ts` proves the bypasses fail.
//
//   authority     decides whose authority, approvals or standing a step, a decision or a dispatch uses: must reach `effectiveTaskOwner` (or a sibling) in its function
//   owner-actor   asks "is this actor the owner?": must reach the owner functions in its function
//   attribution   names or mentions the owner to people: must reach the owner functions in its function
//   index         keeps the creator's task-list row and the owner's: must reach the owner functions in its function
//   principal     the task's workspace identity, object prefixes, idempotency keys and shared-thread bindings: never changes
//   history       what was true when something was written (a start message, a turn record, a stored identity)
//   money         whose budget pays: a take-over writes the payer explicitly (Task 12b), so these keep reading the creator
//   caller-actor  turns a named person into an actor id; it decides nothing about who owns the task
//   shape         validates the shape of a stored row; it decides nothing
//   other-record  a field of a row that is not a task, read where the scan took it for one
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { guardedRoots, problemsOf, programOf, rowsOf, scanProgram, sourceFiles, type Hit, type Root, type Row } from "../support/task-owner-scan.js";

const ROWS: readonly Row[] = [
  ["model-selection/turn-authority.ts", "readTurnActorChecks", "authority", ".developerId"],
  // C53: fallback authorization checks the effective owner's membership and fences the immutable creator identity; both run through effectiveTaskOwner/ownerFenceOf.
  ["model-selection/authorize-fallback.ts", "prepareTaskModelAuthorization", "authority", ".developerId*2"],
  ["agents/write-gate.ts", "executeWrite", "principal", ".ownerKey*2"],
  // Plan 4: a cancel's idempotency key (read by a chain to find that its cancel of a step's task was taken, and built by the task cancel) is made from the task's principal (`ownerKey`) and its workspace; it never changes
  ["chains/runner.ts", "endedByOwnTimeoutCancel", "principal", ".ownerKey*2"],
  ["developer/task-records.ts", "taskActionRequestKey", "principal", ".ownerKey"],
  // a take-over (Plan 5 Task 12b): the default payer of a task that recorded none is its creator's (money, as in `paymentOfTask`; the take-over then writes it explicitly), and the
  // creator's task-list row is the one the taker's row is copied from (it calls `ownerFenceOf` for the owner the write is fenced on)
  ["agent-sessions/take-over.ts", "payerOfSession", "money", ".developerId"],
  // Plan 6 Task 11: how many parts of an approved plan may build at once is the room left in the creator's and the organization's workspace counts (the creator's own charge keys), so it reads the creator like the other money reads; it never grants authority
  ["aws/developer-tasks/workflow-inputs.ts", "partsSettingOf", "money", ".developerId", ".slackUserId"],
  ["aws/developer-tasks/workflow-inputs.ts", "partsDecisionOf", "money", ".developerId", ".slackUserId"],
  ["rovara-code/parallel-parts.ts", "parallelPartsDecision", "money", ".developerId", ".slackUserId"],
  ["agent-sessions/take-over.ts", "registerSessionTakeOverApprovals", "money", ".developerId"],
  ["agent-sessions/take-over.ts", "taskItems", "index", ".developerId*2"],
  // a merge (Plan 5 Task 21): whether a person's task-list row is a taker's copy, which moves with them (it asks the owner functions)
  ["developer/task-records.ts", "holdsTaskByTakeOver", "index", ".developerId"],
  ["spend/payer.ts", "paymentOfTask", "money", ".developerId*2", ".startedBy"],
  ["developer/task-person-identity.ts", "resolveTaskPickerPerson", "history", ".developerId*2", ".provider*2", ".slackUserId*2"],
  ["developer/task-person-identity.ts", "registerTaskChannelPeople", "history", ".developerId*2", ".provider*2", ".slackUserId*2"],
  ["developer/task-person-identity.ts", "checkTaskPersonIdentity", "history", ".developerId*3", ".provider*3", ".slackUserId*6", ".developerName"],
  ["developer/task-people.ts", "loadTask", "shape", ".developerId"],
  ["developer/task-people.ts", "taskRowCondition", "principal", ".developerId"],
  ["developer/task-people.ts", "initialize", "owner-actor", ".developerId*3"],
  ["developer/task-people.ts", "reconcile", "owner-actor", ".developerId"],
  ["developer/task-people.ts", "resolveTaskPeopleAccess", "owner-actor", "taskOwnerKey()"],
  ["developer/task-people.ts", "resolveTaskDispatchPeople", "owner-actor", ".developerId", "taskOwnerKey()"],
  ["aws/task-dispatch-access.ts", "guardTaskDispatchCore", "owner-actor", "taskOwnerKey()"],
  ["aws/developer-tasks/thread-notes.ts", "planWhyEntries", "attribution", ".developerName*2", ".developerId"],
  ["aws/developer-tasks/access.ts", "authorizeTaskAction", "caller-actor", "taskOwnerKey()"],
  // the session actor of a stop or retry (Plan 5 Task 13): a person's actor id on a task that is not theirs; it decides nothing about who owns it
  ["aws/developer-tasks/access.ts", "sessionActorAccess", "caller-actor", "taskOwnerKey()"],
  // Plan 6 Task 5: a person's answers to Understand's questions are recorded under their actor id on the task (the route checked that they may answer); it decides nothing about who owns the task
  ["aws/developer-tasks/thread-notes.ts", "answerIntentFromReply", "caller-actor", "taskOwnerKey()"],
  ["rovara-code/questions.ts", "answerIntentOnSession", "caller-actor", "taskOwnerKey()"],
  // the test proof is read from the task's own object prefix (`private/<ownerKey>/<workspace>/<operation>/`): the task's principal, never changes
  ["developer/test-proof-lines.ts", "loadTestProofLines", "principal", ".ownerKey"],
  ["rovara-code/test-proof-reader.ts", "loadTestProof", "principal", ".ownerKey"],
  // Plan 6 Task 13: the object prefix of the task's own diff artifact (`ownArtifactKey`): the task's principal, never changes
  ["aws/developer-tasks/task-view.ts", "candidateChangedFiles", "principal", ".ownerKey"],
  ["aws/developer-tasks/feedback-review.ts", "submitWorkflowFeedbackDecision", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-view.ts", "ownArtifactKey", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-view.ts", "taskView", "history", ".developerName"],
  ["aws/developer-tasks/start.ts", "startTask", "history", ".ownerKey", ".developerId", ".developerName"],
  ["aws/developer-tasks/task-index.ts", "ownerIndexRowOf", "index", ".developerId"],
  ["aws/developer-tasks/task-index.ts", "syncIndex", "index", ".developerId"],
  ["aws/developer-tasks/continue.ts", "dispatchHeldStart", "principal", ".ownerKey"],
  ["aws/developer-tasks/continue.ts", "dispatchHeldStart", "money", ".slackUserId", ".developerId*2"],
  ["aws/developer-tasks/continue.ts", "continueAsTask", "authority", ".startedBy"],
  ["aws/developer-tasks/task-view.ts", "pauseViewOf", "authority", ".startedBy", ".developerId*3"],
  ["aws/developer-tasks/workflow-review.ts", "workflowReviewFeedbackOption", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-page.ts", "replyLookups", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-page.ts", "currentSuggestions", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-page.ts", "getTaskDocumentView", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-page.ts", "getTaskDocumentView", "caller-actor", "taskOwnerKey()*3"],
  ["aws/developer-tasks/feedback-capture.ts", "feedbackReviewWorkspaceReady", "principal", "taskOwnerKey()", ".developerId"],
  ["aws/developer-tasks/task-answer-context.ts", "workflowTaskAnswerContext", "principal", ".ownerKey"],
  ["aws/developer-tasks/task-answer-context.ts", "commentAnswerSection", "principal", ".ownerKey"],
  ["aws/developer-tasks/close.ts", "finishTaskClose>closing", "index", ".developerId"],
  ["aws/developer-tasks/release.ts", "releaseFinishedTask>rest", "index", ".developerId"],
  ["aws/developer-tasks/share.ts", "shareItems", "index", ".developerId"],
  ["aws/developer-tasks/share.ts", "shareIdempotencyKey", "principal", ".ownerKey"],
  ["developer/page-comments.ts", "loadDocumentVersion", "principal", ".ownerKey"],
  ["spend/requests.ts", "payerOf", "money", ".developerId"],
  ["spend/requests.ts", "taskPayerId", "money", ".developerId"],
  ["spend/requests.ts", "createRunLimitRequest", "authority", ".startedBy"],
  ["spend/requests.ts", "askPausedTask", "authority", ".startedBy"],
  ["spend/requests.ts", "requestForMonth", "authority", ".startedBy"],
  ["spend/requests.ts", "followUpRunLimit", "authority", ".startedBy"],
  ["spend/requests.ts", "pausedTaskGate", "authority", ".startedBy"],
  ["spend/requests.ts", "confirmViewOf", "money", ".developerId"],
  ["developer/task-records.ts", "ownerDecisionCounts", "owner-actor", "taskOwnerKey()", ".developerId"],
  ["developer/task-records.ts", "partyOfTask", "history", ".developerId", ".provider", ".developerName", ".slackUserId"],
  ["developer/task-records.ts", "developerTaskIdentity", "principal", ".developerId*3", "taskOwnerKey()", ".provider", ".developerName"],
  ["aws/admin-reads.ts", "workspaceOwner", "history", ".developerId*3", ".developerName*2"],
  ["agent-sessions/summary.ts", "requestSlotsOf", "authority", ".startedBy", ".developerId*3"],
  ["agents/agent-tools-routes.ts", "frameOf", "principal", ".ownerKey*2"],
  ["agents/agent-tools-routes.ts", "regrantAgentTool", "principal", ".ownerKey"],
  // Plan 6 Task 23 (Codex): a task's lazily made session records its creator as the session's owner and the starter it was started by, as `ensureTaskSession` always did (its reads moved into `lazyTaskSessionInput`, and `taskSessionHeader` out of `createTaskSessionItems`); history, and a take-over asks the session's own rules before it
  ["agent-sessions/create.ts", "lazyTaskSessionInput", "history", ".developerId*2", ".startedBy"],
  ["agent-sessions/create.ts", "taskSessionHeader", "history", ".startedBy"],
  // Plan 6 Task 23: the task's creator's name is only what the lazily made session shows as its first owner (history); who may take the task over is decided by `askTakeOver` on that session
  ["aws/developer-tasks/task-people.ts", "codeOwnershipConfirmation", "history", ".developerName*2"],
  // Plan 6 Task 23: who may share a Code task is the session level "edit" (`requireSessionLevel`, which follows a take-over); the actor ids are made from that session's effective owner and the caller, and the write is fenced on the task's owner (`ownerFenceOf` in `shareItems`)
  ["aws/developer-tasks/share.ts", "authorizeShare", "caller-actor", "taskOwnerKey()*2"],
  // Plan 6 Task 16: the review reads of `getWorkflowFeedbackReview` moved into `verifiedFeedbackReview`; the review of comments Rovara fixes on its own is bound to the task's principal (`ownerKey`), which never changes, as the owner's approval path binds it
  ["aws/developer-tasks/workflow-review.ts", "startAutomaticFeedbackRound", "principal", ".ownerKey"],
  ["aws/developer-tasks/feedback-review.ts", "verifiedFeedbackReview", "principal", ".ownerKey*2"],
  // Plan 6 Task 19: which approvals are a requester's own: the creator, whoever started the task and its owner now (read through `tryEffectiveTaskOwner`, so a take-over or a merge is followed and an owner that cannot be read refuses)
  ["rovara-code/approval.ts", "requesterIds", "authority", ".developerId", ".startedBy"],
  // Plan 6 Task 23: undoing a Slack share keeps the creator's task-list row and the owner's in step (`effectiveTaskOwner` is called for the owner)
  ["rovara-code/sharing.ts", "undoCodeShare", "index", ".developerId*2"],
  ["aws/broker/handler.ts", "createAwsBrokerHandler", "other-record", ".ownerKey*2"],
  ["aws/broker/workspace-preparation.ts", "sharedThread", "principal", "taskOwnerKey()"],
  ["aws/broker/workspace-preparation.ts", "verifiedSharedStopBinding", "principal", ".developerId*3", ".ownerKey*4", "taskOwnerKey()"],
  ["aws/broker/workspace-preparation.ts", "sharedStopFences", "principal", ".developerId*2", ".ownerKey*2"],
  ["aws/broker/task-operations.ts", "taskOperationParts", "money", ".developerId"],
  // Immutable Slack creator/thread bindings remain the task principal; current turn authority uses effectiveTaskOwner.
  ["aws/broker/task-operations.ts", "taskOperationParts", "principal", ".developerId*5", ".provider", ".slackUserId*2"],
  ["model-selection/turn-fallback.ts", "authorizeTurnModelFallback", "principal", ".developerId*3", ".slackUserId"],
  // C55: the pull request footer names the identity the workspace was prepared for (as it always did); when its display name is an email address, the GitHub login that same person linked stands in for it (a stored identity, read only to find that login)
  ["aws/broker/thread-workspaces.ts", "attributedBody", "history", ".developerId"],
  ["aws/broker/model-access.ts", "handleModelAccess>loadScope", "money", ".developerId"],
  ["aws/broker/workflow-e2e-verification.ts", "workflowE2EPresentationDetailed", "principal", ".ownerKey"],
  ["aws/broker/feedback-and-codebuild.ts", "currentWorkflowFeedbackApproval", "principal", ".ownerKey"],
  ["aws/broker/feedback-and-codebuild.ts", "readFeedbackBundlesForCritic", "principal", ".ownerKey*2"],
  ["aws/broker/pull-request-reconcile.ts", "describeFeedbackFixes>update", "principal", ".ownerKey"],
  ["aws/broker/terminal-and-github-events.ts", "processGithubWorkflowEvent>reviewedComments", "principal", ".ownerKey"],
  ["aws/broker/terminal-and-github-events.ts", "processGithubWorkflowEvent>persistBundle", "principal", ".ownerKey"],
  ["aws/broker/workflow-items.ts", "completedWorkflowItems", "principal", ".ownerKey"],
  // Plan 6 Task 4: an Understand that chose the Full path is admitted as a Full start is, against the budget of whoever pays for the task (the recorded payer, else the creator; a test run's starter): money, read as `paymentOfTask` reads it
  ["aws/broker/workflow-items.ts", "completedWorkflowItems", "money", ".developerId*2", ".startedBy"],
  ["aws/broker/plan-answers.ts", "storePlanAnswer", "principal", ".ownerKey*2"],
  // Mainline #408 (plan self-check and grounding): the object prefix of the plan the planner answered and of the task's stored plan document, and the task's principal for the grounding step's workspace: the task's principal, never changes
  ["aws/broker/e2e-rounds.ts", "runGroundingStep", "principal", ".ownerKey"],
  ["aws/task-plan-document.ts", "readTaskPlanDocument", "principal", ".ownerKey"],
  ["aws/activity-index.ts", "contextOf", "history", ".developerName"],
  ["aws/activity-index.ts", "contextOf", "principal", ".ownerKey"],
  ["aws/slack-interactivity.ts", "workflowSlackHandlers>requireOwnerAction", "authority", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "deliverPeopleNotification", "other-record", ".slackUserId*3"],
  ["aws/developer-task-notifier.ts", "recordThread", "principal", ".ownerKey"],
  ["aws/developer-task-notifier.ts", "recordThread", "history", ".developerId", ".developerName"],
  ["aws/developer-task-notifier.ts", "deliverRefusal", "other-record", ".slackUserId*2"],
  ["aws/developer-task-notifier.ts", "deliverChatGptFallback", "money", ".developerId", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "deliver", "history", ".developerName", ".slackUserId"],
  // Round 4 (mainline M1.3/M1.4): a round's stored screenshots and rows are filed under the task's principal (`ownerKey`) in object keys, which never changes.
  ["aws/developer-task-notifier.ts", "workflowE2ENotifierBlocks", "principal", ".ownerKey"],
  ["aws/workflow-e2e-artifacts.ts", "loadStoredScenarioResults", "principal", ".ownerKey"],
  ["aws/workflow-e2e-artifacts.ts", "loadWorkflowE2EArtifact", "principal", ".ownerKey"],
  ["aws/workflow-e2e-artifacts.ts", "storeWorkflowE2EArtifacts", "principal", ".ownerKey"],
  ["aws/task-person-runtime.ts", "identityDocumentClient>send", "other-record", ".developerId*3"],
  ["aws/task-person-runtime.ts", "createTaskPersonRuntime>stateAuthorityWitnessForOwnerActor", "caller-actor", "taskOwnerKey()"],
  ["aws/plan-evidence-handler.ts", "runPlanEvidenceJob", "principal", ".ownerKey"],
  ["aws/unwaited-tasks.ts", "candidate", "principal", ".ownerKey*2"],
  ["aws/task-person-invite-handler.ts", "exactIdentityRow", "shape", ".developerId"],
  ["aws/task-person-invite-handler.ts", "validRegistry", "shape", ".developerId", ".slackUserId"],
  ["aws/task-person-invite-handler.ts", "validTask", "shape", ".developerId"],
  ["aws/task-person-invite-handler.ts", "validPeople", "shape", ".developerId*3", ".slackUserId"],
  ["aws/task-person-invite-handler.ts", "createTaskPersonInviteHandler", "caller-actor", "taskOwnerKey()"],
  // reads the structural scan found (12b review): a witness, a note, an identity or a projection of the task, each classified
  ["agent-sessions/events.ts", "slackReplyAuthor", "other-record", ".developerId", ".developerName*2", ".slackUserId"],
  ["agents/runs.ts", "runStartItems", "other-record", ".developerId"],
  ["aws/admin-change-plans.ts", "planStop", "history", ".developerName*2"],
  ["aws/broker/thread-workspaces.ts", "requesterOf", "history", ".developerId", ".provider"],
  ["aws/broker/workspace-preparation.ts", "sharedThread", "principal", ".developerId", ".ownerKey"],
  ["aws/broker/thread-workspaces.ts", "sharedThreadWorkspace", "history", ".developerName"],
  ["aws/broker/workspace-preparation.ts", "slackServiceIdentity", "history", ".developerId", ".developerName", ".ownerKey"],
  ["aws/broker/slack-workflow-events.ts", "stopSlackThreadTask", "principal", ".ownerKey"],
  ["aws/broker/model-access.ts", "writeGateRuntime>requireRunAuthority", "principal", ".ownerKey"],
  ["aws/developer-tasks/thread-notes.ts", "threadNotesPromptSection", "other-record", ".developerId"],
  ["aws/task-dispatch-access.ts", "allowedStillCurrent", "other-record", ".developerId*3"],
  ["aws/task-dispatch-access.ts", "guardTaskDispatchCore", "other-record", ".developerId"],
  ["aws/task-person-invite-authority-fence.ts", "positiveRowCondition", "other-record", ".developerId*3"],
  ["aws/task-person-invite-authority-fence.ts", "taskPersonInviteStateConditions", "other-record", ".developerId*2"],
  ["aws/task-person-invite-handler.ts", "createTaskPersonInviteHandler", "other-record", ".slackUserId"],
  ["aws/task-person-runtime.ts", "createTaskPersonRuntime>currentWitness", "other-record", ".developerId"],
  ["aws/task-person-runtime.ts", "createTaskPersonRuntime>stateAuthorityWitnessForOwnerActor", "other-record", ".developerId*2"],
  ["aws/workflow-e2e-notifier-projection.ts", "createWorkflowE2EDisplayObject", "principal", ".ownerKey"],
  ["aws/workflow-e2e-notifier-projection.ts", "readWorkflowE2ENotifierProjection", "principal", ".ownerKey"],
  ["aws/workflow-e2e-notifier-projection.ts", "workflowE2EDisplayRef", "principal", ".ownerKey"],
  ["events.ts", "putArtifact", "principal", ".ownerKey*2"],
  ["repository-access.ts", "issue", "principal", ".ownerKey"],
  // reads on NAMED interfaces and aliases that carry a task's id (13 review: the scan sees `interface TaskLike { developerId }` as it sees a literal type), each classified
  ["agent-sessions/create.ts", "createTaskSessionItems", "history", ".startedBy*6"],
  ["agent-sessions/create.ts", "startedText", "history", ".startedBy*4"],
  ["agent-sessions/retry.ts", "repairLink", "other-record", ".developerId"],
  // a move to the cloud (Plan 5 Task 19): the task the runtime answered with must be the caller's own new one (its row names the caller as creator); it validates the shape of the runtime's answer and decides nothing about ownership
  ["agent-sessions/handoff.ts", "toCloud", "shape", ".developerId"],
  // Task 14 minor: a retry is recorded as the caller's only when the idempotency item of ITS request id exists (the key is the task's owner key, as Plan 3 writes it)
  ["agent-sessions/retry.ts", "workflowMovedOn", "principal", ".ownerKey"],
  ["agents/agent-tools-routes.ts", "callAgentTool>holdRecord", "principal", ".ownerKey"],
  ["agents/agent-tools-routes.ts", "callAgentTool>replayOfRecorded", "principal", ".ownerKey*2"],
  ["aws/activity-index.ts", "failureItem", "history", ".developerName"],
  ["aws/activity-index.ts", "usageItem", "history", ".developerName"],
  ["aws/broker/slack-workflow-events.ts", "handleSlackTaskPeople", "other-record", ".slackUserId"],
  ["aws/broker/model-access.ts", "writeGateRuntime>runConnector", "principal", ".ownerKey"],
  ["aws/connector-ledger.ts", "finish", "principal", ".ownerKey"],
  ["aws/connector-routes.ts", "scopeContext", "principal", ".ownerKey"],
  ["aws/developer-tasks/thread-notes.ts", "sessionNoteItems", "other-record", ".developerId"],
  ["developer/task-records.ts", "aiToolTurn", "history", ".developerId", ".developerName", ".provider", ".slackUserId*2"],
  ["events.ts", "getArtifact", "principal", ".ownerKey"],
  ["github-mcp.ts", "connectorContext", "principal", ".ownerKey"],
  ["repository-access.ts", "inspect", "principal", ".ownerKey"],
  // Meta repo lane D: the broker's own meta-repository token is issued for the task's principal (`ownerKey`, with the workspace and an operation id it makes), as `repositoryGrants.issue` is for a worker; it never changes, and the broker uses it itself
  ["aws/broker/spec-wiring.ts", "metaClient", "principal", ".ownerKey"],
  // Proof and evidence P6: an evidence file is stored under the task's object prefix (`private/<ownerKey>/<workspace>/evidence/<task>/<sha256>`), the task's principal; who may download it is decided by `authorize()` before either read
  ["aws/evidence-artifacts.ts", "keyOf", "principal", ".ownerKey"],
  ["aws/evidence-artifacts.ts", "serveEvidenceArtifact", "principal", ".ownerKey"],
  // Meta repo lane E: the project authority check of a context-tools call is looked up for the task's principal (its per-task MEMBERSHIP row), as `agent-tools-routes` does; the creator's org standing is read through `effectiveTaskOwner` in the same call
  ["context-sources/routes.ts", "stageSources", "principal", ".ownerKey"],
  // Meta repo lane F: `known` is an intake item (a ticket waiting or starting), not a task; its `startedBy` is the member whose act started the ticket, handed back to the waiting list
  ["intake/engine.ts", "ingestOnce", "other-record", ".startedBy*2"],
];

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages");
const SRC = path.join(PACKAGES, "broker/src");
const CONTRACTS = path.join(PACKAGES, "contracts/src");
/** The owner functions themselves read the creator's fields: that is what they are for. */
const OWNER_FUNCTION_ROWS = new Set(["effectiveTaskOwner", "ownerActorIdOf", "ownerNameOfActor", "ownerFenceOf", "tryEffectiveTaskOwner"]);

function scan(): { hits: Hit[]; program: ts.Program } {
  const program = programOf(path.join(PACKAGES, "broker/tsconfig.json"));
  const contracts = programOf(path.join(PACKAGES, "contracts/tsconfig.json"));
  const [broker, contractsRoot] = guardedRoots(PACKAGES) as [Root, Root];
  const hits = [
    ...scanProgram(program, [broker]).filter((hit) => hit.file !== "developer/task-records.ts" || !OWNER_FUNCTION_ROWS.has(hit.fn)),
    ...scanProgram(contracts, [contractsRoot]),
  ];
  return { hits, program };
}

describe("every read of a task's owner is classified, and the ones that carry authority go through the one function", () => {
  const { hits, program } = scan();
  const rows = rowsOf(ROWS);

  it("finds every read in the table, and the table holds no read that is gone", () => {
    const { unclassified, stale } = problemsOf(hits, rows);
    expect(unclassified, "reads that no row classifies").toEqual([]);
    expect(stale, "rows with no read").toEqual([]);
  });

  it("sends every read that carries authority through the one function: the function calls it, not just names it", () => {
    expect(problemsOf(hits, rows).notRouted).toEqual([]);
  });

  it("reads `currentOwner` nowhere but in the owner functions, and the one projection that hands it to the Slack buttons", () => {
    const allowed = new Set(["developer/task-records.ts", "aws/slack-interactivity.ts"]);
    const raw = [SRC, CONTRACTS].flatMap((root) => sourceFiles(root).map((file) => ({ root, file })))
      .map(({ root, file }) => ({ name: `${root === CONTRACTS ? "contracts/" : ""}${path.relative(root, file).split(path.sep).join("/")}`, file }))
      .filter(({ name }) => !allowed.has(name))
      .filter(({ file }) => /(\.currentOwner\b|["'`]currentOwner["'`]|\bcurrentOwner\??:)/u.test(readFileSync(file, "utf8")))
      .map(({ name }) => name);
    expect(raw).toEqual([]);
  });

  it("names the effective owner wherever a project authority check asks for the task's creator (`taskCreator`)", () => {
    const wrong: string[] = [];
    for (const source of program.getSourceFiles()) {
      if (source.isDeclarationFile || !source.fileName.startsWith(`${SRC}${path.sep}`)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "taskCreator" && !/\b(effectiveTaskOwner|workspaceTaskOwner|ownerOfTask)\b/u.test(node.initializer.getText())) {
          wrong.push(`${path.relative(SRC, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(wrong).toEqual([]);
  });

  it("hands `currentOwner` to the Slack buttons in the one task projection they load, so their owner check sees a take-over", () => {
    const source = readFileSync(path.join(SRC, "aws/slack-interactivity.ts"), "utf8");
    const projections = [...source.matchAll(/ProjectionExpression: "([^"]*)"[^\n]*\n?/gu)].map((match) => match[1] ?? "").filter((projection) => projection.includes("workflow"));
    expect(projections).toHaveLength(1);
    expect(projections[0]).toContain("currentOwner");
    expect(projections[0]).toContain("slackUserId");
  });
});
