// Plan 5 Task 12a: the inventory of every read of a task's owner, as an allowlist. A TypeScript pass over `packages/broker/src` finds each read of the creator's
// fields (`developerId`, `developerName`, `slackUserId`, `provider`) and of `ownerKey` on an expression typed as a `DeveloperTaskRecord` (or a `Pick` of it), through
// `.x`, `?.x`, `["x"]` and destructuring, whatever the variable is called, plus every `taskOwnerKey(` call, every `taskCreator` option and every raw read of
// `currentOwner`. Each hit must match a row below by file, function and field, with its class. A new read that is not in the table fails here: classify it
// (and, if it carries authority, route it through `effectiveTaskOwner`) before it ships.
//
//   authority     decides whose authority, approvals or standing a step, a decision or a dispatch uses: must reach `effectiveTaskOwner` (or a sibling) in its function
//   owner-actor   asks "is this actor the owner?": must reach the owner functions in its function
//   attribution   names or mentions the owner to people: must reach the owner functions in its function
//   index         keeps the creator's task-list row and the owner's: must reach the owner functions in its function
//   principal     the task's workspace identity, object prefixes, idempotency keys and shared-thread bindings: never changes
//   history       what was true when something was written (a start message, a turn record, a stored identity)
//   money         whose budget pays: a take-over writes the payer explicitly (Task 12b), so these keep reading the creator
//   caller-actor  turns a named person into an actor id; it decides nothing about who owns the task
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Klass = "authority" | "owner-actor" | "attribution" | "index" | "principal" | "history" | "money" | "caller-actor";
const NEEDS_THE_FUNCTION: ReadonlySet<Klass> = new Set(["authority", "owner-actor", "attribution", "index"]);
/** Reaching any of these in the function is how a read of an owner goes through the one function. */
const OWNER_FUNCTIONS = /\b(effectiveTaskOwner|tryEffectiveTaskOwner|ownerActorIdOf|ownerNameOfActor|ownerFenceOf|ownerCallerOf|ownerIndexRowOf|ownerSlackUserOf)\b/u;

