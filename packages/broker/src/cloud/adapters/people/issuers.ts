// Convergence A6 (`cloud/people`): the issuer of each Cloud approval method, built from the functions Cloud's routes use today. An issuer reads the token live and answers the person it stands for, or nothing.
//   browser-session  the review session id from the browser's cookie: `authenticateDeveloperSessionId` and the method switch (`authenticateCloudCredential`). The HTTP surface keeps the Origin and CSRF checks.
//   browser-step-up  "<review session id>:<decide session cookie>": the browser session above AND the decide-grade sign-in (`isDecideGradeSession`: this person, their org, email code, unused, unexpired, at most 10 minutes old),
//                    whose pending `card_decision` record is this person's, still pending and for this request's subject (the task). The press still claims and spends the session in its own commit.
//   chat-slack       a Slack press as the interactivity Lambda passed it (it checked Slack's signature), JSON with the press fields: `resolveSlackDecisionCaller` finds the linked, signed-in, live member behind it; never the
//                    stand-in identity of a Slack user id. Accept this method only from the internal Slack ingress.
//   api-token        a developer token: `authenticateDeveloper` (the token, its live session, the method, the company and role now). A script token is not a developer token and decides nothing.
import { z } from "zod";
import type { ApprovalRequest } from "@rovara-code/contracts";
import { getAnyApproval, type ApprovalDependencies } from "../../../agents/approvals.js";
import { SLACK_DECISION_SESSION_ID } from "../../../approval-place/evaluate.js";
import { isDecideGradeSession } from "../../../aws/developer-routes/card-decide-grade.js";
import type { DeveloperCaller } from "../../../aws/developer-routes/types.js";
import { resolveSlackDecisionCaller, type SlackPersonLookups } from "../../../decisions/slack-actions.js";
import { DecideStore } from "../../../developer/decide-session.js";
import { safeDisplayName } from "../../../developer/person-name.js";
import type { DeveloperRecord } from "../../../developer/store.js";
import type { OrgRole } from "@agentx/cloud-contracts";
import type { CloudApprovalIssuers, CloudDecider } from "./approvers.js";
import { authenticateCloudCredential, type CloudPeopleDependencies } from "./identity.js";
import { API_TOKEN_METHOD, BEARER_SCHEME, BROWSER_SESSION_METHOD, BROWSER_SESSION_SCHEME, BROWSER_STEP_UP_METHOD, CHAT_SLACK_METHOD } from "./methods.js";

const deciderOf = (caller: DeveloperCaller): CloudDecider => ({
  developerId: caller.developerId, sessionId: caller.sessionId, amr: caller.amr, name: caller.name, orgId: caller.orgId, orgRole: caller.orgRole,
  ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
});

const text = (max: number) => z.string().max(max);
/** The press fields the interactivity Lambda hands the broker (`SlackDecisionPressEvent.press`), strict. */
const SlackPressTokenSchema = z.object({
  userId: text(40), userTeamId: text(40), workspaceTeamId: text(40), enterpriseId: text(40), userEnterpriseId: text(40),
}).strict();

export interface CloudIssuerSources {
  routes: CloudPeopleDependencies;
  /** The Slack person lookups (`aws/broker/decision-press.ts` `slackPersonLookups`); absent: no `chat-slack` method. They record each signed-in person's row in the map they are given. */
  slackLookups?: (signedIn: Map<string, DeveloperRecord>) => SlackPersonLookups;
  /** The decision card a request is about, for the step-up's binding; default `planCardOf` (coding plans). */
  cardOf?: (request: ApprovalRequest) => CloudDecisionCard | undefined;
}

/** A browser session, as the web boundary would see it, or undefined. */
async function browserCaller(routes: CloudPeopleDependencies, sessionId: string): Promise<DeveloperCaller | undefined> {
  const answer = await authenticateCloudCredential(routes, { scheme: BROWSER_SESSION_SCHEME, value: sessionId });
  return "ok" in answer ? undefined : answer;
}

