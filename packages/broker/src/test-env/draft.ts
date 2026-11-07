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
import { z } from "zod";
import {
  INDEX_EXPIRY_ATTRIBUTE,
  SETUP_RECIPE_OFFERS_MAX,
  SetupRecipeIdSchema,
  parseSetupRecipeSource,
  TEST_ENV_DRAFT_MAX_BYTES,
  TEST_ENV_DRAFT_RESULT_KEY,
  TEST_ENV_ROUND_BUDGET_MIN,
  TestEnvDraftSchema,
  projectPk,
  redactText,
  testEnvLessSafeChanges,
  type OrgId,
  type TestEnvDraft,
  type TestEnvironmentBody,
} from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import type { TransactItem } from "../audit/outbox.js";
import { TEST_ENV_PROPOSAL_TTL_MS } from "../org/test-environment.js";
import { checkSelectionIsSafe, SAFE_SELECTION_METHODS } from "./prove-from-setup-check.js";
import { testEnvironmentEnabled } from "./switch.js";
import { refusedCommand } from "./refused-command.js";
import { testServicesEnabled } from "./test-services-switch.js";
import { proposeDependencies, type DependencyProposalContext } from "./dependency-proposal.js";
import { attachDraftSeeds } from "./seed-routing.js";

type Send = { send(command: unknown): Promise<unknown> };

export const DRAFT_SELECTION_NOTE = "A way of narrowing the tests that Rovara does not accept was left out; that check runs in full.";
export const DRAFT_TOO_LARGE_NOTE = "The environment Rovara found was too large to keep, so none is proposed.";
export const DRAFT_LEFT_OUT_NOTE = "A command that downloads and runs code, or that holds a secret, was left out of the proposal.";

