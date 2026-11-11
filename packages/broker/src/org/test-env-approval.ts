// Setup wizard (E4): the SECOND person's confirmation of a less-safe test environment, as an approval card on the confirmation page (`/v1/app/approve/<id>`, which asks for a fresh sign-in).
//
// A less-safe change (pre-prod access, a shared or per-task environment, video or traces, a nightly run, a raised round budget, ...) needs two people: the maintainer who presses Approve in the setup wizard, and a
// second person who confirms it here. This module only makes and reads the second person's card; it applies nothing (the same way a setup suggestion's card does):
//   - `requestTestEnvCard` makes the card (or finds the live one), bound to the proposal's digest and to the revision of the approved environment the person looked at;
//   - the approver rule is read when the card is decided: the second person must be an owner or admin, or a maintainer of the project, and a different person from the one who asked, unless the company's records
//     say the asker is its only owner and nobody eligible has left in the last day (the sole-owner exception: `org/second-person-approval.ts`);
//   - confirming the card records consent and changes nothing;
//   - `confirmedTestEnvApproval` reads the confirmed card back for the asker's Approve press: the second person and the fresh sign-in proof the confirmation page recorded. `approveTestEnvironment` then reads both
//     people's live authority again and refuses a proof older than ten minutes, so a card confirmed long ago, by someone since demoted, or for a revision that has moved on, approves nothing.
// The card is single use by construction: it is bound to the approved revision the person looked at, and an approval moves that revision on.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AuditProofSchema } from "@agentx/cloud-contracts";
import { agentXError, projectPk, type OrgId } from "@rovara-code/contracts";
import { approvalIdFor, createPendingChange, getApproval, mayDecideApproval, registerApprovalSubjectHandler, registerApproverRule, type ApprovalDependencies, type ApprovalRecord } from "../agents/approvals.js";
import type { ApprovalCaller } from "../agents/approvals.js";
import { confirmationStands, decideFromRecords, type LessSafeApproval } from "./test-environment.js";

export const TEST_ENV_RULE = "test_env";
/** A confirmation card lives a day: long enough for the second person to get to it, short enough that a forgotten one does not wait for weeks. */
export const TEST_ENV_CARD_TTL_MS = 86_400_000;
/** How many cards one proposal can have (the first, then one for each earlier card that was declined or expired). */
export const TEST_ENV_CARD_ATTEMPTS_MAX = 6;

export const TEST_ENV_CARD_WORDS = {
  changes: (project: string, flags: readonly string[]) => `Confirm a less-safe test environment for ${project}: ${flags.length === 0 ? "it is above the sandbox" : flags.join(", ").replace(/_/gu, " ")}. Confirming it records your OK; the maintainer who asked then finishes the approval on the setup page.`,
  diffTitle: "Exactly what changes (before \u2192 after):",
  tooMany: "This proposal has had too many confirmation cards. Propose the environment again.",
  unavailable: "Confirmation cards are not set up in this deployment.",
  notDecided: "this has not been decided by anyone, so it can't be taken as confirmed",
} as const;

const isChange = (record: { kind: string }): record is ApprovalRecord => record.kind === "change";

/** The id a card's request carries: the same for the same proposal, revision, asker and attempt, so asking twice is one card. */
export function testEnvCardRequestId(digest: string, expectedRevision: number, askedBy: string, attempt: number): string {
  return createHash("sha256").update(`rovara-test-env-card|${digest}|${String(expectedRevision)}|${askedBy}|${String(attempt)}`).digest("hex").slice(0, 32);
}

/**
 * Registers the rule and the handler behind `test_env`. Safe to call more than once.
 *   rule     the second person, read NOW from the company's records (never from what they could do when the card was made): `readSecondPersonApprovalEvidence` for both people, then the shared
 *            second-person decision. No sign-in table, or any record that cannot be read, is a no.
 *   handler  consent only. A card nobody decided is never taken as consent.
 */
export function registerTestEnvApprovals(): void {
  registerApproverRule(TEST_ENV_RULE, async (deps, record, caller) => {
    if (!isChange(record) || record.subject.kind !== "test_env" || caller.orgId !== record.orgId || deps.modelSignInTableName === undefined) return false;
    try {
      await decideFromRecords(
        { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.modelSignInTableName, now: deps.now, soleOwnerTable: deps.teamRecordTable },
        { orgId: record.orgId, project: record.subject.project, proposerId: record.requestedBy, approverId: caller.developerId },
      );
      return true;
    } catch {
      return false;
    }
  });
  registerApprovalSubjectHandler("test_env", async (_deps, record) => {
    if (!isChange(record) || record.subject.kind !== "test_env") return;
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", TEST_ENV_CARD_WORDS.notDecided);
  });
}
registerTestEnvApprovals();

