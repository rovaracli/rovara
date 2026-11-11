// Approval place (U4, A-03, A-04): the ONE entry a comment feed (a tracker's comments, a code host's pull request comments) calls to decide a coding plan from a comment. Cloud has no comment feed yet; this is the door it must use, so
// a comment goes through the very gate Slack, a tool and the app go through (`decideTaskWorkflow` -> `approvalPlaceDecision`) and cannot make up its own rule.
//
// What the FEED has already done (core comment checks, owner decision 66, which Cloud adopts when the feed lands): the comment is on the right subject (the ticket or pull request linked to this task), was written after the notice that
// names this plan's short digest, is unedited, says the right command for the answer, is from a human, and is used once. What THIS entry adds is the person: the comment's outside account must resolve (`resolvePerson`, an exact lookup of a
// verified link, never a guess) to a live member of this company; the policy then asks for the role (owner, co-owner or maintainer), and, for a medium plan, a recent interactive Rovara sign-in inside the company's window.
// A high-risk plan is never decided from a comment, and a rejection is not either (both are answered with the card's link).
import { type OrgRole } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { decideTaskWorkflow } from "../aws/developer-tasks/decide.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks/types.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { linkAccountWords } from "./words.js";

/** The Rovara person an outside account is linked to in this company, from the feed's verified link. */
export interface CommentPerson { developerId: string; name: string; orgRole: OrgRole }

export const COMMENT_DECISION_SESSION_ID = "comment-decision";

export interface CommentDecisionInput {
  place: "tracker-comment" | "code-host-comment";
  orgId: OrgId;
  taskId: string;
  /** The outside account's person, or undefined when the account is not linked (the answer then asks them to link). */
  person: CommentPerson | undefined;
  /** What the comment's command asked: `/rovara approve <digest>` is APPROVE; a request for changes is REQUEST_CHANGES. Never REJECT (a rejection needs a signed-in session). */
  decision: "APPROVE" | "REQUEST_CHANGES";
  /** The workflow decision body the feed built from the comment (request id, revision, digest, reason ...); the decision checks every field again. */
  body: Record<string, unknown>;
  /** The link to the plan's card, for the refusal's words. */
  link?: string | undefined;
}

/** Decides from a comment. Throws the same refusals the other places do (`FORBIDDEN` with fixed words); never decides for an account that is not linked. */
export async function decideTaskFromComment(depsFor: (caller: DeveloperCaller) => DeveloperTaskRouteDependencies, input: CommentDecisionInput): Promise<ReturnType<typeof decideTaskWorkflow>> {
  if (input.person === undefined) throw agentXError("FORBIDDEN", linkAccountWords(input.link));
  if ((input.decision as string) !== "APPROVE" && (input.decision as string) !== "REQUEST_CHANGES") throw agentXError("FORBIDDEN", "A plan is rejected in Rovara, signed in.");
  // The person acts as themselves: their own id and live role, no browser session (a comment is never one), and the sign-in method of an interactive Rovara sign-in is not claimed (the policy reads their last one from the store).
  const caller: DeveloperCaller = { developerId: input.person.developerId, sessionId: COMMENT_DECISION_SESSION_ID, amr: "cloud", name: input.person.name, orgId: input.orgId, orgRole: input.person.orgRole };
  // `depsFor` builds the task dependencies BOUND TO THIS PERSON (their project access check, their role), as every route builds them for its caller: a comment never borrows another person's seat.
  return decideTaskWorkflow(depsFor(caller), caller, input.taskId, { ...input.body, decision: input.decision }, { place: input.place, commentAuthorLinked: true });
}
