// Meta repo lane B (K1, fix round 1, I2): an approved card is consent for ONE application, and it does not last for ever.
//
// A card for a risky setup item (a repository to add, a dev container pull request, a source, an intake trigger, a secret) records that an administrator agreed. That
// agreement used to be read as "approved" for as long as the draft was current, so a maintainer could apply the same card again after the administrator (or anyone) had taken
// the change back. Now the application USES the consent up, in a conditional write made before the applier runs, the way `claimPullRequest` claims the pull request:
//
//   `SETUP_DRAFT#<org>#<project>` / `USED#<approvalId>`   written with `attribute_not_exists`; the request id that used it is kept so a retry of that same request may continue.
//
// A used card reads as dead (the person has to ask for a new one), and so does an approved card nobody used within `SETUP_CONSENT_MAX_AGE_MS`. A failed application gives the
// consent back, so the person can try again under the same card. Every applier that the registry holds (the built-in ones and the ones the source, intake and secret lanes
// register) goes through `applySetupDraft`, which calls these, so no applier has to remember to.
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, setupDraftKey, type OrgId } from "@agentx/contracts";

type Client = { send(command: unknown): Promise<unknown> };

/** How long an approved card stays usable. After this the administrator has to approve again. */
export const SETUP_CONSENT_MAX_AGE_MS = 7 * 86_400_000;
/** How long the record of a used consent is kept: longer than the consent could ever have been used. */
const USED_KEPT_SECONDS = 30 * 86_400;

export const SETUP_CONSENT_USED = "This approval was already used. Ask for a new approval if you want to apply it again.";

export interface SetupConsentDependencies { documentClient: Client; tableName: string; now: () => number }

const usedKey = (orgId: OrgId, project: string, approvalId: string) => ({ pk: setupDraftKey(orgId, project).pk, sk: `USED#${approvalId}` });

/** Whether this approved card was approved too long ago to be used (a missing time reads as too long: fail closed). */
export function consentHasExpired(decidedAt: string | undefined, now: number): boolean {
  const decided = decidedAt === undefined ? Number.NaN : Date.parse(decidedAt);
  return !Number.isFinite(decided) || now - decided > SETUP_CONSENT_MAX_AGE_MS;
}

/** Whether a card's consent was used already (by any request). */
export async function consentIsUsed(deps: SetupConsentDependencies, orgId: OrgId, project: string, approvalId: string): Promise<boolean> {
  const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: usedKey(orgId, project, approvalId), ConsistentRead: true }))) as { Item?: unknown };
  return found.Item !== undefined;
}

/**
 * Uses a card's consent up, before the change it allows is made. It holds for the first caller only (or for a repeat of the same request, which may be finishing what it
 * started); anyone else is refused with fixed words and changes nothing. Give it back with `giveBackConsent` when the change could not be made.
 */
export async function useConsent(
  deps: SetupConsentDependencies, input: { orgId: OrgId; project: string; approvalId: string; requestId: string; by: string },
): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...usedKey(input.orgId, input.project, input.approvalId), entityType: "SETUP_DRAFT_USED", orgId: input.orgId, project: input.project, approvalId: input.approvalId,
        requestId: input.requestId, by: input.by, at: new Date(deps.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + USED_KEPT_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(pk) OR requestId = :request",
      ExpressionAttributeValues: { ":request": input.requestId },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw agentXError("APPROVAL_CLOSED", SETUP_CONSENT_USED);
    throw error;
  }
}

/** Gives a consent back after a change that was not made. Only the request that used it can; if that cannot be done the consent stays used and the person asks again. */
export async function giveBackConsent(deps: SetupConsentDependencies, input: { orgId: OrgId; project: string; approvalId: string; requestId: string }): Promise<void> {
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName, Key: usedKey(input.orgId, input.project, input.approvalId),
      ConditionExpression: "requestId = :request", ExpressionAttributeValues: { ":request": input.requestId },
    }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "setup_draft.consent_not_returned", orgId: input.orgId, project: input.project, error: error instanceof Error ? error.name : "unknown" }));
  }
}
