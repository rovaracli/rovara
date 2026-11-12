// Convergence A6 (`cloud/people`): Cloud's Approvers on Code's port. A wrapper over the rules Cloud enforces today, with NO rule of its own:
//   - the place rule is `evaluateApprovalPlace` (approval-place/evaluate.ts -> `approvalPlaceDecision`): low anywhere by a linked person; medium in a signed-in browser, or from Slack by a linked person whose last interactive
//     Rovara sign-in is inside the company's window; high only in a signed-in browser under the decide-grade sign-in; a rejection only in a signed-in browser under it; request changes from any place a linked person reaches;
//   - who may decide (owner, co-owner, maintainer; a collaborator a low product decision; nobody else) is the same function's, given the decider's standing on the subject (`deciderRole`, the caller's own read);
//   - the second-person rule by risk (`approvalByRisk`: how many people a tier needs, and a proposer approving their own work only through the sole-owner exception with its 24-hour cool-off) is `secondPersonOutcome`;
//   - the Auditor (and any role that is not a writer's) never approves (`isWriterOrgRole`); a person of another company never approves (the proof's person is read live, the request's company compared).
// The token of every method is checked by its issuer (`issuers.ts`), the functions the routes use; a person or account the proof only CLAIMS is never believed.
// Not expressed here (owed upstream, `gaps.ts`): the company's sign-in window applies to MEDIUM approvals from outside places, which the port's `signIn` rule (high-risk and rejections) cannot say, so `signIn` is left
// unset and the window is enforced inside `verify`; and the sole-owner exception, which the port's `selfApprovalAllowed` cannot say.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { approvalProofKey, companyScoped, type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalVerdict, type Approvers, type Principal } from "@rovara-code/contracts";
import { APPROVAL_DECISION_KINDS, isWriterOrgRole, type ApprovalDeciderRole, type ApprovalDecisionKind, type OrgRole } from "@agentx/cloud-contracts";
import { evaluateApprovalPlace, type PlaceDependencies } from "../../../approval-place/evaluate.js";
import { approversRequired, secondPersonOutcome, type ApprovalEligibility, type ApprovalLevels } from "../../../org/approval-by-risk.js";
import { AUDITOR_REFUSED } from "../../../org/auditor.js";
import { BROWSER_STEP_UP_METHOD, CLOUD_APPROVAL_METHODS, CLOUD_STRONG_METHODS, PLACE_OF_METHOD, isCloudApprovalMethod, type CloudApprovalMethod } from "./methods.js";

/** The person a proof's token stands for, as the issuer read it live: their id, session, sign-in method, company and role NOW, and (for a Slack press) the Slack user. */
export interface CloudDecider {
  developerId: string;
  sessionId: string;
  amr: string;
  name: string;
  orgId: string;
  orgRole: OrgRole;
  slackUserId?: string | undefined;
}

/** Checks one method's token with its issuer. Undefined (or a thrown refusal) when the token does not check out. */
export type CloudApprovalIssuer = (token: string, request: ApprovalRequest) => Promise<CloudDecider | undefined>;
export type CloudApprovalIssuers = Partial<Record<CloudApprovalMethod, CloudApprovalIssuer>>;

/** The second-person rule's facts for a request that has one (a lesson, a design review, a test environment), read fresh by the caller from its own store; undefined when the request has no second-person rule. */
export interface SecondPersonFacts {
  /** The tier code decided (a model's words can only raise it). */
  tier: 0 | 1 | 2;
  levels: ApprovalLevels;
  eligibility: ApprovalEligibility;
  /** Who proposed or wrote it. */
  proposerId: string;
  /** Which approval-place kind the request answers to (for example `design`). */
  placeKind: ApprovalDecisionKind;
}

export interface CloudApproversDependencies {
  issuers: CloudApprovalIssuers;
  /** The decider's standing on the request's subject, read live by the caller (for a coding plan: the task's owner or co-owner, or a project maintainer who may decide it). */
  deciderRole(request: ApprovalRequest, decider: CloudDecider): Promise<ApprovalDeciderRole>;
  /** What the place rule reads: the sign-in table (who is linked, when they last signed in) and the State table (the company's window). */
  place: PlaceDependencies;
  secondPerson?: (request: ApprovalRequest) => Promise<SecondPersonFacts | undefined>;
  /** Whether a proof was already used, by its `approvalProofKey`, in the store the caller's commit writes its marker to (`coreProofMarkerReader`). Absent: only this instance's own memory (gaps.ts G3). */
  proofUsed?: (companyId: string, proofKey: string) => Promise<boolean>;
}

