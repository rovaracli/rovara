import { type OrgRole } from "./org.js";
import { randomBytes } from "node:crypto";
import { GITHUB_INSTALLATION_TAKEN_MESSAGE, normalizeEmail, type OrgId, OrgIdSchema, type OrgKey, orgPk, orgScoped } from "@rovara-code/contracts";

export interface OrgRecord {
  orgId: OrgId;
  name: string;
  createdAt: string;
  /** developerId of the creator. */
  createdBy: string;
  plan: "trial" | "team";
  /** When connecting GitHub unlocked this trial org (epoch milliseconds); absent while it is locked. Only a `trial` org is ever locked. */
  trialUnlockedAt?: number;
  /** A GitHub connection could not unlock this trial because its account had already claimed another trial. */
  trialGithubUsedAt?: number;
  /** False after an explicit organization rename; absent on initial organization records. */
  nameIsDefault?: boolean;
  /** The GitHub account whose connection unlocked the trial; it can unlock no other org. */
  trialGithubUserId?: string;
  /** When the org was closed (its sole owner left; before 0.5.15 also a duplicate sign-in's race org, which no merge closes any more); a closed org takes no new members. */
  closedAt?: string;
  /** Set while the sole owner's leave closes the org: from then on no invite is accepted into it. A stopped close is run again by the owner. */
  closingAt?: string;
}

export interface OrgMembershipRecord {
  orgId: OrgId;
  developerId: string;
  role: OrgRole;
  joinedAt: string;
}

export interface OrgInviteRecord {
  /** Sparse directory id; absent on legacy invites. Never the bearer token or its hash. */
  inviteId?: string;
  orgId: OrgId;
  tokenHash: string;
  email?: string;
  /** An invite makes an admin or a member. An owner is never invited, and the Auditor is set by a role change or a group mapping, never by an invite link. */
  role: Exclude<OrgRole, "owner" | "auditor">;
  createdBy: string;
  /** The request that created it (POST /v1/dev/org/invites); a replay of that request is refused. */
  requestId?: string;
  createdAt: string;
  expiresAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revision?: number;
  /** A-31: the project the person also joins, and their role in it. Absent on a company-only invite (and on every invite made before 0.5.14). */
  project?: { name: string; role: "maintainer" | "contributor" | "viewer" };
  /** A-31: who could make the project part: `admin` (an owner or admin) or `maintainer` (the project's own maintainer, whose authority is checked again at the join). */
  projectInviter?: "admin" | "maintainer";
}

const ORG_ID_BODY_LENGTH = 20;

const MIN_RANDOM_BYTES = 16;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * 20 base36 characters from at least 16 random bytes. The value is reduced modulo 36^20, so the
 * mapping is uniform up to a bias below 2^-24 for 16 bytes and smaller for more.
 */
export function newOrgId(random: () => Uint8Array = () => randomBytes(32)): OrgId {
  const bytes = random();
  if (bytes.length < MIN_RANDOM_BYTES) throw new Error(`org id needs at least ${MIN_RANDOM_BYTES} random bytes`);
  const body = (bytesToBigInt(bytes) % 36n ** BigInt(ORG_ID_BODY_LENGTH)).toString(36).padStart(ORG_ID_BODY_LENGTH, "0");
  return OrgIdSchema.parse(`org_${body}`);
}

export function orgMetaKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "META" };
}

export function orgMemberKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `MEMBER#${developerId}` };
}

/** Pointer from a developer to their org. */
export function developerOrgKey(developerId: string): OrgKey {
  return { pk: `DEVELOPER_ORG#${developerId}`, sk: "ORG" };
}

/** Org-scoped sparse invite reference, independent of bearer material. */
export function orgInviteDirectoryKey(orgId: OrgId, inviteId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `INVITE_DIRECTORY#${inviteId}` };
}

export function orgInviteKey(tokenHash: string): OrgKey {
  return { pk: `ORG_INVITE#${tokenHash}`, sk: "META" };
}

/** Marks that an org's invite request was served, so a replay of the same requestId is refused rather than minting a second invite. */
export function orgInviteRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `INVITE_REQUEST#${requestId}` };
}

/** Marks that an org's project creation request was served (a day), so a replay of the same requestId answers the project it made. */
export function projectCreateRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, "PROJECT_CREATE_REQUEST"), sk: requestId };
}

export function slackTeamOrgKey(teamId: string): OrgKey {
  return { pk: `SLACK_TEAM#${teamId}`, sk: "ORG" };
}

/** The claim a GitHub account holds on the one trial it unlocked. Global, not org-scoped: a second org must find it. */
export function trialGithubKey(githubUserId: string): OrgKey {
  return { pk: `TRIAL_GITHUB#${githubUserId}`, sk: "ORG" };
}

export function orgEmailKey(email: string): OrgKey {
  return { pk: `ORG_EMAIL#${normalizeEmail(email).email}`, sk: "DEVELOPER" };
}