/** The confirmation a decided card holds, if it stands: decided on the confirmation page with a fresh sign-in proof, and still good (`confirmationStands`). A card that holds none reads as expired, so it is asked for again. */
export function confirmationOf(record: ApprovalRecord, nowMs: number): LessSafeApproval | undefined {
  if (record.decidedBy === undefined || record.decision !== "APPROVE") return undefined;
  const proof = AuditProofSchema.safeParse((record as { decisionProof?: unknown }).decisionProof);
  if (!proof.success || proof.data.kind !== "fresh_sign_in") return undefined;
  const signedInAtMs = Date.parse(proof.data.authTime), decidedAtMs = Date.parse(record.decidedAt ?? "");
  return confirmationStands(signedInAtMs, decidedAtMs, nowMs) ? { approverId: record.decidedBy, signedInAtMs, decidedAtMs, sessionRef: proof.data.sessionRef } : undefined;
}

export type TestEnvCardState = "none" | "pending" | "approved" | "expired";
export interface TestEnvCard { state: TestEnvCardState; approvalId?: string; record?: ApprovalRecord }

interface CardScope { orgId: OrgId; project: string; digest: string; expectedRevision: number; askedBy: string }

/** One attempt's card: the record when it is this proposal's, with the state it stands at. A card for another proposal or revision is not this one's. */
async function cardAt(deps: ApprovalDependencies, scope: CardScope, attempt: number): Promise<TestEnvCard> {
  const record = await getApproval(deps, scope.orgId, approvalIdFor(scope.orgId, scope.askedBy, testEnvCardRequestId(scope.digest, scope.expectedRevision, scope.askedBy, attempt)));
  const subject = record?.subject;
  if (record === undefined || subject?.kind !== "test_env" || subject.project !== scope.project || subject.digest !== scope.digest || subject.expectedRevision !== scope.expectedRevision || record.requestedBy !== scope.askedBy) return { state: "none" };
  switch (record.status) {
    case "PENDING":
    case "EXECUTING": return Date.parse(record.expiresAt) <= deps.now() ? { state: "expired", approvalId: record.approvalId, record } : { state: "pending", approvalId: record.approvalId, record };
    case "APPROVED":
    case "APPROVED_DONE": {
      if (record.decidedBy === undefined) return { state: "pending", approvalId: record.approvalId, record };
      // A confirmation is good for a day: after that the asker asks again (a new card), which is what the wizard offers for an expired one.
      return confirmationOf(record, deps.now()) !== undefined ? { state: "approved", approvalId: record.approvalId, record } : { state: "expired", approvalId: record.approvalId, record };
    }
    default: return { state: "expired", approvalId: record.approvalId, record };
  }
}

/** The card a proposal has now: the first attempt that is not dead, or the next attempt to ask for (`attempt === TEST_ENV_CARD_ATTEMPTS_MAX`: no more). */
export async function liveTestEnvCard(deps: ApprovalDependencies, scope: CardScope): Promise<{ card: TestEnvCard; attempt: number }> {
  let card: TestEnvCard = { state: "none" };
  for (let attempt = 0; attempt < TEST_ENV_CARD_ATTEMPTS_MAX; attempt += 1) {
    const found = await cardAt(deps, scope, attempt);
    if (found.state === "none") return { card, attempt };
    if (found.state === "pending" || found.state === "approved") return { card: found, attempt };
    card = found;
  }
  return { card, attempt: TEST_ENV_CARD_ATTEMPTS_MAX };
}

/**
 * Makes the confirmation card for a proposal the caller asked about (or finds the live one). The approvers are the rule above, so only a second person who is eligible NOW can confirm it. Returns the record;
 * the caller builds the confirmation link (it mints a ticket for the asker, and a read never does).
 */