/** Reads the marker Code's decision gate writes for a used proof (core/decisions/approval-gate.ts `approvalProofMarkerKey`: the company's APPROVAL_PROOF partition, keyed by the proof key), so a proof spent by any instance is refused. */
export function coreProofMarkerReader(input: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }): (companyId: string, proofKey: string) => Promise<boolean> {
  return async (companyId, proofKey) => {
    const answer = await input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: { pk: companyScoped(companyId, "APPROVAL_PROOF"), sk: proofKey }, ConsistentRead: true })) as { Item?: unknown };
    return answer.Item !== undefined;
  };
}

const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason });
const isPlaceKind = (kind: string): kind is ApprovalDecisionKind => (APPROVAL_DECISION_KINDS as readonly string[]).includes(kind);

export function createCloudApprovers(deps: CloudApproversDependencies): Approvers {
  const offered = (): CloudApprovalMethod[] => CLOUD_APPROVAL_METHODS.filter((method) => deps.issuers[method] !== undefined);
  /** Proofs this instance accepted (the port's courtesy check; the caller's transaction with `approvalProofKey` is the guarantee). */
  const used = new Set<string>();

  return {
    async requirement(request: ApprovalRequest): Promise<ApprovalRequirement> {
      const methods = offered();
      const strong = CLOUD_STRONG_METHODS.filter((method) => methods.includes(method));
      const facts = await deps.secondPerson?.(request);
      return {
        methods,
        minApprovers: facts === undefined ? 1 : Math.max(1, approversRequired(facts.tier, facts.levels)),
        // The task owner approves their own plan; where a second person is required the proposer is not one (the sole-owner exception is checked in `verify`, see gaps.ts).
        selfApprovalAllowed: facts === undefined,
        strongMethods: strong,
        rejectMethods: strong,
        changesMethods: methods,
      };
    },

    async verify(request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
      if (proof.requestId !== request.requestId || proof.revision !== request.revision || proof.artifactDigest !== request.artifactDigest) return refuse("the proof is for another request, revision or content");
      if (typeof proof.token !== "string" || proof.token === "") return refuse("the proof has no token");
      if (request.expiresAt !== undefined) {
        const expires = Date.parse(request.expiresAt);
        if (!Number.isFinite(expires) || expires <= deps.place.now()) return refuse("the request has expired");
      }
      if (!isCloudApprovalMethod(proof.method)) return refuse("this method is not one Rovara Cloud accepts");
      const issuer = deps.issuers[proof.method];
      if (issuer === undefined) return refuse("this method is not offered here");
      const proofKey = approvalProofKey(proof);
      if (used.has(proofKey)) return refuse("this proof was already used");
      try {
        if (deps.proofUsed !== undefined && await deps.proofUsed(request.companyId, proofKey)) return refuse("this proof was already used");
      } catch {
        return refuse("whether this proof was used could not be checked just now");
      }
      const risk = request.risk;
      if (risk === undefined) return refuse("the request's risk is not known");

      let decider: CloudDecider | undefined;
      try { decider = await issuer(proof.token, request); } catch { decider = undefined; }
      if (decider === undefined) return refuse("the proof did not check out with its issuer");
      if (decider.orgId !== request.companyId) return refuse("the person is not in this company");
      if (!isWriterOrgRole(decider.orgRole)) return refuse(AUDITOR_REFUSED);

      const facts = await deps.secondPerson?.(request);
      const kind = facts?.placeKind ?? request.kind;
      if (!isPlaceKind(kind)) return refuse("this kind of request has no Cloud approval rule here");
      const answer = request.outcome ?? "approve";
      let role: ApprovalDeciderRole;
      try { role = await deps.deciderRole(request, decider); } catch { return refuse("who may decide this could not be read"); }

      try {
        const placed = await evaluateApprovalPlace(deps.place, {
          orgId: request.companyId, caller: { developerId: decider.developerId, sessionId: decider.sessionId, slackUserId: decider.slackUserId },
          kind, risk, answer, place: PLACE_OF_METHOD[proof.method], role, freshSignIn: proof.method === BROWSER_STEP_UP_METHOD,
        });
        if (!placed.verdict.allowed) return refuse(placed.verdict.reason);
      } catch {
        return refuse("where this can be approved could not be checked just now");
      }

      if (facts !== undefined && answer === "approve") {
        const outcome = secondPersonOutcome(facts.eligibility, facts.proposerId, decider.developerId, deps.place.now());
        if (!outcome.ok) return refuse(outcome.code);
      }

      used.add(proofKey);
      const approver: Principal = { companyId: decider.orgId, personId: decider.developerId, displayName: decider.name, roles: [decider.orgRole], provider: decider.amr, methods: [decider.amr] };
      return { approved: true, approver, method: proof.method, proofId: proof.proofId };
    },
  };
}
