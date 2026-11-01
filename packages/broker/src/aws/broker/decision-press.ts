// Part of the broker: a decision card's button pressed in Slack (wire-proof). The interactivity Lambda hands the press to the broker (`decision-card-press`); the broker finds the REAL Rovara person behind it
// (`resolveSlackDecisionCaller`: the press's workspace, member workspace and grid agree, an org is bound to that install, the Slack user has a verified sign-in, and is a live member of THAT org: never the
// stand-in identity of a Slack user id), runs the press through the same card routes the web uses (so the evidence-first rule, the digest, the no-approve-on-high rule and the endpoint's own authority apply
// unchanged), and answers one fixed sentence for the Lambda to say privately. A Slack press carries no browser session, so a merge from Slack never merges on a click: it answers the confirmation page.
// With the cards switch off the answer is `enabled: false` and the Lambda says what it says for any button it does not know.
import { SLACK_OIDC_ISSUER, agentXError } from "@agentx/contracts";
import { DECISION_SLACK_TEXT, decisionSlackHandler, resolveSlackDecisionCaller, type SlackPersonLookups, type SlackPress } from "../../decisions/slack-actions.js";
import { routeDecisionCards } from "../../decisions/routes.js";
import { decisionRouteDepsOf } from "../developer-routes/decisions.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../developer-routes/types.js";
import { ownerKeyForSubject } from "../lambda.js";
import { signInStoreOf } from "../developer-routes/common.js";
import { safeDisplayName } from "../../developer/person-name.js";
import { endedByAdmin, startedBeforeMethodOn, type DeveloperRecord, type DeveloperSignInStore } from "../../developer/store.js";
import { methodAllowedByEdition } from "../../developer/edition-methods.js";
import { auditorAllowedByEdition } from "../../org/auditor.js";
import type { EditionPolicy } from "@agentx/contracts";
import { decisionCardsEnabled } from "../../proof/switch.js";
import { orgStoreOf } from "./dependency-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

export interface SlackDecisionPressEvent {
  source: "agentx.slack-ingress"; action: "decision-card-press";
  press: { actionId: string; value: string; userId: string; actionTs?: string; messageTs: string; userTeamId: string; workspaceTeamId: string; enterpriseId: string; userEnterpriseId: string };
}

const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length <= max;
export function isSlackDecisionPressEvent(event: unknown): event is SlackDecisionPressEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  if (value.source !== "agentx.slack-ingress" || value.action !== "decision-card-press" || value.requestContext !== undefined) return false;
  const press = value.press as Record<string, unknown> | null | undefined;
  return press !== null && press !== undefined && typeof press === "object" && text(press.actionId, 200) && text(press.value, 400) && text(press.userId, 40) && text(press.messageTs, 40)
    && (press.actionTs === undefined || text(press.actionTs, 40)) && text(press.userTeamId, 40) && text(press.workspaceTeamId, 40) && text(press.enterpriseId, 40) && text(press.userEnterpriseId, 40);
}

/** The sign-in policy a Slack press is held to, the one every request of a Slack session meets (`authenticateSession`): the edition's methods, the install's switch for the method and when it was last turned on. */
export interface SlackSignInPolicy {
  editionPolicy?: EditionPolicy | undefined;
  /** `developer.methods.slack`: whether Slack sign-in is on in this install. */
  slackOn: boolean;
  /** `developer.since.slack`: epoch seconds the method was last turned on; a sign-in from before it ended with it. */
  slackSince?: number | undefined;
}

/**
 * Whether the person's Slack sign-in still stands. A press has no session of its own, so the sign-in it rests on is the person's last Slack sign-in (`lastSignInAt`), and every rule a session meets is
 * applied to it: the install has Slack sign-in on, the edition offers it, it did not start before the method was last turned on, and an admin has not ended the person's sign-ins since (`sessionsEndedAt`).
 * An unreadable time fails closed.
 */
export function slackSignInStands(row: { revoked: boolean; lastSignInAt: string; sessionsEndedAt?: string | undefined }, policy: SlackSignInPolicy): boolean {
  if (row.revoked || !policy.slackOn || !methodAllowedByEdition(policy.editionPolicy, "slack")) return false;
  if (startedBeforeMethodOn(row.lastSignInAt, policy.slackSince) || endedByAdmin(row.lastSignInAt, row.sessionsEndedAt)) return false;
  return Number.isFinite(Date.parse(row.lastSignInAt));
}

