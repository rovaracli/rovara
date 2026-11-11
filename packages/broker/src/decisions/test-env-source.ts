// Decision cards (setup wizard E4): the two test-environment kinds.
//
//   approve_test_env   A maintainer's proposal that is proved and waiting for approval. Each project the caller can edit settings of has at most one: the newest proposal that is not the approved environment and
//                      whose Prove report passed. Its risk is the proposal's own (`testEnvApprovalRisk`, or high for anything less safe than the approved environment): a MEDIUM card approves with one press, through
//                      `approveChecked` (the same function the setup wizard's Approve calls, so the proof is read again); a HIGH card has no approve action and opens the setup page, where the fresh sign-in and the second
//                      person are asked for. A card that lists the confirmation page (`confirmPath`) does so only where the caller can decide their own card there (the sole owner of a company).
//   confirm_env_change A running task's owner is asked to move the task onto a newer approved revision, when the change is one a running task can take: the same checks, nothing less safe. Approving moves the
//                      task's pin (the plan and the evidence read it); declining records that, so the card does not come back for that revision. A change to the checks themselves, or anything less safe, is never offered:
//                      the task keeps the revision it started with, and the next task gets the new one.
// Nothing here decides anything about authority: a card is a projection, the performer calls the real function, and that function checks the caller's live authority again.
import { createHash } from "node:crypto";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { projectPk, testEnvApprovalRisk, testEnvDigest, testEnvIsProved, testEnvLessSafeChanges, type OrgId, type TestEnvironmentBody } from "@rovara-code/contracts";
import { tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { testEnvChangeLines } from "../org/test-env-diff.js";
import { proposalNeedsFreshSignIn, proposalSeedTrust, readApprovedTestEnvironment, readProposal, readProposalSources, readTestEnvProveReport, type TestEnvDeps } from "../org/test-environment.js";
import { seedCardLinesOf, seedRisksOf } from "../test-env/seed-lock.js";
import { dependencyCardLines } from "../test-env/dependency-card-lines.js";
import { approvedFixturesOf, type FixtureReadPort } from "../test-env/fixture-lookup.js";
import { environmentUnusedReason, readTestEnvPin } from "../test-env/usable.js";
import { testEnvironmentEnabled } from "../test-env/switch.js";
import type { DecisionItem } from "./project.js";

type ChangeItem = Extract<DecisionItem, { kind: "confirm_env_change" }>;
interface Who { orgId: string; developerId: string }

/** The most projects and tasks one listing reads, so a listing is bounded. */
export const TEST_ENV_CARD_PROJECTS_MAX = 25;
export const TEST_ENV_CARD_TASKS_MAX = 50;
/** The most pages of a project's proposals read to find the newest (a page is up to 1 MB of small rows; a proposal lives 7 days). A project with more is left out rather than guessed at. */
const PROPOSAL_PAGES_MAX = 50;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);
const flagWords = (flag: string): string => `Turns on or raises: ${flag.replace(/_/gu, " ")}.`;
const dependencyReason = (count: number): string => `Starts ${count === 1 ? "a dependency" : `${String(count)} dependencies`} for this project's tests (listed under Dependencies).`;

/** The newest proposal of a project by the time it was proposed, over ALL its stored proposals (the keys are digests, so the newest is anywhere among them). Throws when there are too many pages to read. */
export async function newestProposal(store: TestEnvDeps, orgId: OrgId, project: string): Promise<{ digest: string; proposedAt: string } | undefined> {
  let newest: { digest: string; proposedAt: string } | undefined;
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < PROPOSAL_PAGES_MAX; page += 1) {
    const rows = (await store.documentClient.send(new QueryCommand({
      TableName: store.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": "TESTENV#PROPOSAL#" },
      ProjectionExpression: "digest, proposedAt", ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }))) as { Items?: Array<{ digest?: unknown; proposedAt?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of rows.Items ?? []) {
      if (typeof row.digest === "string" && typeof row.proposedAt === "string" && (newest === undefined || row.proposedAt.localeCompare(newest.proposedAt) > 0)) newest = { digest: row.digest, proposedAt: row.proposedAt };
    }
    if (rows.LastEvaluatedKey === undefined) return newest;
    start = rows.LastEvaluatedKey;
  }
  throw new Error("too many proposals to read");
}

