// Setup and test health SH17 (owner decision F4, option D): the SECOND person's confirmation of "Mark as known failing", as an approval card on the confirmation page (`/v1/app/approve/<id>`, which asks for a fresh
// sign-in). It is the test-environment confirmation's pattern (org/test-env-approval.ts), word for word, for a different subject:
//   - `requestKnownFailingCard` makes the card (or finds the live one), bound to the Fix setup card it is for (project, cause, record epoch and version) and to the exact set of tests it marks (`testSetSha256`);
//   - the approver rule is read when the card is decided: the second person must be eligible NOW (an owner or admin, or a maintainer of the project) and a different person from the one who asked, unless the company's
//     records say the asker is its only owner and nobody eligible has left in the last day (the sole-owner exception: `org/second-person-approval.ts`) AND the company has not turned that exception off;
//   - confirming the card records consent and changes nothing;
//   - `confirmedKnownFailingApproval` reads the confirmed card back for the asker's second press: the second person and the fresh sign-in proof. `markKnownFailing` then reads both people's live authority again.
// A card is bound to the record's version: a task that joins after it was made, or a mark made meanwhile, makes it stale, and a new card is asked for.
import { createHash } from "node:crypto";
import { agentXError, type OrgId } from "@agentx/contracts";
import { approvalIdFor, createPendingChange, getApproval, registerApprovalSubjectHandler, registerApproverRule, type ApprovalCaller, type ApprovalDependencies, type ApprovalRecord } from "../agents/approvals.js";
import "../agents/approval-viewed.js"; // registers the decision guard that makes a confirmation need the page opened first
import { decideFromRecords, type LessSafeApproval } from "./test-environment.js";
import { confirmationOf } from "./test-env-approval.js";

export const KNOWN_FAILING_RULE = "known_failing";
/** A confirmation card lives a day, like the test environment's. */
export const KNOWN_FAILING_CARD_TTL_MS = 86_400_000;
/** How many cards one Fix setup card version can have (the first, then one for each earlier card that was declined or expired). */
export const KNOWN_FAILING_CARD_ATTEMPTS_MAX = 6;

export const KNOWN_FAILING_CARD_WORDS = {
  changes: (project: string, count: number) => `Confirm marking ${String(count)} test${count === 1 ? "" : "s"} as already failing for ${project}. Confirming it records your OK; the maintainer who asked then finishes the mark from the Fix setup card. These are the tests; open this page and read them first.`,
  tooMany: "This Fix setup card has had too many confirmation cards. Open the card again.",
  notDecided: "this has not been decided by anyone, so it can't be taken as confirmed",
} as const;

const isChange = (record: { kind: string }): record is ApprovalRecord => record.kind === "change";

export interface KnownFailingScope { orgId: OrgId; project: string; cause: string; epoch: number; recordVersion: number; testSetSha256: string; askedBy: string }

/** The id a card's request carries: the same for the same Fix setup card version, test set, asker and attempt, so asking twice is one card. */
export function knownFailingCardRequestId(scope: KnownFailingScope, attempt: number): string {
  return createHash("sha256").update(`rovara-known-failing-card|${scope.project}|${scope.cause}|${String(scope.epoch)}|${String(scope.recordVersion)}|${scope.testSetSha256}|${scope.askedBy}|${String(attempt)}`).digest("hex").slice(0, 32);
}