type Row = readonly [file: string, fn: string, klass: Klass, ...fields: string[]];
const ROWS: readonly Row[] = [
  // the people path
  ["developer/creator-member.ts", "requireCreatorStillMember", "authority", ".developerId", ".developerName"],
  ["developer/task-access.ts", "resolveTaskRoleByTask", "owner-actor", ".developerId", ".developerName"],
  ["developer/task-people.ts", "initialize", "owner-actor", ".developerId"],
  ["developer/task-people.ts", "authorizeColdInitialization", "owner-actor", ".developerId"],
  ["developer/task-people.ts", "commitMutation", "owner-actor", ".developerId"],
  ["developer/task-person-identity.ts", "resolveTaskPickerPerson", "history", ".developerId", ".provider", ".slackUserId"],
  ["developer/task-person-identity.ts", "registerTaskChannelPeople", "history", ".developerId", ".provider", ".slackUserId"],
  ["developer/task-person-identity.ts", "checkTaskPersonIdentity", "history", ".developerId", ".developerName", ".provider", ".slackUserId"],
  ["developer/task-records.ts", "developerTaskIdentity", "principal", ".developerId", ".developerName", ".provider"],
  ["developer/task-records.ts", "partyOfTask", "history", ".developerId", ".developerName", ".provider", ".slackUserId"],
  ["developer/page-comments.ts", "loadDocumentVersion", "principal", ".ownerKey"],
  ["developer/page-comments.ts", "queueCommentAnswer", "owner-actor", ".slackUserId"],
  ["aws/task-dispatch-access.ts", "creatorIsProjectViewer", "authority", ".developerId"],
  // approvals, writes and agent tools
  ["agents/agent-tools-routes.ts", "taskCreator", "authority", ".developerId"],
  ["agents/agent-tools-routes.ts", "frameOf", "principal", ".ownerKey"],
  ["agents/agent-tools-routes.ts", "attributionOf", "attribution", ".developerName"],
  ["agents/agent-tools-routes.ts", "callAgentTool", "authority", ".developerId", ".developerName"],
  ["agents/agent-tools-routes.ts", "regrantAgentTool", "principal", ".ownerKey"],
  ["agents/run-engine.ts", "askForApproval", "authority", ".developerId", ".developerName"],
  ["agents/write-gate.ts", "executeWrite", "principal", ".ownerKey"],
  // the broker
  ["aws/broker.ts", "workspaceTaskOwner", "authority", ".developerId"],
  ["aws/broker.ts", "taskCreator", "authority", ".developerId"],
  ["aws/broker.ts", "resumeTask", "authority", ".developerId"],
  ["aws/broker.ts", "slackTaskAccess", "owner-actor", ".developerId", ".developerName", ".provider", ".slackUserId"],
  ["aws/broker.ts", "ownedSlackWorkflowTask", "owner-actor", ".developerId"],
  ["aws/broker.ts", "authorizeWorkflowFeedbackApproval", "authority", ".developerId", ".developerName", ".provider", ".slackUserId"],
  ["aws/broker.ts", "authorizeWorkflowFeedbackApproval", "principal", ".ownerKey"],
  ["aws/broker.ts", "processGithubWorkflowEvent", "authority", ".developerId", ".developerName", ".provider"],
  ["aws/broker.ts", "runWorkflowDispatch", "authority", ".developerId", ".developerName", ".provider"],
  ["aws/broker.ts", "requireWorkflowE2ECreatorAuthority", "authority", ".developerId"],
  ["aws/broker.ts", "workflowE2ECreatorAuthorityProof", "authority", ".developerId"],
  ["aws/broker.ts", "workflowE2ECurrentAuthorityIsValid", "authority", ".developerId"],
  ["aws/broker.ts", "taskOperationParts", "money", ".developerId"],
  ["aws/broker.ts", "loadScope", "money", ".developerId"],
  ["aws/broker.ts", "sharedStopFences", "principal", ".developerId", ".ownerKey"],
  ["aws/broker.ts", "verifiedSharedStopBinding", "principal", ".developerId", ".ownerKey"],
  ["aws/broker.ts", "completedWorkflowItems", "principal", ".ownerKey"],
  ["aws/broker.ts", "currentWorkflowFeedbackApproval", "principal", ".ownerKey"],
  ["aws/broker.ts", "persistBundle", "principal", ".ownerKey"],
  ["aws/broker.ts", "readFeedbackBundlesForCritic", "principal", ".ownerKey"],
  ["aws/broker.ts", "reviewedComments", "principal", ".ownerKey"],
  ["aws/broker.ts", "storePlanAnswer", "principal", ".ownerKey"],
  ["aws/broker.ts", "update", "principal", ".ownerKey"],
  ["aws/broker.ts", "workflowE2EPresentation", "principal", ".ownerKey"],
  ["aws/plan-evidence-handler.ts", "runPlanEvidenceJob", "principal", ".ownerKey"],
  // the task's routes
  ["aws/developer-tasks.ts", "loadOwnedTask", "authority", ".developerId"],
  ["aws/developer-tasks.ts", "continueAsTask", "authority", ".developerId"],
  ["aws/developer-tasks.ts", "listTasks", "authority", ".developerId"],
  ["aws/developer-tasks.ts", "pauseViewOf", "authority", ".developerId"],
  ["aws/developer-tasks.ts", "refused", "attribution", ".developerName", ".slackUserId"],
  ["aws/developer-tasks.ts", "planWhyEntries", "attribution", ".developerName"],
  ["aws/developer-tasks.ts", "recordWorkflowThreadNote", "owner-actor", ".slackUserId"],
  ["aws/developer-tasks.ts", "getTaskDocumentView", "attribution", ".developerName"],
  ["aws/developer-tasks.ts", "getTaskDocumentView", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "personName", "owner-actor", ".ownerKey"],
  ["aws/developer-tasks.ts", "syncIndex", "index", ".developerId"],
  ["aws/developer-tasks.ts", "closing", "index", ".developerId"],
  ["aws/developer-tasks.ts", "rest", "index", ".developerId"],
  ["aws/developer-tasks.ts", "shareItems", "index", ".developerId"],
  ["aws/developer-tasks.ts", "startTask", "history", ".developerId", ".developerName", ".ownerKey"],
  ["aws/developer-tasks.ts", "taskView", "history", ".developerName"],
  ["aws/developer-tasks.ts", "dispatchHeldStart", "money", ".developerId", ".slackUserId"],
  ["aws/developer-tasks.ts", "dispatchHeldStart", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "feedbackReviewWorkspaceReady", "principal", ".developerId"],
  ["aws/developer-tasks.ts", "cancelTask", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "commentAnswerSection", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "currentSuggestions", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "getWorkflowFeedbackReview", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "ownArtifactKey", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "replyLookups", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "shareIdempotencyKey", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "submitWorkflowFeedbackDecision", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "workflowReviewFeedbackOption", "principal", ".ownerKey"],
  ["aws/developer-tasks.ts", "workflowTaskAnswerContext", "principal", ".ownerKey"],
  // who is told
  ["aws/developer-task-notifier.ts", "updateWorkflowApprovalCard", "attribution", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "workflowReply", "attribution", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "replyText", "attribution", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "deliver", "history", ".developerName", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "deliverChatGptFallback", "money", ".developerId", ".slackUserId"],
  ["aws/developer-task-notifier.ts", "recordThread", "history", ".developerId", ".developerName"],
  ["aws/developer-task-notifier.ts", "recordThread", "principal", ".ownerKey"],
  ["aws/developer-task-notifier.ts", "workflowE2EBlocks", "principal", ".ownerKey"],
  // the budget pause and money
  ["spend/requests.ts", "askPausedTask", "authority", ".developerId"],
  ["spend/requests.ts", "askRunLimitAgain", "authority", ".developerId"],
  ["spend/requests.ts", "createRunLimitRequest", "authority", ".developerId"],
  ["spend/requests.ts", "requestForMonth", "authority", ".developerId"],
  ["spend/requests.ts", "followUpRunLimit", "authority", ".developerId"],
  ["spend/requests.ts", "pausedTaskGate", "authority", ".developerId"],
  ["spend/requests.ts", "creatorGone", "authority", ".developerId"],
  ["spend/requests.ts", "maySee", "authority", ".developerId"],
  ["spend/requests.ts", "payerOf", "money", ".developerId"],
  ["spend/requests.ts", "taskPayerId", "money", ".developerId"],
  ["spend/requests.ts", "confirmViewOf", "money", ".developerId"],
  ["spend/payer.ts", "paymentOfTask", "money", ".developerId"],
  // sessions
  ["agent-sessions/summary.ts", "requestSlotsOf", "authority", ".developerId"],
  // `taskOwnerKey(` calls
  ["developer/task-people.ts", "resolveTaskPeopleAccess", "owner-actor", "taskOwnerKey()"],
  ["developer/task-people.ts", "resolveTaskDispatchPeople", "owner-actor", "taskOwnerKey()"],
  ["developer/task-access.ts", "resolveTaskRoleByTask", "owner-actor", "taskOwnerKey()"],
  ["developer/task-records.ts", "developerTaskIdentity", "principal", "taskOwnerKey()"],
  ["aws/task-dispatch-access.ts", "guardTaskDispatchCore", "owner-actor", "taskOwnerKey()"],
  ["aws/task-person-invite-handler.ts", "createTaskPersonInviteHandler", "caller-actor", "taskOwnerKey()"],
  ["aws/task-person-runtime.ts", "stateAuthorityWitnessForOwnerActor", "caller-actor", "taskOwnerKey()"],
  ["aws/developer-tasks.ts", "authorizeTaskAction", "caller-actor", "taskOwnerKey()"],
  ["aws/developer-tasks.ts", "getTaskDocumentView", "caller-actor", "taskOwnerKey()"],
  ["aws/developer-tasks.ts", "feedbackReviewWorkspaceReady", "principal", "taskOwnerKey()"],
  ["aws/broker.ts", "slackTaskAccess", "owner-actor", "taskOwnerKey()"],
  ["aws/broker.ts", "verifiedSharedStopBinding", "principal", "taskOwnerKey()"],
  ["aws/broker.ts", "sharedThread", "principal", "taskOwnerKey()"],
];

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/broker/src");
const TASK_PROPERTIES = new Set(["developerId", "developerName", "slackUserId", "provider", "ownerKey"]);