export interface TestEnvCardPorts {
  store: TestEnvDeps;
  /** The projects the caller may edit the settings of (a maintainer), at most `TEST_ENV_CARD_PROJECTS_MAX`. */
  maintainedProjects(caller: Who): Promise<string[]>;
  /** The confirmation page for the caller's own pending second-person card, where they can decide it there themselves. */
  confirmPathOf(caller: Who, scope: { project: string; digest: string; expectedRevision: number }): Promise<string | undefined>;
  /** Slice 3: the fixture store, read side. With it a fake's line on the card says whether its answers were recorded or written by hand; without it the line says "a fake". */
  fixtureStore?: Pick<FixtureReadPort, "record"> | undefined;
}

/** One `approve_test_env` card per project that has a proved proposal waiting; the caller's projects only. A project that cannot be read is left out (fail closed). */
export async function approveTestEnvItemsFor(ports: TestEnvCardPorts, caller: Who, env: NodeJS.ProcessEnv = process.env): Promise<DecisionItem[]> {
  if (!testEnvironmentEnabled(env)) return [];
  const orgId = caller.orgId;
  const found: DecisionItem[] = [];
  for (const project of (await ports.maintainedProjects(caller)).slice(0, TEST_ENV_CARD_PROJECTS_MAX)) {
    try {
      const newest = await newestProposal(ports.store, orgId, project);
      if (newest === undefined) continue;
      const approved = await readApprovedTestEnvironment(ports.store, orgId, project);
      if (approved !== undefined && testEnvDigest(approved.environment) === newest.digest) continue;
      const body = await readProposal(ports.store, orgId, project, newest.digest);
      if (body === undefined || !testEnvIsProved(await readTestEnvProveReport(ports.store, orgId, project, newest.digest), newest.digest, body)) continue;
      const expectedRevision = approved?.revision ?? 0;
      // SEED-RISK-1: a seed the broker verified itself (the proposal item's own checks) is not less safe, and the card says why each seed command is medium or high.
      const trust = await proposalSeedTrust(ports.store, orgId, project, newest.digest, body);
      const lessSafe = testEnvLessSafeChanges(approved?.environment, body, trust);
      const { seedChecks } = await readProposalSources(ports.store, orgId, project, newest.digest);
      const seedReasons = seedCardLinesOf(seedRisksOf(seedChecks, body), seedChecks, body);
      // TE-2: a proposal a setup RUN made is approved only with the approver's fresh sign-in, which a one-press card cannot ask for: it is a high card that opens the setup page.
      // A setup draft's proposal ("Check and apply", UX-4b) needs the same fresh sign-in, so it is a high card that opens the setup page too.
      const setupRun = await proposalNeedsFreshSignIn(ports.store, orgId, project, newest.digest);
      const risk = lessSafe.length > 0 || setupRun ? "high" as const : testEnvApprovalRisk(body, trust);
      const dependencies = body.dependencies ?? [];
      const confirmPath = lessSafe.length > 0 ? await ports.confirmPathOf(caller, { project, digest: newest.digest, expectedRevision }) : undefined;
      found.push({
        kind: "approve_test_env", subjectId: newest.digest, project, title: `Test environment for ${project}`, createdAt: newest.proposedAt,
        openPath: `/app/onboard?project=${encodeURIComponent(project)}&step=setup`, ...(confirmPath === undefined ? {} : { confirmPath }),
        contentVersion: sha(`${newest.digest}:${String(expectedRevision)}`), risk, riskReasons: [...seedReasons, ...lessSafe.map(flagWords), ...(setupRun ? ["Made by Rovara on the setup page (a setup run or a setup draft): approve it there after signing in again."] : []), ...(dependencies.length > 0 ? [dependencyReason(dependencies.length)] : [])], tier: body.tier, expectedRevision,
        // Test services: the plain Dependencies section. Absent for an environment without any, so such a card is what it was.
        ...(dependencies.length > 0 ? { details: [{ title: "Dependencies", lines: dependencyCardLines(dependencies, await approvedFixturesOf(ports.fixtureStore, orgId, project, body)) }] } : {}),
      });
    } catch { /* a project whose proposal cannot be read has no card */ }
  }
  return found;
}