/** A developer removed from a single-org install, who may not rejoin it by signing in again until an invite clears this item. */
export function orgBanKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "BAN"), sk: developerId };
}

/**
 * Written when a person is removed from an org or leaves it, and never deleted. A task's creator who is not a member is refused (ruling
 * R60) only when this says they once were: a Slack user who has not signed in yet has no member record and is not removed.
 */
export function orgRemovedKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "REMOVED"), sk: developerId };
}

/** The reverse of `slackTeamOrgKey`, in the org's own partition, so closing the org finds the Slack teams it bound. */
export function orgSlackTeamKey(orgId: OrgId, teamId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `SLACK_TEAM#${teamId}` };
}

/** A GitHub App installation bound to an org. Global, so a second org finds it. */
export function githubInstallationKey(installationId: number): OrgKey {
  return { pk: `GITHUB_INSTALLATION#${String(installationId)}`, sk: "ORG" };
}

/**
 * The index GitHub's events find a project by: one item per (GitHub repository id, org, project), global and holding ids only. It is written in the transaction of each revision that
 * pins the repository and deleted by the one that removes it. An event trusts it for nothing but a lead: the installation's org and the project's latest revision decide.
 */
export function githubRepoProjectKey(githubRepositoryId: number, orgId: OrgId, project: string): OrgKey {
  return { pk: `GITHUB_REPO#${String(githubRepositoryId)}`, sk: `${orgId}#${project}` };
}

/** The same binding in the org's own partition, so closing the org finds its installations. */
export function orgGithubInstallationKey(orgId: OrgId, installationId: number): OrgKey {
  return { pk: orgPk(orgId), sk: `GITHUB_INSTALLATION#${String(installationId)}` };
}

/**
 * One connect attempt (Plan 2, Task 13), keyed by the SHA-256 of its state (base64url). It holds who started it and for which org, and
 * later what the callback found and the hash of the confirmation token; it is single use (`consumedAt`) and short lived (`expiresAt`).
 */
export function githubConnectStateKey(stateHash: string): OrgKey {
  return { pk: `GITHUB_CONNECT#${stateHash}`, sk: "META" };
}

/**
 * Written once when an installation is first bound to an org, and never deleted (not by a disconnect, not by closing the org): it says the
 * installation was bound before. `firstBoundAt` and `firstOrgId` are set only the first time. Task 14's request flow never binds an
 * installation that has one.
 */
export function githubInstallationEverBoundKey(installationId: number): OrgKey {
  return { pk: `GITHUB_INSTALLATION#${String(installationId)}`, sk: "EVER_BOUND" };
}

/** How long a request to a GitHub admin stays open (Plan 2, Task 14). A request not approved by then is `expired`. */
export const GITHUB_INSTALL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type GithubInstallRequestStatus = "waiting" | "connected" | "declined" | "taken" | "reinstall_needed" | "cancelled";

/**
 * A Rovara owner or admin who is not an admin of their GitHub organization asked that organization's GitHub admin to approve the App
 * (Plan 2, Task 14). Global, because GitHub's `installation.created` webhook knows only the requesting GitHub user: one request per GitHub
 * user. A newer request replaces one that is not `waiting`, or a `waiting` one of the same developer.
 */
export function githubInstallRequestKey(githubUserId: string): OrgKey {
  return { pk: `GITHUB_INSTALL_REQUEST#${githubUserId}`, sk: "META" };
}

/** The same request in the org's own partition, so the org can list its requests. */
export function orgGithubInstallRequestKey(orgId: OrgId, githubUserId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `GITHUB_INSTALL_REQUEST#${githubUserId}` };
}

/** The sweep's index of `waiting` requests (the 2-day reminder), oldest first. Deleted when the request leaves `waiting`. */
export const GITHUB_INSTALL_REQUEST_QUEUE_PK = "GITHUB_INSTALL_REQUEST_QUEUE";

export function githubInstallRequestQueueKey(requestedAt: number, githubUserId: string): OrgKey {
  return { pk: GITHUB_INSTALL_REQUEST_QUEUE_PK, sk: `${String(requestedAt)}#${githubUserId}` };
}

/** A webhook delivery whose installation request was decided (bound or not); a redelivery of it does nothing. Expires through DynamoDB's time to live. */
export function githubDeliveryKey(deliveryId: string): OrgKey {
  return { pk: `GITHUB_DELIVERY#${deliveryId}`, sk: "INSTALL_REQUEST" };
}

/** One entry of an org's GitHub audit trail, written in the same transaction as what it records. Never expires. */
export function githubAuditKey(orgId: OrgId, at: string, id: string): OrgKey {
  return { pk: orgScoped(orgId, "GITHUB_AUDIT"), sk: `${at}#${id}` };
}