interface Hit { file: string; fn: string; field: string; node: ts.Node; line: number }

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** The function that holds `node`, named as a person would: a declaration, a method, a variable or property an arrow is assigned to. */
function functionOf(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name !== undefined) return current;
    if (ts.isVariableDeclaration(current) && current.initializer !== undefined && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) return current;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && (ts.isPropertyAssignment(current.parent) || ts.isVariableDeclaration(current.parent))) return current.parent;
  }
  return undefined;
}

const nameOf = (fn: ts.Node | undefined): string => {
  if (fn === undefined) return "<top>";
  const named = fn as ts.Node & { name?: ts.Node };
  return named.name === undefined ? "<top>" : named.name.getText();
};

function scan(): { hits: Hit[]; program: ts.Program } {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(SRC, "../tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); } });
  if (config === undefined) throw new Error("the broker's tsconfig can't be read");
  const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false } });
  const checker = program.getTypeChecker();
  const isTaskField = (symbol: ts.Symbol | undefined): boolean => (symbol?.declarations ?? []).some((declaration) => ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "DeveloperTaskRecord");
  const hits: Hit[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.fileName.startsWith(`${SRC}${path.sep}`)) continue;
    const file = path.relative(SRC, source.fileName).split(path.sep).join("/");
    const add = (node: ts.Node, field: string) => hits.push({ file, fn: nameOf(functionOf(node)), field, node: functionOf(node) ?? source, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && TASK_PROPERTIES.has(node.name.text) && isTaskField(checker.getSymbolAtLocation(node.name))) add(node, `.${node.name.text}`);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && TASK_PROPERTIES.has(node.argumentExpression.text) && isTaskField(checker.getSymbolAtLocation(node.argumentExpression))) add(node, `.${node.argumentExpression.text}`);
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) && TASK_PROPERTIES.has(name.text) && isTaskField(checker.getTypeAtLocation(node.parent).getProperty(name.text))) add(node, `.${name.text}`);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "taskOwnerKey") add(node, "taskOwnerKey()");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { hits, program };
}