// ---- confirm_env_change

export interface EnvChangePorts {
  store: TestEnvDeps;
  task(taskId: string): Promise<DeveloperTaskRecord | undefined>;
  /** Decision journey slice 2: the task's page (its session, so the card's link names the card there). Absent or failing: the project's page, as before. */
  taskPagePathOf?: ((task: DeveloperTaskRecord) => Promise<string>) | undefined;
}

/** The checks of an environment as a running task depends on them: which commands run, in which order. A change to anything here is not a change a running task can take. */
const repoShape = (body: TestEnvironmentBody): string => JSON.stringify(body.repos.map((repo) => ({ repositoryId: repo.repositoryId, setup: repo.setupCommands, checks: repo.checks.map((check) => [check.id, check.kind, check.command, check.reportPath ?? null, check.coveragePath ?? null, check.sarifPath ?? null]) })));
/** Test services: the dependencies a running task started with are part of what it cannot change midway (a plan pins them), so a change to them is not offered to a running task. A body without dependencies shapes exactly as before. */
const checkShape = (body: TestEnvironmentBody): string => (body.dependencies === undefined || body.dependencies.length === 0 ? repoShape(body) : `${repoShape(body)}|${JSON.stringify(body.dependencies)}`);

/** Whether a running task may be offered `next` in place of the `pinned` revision: usable by tasks, the same commands, and not one bit less safe. */
export function takesTheChange(pinned: TestEnvironmentBody, next: TestEnvironmentBody): boolean {
  return checkShape(pinned) === checkShape(next) && testEnvLessSafeChanges(pinned, next).length === 0;
}

const owns = (task: DeveloperTaskRecord | undefined, caller: Who): task is DeveloperTaskRecord =>
  task !== undefined && task.orgId === caller.orgId && task.closedAt === undefined && task.releasedAt === undefined && task.purpose === undefined && tryEffectiveTaskOwner(task)?.developerId === caller.developerId;

/** The card for one running task: undefined when there is nothing to confirm (no pin, nothing newer, a change a running task does not take, or one the owner declined). */
async function changeItemOf(ports: EnvChangePorts, task: DeveloperTaskRecord): Promise<ChangeItem | undefined> {
  const orgId = task.orgId as OrgId;
  const pin = await readTestEnvPin(ports.store, orgId, task.project, task.taskId);
  if (pin === undefined || pin.unused !== undefined) return undefined;
  const latest = await readApprovedTestEnvironment(ports.store, orgId, task.project);
  if (latest === undefined || latest.revision <= pin.revision || environmentUnusedReason(latest) !== undefined) return undefined;
  const latestDigest = testEnvDigest(latest.environment);
  if (pin.declined === latestDigest) return undefined;
  const pinned = await readApprovedTestEnvironment(ports.store, orgId, task.project, pin.revision);
  if (pinned === undefined || testEnvDigest(pinned.environment) !== pin.digest || !takesTheChange(pinned.environment, latest.environment)) return undefined;
  // The person is shown every value that changes for their task, as before and after: a change to which tests run (the method, `selectArgs`, what always runs) is never summed up in one word.
  const lines = testEnvChangeLines(pinned.environment, latest.environment);
  return {
    kind: "confirm_env_change", subjectId: task.taskId, taskId: task.taskId, project: task.project, title: task.title, createdAt: latest.approvedAt,
    what: lines.some((line) => line.startsWith("selection")) || lines.some((line) => line.includes(".selectArgs:")) ? "selection" : "environment",
    openPath: (ports.taskPagePathOf === undefined ? undefined : await ports.taskPagePathOf(task).catch(() => undefined)) ?? `/app/projects/${encodeURIComponent(task.project)}`, contentVersion: sha(`${pin.digest}:${latestDigest}`),
    details: [{ title: "What changes for this task", lines }],
  };
}