const RecordedOffersSchema = z.array(z.object({ recipeId: SetupRecipeIdSchema, revision: z.number().int().min(1) }).strict()).max(SETUP_RECIPE_OFFERS_MAX);
const draftKey = (orgId: OrgId, project: string, taskId: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#DRAFT#${taskId}` });

// `refusedCommand` lives in ./refused-command.ts (a leaf module); re-exported here for the callers that always had it from this file.
export { refusedCommand };

/**
 * The safest environment, and nothing beyond: the draft is refused (undefined) when it asks for more. A worker never proposes a backing: the draft's own `environment.dependencies` must be empty (the broker adds
 * the dependencies it proposes itself, from the candidates, after this check).
 */
function isSafestEnvironment(body: TestEnvironmentBody): boolean {
  return body.tier === "sandbox" && (body.dependencies === undefined || body.dependencies.length === 0) && body.services.length === 0 && body.accounts.length === 0 && body.data.seeds.length === 0
    && body.preview === undefined && body.shared === undefined && !body.capture.video && !body.capture.traces && body.capture.screenshots === "failed"
    && SAFE_SELECTION_METHODS.includes(body.selection.method) && body.selection.declared === undefined
    && !body.nightly.enabled && body.roundBudgetMin === TEST_ENV_ROUND_BUDGET_MIN.min
    && body.prodDeny.accountIds.length === 0 && body.prodDeny.hosts.length === 0 && body.prodDeny.arnPrefixes.length === 0
    && testEnvLessSafeChanges(undefined, body).length === 0;
}

const plain = (text: string): string => redactText(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 400);

/**
 * What `sanitizeTestEnvDraft` needs for test services. `env` reads the install switch (default: the process environment). `propose` is given only by a reader that has the signed catalog and wants the
 * dependencies the broker proposes from the candidates; the write at the end of a setup draft gives none and keeps the validated candidates only.
 */
export interface DraftDependencyOptions { env?: NodeJS.ProcessEnv; propose?: { catalog: DependencyProposalContext["catalog"]; edition: DependencyProposalContext["edition"]; projectId: string } }

/**
 * The draft as the broker keeps it, or undefined when the worker's report is not a safe draft. Never throws.
 * Test services: with the switch `tx` off the candidates are dropped and the draft is exactly what it was. With it on they are carried through, validated (bounded, strict: `TestEnvDraftSchema`), and when
 * `options.propose` is given the broker turns them into the draft environment's `dependencies` (`proposeDependencies`). A draft whose own environment lists dependencies is refused whole by the schema: a worker
 * never proposes a backing.
 */
export function sanitizeTestEnvDraft(raw: unknown, options?: DraftDependencyOptions): TestEnvDraft | undefined {
  const parsed = TestEnvDraftSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const servicesOn = testServicesEnabled(options?.env);
  // An empty list is the same as none; no key is kept.
  const { dependencies: _empty, ...withoutDependencies } = parsed.data.environment;
  void _empty;
  if (!isSafestEnvironment(withoutDependencies)) return undefined;
  const { dependencies: candidates, seedCommands, ...rest } = parsed.data;
  // TS-UX-1: the seed commands travel with the candidates (test services on) and are attached to the database dependency when the draft is read with the catalog.
  const draft: TestEnvDraft = { ...rest, environment: withoutDependencies, ...(servicesOn && candidates !== undefined ? { dependencies: candidates } : {}), ...(servicesOn && seedCommands !== undefined && seedCommands.length > 0 ? { seedCommands } : {}) };
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > TEST_ENV_DRAFT_MAX_BYTES) return undefined;
  let leftOut = false;
  let narrowingDropped = false;
  const kept = new Set<string>();
  const repos = draft.environment.repos.map((repo) => {
    const setupCommands = repo.setupCommands.filter((command) => { const refused = refusedCommand(command); leftOut ||= refused; return !refused; });
    const checks = repo.checks.filter((check) => { const refused = refusedCommand(check.command); leftOut ||= refused; if (!refused) kept.add(check.id); return !refused; })
      // A narrowing argument other than the approved placeholder, or the placeholder on a command that is not a test runner taking test ids, is dropped (the check then runs in full), never carried.
      .map((check) => { if (checkSelectionIsSafe(check)) return check; narrowingDropped = true; const { selectArgs: _dropped, ...whole } = check; void _dropped; return whole; });
    return { ...repo, setupCommands, checks };
  });
  if (repos.every((repo) => repo.checks.length === 0)) return undefined;
  const environment: TestEnvironmentBody = {
    ...draft.environment,
    repos,
    selection: { ...draft.environment.selection, alwaysRun: draft.environment.selection.alwaysRun.filter((id) => kept.has(id)) },
  };
  // Test services: the BROKER proposes dependencies from the candidates (through `chooseBacking`, real catalog software only). Only when it has the catalog to do it with; a draft kept without one (the write at the end of
  // a setup draft) holds just the candidates, and the proposal is made when the draft is read.
  let dependencyNotes: string[] = [];
  if (servicesOn && options?.propose !== undefined && draft.dependencies !== undefined && draft.dependencies.length > 0) {
    const proposed = proposeDependencies(draft.dependencies, { catalog: options.propose.catalog, edition: options.propose.edition, projectId: options.propose.projectId, prodDeny: environment.prodDeny });
    const seeded = attachDraftSeeds(proposed.dependencies, draft.seedCommands);
    if (seeded.dependencies.length > 0) environment.dependencies = seeded.dependencies;
    dependencyNotes = [...proposed.notes, ...seeded.notes];
  }
  // A value source names a field by position: those of a dropped command would now point at another value, so the sources of a draft that lost something are kept only where they still line up (none).
  const valueSources = leftOut || narrowingDropped ? [] : draft.valueSources;
  return {
    environment, valueSources,
    pendingServices: draft.pendingServices.map((service) => ({ kind: service.kind, target: plain(service.target) })).filter((service) => service.target !== ""),
    ...(servicesOn && draft.dependencies !== undefined ? { dependencies: draft.dependencies } : {}),
    ...(draft.seedCommands === undefined ? {} : { seedCommands: draft.seedCommands }),
    notes: [...draft.notes.map(plain), ...(leftOut ? [DRAFT_LEFT_OUT_NOTE] : []), ...(narrowingDropped ? [DRAFT_SELECTION_NOTE] : []), ...dependencyNotes].filter((line) => line !== "").slice(0, 60),
    questions: draft.questions.map(plain).filter((line) => line !== "").slice(0, 60),
  };
}

/**
 * SR-3: a value source that cites a company recipe (`recipe:<id>@<revision>`) stays only if the BROKER offered exactly that recipe and revision to this run (the operation's record at dispatch). A worker's report is a claim:
 * a citation of a recipe it was not offered (another recipe of the company, another revision, an id it made up) is dropped before the draft is stored, so no later reader, card or host mark can rely on it. Other sources are untouched.
 */
export function onlyOfferedRecipeSources<T extends { source: unknown }>(valueSources: readonly T[], offers: ReadonlyArray<{ recipeId: string; revision: number }> | undefined): T[] {
  return valueSources.filter(({ source }) => {
    if (typeof source !== "string" || !source.startsWith("recipe:")) return true;
    const cited = parseSetupRecipeSource(source);
    return cited !== undefined && (offers ?? []).some((offer) => offer.recipeId === cited.id && offer.revision === cited.revision);
  });
}