describe("every read of a task's owner is classified, and the ones that carry authority go through the one function", () => {
  const { hits, program } = scan();
  const rows = new Map<string, Klass>();
  for (const [file, fn, klass, ...fields] of ROWS) for (const field of fields) rows.set(`${file}::${fn}::${field}`, klass);

  it("finds every read in the table, and the table holds no read that is gone", () => {
    const found = new Set(hits.filter((hit) => hit.file !== "developer/task-records.ts" || !["effectiveTaskOwner", "ownerActorIdOf", "ownerNameOfActor", "ownerFenceOf", "tryEffectiveTaskOwner"].includes(hit.fn)).map((hit) => `${hit.file}::${hit.fn}::${hit.field}`));
    expect([...found].filter((key) => !rows.has(key)).sort(), "reads that no row classifies").toEqual([]);
    expect([...rows.keys()].filter((key) => !found.has(key)).sort(), "rows with no read").toEqual([]);
  });

  it("sends every read that carries authority through the one function, in the function that reads it", () => {
    const missing = new Set<string>();
    for (const hit of hits) {
      const klass = rows.get(`${hit.file}::${hit.fn}::${hit.field}`);
      if (klass === undefined || !NEEDS_THE_FUNCTION.has(klass)) continue;
      if (!OWNER_FUNCTIONS.test(hit.node.getText())) missing.add(`${hit.file}::${hit.fn} (${klass}, line ${hit.line})`);
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("reads `currentOwner` nowhere but in the owner functions, and the one projection that hands it to the Slack buttons", () => {
    const allowed = new Set(["developer/task-records.ts", "aws/slack-interactivity.ts"]);
    const raw = sourceFiles(SRC)
      .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
      .filter((file) => !allowed.has(file) && /(\.currentOwner\b|["'`]currentOwner["'`]|\bcurrentOwner\??:)/u.test(readFileSync(path.join(SRC, file), "utf8")));
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
});
