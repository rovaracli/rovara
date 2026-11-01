// Test environment (wire-testenv): the draft environment a setup draft run reports, read again by the broker and kept for the maintainer's "propose".
//
// The worker's draft is UNTRUSTED (the run read repository files and talked to a model). So the broker, not the worker, decides what it accepts:
//   - it must parse as a draft (bounded, strict) and describe the SAFEST environment: the sandbox tier, no services, no accounts, no seeds, no preview or shared block, no video or traces, no nightly run,
//     round budget at its floor, no unrecorded-request answers. A draft that asks for anything more is refused as a whole: more access is a person's decision on a card, never a detector's;
//   - a command that downloads and runs code (`remoteCodeReason`), or that the redactor would change (it holds something secret-shaped), is dropped from the setup commands and checks with a fixed note;
//     the id of a dropped check also leaves `alwaysRun`;
//   - what is shown to people (notes, questions, services) is one plain line each.
// The draft is stored under the project, keyed by the setup draft's task (a newer setup draft makes an older one stale), and expires with the proposal's own life.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  TEST_ENV_DRAFT_RESULT_KEY,
  TEST_ENV_ROUND_BUDGET_MIN,
  TestEnvDraftSchema,
  formatCommandLine,
  projectPk,
  redactText,
  remoteCodeReason,
  testEnvLessSafeChanges,
  type OrgId,
  type ProjectCommand,
  type TestEnvDraft,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { TransactItem } from "../audit/outbox.js";
import { TEST_ENV_PROPOSAL_TTL_MS } from "../org/test-environment.js";
import { testEnvironmentEnabled } from "./switch.js";

type Send = { send(command: unknown): Promise<unknown> };

export const DRAFT_LEFT_OUT_NOTE = "A command that downloads and runs code, or that holds a secret, was left out of the proposal.";

const draftKey = (orgId: OrgId, project: string, taskId: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#DRAFT#${taskId}` });

/** A command the broker will not carry in a draft: it fetches code and runs it, or its text changes under the redactor (a secret-shaped value). */
function refusedCommand(command: ProjectCommand): boolean {
  const text = formatCommandLine(command);
  return remoteCodeReason(text) !== undefined || redactText(text) !== text;
}

/** The safest environment, and nothing beyond: the draft is refused (undefined) when it asks for more. */
function isSafestEnvironment(body: TestEnvironmentBody): boolean {
  return body.tier === "sandbox" && body.services.length === 0 && body.accounts.length === 0 && body.data.seeds.length === 0
    && body.preview === undefined && body.shared === undefined && !body.capture.video && !body.capture.traces && body.capture.screenshots === "failed"
    && !body.nightly.enabled && body.roundBudgetMin === TEST_ENV_ROUND_BUDGET_MIN.min
    && body.prodDeny.accountIds.length === 0 && body.prodDeny.hosts.length === 0 && body.prodDeny.arnPrefixes.length === 0
    && testEnvLessSafeChanges(undefined, body).length === 0;
}

const plain = (text: string): string => redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 400);

/** The draft as the broker keeps it, or undefined when the worker's report is not a safe draft. Never throws. */
export function sanitizeTestEnvDraft(raw: unknown): TestEnvDraft | undefined {
  const parsed = TestEnvDraftSchema.safeParse(raw);
  if (!parsed.success || !isSafestEnvironment(parsed.data.environment)) return undefined;
  const draft = parsed.data;
  let leftOut = false;
  const kept = new Set<string>();
  const repos = draft.environment.repos.map((repo) => {
    const setupCommands = repo.setupCommands.filter((command) => { const refused = refusedCommand(command); leftOut ||= refused; return !refused; });
    const checks = repo.checks.filter((check) => { const refused = refusedCommand(check.command); leftOut ||= refused; if (!refused) kept.add(check.id); return !refused; });
    return { ...repo, setupCommands, checks };
  });
  if (repos.every((repo) => repo.checks.length === 0)) return undefined;
  const environment: TestEnvironmentBody = {
    ...draft.environment,
    repos,
    selection: { ...draft.environment.selection, alwaysRun: draft.environment.selection.alwaysRun.filter((id) => kept.has(id)) },
  };
  // A value source names a field by position: those of a dropped command would now point at another value, so the sources of a draft that lost something are kept only where they still line up (none).
  const valueSources = leftOut ? [] : draft.valueSources;
  return {
    environment, valueSources,
    pendingServices: draft.pendingServices.map((service) => ({ kind: service.kind, target: plain(service.target) })).filter((service) => service.target !== ""),
    notes: [...draft.notes.map(plain), ...(leftOut ? [DRAFT_LEFT_OUT_NOTE] : [])].filter((line) => line !== "").slice(0, 60),
    questions: draft.questions.map(plain).filter((line) => line !== "").slice(0, 60),
  };
}

/**
 * The item that keeps a setup draft's environment draft, for the transaction of the setup draft's terminal result. Nothing while the switch is off, for a task that is not a setup draft, for a run that did not
 * succeed, or for a report that is not a safe draft: the setup draft's own result is never touched by this.
 */
export function testEnvDraftEndItems(
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId" | "purpose" | "project"> & { orgId?: OrgId | undefined },
  operation: { kind: string; workflowMode?: string | undefined },
  outcome: { status: string; result: unknown },
  nowIso: string,
  env: NodeJS.ProcessEnv = process.env,
): TransactItem[] {
  if (!testEnvironmentEnabled(env) || task.purpose !== "setup_draft" || task.orgId === undefined) return [];
  if (operation.kind !== "task" || operation.workflowMode !== "SETUP_DRAFT" || outcome.status !== "SUCCEEDED") return [];
  const reported = typeof outcome.result === "object" && outcome.result !== null ? (outcome.result as Record<string, unknown>)[TEST_ENV_DRAFT_RESULT_KEY] : undefined;
  const draft = reported === undefined ? undefined : sanitizeTestEnvDraft(reported);
  if (draft === undefined) return [];
  return [{ Put: {
    TableName: tableName,
    Item: { ...draftKey(task.orgId, task.project, task.taskId), entityType: "TEST_ENV_DRAFT", orgId: task.orgId, project: task.project, taskId: task.taskId, draft, at: nowIso, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((Date.parse(nowIso) + TEST_ENV_PROPOSAL_TTL_MS) / 1000) },
  } }];
}

/** The stored draft of a setup draft task, read again through the sanitizer (a damaged or unsafe item is "none"), or undefined. */
export async function readTestEnvDraft(client: Send, tableName: string, orgId: OrgId, project: string, taskId: string, nowMs: number): Promise<{ draft: TestEnvDraft; at: string } | undefined> {
  const item = (await client.send(new GetCommand({ TableName: tableName, Key: draftKey(orgId, project, taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const stored = item.Item;
  if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId || typeof stored["at"] !== "string") return undefined;
  const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= nowMs) return undefined;
  const draft = sanitizeTestEnvDraft(stored["draft"]);
  return draft === undefined ? undefined : { draft, at: stored["at"] };
}