/** Registers the rule and the handler behind `known_failing`. Safe to call more than once. */
export function registerKnownFailingApprovals(): void {
  registerApproverRule(KNOWN_FAILING_RULE, async (deps, record, caller) => {
    if (!isChange(record) || record.subject.kind !== "known_failing" || caller.orgId !== record.orgId || deps.modelSignInTableName === undefined) return false;
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
  registerApprovalSubjectHandler("known_failing", async (_deps, record) => {
    if (!isChange(record) || record.subject.kind !== "known_failing") return;
    if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", KNOWN_FAILING_CARD_WORDS.notDecided);
  });
}
registerKnownFailingApprovals();

export type KnownFailingCardState = "none" | "pending" | "approved" | "expired";
export interface KnownFailingCard { state: KnownFailingCardState; approvalId?: string; record?: ApprovalRecord }

async function cardAt(deps: ApprovalDependencies, scope: KnownFailingScope, attempt: number): Promise<KnownFailingCard> {
  const record = await getApproval(deps, scope.orgId, approvalIdFor(scope.orgId, scope.askedBy, knownFailingCardRequestId(scope, attempt)));
  const subject = record?.subject;
  if (record === undefined || subject?.kind !== "known_failing" || subject.project !== scope.project || subject.cause !== scope.cause || subject.epoch !== scope.epoch || subject.recordVersion !== scope.recordVersion
    || subject.testSetSha256 !== scope.testSetSha256 || record.requestedBy !== scope.askedBy) return { state: "none" };
  switch (record.status) {
    case "PENDING":
    case "EXECUTING": return Date.parse(record.expiresAt) <= deps.now() ? { state: "expired", approvalId: record.approvalId, record } : { state: "pending", approvalId: record.approvalId, record };
    case "APPROVED":
    case "APPROVED_DONE": {
      if (record.decidedBy === undefined) return { state: "pending", approvalId: record.approvalId, record };
      return confirmationOf(record, deps.now()) !== undefined ? { state: "approved", approvalId: record.approvalId, record } : { state: "expired", approvalId: record.approvalId, record };
    }
    default: return { state: "expired", approvalId: record.approvalId, record };
  }
}

/** The card a Fix setup card version has now: the first attempt that is not dead, or the next attempt to ask for (`attempt === KNOWN_FAILING_CARD_ATTEMPTS_MAX`: no more). */
export async function liveKnownFailingCard(deps: ApprovalDependencies, scope: KnownFailingScope): Promise<{ card: KnownFailingCard; attempt: number }> {
  let card: KnownFailingCard = { state: "none" };
  for (let attempt = 0; attempt < KNOWN_FAILING_CARD_ATTEMPTS_MAX; attempt += 1) {
    const found = await cardAt(deps, scope, attempt);
    if (found.state === "none") return { card, attempt };
    if (found.state === "pending" || found.state === "approved") return { card: found, attempt };
    card = found;
  }
  return { card, attempt: KNOWN_FAILING_CARD_ATTEMPTS_MAX };
}

/** Makes the confirmation card for the asker's press (or finds the live one). Only a second person who is eligible NOW can confirm it. */
export async function requestKnownFailingCard(deps: ApprovalDependencies, caller: ApprovalCaller, input: Omit<KnownFailingScope, "askedBy" | "orgId"> & { tests: ReadonlyArray<{ name: string; checkId: string }> }): Promise<{ record: ApprovalRecord; state: "pending" | "approved" }> {
  const scope: KnownFailingScope = { orgId: caller.orgId, project: input.project, cause: input.cause, epoch: input.epoch, recordVersion: input.recordVersion, testSetSha256: input.testSetSha256, askedBy: caller.developerId };
  const { card, attempt } = await liveKnownFailingCard(deps, scope);
  if ((card.state === "pending" || card.state === "approved") && card.record !== undefined) return { record: card.record, state: card.state };
  if (attempt >= KNOWN_FAILING_CARD_ATTEMPTS_MAX) throw agentXError("CONFIG_INVALID", KNOWN_FAILING_CARD_WORDS.tooMany);
  const record = await createPendingChange(deps, {
    orgId: caller.orgId, requestId: knownFailingCardRequestId(scope, attempt), requestedBy: caller.developerId,
    subject: { kind: "known_failing", project: scope.project, cause: scope.cause, epoch: scope.epoch, recordVersion: scope.recordVersion, testSetSha256: scope.testSetSha256 },
    // The page lists every test the mark covers, in full (the card holds at most 20, each name at most 200 characters), one line each with its check: what the second person reads is what the mark does.
    changes: [KNOWN_FAILING_CARD_WORDS.changes(scope.project, input.tests.length), ...input.tests.map((test) => `${test.name} (check ${test.checkId})`)],
    approvers: { kind: "rule", rule: KNOWN_FAILING_RULE, candidates: [] },
    expiresAt: new Date(deps.now() + KNOWN_FAILING_CARD_TTL_MS).toISOString(),
  });
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return { record, state: "pending" };
}

/** The second person's confirmation of the asker's card: who confirmed and the fresh sign-in proof the confirmation page recorded. Undefined unless a card of THIS Fix setup card version and test set, asked by this person, was confirmed and the confirmation stands. */
export async function confirmedKnownFailingApproval(deps: ApprovalDependencies, scope: KnownFailingScope): Promise<LessSafeApproval | undefined> {
  const { card } = await liveKnownFailingCard(deps, scope);
  return card.state === "approved" && card.record !== undefined ? confirmationOf(card.record, deps.now()) : undefined;
}