/** The lookups over the sign-in store and the org store; each is exact, none guesses. */
export function slackPersonLookups(input: { signIn: Pick<DeveloperSignInStore, "developerForIdentity" | "getDeveloper" | "getIdentityLink">; orgs: Pick<ReturnType<typeof orgStoreOf>, "orgForSlackTeam" | "orgForDeveloper">; policy: SlackSignInPolicy }, signedIn: Map<string, DeveloperRecord>): SlackPersonLookups {
  return {
    orgOfSlackInstall: ({ teamId }) => input.orgs.orgForSlackTeam(teamId),
    async linkedDeveloper({ userId }) {
      // The developer a VERIFIED Slack sign-in of exactly this user belongs to (a link survives a merge: the survivor is returned), and only one that exists and is not revoked. A Slack user who never signed in has none;
      // the stand-in identity of `developerIdForSlackUser` is never used.
      const identityKey = ownerKeyForSubject(SLACK_OIDC_ISSUER, userId);
      const developerId = await input.signIn.developerForIdentity(identityKey);
      if (developerId === undefined) return undefined;
      const row = await input.signIn.getDeveloper(developerId);
      if (row === undefined) return undefined;
      // The sign-in the press rests on is this Slack identity's last one (the link item), not the person's last sign-in by any method; the person's own record only when no link item exists.
      const link = await input.signIn.getIdentityLink(identityKey);
      if (!slackSignInStands({ revoked: row.revoked, sessionsEndedAt: row.sessionsEndedAt, lastSignInAt: link?.lastSignInAt ?? row.lastSignInAt }, input.policy)) return undefined;
      signedIn.set(developerId, row);
      return developerId;
    },
    async memberRole(orgId, developerId) {
      const membership = await input.orgs.orgForDeveloper(developerId);
      if (membership === undefined || membership.orgId !== orgId) return undefined;
      // The Auditor is an Enterprise role: a membership that holds it where the edition does not is refused, as on every other request.
      if (membership.role === "auditor" && !auditorAllowedByEdition(input.policy.editionPolicy)) return undefined;
      return { orgId, developerId, orgRole: membership.role };
    },
  };
}

/** Handles one press; never throws. `enabled: false` while the cards switch is off (nothing else is read). */
export async function handleSlackDecisionPress(
  dependencies: AwsBrokerDependencies, routeDependencies: DeveloperRouteDependencies, event: SlackDecisionPressEvent, env: NodeJS.ProcessEnv = process.env,
  /** The card routes' dependencies for a caller (tests stand in). */
  seams: { cardDepsOf?: typeof decisionRouteDepsOf; lookupsOf?: (signedIn: Map<string, DeveloperRecord>) => SlackPersonLookups } = {},
): Promise<{ enabled: false } | { enabled: true; text: string }> {
  if (!decisionCardsEnabled(env)) return { enabled: false };
  let said = DECISION_SLACK_TEXT.failed as string;
  const signedIn = new Map<string, DeveloperRecord>();
  const lookups = seams.lookupsOf?.(signedIn) ?? slackPersonLookups({ signIn: signInStoreOf(routeDependencies), orgs: orgStoreOf(dependencies), policy: { editionPolicy: routeDependencies.editionPolicy, slackOn: routeDependencies.developer.methods.slack === true, slackSince: routeDependencies.developer.since?.slack } }, signedIn);
  const handler = decisionSlackHandler<DeveloperCaller>({
    async resolveCaller(press) {
      const member = await resolveSlackDecisionCaller(lookups, press);
      const row = member === undefined ? undefined : signedIn.get(member.developerId);
      if (member === undefined || row === undefined) return undefined;
      // The caller is the signed-in person with their live role. No browser session: the Slack press never carries one.
      return { developerId: member.developerId, sessionId: "slack-decision", amr: "slack", name: safeDisplayName(row.displayName, member.developerId), orgId: member.orgId, orgRole: member.orgRole as DeveloperCaller["orgRole"], slackUserId: event.press.userId };
    },
    async route(caller, request) {
      const cardDeps = (seams.cardDepsOf ?? decisionRouteDepsOf)(routeDependencies, caller, env);
      if (cardDeps === undefined) throw agentXError("NOT_FOUND", "cards are not set up");
      return routeDecisionCards(cardDeps, caller, request);
    },
    async respondEphemeral(_responseUrl, answer) { said = answer; },
  });
  const press: SlackPress = { ...event.press, responseUrl: "" };
  try { await handler.handle(press); } catch { said = DECISION_SLACK_TEXT.failed; }
  return { enabled: true, text: said };
}