export async function requestTestEnvCard(
  deps: ApprovalDependencies, caller: ApprovalCaller, input: { project: string; digest: string; expectedRevision: number; lessSafe: readonly string[]; /** Every change from the approved environment to the proposal, as lines (`testEnvChangeLines`): what the second person is shown. */ diff: readonly string[] },
): Promise<{ record: ApprovalRecord; state: "pending" | "approved" }> {
  const scope: CardScope = { orgId: caller.orgId, project: input.project, digest: input.digest, expectedRevision: input.expectedRevision, askedBy: caller.developerId };
  const { card, attempt } = await liveTestEnvCard(deps, scope);
  if ((card.state === "pending" || card.state === "approved") && card.record !== undefined) return { record: card.record, state: card.state };
  if (attempt >= TEST_ENV_CARD_ATTEMPTS_MAX) throw agentXError("CONFIG_INVALID", TEST_ENV_CARD_WORDS.tooMany);
  const record = await createPendingChange(deps, {
    orgId: caller.orgId, requestId: testEnvCardRequestId(input.digest, input.expectedRevision, caller.developerId, attempt), requestedBy: caller.developerId,
    subject: { kind: "test_env", project: input.project, digest: input.digest, expectedRevision: input.expectedRevision },
    changes: [TEST_ENV_CARD_WORDS.changes(input.project, input.lessSafe), TEST_ENV_CARD_WORDS.diffTitle, ...input.diff],
    approvers: { kind: "rule", rule: TEST_ENV_RULE, candidates: [] },
    expiresAt: new Date(deps.now() + TEST_ENV_CARD_TTL_MS).toISOString(),
  });
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return { record, state: "pending" };
}

/** What the asker's card stands at, for the state the wizard shows. */
export async function testEnvCardStateOf(deps: ApprovalDependencies, scope: CardScope): Promise<TestEnvCardState> {
  return (await liveTestEnvCard(deps, scope)).card.state;
}

/**
 * The second person's confirmation of the asker's card, as `approveTestEnvironment` takes it: who confirmed, the sign-in the confirmation page recorded and when they confirmed. Undefined unless a card of THIS
 * proposal and revision, asked by this person, was confirmed with a fresh sign-in proof that stood at the moment of confirming (`confirmationStands`: ten minutes of sign-in before it, a day after it). The
 * approval itself reads both people's authority and the same times again.
 */
export async function confirmedTestEnvApproval(deps: ApprovalDependencies, scope: CardScope): Promise<LessSafeApproval | undefined> {
  const { card } = await liveTestEnvCard(deps, scope);
  return card.state === "approved" && card.record !== undefined ? confirmationOf(card.record, deps.now()) : undefined;
}

// ---- TS-UX-1 item 1: the card on the setup page itself, for the person who asked and for the person who confirms

/** Who asked for a proposal's card, kept so ANY viewer of the setup page finds the card (a card's id is derived from its asker). Bound to the proposal and the approved revision it was asked against. */
const askKey = (orgId: OrgId, project: string, digest: string) => ({ pk: projectPk(orgId, project), sk: `TESTENV#ASK#${digest}` });
type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };

export async function recordTestEnvAsk(table: Table, scope: CardScope): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...askKey(scope.orgId, scope.project, scope.digest), entityType: "TEST_ENV_ASK", orgId: scope.orgId, project: scope.project, digest: scope.digest, expectedRevision: scope.expectedRevision, askedBy: scope.askedBy } }));
}

async function askerOf(table: Table, scope: Omit<CardScope, "askedBy">): Promise<string | undefined> {
  const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: askKey(scope.orgId, scope.project, scope.digest), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  return item !== undefined && item["orgId"] === scope.orgId && item["project"] === scope.project && item["digest"] === scope.digest && item["expectedRevision"] === scope.expectedRevision && typeof item["askedBy"] === "string" ? item["askedBy"] : undefined;
}

/**
 * The proposal's card as ONE viewer of the setup page sees it:
 *   - `status`: the card of whoever asked (the viewer, when nobody else has);
 *   - `askedByYou`: the viewer asked for it (they finish the approval once it is confirmed);
 *   - `youConfirm`: the card is waiting and the viewer may decide it NOW (the card's own live rule: a second person, or the asker when the sole-owner exception applies);
 *   - `approvalId`: given only to the asker and to a viewer who may confirm it, so the page can show the card itself; anyone else learns only that it waits.
 * Who may decide is the card's rule, unchanged; the card is decided through the decision cards' own Approve (the decide-grade email-code sign-in).
 */
export async function testEnvCardViewOf(deps: ApprovalDependencies, table: Table, scope: Omit<CardScope, "askedBy">, viewer: ApprovalCaller): Promise<{ status: TestEnvCardState; askedByYou: boolean; youConfirm: boolean; approvalId?: string }> {
  const asker = await askerOf(table, scope).catch(() => undefined) ?? viewer.developerId;
  const { card } = await liveTestEnvCard(deps, { ...scope, askedBy: asker });
  const askedByYou = asker === viewer.developerId && card.state !== "none";
  const youConfirm = card.state === "pending" && card.record !== undefined && await mayDecideApproval(deps, viewer, card.record).catch(() => false);
  const shown = card.approvalId !== undefined && (askedByYou || youConfirm);
  return { status: card.state, askedByYou, youConfirm, ...(shown ? { approvalId: card.approvalId } : {}) };
}