/**
 * The item that keeps a setup draft's environment draft, for the transaction of the setup draft's terminal result. Nothing while the switch is off, for a task that is not a setup draft, for a run that did not
 * succeed, or for a report that is not a safe draft: the setup draft's own result is never touched by this.
 */
export function testEnvDraftEndItems(
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId" | "purpose" | "project"> & { orgId?: OrgId | undefined },
  operation: { kind: string; workflowMode?: string | undefined; /** SR-3: the recipes (id and revision) the BROKER offered this run at dispatch, copied from its own operation record. */ setupRecipeOffers?: ReadonlyArray<{ recipeId: string; revision: number }> | undefined },
  outcome: { status: string; result: unknown },
  nowIso: string,
  env: NodeJS.ProcessEnv = process.env,
): TransactItem[] {
  if (!testEnvironmentEnabled(env) || task.purpose !== "setup_draft" || task.orgId === undefined) return [];
  if (operation.kind !== "task" || operation.workflowMode !== "SETUP_DRAFT" || outcome.status !== "SUCCEEDED") return [];
  const reported = typeof outcome.result === "object" && outcome.result !== null ? (outcome.result as Record<string, unknown>)[TEST_ENV_DRAFT_RESULT_KEY] : undefined;
  if (reported === undefined) return [];
  // Test services: the validated candidates are kept with the draft (the dependencies are proposed when the draft is read, with the catalog).
  const sanitized = sanitizeTestEnvDraft(reported, { env });
  const draft = sanitized === undefined ? undefined : { ...sanitized, valueSources: onlyOfferedRecipeSources(sanitized.valueSources, operation.setupRecipeOffers) };
  if (draft === undefined) {
    // Too large to keep: a small marker says so (the setup draft's own write is never put at risk by a big item), and the state shows the fixed note. Any other refusal leaves nothing.
    const size = Buffer.byteLength(JSON.stringify(reported) ?? "", "utf8");
    return size > TEST_ENV_DRAFT_MAX_BYTES ? [{ Put: { TableName: tableName, Item: { ...draftKey(task.orgId, task.project, task.taskId), entityType: "TEST_ENV_DRAFT_REFUSED", orgId: task.orgId, project: task.project, taskId: task.taskId, reason: "too_large", at: nowIso, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((Date.parse(nowIso) + TEST_ENV_PROPOSAL_TTL_MS) / 1000) } } }] : [];
  }
  return [{ Put: {
    TableName: tableName,
    Item: { ...draftKey(task.orgId, task.project, task.taskId), entityType: "TEST_ENV_DRAFT", orgId: task.orgId, project: task.project, taskId: task.taskId, draft, at: nowIso,
      ...(operation.setupRecipeOffers === undefined || operation.setupRecipeOffers.length === 0 ? {} : { recipeOffers: operation.setupRecipeOffers.map(({ recipeId, revision }) => ({ recipeId, revision })) }), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((Date.parse(nowIso) + TEST_ENV_PROPOSAL_TTL_MS) / 1000) },
  } }];
}

/** The stored draft of a setup draft task, read again through the sanitizer (a damaged or unsafe item is "none"), or undefined. */
export async function readTestEnvDraft(client: Send, tableName: string, orgId: OrgId, project: string, taskId: string, nowMs: number, options?: DraftDependencyOptions): Promise<{ draft: TestEnvDraft; at: string; /** The recipes the broker offered the run that made this draft (id and revision); empty when none. */ recipeOffers: Array<{ recipeId: string; revision: number }> } | undefined> {
  const item = (await client.send(new GetCommand({ TableName: tableName, Key: draftKey(orgId, project, taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const stored = item.Item;
  if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId || typeof stored["at"] !== "string") return undefined;
  const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= nowMs) return undefined;
  if (stored["entityType"] !== "TEST_ENV_DRAFT") return undefined;
  const draft = sanitizeTestEnvDraft(stored["draft"], options);
  if (draft === undefined) return undefined;
  const offers = RecordedOffersSchema.safeParse(stored["recipeOffers"]);
  return { draft, at: stored["at"], recipeOffers: offers.success ? offers.data : [] };
}

/** The fixed note when the task's draft was too large to keep (a marker item), else undefined. */
export async function readTestEnvDraftNote(client: Send, tableName: string, orgId: OrgId, project: string, taskId: string, nowMs: number): Promise<string | undefined> {
  const item = (await client.send(new GetCommand({ TableName: tableName, Key: draftKey(orgId, project, taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const stored = item.Item;
  if (stored === undefined || stored["entityType"] !== "TEST_ENV_DRAFT_REFUSED" || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId) return undefined;
  const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
  return typeof expires === "number" && expires * 1000 <= nowMs ? undefined : DRAFT_TOO_LARGE_NOTE;
}