/**
 * The outbox of what must follow a request's bind (Plan 2, Task 14): the owners' notice and the trial unlock. The item is written in the same
 * transaction as the bind, sent from after the commit, and deleted when done; the hourly sweep drains what is left. One item per delivery.
 */
export const GITHUB_INSTALL_NOTICE_OUTBOX_PK = "GITHUB_INSTALL_NOTICE_OUTBOX";

export function githubInstallNoticeOutboxKey(deliveryId: string): OrgKey {
  return { pk: GITHUB_INSTALL_NOTICE_OUTBOX_PK, sk: deliveryId };
}

/** What an outbox item carries: ids and logins only, never an address (the sender reads the owners' addresses when it sends). Times are epoch milliseconds. */
export interface GithubInstallNoticeOutboxRecord {
  orgId: OrgId;
  requesterDeveloperId: string;
  requesterGithubUserId: string;
  requesterLogin: string;
  accountLogin: string;
  approverLogin: string;
  createdAt: number;
  /** Tries made so far (each claim counts one). */
  attempts: number;
  /** The trial unlock is still to do. */
  trialPending: boolean;
  /** The owners (developer ids) still to be told; absent means every owner of the org. Empty means all were told. */
  pendingOwners?: string[];
  /** Set while one worker sends; a claim older than the lease is taken over. */
  claimedAt?: number;
}

/** What a request is shown as: `expired` is how a `waiting` request past its expiry reads. */
export type GithubInstallRequestShownStatus = GithubInstallRequestStatus | "expired";

/** The message a person gives their GitHub admin, because GitHub's request names no Rovara org: GitHub documents no place to write one. */
export const githubAdminMessage = (orgName: string, ownerName: string) => `for Rovara org ${orgName} (owner ${ownerName})`;

/** The words for each state of a request, for the callback page and the CLI. `lines` follow the headline. */
export function githubInstallRequestCopy(
  status: GithubInstallRequestShownStatus,
  names: { account?: string | undefined; orgName?: string | undefined; ownerName?: string | undefined } = {},
): { title: string; lines: string[] } {
  const account = names.account ?? "this GitHub organization";
  const org = names.orgName ?? "your organization";
  switch (status) {
    case "waiting":
      return {
        title: "Waiting for your GitHub admin",
        lines: [
          `You asked an admin of your GitHub organization to approve Rovara. Once they approve it on GitHub, Rovara connects it to ${org} and tells your organization's owners. The request stays open for 7 days.`,
          `GitHub doesn't show your admin which Rovara organization asked. Tell them: ${githubAdminMessage(org, names.ownerName ?? "an owner")}.`,
        ],
      };
    case "connected":
      return { title: `Your GitHub admin approved Rovara. ${account} is now connected to ${org}.`, lines: [] };
    case "declined":
      return { title: "Your GitHub admin declined the request. Ask them about it, or ask them to run agentx github connect.", lines: [] };
    case "expired":
      return { title: "Your request wasn't approved within 7 days, or your GitHub admin declined it. Run agentx github connect to ask again.", lines: [] };
    case "taken":
      return { title: GITHUB_INSTALLATION_TAKEN_MESSAGE, lines: [] };
    case "reinstall_needed":
      return {
        title: `${account} was connected to Rovara before, so an approval can't reconnect it on its own. Ask an admin of ${account} on GitHub to uninstall Rovara and approve a new request, or to run agentx github connect themselves.`,
        lines: [],
      };
    case "cancelled":
      return { title: "This request was cancelled.", lines: [] };
  }
}

/** Times are epoch milliseconds. Both items of a request (global and the org's) carry all of it. */
export interface GithubInstallRequestRecord {
  orgId: OrgId;
  developerId: string;
  githubUserId: string;
  githubLogin: string;
  requestedAt: number;
  /** `requestedAt` plus GITHUB_INSTALL_REQUEST_TTL_MS. A `waiting` record past it reads as `expired`. */
  expiresAt: number;
  remindedAt?: number;
  requestedAccountLogin?: string;
  status: GithubInstallRequestStatus;
  installationId?: number;
  accountLogin?: string;
  approvedBy?: { githubUserId: string; login: string };
  decidedAt?: number;
}

export interface GithubInstallationRecord {
  installationId: number;
  orgId: OrgId;
  accountLogin: string;
  accountId: number;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  installedByGithubUserId: string;
  boundByDeveloperId: string;
  status: "active" | "suspended" | "removed";
  boundAt: string;
  updatedAt: string;
  /** Epoch milliseconds GitHub stamped on the newest lifecycle event applied (Plan 2, Task 15), so an older delivery arriving later is ignored. */
  githubUpdatedAt?: number;
}

/** Idempotent organization rename, separate from invite requests. */
export function orgRenameRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgPk(orgId), sk: `RENAME_REQUEST#${requestId}` };
}

export { OrgRoleSchema, type OrgRole, WriterOrgRoleSchema, type WriterOrgRole, isWriterOrgRole } from "./org.js";
