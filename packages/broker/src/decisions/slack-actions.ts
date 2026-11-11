// Decision cards on Slack (Decisions D4): what a press does. A press names only the card; it is turned into the same request the web sends and goes through `routeDecisionCards`, so the server's
// friction (evidence opened first for a medium card, no approve for a high one, the caller's own authority) applies to Slack exactly as to the web. A refusal is said to the person alone
// (ephemeral), in fixed words; nothing from the refusal's own text is shown.
import { createHash } from "node:crypto";
import { DecisionCardIdSchema, DecisionDigestSchema } from "@rovara-code/contracts";
import { DECISION_SLACK_ACTION_IDS, DECISION_SLACK_APPROVE_ACTION, DECISION_SLACK_OPEN_ACTION, DECISION_SLACK_REJECT_ACTION } from "./slack-card.js";
import { decisionCardPath } from "./project.js";
import type { StatusReply } from "../aws/status-reply.js";
import { slackRunLimitRefusal } from "../aws/slack-refusals.js";
import type { DecisionCaller, DecisionRequest } from "./routes.js";

/** A stable v4-shaped request id from the card and the press's own timestamp, so Slack's retry of one press is one decision. */
export function pressRequestId(cardId: string, actionTs: string): string {
  const hex = createHash("sha256").update(`decision-slack\0${cardId}\0${actionTs}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The press as a card request, or undefined for a button that is not a decision press (or a card id that is not one). Only an approve or a "not now" is a request. */
export function pressToRequest(press: { actionId: string; value: string; actionTs: string }): DecisionRequest | undefined {
  const [rawId, shownDigest, ...rest] = press.value.split("|");
  const id = DecisionCardIdSchema.safeParse(rawId);
  const digest = DecisionDigestSchema.safeParse(shownDigest);
  // An approve of a coding plan that raises the run limit carries the amount its message showed, as a third part: a plain amount, written the way `String` writes a number.
  const acknowledged = rest.length === 1 && press.actionId === DECISION_SLACK_APPROVE_ACTION ? Number(rest[0]) : undefined;
  if (!id.success || !digest.success || rest.length > 1 || (rest.length === 1 && (acknowledged === undefined || !Number.isFinite(acknowledged) || acknowledged < 0 || acknowledged > 100_000 || String(acknowledged) !== rest[0]))) return undefined;
  if (press.actionId === DECISION_SLACK_APPROVE_ACTION) return { method: "POST", pathname: `${decisionCardPath(id.data)}/approve`, searchParams: new URLSearchParams(), body: { requestId: pressRequestId(id.data, press.actionTs), shownDigest: digest.data, ...(acknowledged === undefined ? {} : { acknowledgedRunLimitUsd: acknowledged }) } };
  if (press.actionId === DECISION_SLACK_REJECT_ACTION) return { method: "POST", pathname: `${decisionCardPath(id.data)}/reject`, searchParams: new URLSearchParams(), body: { requestId: pressRequestId(id.data, press.actionTs), reason: "not_now" } };
  return undefined;
}

export const DECISION_SLACK_TEXT = Object.freeze({
  approved: "Approved.",
  rejected: "Noted. Not now.",
  openFirst: "Open the evidence on the web first, then approve it there.",
  changed: "This changed since the message was posted. Open it on the web to see the current version.",
  openToDecide: "This one is decided on its card in Rovara. Use Open.",
  gone: "This decision is no longer waiting for you.",
  unknownPerson: "I couldn't tell who you are in Rovara. Link your Slack account to Rovara on the web, then try again.",
  failed: "I couldn't record that. Open the decision on the web and try again.",
  forbidden: "You can't decide this.",
  notDecided: "Nothing was decided yet. Confirm it on the web:",
});

/** The fixed sentence for an error a route threw (by its code only). */
export function refusalText(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error).code : undefined;
  const message = typeof error === "object" && error !== null && "message" in error ? String((error).message) : "";
  if (code === "CHANGE_STALE") return message.includes("Open the evidence first") ? DECISION_SLACK_TEXT.openFirst : DECISION_SLACK_TEXT.changed;
  if (code === "NOT_FOUND") return DECISION_SLACK_TEXT.gone;
  if (code === "FORBIDDEN") return DECISION_SLACK_TEXT.forbidden;
  // QA6-12b: a plan approval refused over its run limit (no amount, or one that is not what approving sets now) is said with the amounts: they are numbers in fixed sentences, never a person's or a model's words.
  if (code === "CONFIG_INVALID") return slackRunLimitRefusal(message) ?? DECISION_SLACK_TEXT.failed;
  return DECISION_SLACK_TEXT.failed;
}

/** Everything the interactivity layer knows about a press: the signed-in-by-Slack identity is (enterprise grid, workspace, user), never the user id alone. */
export interface SlackPress {
  actionId: string; value: string; userId: string; actionTs?: string | undefined; messageTs: string; responseUrl: string;
  /** The clicking member's own workspace (`user.team_id`) and the workspace the click came through (`team.id`); empty when Slack sent none. */
  userTeamId: string; workspaceTeamId: string;
  /** The Enterprise Grid of the click and of the member; empty outside a grid. */
  enterpriseId: string; userEnterpriseId: string;
}

export interface DecisionSlackDependencies<C extends DecisionCaller> {
  /** The Rovara person behind a Slack press (see `resolveSlackDecisionCaller`), or undefined when it cannot be told (never guessed). */
  resolveCaller(press: SlackPress): Promise<C | undefined>;
  route(caller: C, request: DecisionRequest): Promise<StatusReply | undefined>;
  respondEphemeral(responseUrl: string, text: string): Promise<void>;
}

/** What to say for a route's answer. Only a decided answer says "Approved"; a confirmation page is a link, and nothing is claimed. */
export function pressAnswerText(press: SlackPress, reply: StatusReply | undefined): string {
  if (reply === undefined) return DECISION_SLACK_TEXT.gone;
  const body = reply.body as { outcome?: unknown; confirmUrl?: unknown };
  if (reply.statusCode === 202 && body.outcome === "needs_confirmation" && typeof body.confirmUrl === "string") return `${DECISION_SLACK_TEXT.notDecided} ${body.confirmUrl}`;
  if (reply.statusCode === 200 && body.outcome === "approved") return DECISION_SLACK_TEXT.approved;
  if (reply.statusCode === 200 && body.outcome === "rejected") return DECISION_SLACK_TEXT.rejected;
  return DECISION_SLACK_TEXT.failed;
}

/** A handler shaped like `SlackActionHandler` (matches / handle), ready for the interactivity list. The link buttons' own presses are acknowledged and ignored. */
export function decisionSlackHandler<C extends DecisionCaller>(deps: DecisionSlackDependencies<C>): { matches(actionId: string): boolean; handle(action: SlackPress): Promise<void> } {
  return {
    matches: (actionId) => DECISION_SLACK_ACTION_IDS.has(actionId),
    async handle(press) {
      if (press.actionId === DECISION_SLACK_OPEN_ACTION) return;
      const request = pressToRequest({ actionId: press.actionId, value: press.value, actionTs: press.actionTs ?? press.messageTs });
      if (request === undefined) { await deps.respondEphemeral(press.responseUrl, DECISION_SLACK_TEXT.gone); return; }
      const caller = await deps.resolveCaller(press);
      if (caller === undefined) { await deps.respondEphemeral(press.responseUrl, DECISION_SLACK_TEXT.unknownPerson); return; }
      let reply: StatusReply | undefined;
      try {
        reply = await deps.route(caller, request);
      } catch (error) {
        await deps.respondEphemeral(press.responseUrl, refusalText(error));
        return;
      }
      await deps.respondEphemeral(press.responseUrl, pressAnswerText(press, reply));
    },
  };
}

// ---- who pressed

/** What the existing identity linking can answer (bound to the sign-in table and the org store by the wiring): all lookups are exact, none guesses. */
export interface SlackPersonLookups {
  /** The org that installed the Slack app for this workspace (and grid), or undefined when no org is bound to it. */
  orgOfSlackInstall(input: { teamId: string; enterpriseId: string }): Promise<string | undefined>;
  /** The developer a Slack user is LINKED to by a verified sign-in (`SLACK_OIDC_ISSUER` identity), or undefined for a user who never linked. Never the pseudo identity of `developerIdForSlackUser`. */
  linkedDeveloper(input: { teamId: string; userId: string }): Promise<string | undefined>;
  /** The person's live membership in the org: their role, or undefined when they are not a member (or were revoked or removed). */
  memberRole(orgId: string, developerId: string): Promise<DecisionCaller & { orgRole: string } | undefined>;
}

/**
 * The real Rovara person behind a press, or undefined. All of these must hold: the press has a user, a workspace and a member workspace and they agree (no Slack Connect guest from another
 * workspace); a Rovara org is bound to that workspace's install; the Slack user is linked to a developer; that developer is a live member of THAT org. The stand-in identity of
 * `developerIdForSlackUser` is never used, so the person's approvals, evidence-opened records and role are the web person's.
 */
export async function resolveSlackDecisionCaller(lookups: SlackPersonLookups, press: Pick<SlackPress, "userId" | "userTeamId" | "workspaceTeamId" | "enterpriseId" | "userEnterpriseId">): Promise<(DecisionCaller & { orgRole: string }) | undefined> {
  if (press.userId === "" || press.workspaceTeamId === "" || press.userTeamId === "" || press.userTeamId !== press.workspaceTeamId) return undefined;
  if (press.userEnterpriseId !== press.enterpriseId) return undefined;
  const orgId = await lookups.orgOfSlackInstall({ teamId: press.workspaceTeamId, enterpriseId: press.enterpriseId });
  if (orgId === undefined) return undefined;
  const developerId = await lookups.linkedDeveloper({ teamId: press.workspaceTeamId, userId: press.userId });
  if (developerId === undefined) return undefined;
  const member = await lookups.memberRole(orgId, developerId);
  return member !== undefined && member.orgId === orgId && member.developerId === developerId ? member : undefined;
}