/** The decision card a request is about: the task, the card id and the version shown (the card's `contentVersion`). */
export interface CloudDecisionCard { taskId: string; cardId: string; contentVersion: string }

/**
 * The card of a coding plan's request, as the plan card names it (developer-routes/plan-cards.ts: id `approve_plan:<task>`, version the plan artifact's sha256, which is the request's digest). Any other request has no card
 * here, so a step-up for it is refused until its card is mapped.
 */
export function planCardOf(request: ApprovalRequest): CloudDecisionCard | undefined {
  if (request.kind !== "plan" || request.subject.type !== "task" || !/^[0-9a-f-]{36}$/iu.test(request.subject.id) || !/^[0-9a-f]{64}$/u.test(request.artifactDigest)) return undefined;
  return { taskId: request.subject.id, cardId: `approve_plan:${request.subject.id}`, contentVersion: request.artifactDigest };
}

export function cloudApprovalIssuers(sources: CloudIssuerSources): CloudApprovalIssuers {
  const { routes } = sources;
  const cardOf = sources.cardOf ?? planCardOf;
  const issuers: CloudApprovalIssuers = {
    async [BROWSER_SESSION_METHOD](token) {
      const caller = await browserCaller(routes, token);
      return caller === undefined ? undefined : deciderOf(caller);
    },

    async [BROWSER_STEP_UP_METHOD](token, request: ApprovalRequest) {
      const split = token.indexOf(":");
      if (split <= 0) return undefined;
      const sessionId = token.slice(0, split), cookie = token.slice(split + 1);
      if (cookie.length < 32 || cookie.length > 128) return undefined;
      const caller = await browserCaller(routes, sessionId);
      const agents = routes.agents as ApprovalDependencies | undefined;
      if (caller === undefined || agents === undefined) return undefined;
      const session = await new DecideStore({ documentClient: routes.documentClient, tableName: routes.developer.signInTableName, now: () => routes.now() }).getSession(cookie);
      if (!isDecideGradeSession(session, caller, Math.floor(routes.now() / 1000)) || !/^apr_[0-9a-z]{20}$/u.test(session.approvalId)) return undefined;
      const record = await getAnyApproval(agents, caller.orgId, session.approvalId);
      // The card the press decides, as the live press names it (`withCardDecideGrade`): this person's pending card_decision record for exactly this card and the version of it shown. A request whose card cannot be
      // named is refused, never matched loosely.
      const card = cardOf(request);
      if (card === undefined) return undefined;
      const bound = record?.kind === "change" && record.status === "PENDING" && Date.parse(record.expiresAt) > routes.now() && record.requestedBy === caller.developerId
        && record.subject.kind === "card_decision" && record.subject.taskId === card.taskId && record.subject.cardId === card.cardId && record.subject.contentVersion === card.contentVersion;
      return bound ? deciderOf(caller) : undefined;
    },

    async [API_TOKEN_METHOD](token) {
      const answer = await authenticateCloudCredential(routes, { scheme: BEARER_SCHEME, value: token });
      return "ok" in answer ? undefined : deciderOf(answer);
    },
  };
  const lookupsOf = sources.slackLookups;
  if (lookupsOf !== undefined) {
    issuers[CHAT_SLACK_METHOD] = async (token) => {
      let press: z.infer<typeof SlackPressTokenSchema>;
      try { press = SlackPressTokenSchema.parse(JSON.parse(token)); } catch { return undefined; }
      const signedIn = new Map<string, DeveloperRecord>();
      const member = await resolveSlackDecisionCaller(lookupsOf(signedIn), press);
      const row = member === undefined ? undefined : signedIn.get(member.developerId);
      if (member === undefined || row === undefined) return undefined;
      // The caller `handleSlackDecisionPress` builds: the signed-in person with their live role, the Slack decision session (never a browser session), the pressing Slack user.
      return { developerId: member.developerId, sessionId: SLACK_DECISION_SESSION_ID, amr: "slack", name: safeDisplayName(row.displayName, member.developerId), orgId: member.orgId, orgRole: member.orgRole as OrgRole, slackUserId: press.userId };
    };
  }
  return issuers;
}