/** The `confirm_env_change` cards of the caller's own running tasks. Reads at most `TEST_ENV_CARD_TASKS_MAX` task rows; a task that cannot be read is left out. */
export async function envChangeItemsFor(ports: EnvChangePorts, caller: Who, env: NodeJS.ProcessEnv = process.env): Promise<DecisionItem[]> {
  if (!testEnvironmentEnabled(env)) return [];
  const response = await ports.store.documentClient.send(new QueryCommand({
    TableName: ports.store.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${caller.developerId}`, ":prefix": "TASK#" },
    ScanIndexForward: false, Limit: TEST_ENV_CARD_TASKS_MAX, ConsistentRead: true,
  })) as { Items?: Array<{ taskId?: string; orgId?: string; status?: string }> };
  const found: DecisionItem[] = [];
  for (const row of response.Items ?? []) {
    if (row.orgId !== caller.orgId || row.status === "CLOSED" || typeof row.taskId !== "string") continue;
    try {
      const task = await ports.task(row.taskId);
      if (!owns(task, caller)) continue;
      const item = await changeItemOf(ports, task);
      if (item !== undefined) found.push(item);
    } catch { /* a task that cannot be read has no card */ }
  }
  return found;
}

const pinKey = (orgId: OrgId, project: string, taskId: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#PIN#${taskId}` });
const conditionFailed = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

export type EnvChangeOutcome = "moved" | "declined" | "gone";

/**
 * Approve or decline a task's `confirm_env_change`. The task, its owner and the change are judged again here, from the records: the caller must be the task's effective owner now, the task still running, and
 * the newest revision still a change the task takes. Approving moves the pin from exactly the revision and digest it holds to the newest ones (a conditional write, so a pin that moved is "gone"); declining
 * records the newest digest on the pin. Returns "gone" when there is no longer anything to confirm.
 */
export async function answerEnvChange(ports: EnvChangePorts, caller: Who, taskId: string, answer: "approve" | "decline"): Promise<EnvChangeOutcome> {
  const task = await ports.task(taskId);
  if (!owns(task, caller)) return "gone";
  const orgId = task.orgId as OrgId;
  const item = await changeItemOf(ports, task);
  if (item === undefined) return "gone";
  const pin = (await readTestEnvPin(ports.store, orgId, task.project, taskId))!;
  const latest = (await readApprovedTestEnvironment(ports.store, orgId, task.project))!;
  const digest = testEnvDigest(latest.environment);
  try {
    await ports.store.documentClient.send(new UpdateCommand(answer === "approve"
      ? {
        TableName: ports.store.tableName, Key: pinKey(orgId, task.project, taskId), UpdateExpression: "SET #revision = :next, #digest = :nextDigest REMOVE #declined",
        ConditionExpression: "#revision = :revision AND #digest = :digest AND attribute_not_exists(#unused)",
        ExpressionAttributeNames: { "#revision": "revision", "#digest": "digest", "#declined": "declined", "#unused": "unused" },
        ExpressionAttributeValues: { ":next": latest.revision, ":nextDigest": digest, ":revision": pin.revision, ":digest": pin.digest },
      }
      : {
        TableName: ports.store.tableName, Key: pinKey(orgId, task.project, taskId), UpdateExpression: "SET #declined = :declined",
        ConditionExpression: "#revision = :revision AND #digest = :digest AND attribute_not_exists(#unused)",
        ExpressionAttributeNames: { "#revision": "revision", "#digest": "digest", "#declined": "declined", "#unused": "unused" },
        ExpressionAttributeValues: { ":declined": digest, ":revision": pin.revision, ":digest": pin.digest },
      }));
  } catch (error) {
    if (conditionFailed(error)) return "gone";
    throw error;
  }
  return answer === "approve" ? "moved" : "declined";
}
